// Banco local (SQLite embutido no Node): índice do cérebro, palco e rastro das janelas.

const { DatabaseSync } = require('node:sqlite');

const ESQUEMA = `
CREATE TABLE IF NOT EXISTS notas (
  id TEXT PRIMARY KEY, caminho TEXT NOT NULL UNIQUE, tipo TEXT NOT NULL, titulo TEXT NOT NULL,
  sistema TEXT, situacao TEXT, meta TEXT NOT NULL, corpo TEXT NOT NULL, erro TEXT,
  bytes INTEGER, modificado TEXT, sincronizado TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ligacoes (origem TEXT NOT NULL, destino TEXT NOT NULL, tipo TEXT NOT NULL, PRIMARY KEY (origem, destino, tipo));
CREATE INDEX IF NOT EXISTS ligacoes_destino ON ligacoes(destino);
CREATE VIRTUAL TABLE IF NOT EXISTS notas_fts USING fts5(id, titulo, corpo, tokenize = 'unicode61 remove_diacritics 2');
CREATE TABLE IF NOT EXISTS sessoes (
  id TEXT PRIMARY KEY, nome TEXT NOT NULL, provedor TEXT NOT NULL DEFAULT 'claude', modelo TEXT NOT NULL,
  papel TEXT NOT NULL, pasta TEXT NOT NULL, criada TEXT NOT NULL, encerrada TEXT, estado TEXT NOT NULL,
  manter INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS eventos (n INTEGER PRIMARY KEY, sessao TEXT NOT NULL, quando TEXT NOT NULL, evento TEXT NOT NULL, ferramenta TEXT, resumo TEXT);
CREATE INDEX IF NOT EXISTS eventos_sessao ON eventos(sessao, n);
CREATE TABLE IF NOT EXISTS toques (sessao TEXT NOT NULL, destino TEXT NOT NULL, tipo TEXT NOT NULL, vezes INTEGER NOT NULL, ultimo TEXT NOT NULL, PRIMARY KEY (sessao, destino, tipo));
CREATE TABLE IF NOT EXISTS estado (chave TEXT PRIMARY KEY, valor TEXT);
CREATE TABLE IF NOT EXISTS conexoes (a TEXT NOT NULL, b TEXT NOT NULL, criada TEXT NOT NULL, PRIMARY KEY (a, b));
CREATE TABLE IF NOT EXISTS posicoes (id TEXT PRIMARY KEY, x REAL NOT NULL, y REAL NOT NULL, w REAL NOT NULL, h REAL NOT NULL);
CREATE TABLE IF NOT EXISTS setores (id TEXT PRIMARY KEY, nome TEXT NOT NULL, cor TEXT NOT NULL, instrucao TEXT NOT NULL DEFAULT '', x REAL NOT NULL, y REAL NOT NULL, w REAL NOT NULL, h REAL NOT NULL, criado TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS mensagens (n INTEGER PRIMARY KEY, de TEXT NOT NULL, para TEXT NOT NULL, quando TEXT NOT NULL, texto TEXT NOT NULL, entregue TEXT);
CREATE INDEX IF NOT EXISTS mensagens_par ON mensagens(de, para, quando);
CREATE TABLE IF NOT EXISTS automacoes (
  id TEXT PRIMARY KEY, nome TEXT NOT NULL, instrucao TEXT NOT NULL DEFAULT '', alvo TEXT, dias TEXT NOT NULL DEFAULT '1,2,3,4,5',
  hora TEXT NOT NULL DEFAULT '09:00', manual INTEGER NOT NULL DEFAULT 0, perdida TEXT NOT NULL DEFAULT 'rodar', aviso INTEGER NOT NULL DEFAULT 1,
  x REAL NOT NULL, y REAL NOT NULL, visto TEXT, criado TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS automacao_rodadas (
  n INTEGER PRIMARY KEY, automacao TEXT NOT NULL, marcada TEXT, inicio TEXT NOT NULL, fim TEXT, motivo TEXT NOT NULL,
  estado TEXT NOT NULL, resumo TEXT, devolutiva TEXT
);
CREATE INDEX IF NOT EXISTS automacao_rodadas_a ON automacao_rodadas(automacao, n);
CREATE TABLE IF NOT EXISTS postits (id TEXT PRIMARY KEY, texto TEXT NOT NULL DEFAULT '', x REAL NOT NULL, y REAL NOT NULL, criado TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS palcos (n INTEGER PRIMARY KEY, nome TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS notas_guardadas (
  fonte TEXT NOT NULL, id TEXT NOT NULL, caminho TEXT NOT NULL, tipo TEXT NOT NULL, titulo TEXT NOT NULL, sistema TEXT, situacao TEXT,
  meta TEXT NOT NULL, corpo TEXT NOT NULL, erro TEXT, bytes INTEGER, modificado TEXT, sincronizado TEXT NOT NULL, PRIMARY KEY (fonte, caminho)
);
CREATE TABLE IF NOT EXISTS ligacoes_guardadas (fonte TEXT NOT NULL, origem TEXT NOT NULL, destino TEXT NOT NULL, tipo TEXT NOT NULL, PRIMARY KEY (fonte, origem, destino, tipo));
`;

const PALCOS = 3; // quantos palcos a pessoa pode alternar

function agora() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function haMinutos(min) {
  const d = new Date(Date.now() - min * 60_000);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function abrir(caminho) {
  const db = new DatabaseSync(caminho);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec(ESQUEMA);
  // colunas que chegaram depois (bancos antigos não têm)
  const colunas = new Set(db.prepare("PRAGMA table_info('sessoes')").all().map(c => c.name));
  if (!colunas.has('externo')) db.exec('ALTER TABLE sessoes ADD COLUMN externo TEXT'); // id da conversa no CLI (Codex)
  if (!colunas.has('mcps')) db.exec('ALTER TABLE sessoes ADD COLUMN mcps TEXT'); // MCPs escolhidos para a janela (JSON); NULL = os ativos
  if (!colunas.has('nome_prompt')) db.exec('ALTER TABLE sessoes ADD COLUMN nome_prompt TEXT'); // o nome com que a conversa começou (está no prompt dela)
  const ligacoes = new Set(db.prepare("PRAGMA table_info('conexoes')").all().map(c => c.name));
  if (!ligacoes.has('revisa')) db.exec('ALTER TABLE conexoes ADD COLUMN revisa TEXT'); // a ponta que revisa as entregas da outra
  // cérebro com que a conversa começou (a descrição dele está no prompt): se a fonte mudar, o agente é avisado
  if (!colunas.has('cerebro_prompt')) db.exec('ALTER TABLE sessoes ADD COLUMN cerebro_prompt TEXT');
  // vários palcos: cada cartão, setor, automação e post-it é de um palco. O que já existia fica no Palco 1. A
  // posição do cartão (tabela posicoes) segue o palco da janela, pelo id.
  for (const tabela of ['sessoes', 'setores', 'automacoes', 'postits']) {
    const cols = new Set(db.prepare(`PRAGMA table_info('${tabela}')`).all().map(c => c.name));
    if (!cols.has('palco')) db.exec(`ALTER TABLE ${tabela} ADD COLUMN palco INTEGER NOT NULL DEFAULT 1`);
  }
  // a devolutiva de uma automação também vira nota no cérebro, se a pessoa ligar no painel dela
  const colsAuto = new Set(db.prepare("PRAGMA table_info('automacoes')").all().map(c => c.name));
  if (!colsAuto.has('nota_no_cerebro')) db.exec('ALTER TABLE automacoes ADD COLUMN nota_no_cerebro INTEGER NOT NULL DEFAULT 0');
  const semNome = db.prepare('INSERT OR IGNORE INTO palcos (n, nome) VALUES (?, ?)');
  for (let n = 1; n <= PALCOS; n++) semNome.run(n, `Palco ${n}`);
  return db;
}

/** Roda fn dentro de uma transação. */
function transacao(db, fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

module.exports = { abrir, transacao, agora, haMinutos, PALCOS };
