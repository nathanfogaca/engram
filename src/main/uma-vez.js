// Uma pergunta só para a IA, sem janela no palco: a mensagem do commit e o mapa dos fluxos do projeto.
// Roda o Claude Code (ou o Codex, se o Claude não estiver instalado) sem interação, só com ferramentas de
// leitura e sem os MCPs da pessoa, e devolve a resposta (o JSON pedido, quando há esquema).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const LEITURA = 'Read,Glob,Grep';

function ambiente() {
  const { VARIAVEIS_FORA } = require('./janelas');
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !VARIAVEIS_FORA.has(k.toUpperCase())));
}

function relativo(cwd, arquivo) {
  if (!arquivo) return '';
  const r = path.relative(cwd, arquivo);
  return r && !r.startsWith('..') && !path.isAbsolute(r) ? r.split(path.sep).join('/') : arquivo;
}

function passo(cwd, nome, e = {}) {
  const arq = relativo(cwd, e.file_path || e.path);
  if (nome === 'Read') return `Lendo ${arq}`;
  if (nome === 'Glob') return `Procurando ${e.pattern}`;
  if (nome === 'Grep') return `Buscando "${e.pattern}"`;
  return nome;
}

function lerJson(texto) {
  if (!texto) return null;
  const limpo = String(texto).trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  try { const j = JSON.parse(limpo); return j && typeof j === 'object' ? j : null; } catch { return null; }
}

/** Roda o programa com o prompt pela entrada padrão; chama aoLinha a cada linha da saída. */
function rodar(comando, args, { cwd, prompt, sinal, tempo, aoLinha }) {
  return new Promise((resolve, reject) => {
    const filho = spawn(comando[0], [...comando.slice(1), ...args], { cwd, windowsHide: true, env: ambiente() });
    let resto = '', erro = '';
    const matar = () => { try { if (process.platform === 'win32') spawn('taskkill', ['/pid', String(filho.pid), '/T', '/F'], { windowsHide: true }); else filho.kill(); } catch { /* já saiu */ } };
    const relogio = setTimeout(() => { matar(); reject(new Error('a IA demorou demais e foi parada')); }, tempo);
    sinal?.addEventListener('abort', () => { matar(); reject(new Error('parado')); }, { once: true });
    filho.stdout.setEncoding('utf8');
    filho.stdout.on('data', d => {
      resto += d;
      let i;
      while ((i = resto.indexOf('\n')) >= 0) { const linha = resto.slice(0, i).trim(); resto = resto.slice(i + 1); if (linha) aoLinha(linha); }
    });
    filho.stderr.on('data', d => { erro = (erro + d).slice(-4000); });
    filho.on('error', e => { clearTimeout(relogio); reject(e); });
    filho.on('close', codigo => {
      clearTimeout(relogio);
      if (resto.trim()) aoLinha(resto.trim());
      resolve({ codigo, erro: erro.trim() });
    });
    filho.stdin.on('error', () => {}); // o processo pode morrer antes de ler o prompt
    filho.stdin.end(prompt);
  });
}

async function comClaude(comando, { prompt, cwd, esquema, modelo, sinal, tempo, aoPasso }) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--no-session-persistence',
    // ninguém está olhando para aprovar: o que está na lista roda, o resto é negado
    '--permission-mode', 'dontAsk', '--tools', LEITURA, '--allowedTools', LEITURA,
    // sem os MCPs, plugins e ganchos da pessoa: só a pasta do projeto
    '--disallowedTools', 'mcp__*', '--strict-mcp-config', '--setting-sources', 'project,local'];
  if (esquema) args.push('--json-schema', JSON.stringify(esquema));
  if (modelo) args.push('--model', modelo);
  let fim = null;
  const r = await rodar(comando, args, {
    cwd, prompt, sinal, tempo,
    aoLinha: linha => {
      let ev;
      try { ev = JSON.parse(linha); } catch { return; }
      if (ev.type === 'assistant') for (const c of ev.message?.content || []) if (c.type === 'tool_use') aoPasso?.(passo(cwd, c.name, c.input));
      if (ev.type === 'result') fim = ev;
    },
  });
  if (!fim) throw new Error(r.erro.split('\n').filter(Boolean).slice(-2).join(' ') || 'o Claude Code não respondeu');
  if (fim.is_error) throw new Error(String(fim.result || fim.subtype || 'o Claude Code devolveu erro').slice(0, 300));
  return esquema ? (fim.structured_output || lerJson(fim.result)) : String(fim.result || '').trim();
}

async function comCodex(comando, { prompt, cwd, esquema, modelo, sinal, tempo, aoPasso }) {
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-'));
  const saida = path.join(pasta, 'saida.txt');
  const args = ['exec', '--json', '--skip-git-repo-check', '--ephemeral', '-C', cwd, '-s', 'read-only', '-o', saida];
  if (esquema) { const arq = path.join(pasta, 'esquema.json'); fs.writeFileSync(arq, JSON.stringify(esquema)); args.push('--output-schema', arq); }
  if (modelo) args.push('-m', modelo);
  args.push('-');
  try {
    const r = await rodar(comando, args, {
      cwd, prompt, sinal, tempo,
      aoLinha: linha => { try { const ev = JSON.parse(linha); if (ev.item?.type === 'command_execution' && ev.type === 'item.started') aoPasso?.(`$ ${ev.item.command}`); } catch { /* outra linha */ } },
    });
    const texto = fs.existsSync(saida) ? fs.readFileSync(saida, 'utf8') : '';
    if (!texto.trim()) throw new Error(r.erro.split('\n').filter(Boolean).slice(-2).join(' ') || 'o Codex não respondeu');
    return esquema ? lerJson(texto) : texto.trim();
  } finally { fs.rmSync(pasta, { recursive: true, force: true }); }
}

/** Pergunta uma vez. Usa o Claude Code; sem ele, o Codex. modelo vazio = o padrão do agente. */
async function perguntar(provedores, { prompt, cwd, esquema = null, modelo = '', sinal = null, tempo = 300_000, aoPasso = null }) {
  const claude = provedores.comando('claude');
  if (claude) return comClaude(claude, { prompt, cwd, esquema, modelo, sinal, tempo, aoPasso });
  const codex = provedores.comando('codex');
  if (codex) return comCodex(codex, { prompt, cwd, esquema, modelo: '', sinal, tempo, aoPasso });
  throw new Error('nenhum agente instalado para responder (instale o Claude Code ou o Codex em Ajustes > Contas)');
}

module.exports = { perguntar };
