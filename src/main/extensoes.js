// Extensões do VS Code na vista Código. Vêm de três lugares: as que a pessoa instala pela loja Open VSX
// (open-vsx.org, o registro aberto que o VSCodium e o Cursor usam; o Marketplace da Microsoft só pode ser
// usado pelos produtos dela), as que ela já tem no VS Code ou no Cursor, e as que vêm embutidas no VS Code
// instalado. Delas o Engram usa só o que é declarativo: temas de cores, temas de ícones, linguagens,
// gramáticas de realce (TextMate) e snippets. Código de extensão nunca roda aqui.
// A loja e os temas vieram do Orbion (Lucas Lessa), que passou a fazer parte do Engram.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const API = 'https://open-vsx.org/api';
const ARQUIVOS_SERVIDOS = /\.(json|jsonc|code-snippets|tmlanguage|plist|xml|svg|png|jpe?g|gif|webp|woff2?|ttf|otf)$/i;
const ORIGENS = { engram: 'Instalada no Engram', vscode: 'Do seu VS Code', cursor: 'Do seu Cursor', vscodium: 'Do seu VSCodium', embutida: 'Embutida no VS Code' };

/** JSON com comentários e vírgulas sobrando, como os arquivos das extensões do VS Code. */
function lerJsonc(texto) {
  let saida = '', emTexto = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i], prox = texto[i + 1];
    if (emTexto) {
      saida += c;
      if (c === '\\') { saida += prox ?? ''; i++; } else if (c === '"') emTexto = false;
    } else if (c === '"') { emTexto = true; saida += c; }
    else if (c === '/' && prox === '/') { while (i < texto.length && texto[i] !== '\n') i++; saida += '\n'; }
    else if (c === '/' && prox === '*') { i += 2; while (i < texto.length && !(texto[i] === '*' && texto[i + 1] === '/')) i++; i++; }
    else saida += c;
  }
  const limpo = saida.charCodeAt(0) === 0xfeff ? saida.slice(1) : saida;
  return JSON.parse(limpo.replace(/,(\s*[}\]])/g, '$1'));
}
const lerJsoncArquivo = arq => lerJsonc(fs.readFileSync(arq, 'utf8'));

function compararVersoes(a, b) {
  const pa = String(a).split(/[.-]/).map(x => parseInt(x, 10) || 0), pb = String(b).split(/[.-]/).map(x => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

function traduzir(rotulo, nls) {
  const m = /^%(.+)%$/.exec(rotulo || '');
  if (!m || !nls[m[1]]) return rotulo;
  return typeof nls[m[1]] === 'string' ? nls[m[1]] : nls[m[1]].message;
}

// ------------------------------------------------------------------ zip (o .vsix), sem programa de fora

function lerZip(buf) {
  let i = buf.length - 22;
  while (i >= Math.max(0, buf.length - 65_557) && buf.readUInt32LE(i) !== 0x06054b50) i--;
  if (i < 0) throw new Error('o pacote da extensão não é um zip válido');
  const total = buf.readUInt16LE(i + 10);
  let p = buf.readUInt32LE(i + 16);
  const itens = [];
  for (let n = 0; n < total; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('o pacote da extensão está corrompido');
    const metodo = buf.readUInt16LE(p + 10), comp = buf.readUInt32LE(p + 20), tam = buf.readUInt32LE(p + 24);
    const lNome = buf.readUInt16LE(p + 28), lExtra = buf.readUInt16LE(p + 30), lCom = buf.readUInt16LE(p + 32), local = buf.readUInt32LE(p + 42);
    itens.push({ nome: buf.toString('utf8', p + 46, p + 46 + lNome), metodo, comp, tam, local });
    p += 46 + lNome + lExtra + lCom;
  }
  const dados = it => {
    const ini = it.local + 30 + buf.readUInt16LE(it.local + 26) + buf.readUInt16LE(it.local + 28);
    const bruto = buf.subarray(ini, ini + it.comp);
    if (it.metodo === 0) return bruto;
    if (it.metodo === 8) return zlib.inflateRawSync(bruto);
    throw new Error('o pacote usa uma compressão que o Engram não abre');
  };
  return itens.map(it => ({ ...it, dados: () => dados(it) }));
}

function extrairExtensao(buf, destino) {
  const itens = lerZip(buf);
  if (itens.reduce((s, it) => s + it.tam, 0) > 300 * 1024 * 1024) throw new Error('a extensão é grande demais (mais de 300 MB aberta)');
  for (const it of itens) {
    if (!it.nome.startsWith('extension/') || it.nome.endsWith('/')) continue;
    const rel = it.nome.slice('extension/'.length);
    const alvo = path.resolve(destino, rel);
    if (!alvo.startsWith(path.resolve(destino) + path.sep)) throw new Error('o pacote da extensão tem um caminho perigoso');
    fs.mkdirSync(path.dirname(alvo), { recursive: true });
    fs.writeFileSync(alvo, it.dados());
  }
  if (!fs.existsSync(path.join(destino, 'package.json'))) throw new Error('o pacote não tem o package.json da extensão');
}

// ------------------------------------------------------------------ as extensões

class Extensoes {
  constructor({ dados, cfg, salvarConfig, avisar, registrar }) {
    Object.assign(this, { cfg, salvarConfig, avisar, registrar });
    this.pasta = path.join(dados, 'extensoes');
    this.cache = null;
  }

  fontes() {
    const casa = os.homedir();
    const lista = [
      { base: this.pasta, origem: 'engram' },
      { base: path.join(casa, '.vscode', 'extensions'), origem: 'vscode' },
      { base: path.join(casa, '.vscode-insiders', 'extensions'), origem: 'vscode' },
      { base: path.join(casa, '.cursor', 'extensions'), origem: 'cursor' },
      { base: path.join(casa, '.vscode-oss', 'extensions'), origem: 'vscodium' },
    ];
    // as embutidas do VS Code instalado (resources/app/extensions, às vezes dentro de uma pasta com a versão)
    const programas = [path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code'), path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft VS Code')];
    for (const prog of programas) {
      if (!prog || !fs.existsSync(prog)) continue;
      const candidatos = [path.join(prog, 'resources', 'app', 'extensions')];
      try { for (const d of fs.readdirSync(prog, { withFileTypes: true })) if (d.isDirectory()) candidatos.push(path.join(prog, d.name, 'resources', 'app', 'extensions')); } catch { /* sem acesso */ }
      const achada = candidatos.find(c => fs.existsSync(c));
      if (achada) { lista.push({ base: achada, origem: 'embutida' }); break; }
    }
    return lista.filter(f => fs.existsSync(f.base));
  }

  /** Lê todas as extensões (a versão mais nova de cada; a do Engram vence a do VS Code, que vence a embutida). */
  escanear(forcar = false) {
    if (this.cache && !forcar && Date.now() - this.cache.em < 30_000) return this.cache.lista;
    const ordem = ['engram', 'vscode', 'cursor', 'vscodium', 'embutida'];
    const porId = new Map();
    for (const { base, origem } of this.fontes()) {
      let pastas = [];
      try { pastas = fs.readdirSync(base, { withFileTypes: true }).filter(d => d.isDirectory()); } catch { continue; }
      for (const d of pastas) {
        const raiz = path.join(base, d.name);
        let pkg;
        try { pkg = lerJsoncArquivo(path.join(raiz, 'package.json')); } catch { continue; }
        const c = pkg.contributes || {};
        const id = `${pkg.publisher || 'local'}.${pkg.name || d.name}`.toLowerCase();
        const atual = porId.get(id);
        if (atual) {
          const melhorOrigem = ordem.indexOf(origem) - ordem.indexOf(atual.origem);
          if (melhorOrigem > 0 || (melhorOrigem === 0 && compararVersoes(atual.versao, pkg.version || '0') >= 0)) continue;
        }
        let nls = {};
        try { nls = lerJsoncArquivo(path.join(raiz, 'package.nls.json')); } catch { /* sem tradução */ }
        const contribui = {
          temas: (c.themes || []).length, icones: (c.iconThemes || []).length,
          linguagens: (c.languages || []).map(l => l.id).filter(Boolean),
          gramaticas: (c.grammars || []).filter(g => g.scopeName && g.path).length,
          snippets: [...new Set((c.snippets || []).map(s => s.language).filter(Boolean))],
        };
        const util = contribui.temas || contribui.icones || contribui.gramaticas || contribui.snippets.length || contribui.linguagens.length;
        const roda = !!(pkg.main || pkg.browser || c.commands?.length || c.debuggers?.length);
        porId.set(id, {
          id, raiz, origem, pkg, nls, versao: pkg.version || '0', titulo: traduzir(pkg.displayName, nls) || pkg.name || d.name,
          descricao: traduzir(pkg.description, nls) || '', editor: pkg.publisher || '', icone: pkg.icon ? path.resolve(raiz, pkg.icon) : null,
          contribui, util: !!util, roda,
        });
      }
    }
    const lista = [...porId.values()];
    this.cache = { em: Date.now(), lista, porId };
    return lista;
  }

  get desligadas() { return new Set(this.cfg.extensoes_desligadas || []); }
  get realceVscode() { return this.cfg.codigo_realce_vscode !== false; }

  /** As extensões que valem agora: ligadas e, as embutidas do VS Code, só com o realce do VS Code ligado (menos os temas). */
  ativas({ temas = false } = {}) {
    const fora = this.desligadas;
    return this.escanear().filter(e => e.util && !fora.has(e.id) && (temas || e.origem !== 'embutida' || this.realceVscode));
  }

  urlArquivo(ext, arquivo) {
    const rel = path.relative(ext.raiz, arquivo).split(path.sep).map(encodeURIComponent).join('/');
    return `ext/${encodeURIComponent(ext.id)}/${rel}`;
  }

  /** O caminho de um arquivo servido pela tela (engram://app/ext/<id>/<rel>), só dentro da extensão. */
  arquivo(id, rel) {
    this.escanear();
    const ext = this.cache.porId.get(String(id).toLowerCase());
    if (!ext) return null;
    const alvo = path.resolve(ext.raiz, decodeURIComponent(rel || ''));
    if (!alvo.startsWith(path.resolve(ext.raiz) + path.sep) || !ARQUIVOS_SERVIDOS.test(alvo) || !fs.existsSync(alvo)) return null;
    return alvo;
  }

  resumo(e) {
    return {
      id: e.id, titulo: e.titulo, descricao: e.descricao, versao: e.versao, editor: e.editor, origem: e.origem, origemNome: ORIGENS[e.origem],
      contribui: e.contribui, roda: e.roda, ligada: !this.desligadas.has(e.id), icone: e.icone && fs.existsSync(e.icone) ? this.urlArquivo(e, e.icone) : null,
    };
  }

  // ---------------------------------------------------------------- temas

  temas() {
    const cores = [], icones = [];
    for (const e of this.ativas({ temas: true })) {
      const c = e.pkg.contributes || {};
      (c.themes || []).forEach((t, i) => {
        if (!t.path) return;
        cores.push({ id: `${e.id}#${t.id || t.label || i}`, nome: traduzir(t.label, e.nls) || t.id || `Tema ${i + 1}`, tipo: t.uiTheme === 'vs' || /light/i.test(t.uiTheme || '') ? 'claro' : t.uiTheme === 'hc-black' ? 'contraste' : 'escuro', extensao: e.titulo, origem: e.origem });
      });
      (c.iconThemes || []).forEach(t => {
        if (!t.path) return;
        icones.push({ id: `${e.id}#${t.id}`, nome: traduzir(t.label, e.nls) || t.id, extensao: e.titulo, origem: e.origem });
      });
    }
    const porNome = (a, b) => a.nome.localeCompare(b.nome, 'pt-BR');
    return { cores: cores.sort(porNome), icones: icones.sort(porNome), cor: this.cfg.codigo_tema_cores || '', icone: this.cfg.codigo_tema_icones || '' };
  }

  acharTema(id, chave) {
    const [extId, temaId] = String(id || '').split('#');
    const e = this.escanear().find(x => x.id === extId);
    if (!e) return null;
    const lista = (e.pkg.contributes || {})[chave] || [];
    const t = lista.find((x, i) => `${x.id || x.label || i}` === temaId || x.id === temaId);
    return t ? { e, t, arquivo: path.resolve(e.raiz, t.path) } : null;
  }

  temaCores(id) {
    const achado = this.acharTema(id, 'themes');
    if (!achado) return null;
    const ler = (arquivo, visto = new Set()) => {
      if (visto.has(arquivo)) return { colors: {}, tokenColors: [] };
      visto.add(arquivo);
      const j = lerJsoncArquivo(arquivo);
      let base = { colors: {}, tokenColors: [] };
      if (j.include) base = ler(path.resolve(path.dirname(arquivo), j.include), visto);
      return { name: j.name, type: j.type, colors: { ...base.colors, ...(j.colors || {}) }, tokenColors: [...base.tokenColors, ...(Array.isArray(j.tokenColors) ? j.tokenColors : [])] };
    };
    const lido = ler(achado.arquivo);
    const ui = achado.t.uiTheme || '';
    return { id, nome: traduzir(achado.t.label, achado.e.nls) || lido.name, tipo: ui === 'vs' || /light/i.test(ui) ? 'claro' : ui === 'hc-black' ? 'contraste' : 'escuro', colors: lido.colors, tokenColors: lido.tokenColors };
  }

  /** Tema de ícones no formato do VS Code, com cada ícone (imagem ou letra de fonte) pronto para a tela. */
  temaIcones(id) {
    const achado = this.acharTema(id, 'iconThemes');
    if (!achado) return null;
    const j = lerJsoncArquivo(achado.arquivo);
    const dir = path.dirname(achado.arquivo);
    const fontes = (j.fonts || []).map(f => {
      const src = (f.src || [])[0];
      return src ? { id: f.id, url: this.urlArquivo(achado.e, path.resolve(dir, src.path)), formato: src.format || 'woff', tamanho: f.size || null, peso: f.weight || 'normal' } : null;
    }).filter(Boolean);
    const defs = {};
    for (const [nome, d] of Object.entries(j.iconDefinitions || {})) {
      if (d.iconPath) defs[nome] = { url: this.urlArquivo(achado.e, path.resolve(dir, d.iconPath)) };
      else if (d.fontCharacter) {
        const hex = String(d.fontCharacter).replace(/^\\/, '');
        defs[nome] = { letra: /^[0-9a-f]{2,6}$/i.test(hex) ? String.fromCodePoint(parseInt(hex, 16)) : String(d.fontCharacter), cor: d.fontColor || null, fonte: d.fontId || fontes[0]?.id || null, tamanho: d.fontSize || null };
      }
    }
    const pegar = o => o && {
      file: o.file, folder: o.folder, folderExpanded: o.folderExpanded, rootFolder: o.rootFolder, rootFolderExpanded: o.rootFolderExpanded,
      fileExtensions: o.fileExtensions || {}, fileNames: o.fileNames || {}, folderNames: o.folderNames || {}, folderNamesExpanded: o.folderNamesExpanded || {},
      languageIds: o.languageIds || {},
    };
    return { id, nome: traduzir(achado.t.label, achado.e.nls) || achado.t.id, defs, fontes, ...pegar(j), light: pegar(j.light), setas: !j.hidesExplorerArrows };
  }

  // ---------------------------------------------------------------- linguagens, gramáticas e snippets (para o editor)

  contribuicoes() {
    const linguagens = [], gramaticas = [], snippets = [];
    for (const e of this.ativas()) {
      const c = e.pkg.contributes || {};
      for (const l of c.languages || []) {
        if (!l.id) continue;
        const conf = l.configuration ? path.resolve(e.raiz, l.configuration) : null;
        linguagens.push({ id: l.id, extensoes: l.extensions || [], nomes: l.filenames || [], aliases: (l.aliases || []).map(a => traduzir(a, e.nls)), configuracao: conf && fs.existsSync(conf) ? this.urlArquivo(e, conf) : null, origem: e.origem, extensao: e.id });
      }
      for (const g of c.grammars || []) {
        const arq = g.path ? path.resolve(e.raiz, g.path) : null;
        if (!g.scopeName || !arq || !fs.existsSync(arq)) continue;
        gramaticas.push({ escopo: g.scopeName, url: this.urlArquivo(e, arq), arquivo: path.basename(arq), linguagem: g.language || null, embutidas: g.embeddedLanguages || {}, injetarEm: g.injectTo || [], origem: e.origem });
      }
      for (const s of c.snippets || []) {
        const arq = s.path ? path.resolve(e.raiz, s.path) : null;
        if (!s.language || !arq || !fs.existsSync(arq)) continue;
        snippets.push({ linguagem: s.language, url: this.urlArquivo(e, arq), extensao: e.titulo });
      }
    }
    return { linguagens, gramaticas, snippets, realceVscode: this.realceVscode, associacoes: this.cfg.codigo_associacoes || {} };
  }

  // ---------------------------------------------------------------- loja (Open VSX)

  async buscar(texto, categoria) {
    const url = new URL(`${API}/-/search`);
    url.searchParams.set('query', texto || '');
    if (categoria) url.searchParams.set('category', categoria);
    url.searchParams.set('size', '40');
    url.searchParams.set('sortBy', texto ? 'relevance' : 'downloadCount');
    url.searchParams.set('sortOrder', 'desc');
    const r = await fetch(url, { headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error(`a loja Open VSX respondeu ${r.status}`);
    const j = await r.json();
    const instaladas = new Map(this.escanear().map(e => [e.id, e]));
    return (j.extensions || []).map(e => {
      const id = `${e.namespace}.${e.name}`.toLowerCase();
      return { id, namespace: e.namespace, nome: e.name, versao: e.version, titulo: e.displayName || e.name, descricao: e.description || '', downloads: e.downloadCount || 0, nota: e.averageRating || null, icone: e.files?.icon || null, instalada: instaladas.get(id)?.origem || null };
    });
  }

  async detalhes(namespace, nome) {
    const r = await fetch(`${API}/${encodeURIComponent(namespace)}/${encodeURIComponent(nome)}`, { headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error(`a loja Open VSX respondeu ${r.status}`);
    const e = await r.json();
    const texto = async u => { try { const t = await fetch(u); return t.ok ? await t.text() : ''; } catch { return ''; } };
    const [leiame, manifesto] = await Promise.all([e.files?.readme ? texto(e.files.readme) : '', e.files?.manifest ? texto(e.files.manifest) : '']);
    let contribui = null, roda = false;
    try {
      const pkg = lerJsonc(manifesto), c = pkg.contributes || {};
      contribui = { temas: (c.themes || []).length, icones: (c.iconThemes || []).length, linguagens: (c.languages || []).map(l => l.id).filter(Boolean), gramaticas: (c.grammars || []).length, snippets: [...new Set((c.snippets || []).map(s => s.language).filter(Boolean))] };
      roda = !!(pkg.main || pkg.browser || c.commands?.length || c.debuggers?.length);
    } catch { /* sem manifesto */ }
    const id = `${e.namespace}.${e.name}`.toLowerCase();
    const local = this.escanear().find(x => x.id === id);
    return {
      id, namespace: e.namespace, nome: e.name, titulo: e.displayName || e.name, descricao: e.description || '', versao: e.version, data: e.timestamp || null,
      licenca: e.license || '', repositorio: e.repository || '', site: e.homepage || '', categorias: e.categories || [], tags: (e.tags || []).filter(x => !/^__/.test(x)).slice(0, 12),
      downloads: e.downloadCount || 0, nota: e.averageRating || null, avaliacoes: e.reviewCount || 0, icone: e.files?.icon || null, editor: e.namespaceDisplayName || e.namespace,
      verificado: !!e.verified, leiame: leiame.slice(0, 200_000), url: `https://open-vsx.org/extension/${e.namespace}/${e.name}`, contribui, roda,
      instalada: local ? { origem: local.origem, versao: local.versao } : null,
    };
  }

  async instalar(namespace, nome) {
    const info = await (await fetch(`${API}/${encodeURIComponent(namespace)}/${encodeURIComponent(nome)}`)).json();
    if (!info.files?.download) throw new Error('essa extensão não tem arquivo para baixar');
    const id = `${namespace}.${nome}`.toLowerCase();
    const destino = path.join(this.pasta, `${id}-${info.version}`);
    const r = await fetch(info.files.download);
    if (!r.ok) throw new Error(`o download falhou (${r.status})`);
    const dados = Buffer.from(await r.arrayBuffer());
    if (info.files.sha256) {
      const esperado = (await (await fetch(info.files.sha256)).text()).trim().split(/\s+/)[0].toLowerCase();
      const obtido = crypto.createHash('sha256').update(dados).digest('hex');
      if (esperado && esperado !== obtido) throw new Error('o arquivo baixado não bate com a assinatura SHA-256 da loja: instalação cancelada');
    }
    const temp = `${destino}.parcial`;
    fs.rmSync(temp, { recursive: true, force: true });
    fs.mkdirSync(temp, { recursive: true });
    try {
      extrairExtensao(dados, temp);
      const pkg = lerJsoncArquivo(path.join(temp, 'package.json'));
      const c = pkg.contributes || {};
      if (!c.themes?.length && !c.iconThemes?.length && !c.grammars?.length && !c.snippets?.length && !c.languages?.length) {
        throw new Error('essa extensão só funciona rodando código dentro do VS Code (comandos, linter, depurador…). O Engram usa temas, ícones, linguagens, realce e snippets');
      }
      // versões antigas da mesma extensão saem
      for (const d of fs.readdirSync(this.pasta, { withFileTypes: true })) if (d.isDirectory() && d.name.startsWith(`${id}-`) && path.join(this.pasta, d.name) !== temp) fs.rmSync(path.join(this.pasta, d.name), { recursive: true, force: true });
      fs.renameSync(temp, destino);
    } catch (e) { fs.rmSync(temp, { recursive: true, force: true }); throw e; }
    this.escanear(true);
    this.avisar({ tipo: 'codigo', evento: 'extensoes' });
    const ext = this.cache.porId.get(id);
    return { ok: true, extensao: ext ? this.resumo(ext) : null };
  }

  remover(id) {
    const e = this.escanear().find(x => x.id === id);
    if (!e) throw new Error('extensão não encontrada');
    if (e.origem !== 'engram') throw new Error('essa extensão é do VS Code: dá para desligar aqui, e remover só pelo VS Code');
    fs.rmSync(e.raiz, { recursive: true, force: true });
    const muda = {};
    if (String(this.cfg.codigo_tema_cores || '').startsWith(`${id}#`)) muda.codigo_tema_cores = '';
    if (String(this.cfg.codigo_tema_icones || '').startsWith(`${id}#`)) muda.codigo_tema_icones = '';
    if (Object.keys(muda).length) { Object.assign(this.cfg, muda); this.salvarConfig(muda); }
    this.escanear(true);
    this.avisar({ tipo: 'codigo', evento: 'extensoes' });
    return { ok: true };
  }

  ajustar(muda) {
    const permitidas = ['codigo_tema_cores', 'codigo_tema_icones', 'codigo_realce_vscode', 'extensoes_desligadas', 'codigo_associacoes'];
    const limpo = Object.fromEntries(Object.entries(muda || {}).filter(([k]) => permitidas.includes(k)));
    Object.assign(this.cfg, limpo);
    this.salvarConfig(limpo);
    return { ok: true };
  }

  registrarRotas(rota) {
    rota('GET', '/api/extensoes', () => ({ lista: this.escanear(true).filter(e => e.util || e.origem === 'engram').map(e => this.resumo(e)), realceVscode: this.realceVscode, temVscode: this.fontes().some(f => f.origem === 'embutida') }));
    rota('GET', '/api/extensoes/temas', () => this.temas());
    rota('GET', '/api/extensoes/tema-cores', (_, __, q) => this.temaCores(q.get('id')));
    rota('GET', '/api/extensoes/tema-icones', (_, __, q) => this.temaIcones(q.get('id')));
    rota('GET', '/api/extensoes/contribuicoes', () => this.contribuicoes());
    rota('GET', '/api/extensoes/loja', (_, __, q) => this.buscar(q.get('texto') || '', q.get('categoria') || ''));
    rota('GET', '/api/extensoes/loja/:namespace/:nome', p => this.detalhes(p.namespace, p.nome));
    rota('POST', '/api/extensoes/instalar', (_, b) => this.instalar(String(b.namespace || ''), String(b.nome || '')));
    rota('POST', '/api/extensoes/remover', (_, b) => this.remover(String(b.id || '')));
    rota('POST', '/api/extensoes/ajustar', (_, b) => this.ajustar(b));
    rota('POST', '/api/extensoes/ligar', (_, b) => {
      const fora = this.desligadas;
      if (b.ligada) fora.delete(b.id); else fora.add(String(b.id));
      this.ajustar({ extensoes_desligadas: [...fora] });
      this.avisar({ tipo: 'codigo', evento: 'extensoes' });
      return { ok: true };
    });
    // imagens do README (capturas do tema, selos): o app busca e devolve como data: — a página não acessa a internet
    rota('GET', '/api/extensoes/imagem', async (_, __, q) => {
      const u = new URL(String(q.get('url') || ''));
      if (u.protocol !== 'https:') throw new Error('só imagens https');
      const r = await fetch(u, { redirect: 'follow' });
      const tipo = String(r.headers.get('content-type') || '').split(';')[0].trim();
      if (!r.ok || !/^image\/(png|jpe?g|gif|webp|svg\+xml)$/.test(tipo)) throw new Error('não é uma imagem');
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > 4 * 1024 * 1024) throw new Error('imagem grande demais');
      return { url: `data:${tipo};base64,${buf.toString('base64')}` };
    });
    rota('POST', '/api/extensoes/abrir-pasta', () => { fs.mkdirSync(this.pasta, { recursive: true }); require('electron').shell.openPath(this.pasta); return { ok: true }; });
  }
}

module.exports = { Extensoes, lerJsonc };
