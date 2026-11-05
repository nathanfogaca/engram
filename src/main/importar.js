// Trazer o time de um Engram anterior (a versão web em Python, em ~/engram/dados): agentes, posições,
// linhas e arquivos. Os agentes que estavam abertos são reabertos aqui (claude --resume), onde pararam.
// Ajustes próprios da pessoa (pasta de trabalho, cérebro, contexto, papéis) não ficam no código: se
// existir um importar-para-o-app.json ao lado da pasta antiga, ele entra no config.json do app.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const PADRAO = path.join(os.homedir(), 'engram', 'dados');
const PORTA_MOTOR_ANTIGO = 8779;

/** Ajustes da pessoa que vêm junto na importação (arquivo dela, fora do código do app). */
function ajustesDaPessoa(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(path.dirname(dir), 'importar-para-o-app.json'), 'utf8').replace(/^\uFEFF/, '')); } catch { return {}; }
}

function lerAntigo(dir = PADRAO) {
  const banco = path.join(dir, 'engram.db');
  if (!fs.existsSync(banco)) return null;
  const db = new DatabaseSync(banco, { readOnly: true });
  try {
    const colunas = db.prepare('PRAGMA table_info(sessoes)').all().map(c => c.name);
    const temManter = colunas.includes('manter');
    const sessoes = db.prepare('SELECT * FROM sessoes ORDER BY criada').all().map(s => ({ ...s, manter: temManter ? s.manter : (s.encerrada ? 0 : 1) }));
    const tabela = n => { try { return db.prepare(`SELECT * FROM ${n}`).all().map(r => ({ ...r })); } catch { return []; } };
    return { dir, sessoes, posicoes: tabela('posicoes'), conexoes: tabela('conexoes') };
  } finally { db.close(); }
}

/** Resumo para a tela: existe? quem estava aberto? */
function verificar(dir = PADRAO) {
  const a = lerAntigo(dir);
  if (!a) return { existe: false };
  return { existe: true, pasta: dir, total: a.sessoes.length, abertos: a.sessoes.filter(s => s.manter).map(s => s.nome), motor_antigo_rodando: motorAntigoPid() !== null };
}

function motorAntigoPid() {
  try {
    const saida = execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-NetTCPConnection -LocalPort ${PORTA_MOTOR_ANTIGO} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`], { encoding: 'utf8', windowsHide: true }).trim();
    return saida ? Number(saida) : null;
  } catch { return null; }
}

/**
 * Traz tudo para o Engram novo. pararAntigo: encerra o motor antigo (os agentes de lá param e são
 * reabertos aqui). reabrir: marca os que estavam abertos para reabrir já.
 */
function importar({ cerebro, caminhos, salvarConfig, dir = PADRAO, pararAntigo = true, reabrir = true }) {
  const a = lerAntigo(dir);
  if (!a) throw new Error('não achei o Engram antigo');
  if (pararAntigo) {
    const pid = motorAntigoPid();
    if (pid) execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  }
  const ajustes = ajustesDaPessoa(dir);
  const db = cerebro.db;
  db.exec('BEGIN');
  try {
    const ins = db.prepare(`INSERT OR IGNORE INTO sessoes (id, nome, provedor, modelo, papel, pasta, criada, encerrada, estado, manter)
                            VALUES (?,?, 'claude', ?,?,?,?,?,?,?)`);
    for (const s of a.sessoes) {
      const aberto = reabrir && s.manter;
      ins.run(s.id, s.nome, s.modelo || '', s.papel || 'livre', s.pasta || ajustes.pasta_trabalho || os.homedir(), s.criada, aberto ? null : (s.encerrada || s.criada), aberto ? 'iniciando' : 'encerrada', aberto ? 1 : 0);
    }
    for (const p of a.posicoes) db.prepare('INSERT OR IGNORE INTO posicoes VALUES (?,?,?,?,?)').run(p.id, p.x, p.y, p.w, p.h);
    for (const c of a.conexoes) db.prepare('INSERT OR IGNORE INTO conexoes VALUES (?,?,?)').run(c.a, c.b, c.criada);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  // arquivos de cada agente
  const origemArq = path.join(dir, 'arquivos');
  let arquivos = 0;
  if (fs.existsSync(origemArq)) {
    for (const id of fs.readdirSync(origemArq)) {
      const destino = path.join(caminhos.arquivos, id);
      if (!fs.existsSync(destino)) { fs.cpSync(path.join(origemArq, id), destino, { recursive: true }); arquivos++; }
    }
  }
  salvarConfig(ajustes);
  return { agentes: a.sessoes.length, reabrir: reabrir ? a.sessoes.filter(s => s.manter).map(s => s.nome) : [], posicoes: a.posicoes.length, linhas: a.conexoes.length, pastas_de_arquivos: arquivos };
}

module.exports = { verificar, importar, PADRAO };
