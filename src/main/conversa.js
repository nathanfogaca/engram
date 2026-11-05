// A conversa de uma janela, lida do arquivo que o próprio Claude Code grava
// (~/.claude/projects/<pasta>/<id>.jsonl). Não chama o modelo: não gasta token.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PROJETOS = path.join(os.homedir(), '.claude', 'projects');
const COLADO = /<\/?pasted_content[^>]*>/g;
const LEMBRETE = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
const COMANDO = /<(command-name|command-message|command-args|local-command-stdout|local-command-caveat)>[\s\S]*?<\/\1>/g;
// o Codex perde o "·" quando a mensagem é colada no Windows
const ENGRAM = /\[Engram\s*·?\s*mensagem de (.+?) \(([^,()]+), ([^()]+)\)\]\s*/;
const RESPONDER = /\s*\(Para responder, use mcp__engram__enviar com para="[^"]*"\.\)\s*$/;
const ID = /^[0-9a-f-]{36}$/;

function achar(sessao) {
  if (!ID.test(sessao || '')) return null;
  try {
    for (const dir of fs.readdirSync(PROJETOS)) {
      const p = path.join(PROJETOS, dir, `${sessao}.jsonl`);
      if (fs.existsSync(p)) return p;
    }
  } catch { /* sem pasta de projetos */ }
  return null;
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

function itensDe(d) {
  if (d.isSidechain || d.isMeta) return [];
  const quando = d.timestamp;
  const conteudo = d.message?.content;
  if (d.type === 'user') {
    if (typeof conteudo === 'string') return textoUsuario(conteudo, quando);
    const saida = [];
    for (const b of conteudo || []) {
      if (b.type === 'text') saida.push(...textoUsuario(b.text || '', quando));
      else if (b.type === 'tool_result') saida.push({ tipo: 'resultado', ref: b.tool_use_id, erro: !!b.is_error, texto: textoResultado(b.content).slice(0, 6000), quando });
    }
    return saida;
  }
  if (d.type === 'assistant') {
    const saida = [];
    for (const b of conteudo || []) {
      if (b.type === 'text' && (b.text || '').trim()) saida.push({ tipo: 'agente', texto: b.text, quando });
      else if (b.type === 'tool_use') {
        const entrada = b.input && typeof b.input === 'object' ? b.input : {};
        saida.push({ tipo: 'ferramenta', id: b.id, nome: b.name || '?', resumo: resumoEntrada(entrada), entrada: JSON.stringify(entrada, null, 1).slice(0, 3000), quando });
      }
    }
    return saida;
  }
  if (d.type === 'system' && d.subtype === 'compact_boundary') return [{ tipo: 'marco', texto: 'conversa compactada', quando }];
  return [];
}

function textoUsuario(texto, quando) {
  texto = String(texto || '').replace(LEMBRETE, '').replace(COMANDO, '').replace(COLADO, '').trim();
  if (!texto) return [];
  if (texto.startsWith('[Request interrupted')) return [{ tipo: 'marco', texto: 'interrompido', quando }];
  const m = ENGRAM.exec(texto);
  if (m && m.index < 40) {
    return [{ tipo: 'colega', de: m[1], papel: m[2], modelo: m[3], texto: texto.slice(m.index + m[0].length).replace(RESPONDER, '').trim(), quando }];
  }
  return [{ tipo: 'voce', texto, quando }];
}

function textoResultado(c) {
  if (typeof c === 'string') return c;
  return (c || []).map(b => (b.type === 'text' ? b.text || '' : b.type === 'tool_reference' ? `(carregou ${b.tool_name || 'ferramenta'})` : b.type === 'image' ? '(imagem)' : '')).join('\n');
}

function resumoEntrada(e) {
  for (const k of ['para', 'quem', 'nome', 'tabela', 'caminho', 'pasta', 'sistema', 'id', 'texto', 'termo', 'file_path', 'pattern', 'command', 'description', 'query', 'sql', 'where']) {
    const v = e[k];
    if (['string', 'number'].includes(typeof v) && String(v).trim()) return String(v).replace(/\n/g, ' ').slice(0, 140);
  }
  return '';
}

module.exports = { achar, ler, textoUsuario, resumoEntrada };
