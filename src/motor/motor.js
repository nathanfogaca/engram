// Motor do Engram: segura os terminais dos agentes num processo à parte (Node puro, sem janela).
// Fechar ou atualizar o app não derruba o time: o app reconecta aqui e reencontra cada agente.
// Fala com o app por TCP local (127.0.0.1), uma mensagem JSON por linha, depois do token.
// Variáveis: ENGRAM_MOTOR_PORTA, ENGRAM_MOTOR_TOKEN, ENGRAM_DADOS (para o log).

const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const pty = require('@lydell/node-pty');

const VERSAO = 1;
const MAX_HISTORICO = 400_000;
const SAIR_SEM_USO_MS = 15 * 60_000;
const PORTA = Number(process.env.ENGRAM_MOTOR_PORTA || 0);
const TOKEN = Buffer.from(process.env.ENGRAM_MOTOR_TOKEN || '');
const LOG = process.env.ENGRAM_DADOS ? path.join(process.env.ENGRAM_DADOS, 'motor.log') : null;

function registrar(texto) {
  if (LOG) try { fs.appendFileSync(LOG, `${new Date().toISOString()} ${texto}\n`); } catch { /* sem log */ }
}

const terminais = new Map(); // id -> { pty, saida: [], tamanho, viva, fimEm }
const clientes = new Set();
let ultimoUso = Date.now();

function mandar(sock, msg) {
  try {
    if (sock.writableLength > 32 * 1024 * 1024) { sock.destroy(); return; } // app travado: ele reconecta
    sock.write(JSON.stringify(msg) + '\n');
  } catch { clientes.delete(sock); }
}
const espalhar = msg => { for (const s of clientes) mandar(s, msg); };

function guardar(t, texto) {
  t.saida.push(texto);
  t.tamanho += texto.length;
  while (t.tamanho > MAX_HISTORICO && t.saida.length > 1) t.tamanho -= t.saida.shift().length;
}

function comando(sock, m) {
  const { op, ref } = m;
  const id = String(m.id || '');
  const t = terminais.get(id);
  if (op === 'abrir') {
    if (t && t.viva) return mandar(sock, { ev: 'erro', ref, erro: 'já existe' });
    let p;
    try {
      p = pty.spawn(m.argv[0], m.argv.slice(1), { name: 'xterm-256color', cols: m.colunas || 100, rows: m.linhas || 28, cwd: m.cwd, env: m.env, useConpty: true });
    } catch (e) {
      return mandar(sock, { ev: 'erro', ref, erro: String(e.message) });
    }
    const novo = { pty: p, saida: [], tamanho: 0, viva: true, fimEm: null };
    terminais.set(id, novo);
    p.onData(d => { guardar(novo, d); espalhar({ ev: 'saida', id, dados: d }); });
    p.onExit(() => {
      novo.viva = false;
      novo.fimEm = Date.now();
      registrar(`terminou ${id}`);
      espalhar({ ev: 'fim', id });
    });
    registrar(`abriu ${id}`);
    return mandar(sock, { ev: 'ok', ref, pid: p.pid });
  }
  if (op === 'escrever') { if (t && t.viva) t.pty.write(String(m.dados || '')); return; }
  if (op === 'tamanho') {
    if (t && t.viva) try { t.pty.resize(Math.max(20, Math.min(m.colunas | 0, 500)), Math.max(5, Math.min(m.linhas | 0, 300))); } catch { /* terminal saindo */ }
    return;
  }
  if (op === 'fechar') { if (t && t.viva) try { t.pty.kill(); } catch { /* já saiu */ } return; }
  if (op === 'listar') return mandar(sock, { ev: 'lista', ref, terminais: [...terminais.entries()].map(([i, x]) => ({ id: i, viva: x.viva })) });
  if (op === 'historico') return mandar(sock, { ev: 'historico', ref, id, dados: t ? t.saida.join('') : '' });
  if (op === 'versao') return mandar(sock, { ev: 'versao', ref, versao: VERSAO, pid: process.pid });
  if (op === 'esquecer') { if (t && !t.viva) terminais.delete(id); }
}

const servidor = net.createServer(sock => {
  sock.setEncoding('utf8');
  let buffer = '';
  let autenticado = false;
  const prazo = setTimeout(() => { if (!autenticado) sock.destroy(); }, 5000);
  sock.on('data', pedaco => {
    buffer += pedaco;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const linha = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      let msg;
      try { msg = JSON.parse(linha); } catch { continue; }
      if (!autenticado) {
        const dado = Buffer.from(String(msg.token || ''));
        if (dado.length !== TOKEN.length || !crypto.timingSafeEqual(dado, TOKEN)) { sock.destroy(); return; }
        autenticado = true;
        clearTimeout(prazo);
        clientes.add(sock);
        ultimoUso = Date.now();
        continue;
      }
      try { comando(sock, msg); } catch (e) { registrar(`erro no comando: ${e.message}`); }
    }
  });
  sock.on('close', () => { clientes.delete(sock); ultimoUso = Date.now(); });
  sock.on('error', () => {});
});

servidor.on('error', e => {
  if (e.code === 'EADDRINUSE') process.exit(0); // já tem um motor nesta porta
  registrar(`erro do servidor: ${e.message}`);
});

setInterval(() => {
  const agora = Date.now();
  for (const [id, t] of terminais) if (!t.viva && t.fimEm && agora - t.fimEm > 600_000) terminais.delete(id);
  const vivos = [...terminais.values()].some(t => t.viva);
  if (vivos || clientes.size) ultimoUso = agora;
  else if (agora - ultimoUso > SAIR_SEM_USO_MS) { registrar('sem uso: saindo'); process.exit(0); }
}, 30_000);

if (!PORTA || !TOKEN.length) { console.error('faltam ENGRAM_MOTOR_PORTA e ENGRAM_MOTOR_TOKEN'); process.exit(2); }
servidor.listen(PORTA, '127.0.0.1', () => registrar(`motor v${VERSAO} na porta ${PORTA} (pid ${process.pid})`));
