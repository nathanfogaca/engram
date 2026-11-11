// A conversa de uma janela do Codex, lida do arquivo que o próprio Codex grava
// (~/.codex/sessions/AAAA/MM/DD/rollout-<data>-<id>.jsonl). Não chama o modelo: não gasta token.
// Os itens saem no mesmo formato da conversa do Claude (voce, colega, agente, ferramenta, resultado, marco).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { textoUsuario, resumoEntrada } = require('./conversa');

const SESSOES = () => path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
const ID = /^[0-9a-f-]{36}$/;
const ID_NO_NOME = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;
const CONTEXTO = /^\s*<(environment_context|user_instructions|permissions instructions|collaboration_mode|skills_instructions|apps_instructions)\b/;

function pastasDoDia(dias) {
  const saida = [];
  for (let i = 0; i < dias; i++) {
    const d = new Date(Date.now() - i * 86_400_000);
    saida.push(path.join(SESSOES(), String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')));
  }
  return saida;
}

/** Acha o arquivo pela id do Codex (thread) em qualquer dia. */
function acharPorExterno(externo) {
  if (!ID.test(externo || '')) return null;
  for (const dia of pastasDoDia(3)) {
    try { const a = fs.readdirSync(dia).find(n => n.endsWith(`-${externo}.jsonl`)); if (a) return path.join(dia, a); } catch { /* sem pasta */ }
  }
  try {
    for (const ano of fs.readdirSync(SESSOES()).sort().reverse()) {
      for (const mes of fs.readdirSync(path.join(SESSOES(), ano)).sort().reverse()) {
        for (const dia of fs.readdirSync(path.join(SESSOES(), ano, mes)).sort().reverse()) {
          const pasta = path.join(SESSOES(), ano, mes, dia);
          const a = fs.readdirSync(pasta).find(n => n.endsWith(`-${externo}.jsonl`));
          if (a) return path.join(pasta, a);
        }
      }
    }
  } catch { /* sem sessões */ }
  return null;
}

/** Antes do primeiro fim de turno não sabemos a id do Codex: achamos pela marca que vai nas instruções. */
function acharPelaMarca(sessao, desdeMs) {
  const marca = Buffer.from(`(Engram: janela ${sessao})`);
  for (const dia of pastasDoDia(2)) {
    let nomes = [];
    try { nomes = fs.readdirSync(dia).filter(n => n.endsWith('.jsonl')); } catch { continue; }
    for (const n of nomes) {
      const p = path.join(dia, n);
      try {
        if (fs.statSync(p).mtimeMs < desdeMs - 120_000) continue;
        const fd = fs.openSync(p, 'r');
        const buf = Buffer.alloc(256 * 1024);
        const lidos = fs.readSync(fd, buf, 0, buf.length, 0);
        fs.closeSync(fd);
        if (buf.subarray(0, lidos).includes(marca)) return p;
      } catch { /* sumiu */ }
    }
  }
  return null;
}

function externoDoCaminho(caminho) {
  const m = ID_NO_NOME.exec(caminho || '');
  return m ? m[1] : null;
}

function ler(caminho, desde = 0, ultimos = null) {
  let dados;
  try {
    const fd = fs.openSync(caminho, 'r');
    const tam = fs.fstatSync(fd).size;
    const n = Math.max(0, tam - desde);
    dados = Buffer.alloc(n);
    fs.readSync(fd, dados, 0, n, desde);
    fs.closeSync(fd);
  } catch { return { itens: [], ate: desde }; }
  const fim = dados.lastIndexOf(0x0a);
  if (fim < 0) return { itens: [], ate: desde };
  let itens = [];
  for (const linha of dados.subarray(0, fim + 1).toString('utf8').split('\n')) {
    if (!linha.trim()) continue;
    let r;
    try { r = JSON.parse(linha); } catch { continue; }
    itens.push(...itensDe(r));
  }
  if (ultimos) itens = itens.slice(-ultimos);
  return { itens, ate: desde + fim + 1 };
}

/**
 * Só as chamadas de ferramenta e o fim de cada uma, com a entrada inteira (a vista Conversa corta em 3000 letras).
 * Serve para as linhas do cérebro: que nota o agente abriu ou gravou. `escapado`: a entrada veio dentro de uma
 * string (código do "exec", argumentos em JSON) e os caminhos estão com barras dobradas.
 */
function chamadas(caminho, desde = 0) {
  let dados;
  try {
    const fd = fs.openSync(caminho, 'r');
    const n = Math.max(0, Math.min(fs.fstatSync(fd).size - desde, 8 << 20));
    dados = Buffer.alloc(n);
    fs.readSync(fd, dados, 0, n, desde);
    fs.closeSync(fd);
  } catch { return { itens: [], ate: desde }; }
  const fim = dados.lastIndexOf(0x0a);
  if (fim < 0) return { itens: [], ate: desde };
  const itens = [];
  for (const linha of dados.subarray(0, fim + 1).toString('utf8').split('\n')) {
    if (!linha.includes('"response_item"')) continue;
    let r;
    try { r = JSON.parse(linha); } catch { continue; }
    const p = r.payload || {};
    if (['function_call', 'custom_tool_call', 'local_shell_call', 'mcp_tool_call'].includes(p.type)) {
      const bruto = p.arguments ?? p.input ?? p.action ?? '';
      const id = p.call_id || p.id;
      if (typeof bruto === 'string') itens.push({ tipo: 'chamada', id, nome: p.name || p.type, texto: bruto, escapado: !(p.type === 'custom_tool_call' && p.name !== 'exec') });
      else if (bruto && typeof bruto === 'object') {
        // local_shell_call: { command: [...], working_directory }
        const comando = Array.isArray(bruto.command) ? bruto.command.join(' ') : String(bruto.command || bruto.cmd || '');
        itens.push({ tipo: 'chamada', id, nome: p.name || p.type, texto: comando, escapado: false, base: bruto.working_directory || bruto.workdir || '' });
      }
      // o local_shell_call já vem com o resultado (status), sem um item de saída depois
      if (p.type === 'local_shell_call' && p.status && p.status !== 'in_progress') itens.push({ tipo: 'fim', ref: id });
    } else if (['function_call_output', 'custom_tool_call_output', 'mcp_tool_call_output'].includes(p.type)) {
      itens.push({ tipo: 'fim', ref: p.call_id });
    }
  }
  return { itens, ate: desde + fim + 1 };
}

function texto(conteudo) {
  if (typeof conteudo === 'string') return conteudo;
  return (conteudo || []).map(b => (['input_text', 'output_text', 'text'].includes(b.type) ? b.text || '' : b.type === 'input_image' ? '(imagem)' : '')).join('\n');
}

function itensDe(d) {
  const quando = d.timestamp;
  const p = d.payload || {};
  if (d.type === 'response_item') {
    if (p.type === 'message') {
      const t = texto(p.content);
      if (p.role === 'user') return CONTEXTO.test(t) ? [] : textoUsuario(t, quando);
      if (p.role === 'assistant' && t.trim()) return [{ tipo: 'agente', texto: t, quando }];
      return [];
    }
    if (['function_call', 'custom_tool_call', 'local_shell_call', 'mcp_tool_call'].includes(p.type)) {
      const bruto = p.arguments ?? p.input ?? p.action ?? '';
      let entrada = {};
      if (typeof bruto === 'string') { try { entrada = JSON.parse(bruto); } catch { entrada = { command: bruto }; } } else if (bruto && typeof bruto === 'object') entrada = bruto;
      // no Codex, as ferramentas MCP rodam dentro de um "exec": mostramos o nome da ferramenta chamada
      const mcp = typeof bruto === 'string' ? /tools\.(mcp__[\w-]+?__[\w-]+)\s*\(/.exec(bruto) : null;
      const nome = mcp ? mcp[1] : p.name || p.type;
      const resumo = resumoEntrada(entrada) || (typeof bruto === 'string' ? bruto.replace(/\s+/g, ' ').slice(0, 140) : '');
      return [{ tipo: 'ferramenta', id: p.call_id || p.id, nome, resumo, entrada: (typeof bruto === 'string' ? bruto : JSON.stringify(bruto, null, 1)).slice(0, 3000), quando }];
    }
    if (['function_call_output', 'custom_tool_call_output', 'mcp_tool_call_output'].includes(p.type)) {
      const out = typeof p.output === 'string' ? p.output : Array.isArray(p.output) ? texto(p.output) : JSON.stringify(p.output ?? '');
      return [{ tipo: 'resultado', ref: p.call_id, erro: false, texto: String(out).slice(0, 6000), quando }];
    }
    return [];
  }
  if (d.type === 'event_msg') {
    if (p.type === 'turn_aborted') return [{ tipo: 'marco', texto: 'interrompido', quando }];
    if (p.type === 'context_compacted') return [{ tipo: 'marco', texto: 'conversa compactada', quando }];
  }
  if (d.type === 'compacted') return [{ tipo: 'marco', texto: 'conversa compactada', quando }];
  return [];
}

module.exports = { acharPorExterno, acharPelaMarca, externoDoCaminho, ler, chamadas };
