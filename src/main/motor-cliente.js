// Cliente do motor (o processo que segura os terminais dos agentes), usado pelo app.
// No app instalado, o motor roda de uma cópia em %LOCALAPPDATA%\Engram\motor\v<N>: assim a
// atualização troca os arquivos do app sem derrubar os agentes. Em desenvolvimento, roda do código.

const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { app } = require('electron');

const VERSAO_MOTOR = 1;

/** Onde estão o node e os scripts do motor (e do gancho) que os agentes vão usar. */
function runtimeDoMotor() {
  if (app.isPackaged) {
    const origem = path.join(process.resourcesPath, 'motor');
    const { id } = JSON.parse(fs.readFileSync(path.join(origem, 'package.json'), 'utf8'));
    const base = path.join(process.env.LOCALAPPDATA || app.getPath('appData'), 'Engram', 'motor');
    const destino = path.join(base, `v${VERSAO_MOTOR}-${id}`);
    const completo = () => fs.existsSync(path.join(destino, '.pronto')) && fs.existsSync(path.join(destino, 'modulos', '@lydell', 'node-pty'));
    if (!completo()) {
      // copia numa pasta temporária e só então renomeia: nunca fica uma cópia pela metade
      const temp = `${destino}.tmp-${process.pid}`;
      fs.rmSync(temp, { recursive: true, force: true });
      fs.cpSync(origem, temp, { recursive: true });
      fs.writeFileSync(path.join(temp, '.pronto'), new Date().toISOString());
      fs.rmSync(destino, { recursive: true, force: true });
      fs.renameSync(temp, destino);
    }
    return { node: path.join(destino, 'node.exe'), motor: path.join(destino, 'motor.js'), gancho: path.join(destino, 'gancho.js'), cwd: destino, modulos: path.join(destino, 'modulos') };
  }
  let node = process.env.ENGRAM_NODE || '';
  if (!node) {
    try { node = execFileSync('where', ['node'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim(); } catch { node = 'node'; }
  }
  const dir = path.resolve(__dirname, '..', 'motor');
  return { node, motor: path.join(dir, 'motor.js'), gancho: path.join(dir, 'gancho.js'), cwd: path.resolve(__dirname, '..', '..') };
}

class MotorErro extends Error {}

class MotorCliente {
  constructor(cfg, token, { aoSaida, aoFim, aoCair, dados }) {
    this.cfg = cfg;
    this.token = token;
    this.aoSaida = aoSaida;
    this.aoFim = aoFim;
    this.aoCair = aoCair;
    this.dados = dados;
    this.sock = null;
    this.refs = 0;
    this.esperando = new Map();
    this.fechando = false;
    this.runtime = runtimeDoMotor();
  }

  get ligado() { return !!this.sock; }

  tentar() {
    return new Promise((resolve, reject) => {
      const s = net.connect(this.cfg.motor_porta, '127.0.0.1');
      s.once('connect', () => resolve(s));
      s.once('error', reject);
    });
  }

  async conectar() {
    for (let i = 0; i < 60; i++) {
      let s;
      try { s = await this.tentar(); } catch {
        if (i === 0) this.subir();
        await new Promise(r => setTimeout(r, 250));
        continue;
      }
      s.setEncoding('utf8');
      s.write(JSON.stringify({ token: this.token }) + '\n');
      this.sock = s;
      this.ler(s);
      return;
    }
    throw new MotorErro('o motor não subiu (veja motor.log)');
  }

  subir() {
    const r = this.runtime;
    const env = { ...process.env, ENGRAM_MOTOR_PORTA: String(this.cfg.motor_porta), ENGRAM_MOTOR_TOKEN: this.token, ENGRAM_DADOS: this.dados };
    delete env.ELECTRON_RUN_AS_NODE;
    if (r.modulos) env.NODE_PATH = r.modulos; // no app instalado o node-pty fica em motor/<id>/modulos
    if (process.platform === 'win32') {
      // Pelo shell do Windows (Start-Process): o motor nasce SEM herdar handles do app. Herdando, ele
      // seguraria arquivos e portas do app, e a atualização não conseguiria trocar os arquivos.
      const aspas = s => `'${String(s).replace(/'/g, "''")}'`;
      const comando = `Start-Process -FilePath ${aspas(r.node)} -ArgumentList ${aspas(`"${r.motor}"`)} -WorkingDirectory ${aspas(r.cwd)} -WindowStyle Hidden`;
      const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', comando], { env, windowsHide: true, stdio: 'ignore' });
      ps.unref();
      return;
    }
    const filho = spawn(r.node, [r.motor], { cwd: r.cwd, detached: true, stdio: 'ignore', env });
    filho.unref();
  }

  ler(s) {
    let buffer = '';
    s.on('data', pedaco => {
      buffer += pedaco;
      let i;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const linha = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        let m;
        try { m = JSON.parse(linha); } catch { continue; }
        if (m.ev === 'saida') this.aoSaida(m.id, m.dados);
        else if (m.ev === 'fim') this.aoFim(m.id);
        else {
          const p = this.esperando.get(m.ref);
          if (p) { this.esperando.delete(m.ref); m.ev === 'erro' ? p.reject(new MotorErro(m.erro)) : p.resolve(m); }
        }
      }
    });
    const caiu = () => {
      if (this.sock !== s) return;
      this.sock = null;
      for (const p of this.esperando.values()) p.reject(new MotorErro('o motor caiu'));
      this.esperando.clear();
      if (!this.fechando) setImmediate(() => this.aoCair());
    };
    s.on('close', caiu);
    s.on('error', () => {});
  }

  mandarBruto(msg) {
    if (!this.sock) throw new MotorErro('sem conexão com o motor');
    this.sock.write(JSON.stringify(msg) + '\n');
  }

  pedir(op, dados = {}) {
    const ref = ++this.refs;
    return new Promise((resolve, reject) => {
      const prazo = setTimeout(() => { this.esperando.delete(ref); reject(new MotorErro('o motor não respondeu')); }, 20_000);
      this.esperando.set(ref, { resolve: v => { clearTimeout(prazo); resolve(v); }, reject: e => { clearTimeout(prazo); reject(e); } });
      try { this.mandarBruto({ op, ref, ...dados }); } catch (e) { this.esperando.delete(ref); clearTimeout(prazo); reject(e); }
    });
  }

  mandar(op, dados = {}) {
    try { this.mandarBruto({ op, ...dados }); } catch { /* sem motor: o próximo conectar resolve */ }
  }

  fechar() {
    this.fechando = true;
    this.sock?.end();
  }
}

module.exports = { MotorCliente, MotorErro, runtimeDoMotor, VERSAO_MOTOR };
