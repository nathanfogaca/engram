// Interpreta uma nota do cérebro: frontmatter (YAML), título e ligações ([[id]] e campos de ligação).

const path = require('node:path');
const YAML = require('yaml');

const CAMPOS_LIGACAO = {
  tabelas: 'toca', padroes: 'caso de', continua: 'continua', parecidos: 'parecido',
  sistemas: 'envolve', projetos: 'parte de', relacionados: 'relacionado',
};
const TIPO_PELA_PASTA = { chamados: 'chamado', tabelas: 'tabela', padroes: 'padrao', sistemas: 'sistema', projetos: 'projeto', sessoes: 'sessao' };

const FRONTMATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const WIKILINK = /\[\[([^\[\]|#\n]+)(?:#[^\[\]|\n]*)?(?:\|([^\[\]\n]+))?\]\]/g;
const TITULO_MD = /^#\s+(.+?)\s*$/m;
const CODIGO = /^(```|~~~)[\s\S]*?^\1[ \t]*$|`[^`\n]*`/gm; // exemplo em código não é ligação

function idDoCaminho(caminho) {
  const nome = path.posix.basename(String(caminho).replace(/\\/g, '/'));
  return nome.toLowerCase().endsWith('.md') ? nome.slice(0, -3) : nome;
}

function comoLista(valor) {
  if (valor === null || valor === undefined) return [];
  if (Array.isArray(valor)) return valor.filter(v => v !== null && v !== undefined).map(v => String(v).trim()).filter(Boolean);
  return String(valor).split(',').map(p => p.trim().replace(/^\[+|\]+$/g, '').trim()).filter(Boolean);
}

function limpar(v) {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (Array.isArray(v)) return v.map(limpar);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [String(k), limpar(x)]));
  return v;
}

function interpretar(caminho, texto) {
  caminho = String(caminho).replace(/\\/g, '/').replace(/^\/+/, '');
  let meta = {};
  let corpo = texto;
  let erro = null;
  const m = FRONTMATTER.exec(texto);
  if (m) {
    corpo = texto.slice(m[0].length);
    try {
      const carregado = YAML.parse(m[1]);
      if (carregado && typeof carregado === 'object' && !Array.isArray(carregado)) meta = limpar(carregado);
      else if (carregado !== null && carregado !== undefined) erro = 'frontmatter não é um mapa chave: valor';
    } catch (e) {
      erro = `frontmatter inválido: ${String(e.message).split('\n')[0]}`;
    }
  }
  const id = idDoCaminho(caminho);
  const pasta = caminho.includes('/') ? caminho.split('/')[0] : '';
  const tipo = String(meta.tipo || TIPO_PELA_PASTA[pasta] || 'guia');
  const semCodigo = corpo.replace(CODIGO, ' ');
  let titulo = meta.titulo;
  if (!titulo) {
    const t = TITULO_MD.exec(semCodigo);
    titulo = t ? t[1] : id;
  }
  const ligacoes = [];
  const vistos = new Set();
  for (const [campo, nomeLig] of Object.entries(CAMPOS_LIGACAO)) {
    for (const destino of comoLista(meta[campo])) {
      if (destino && destino !== id && !ligacoes.some(([d, t]) => d === destino && t === nomeLig)) {
        ligacoes.push([destino, nomeLig]);
        vistos.add(destino);
      }
    }
  }
  for (const w of semCodigo.matchAll(WIKILINK)) {
    const destino = w[1].trim();
    if (destino && destino !== id && !vistos.has(destino)) {
      ligacoes.push([destino, 'cita']);
      vistos.add(destino);
    }
  }
  return { id, caminho, tipo, titulo: String(titulo), meta, corpo, ligacoes, erro };
}

module.exports = { interpretar, idDoCaminho, CAMPOS_LIGACAO };
