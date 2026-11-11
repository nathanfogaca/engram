// Extensões do VS Code dentro da vista Código: a loja (Open VSX), as instaladas (no Engram, no VS Code, no
// Cursor e as embutidas no VS Code), temas de cores e de ícones, realce de sintaxe pelas gramáticas TextMate
// (o mesmo motor do VS Code: vscode-textmate + oniguruma) e snippets. Nada de código de extensão roda aqui:
// só o que elas declaram em arquivos.

import { $, el, api, avisar } from "./util.js";

const ic = (nome, extra = "") => el("i", { class: `codicon codicon-${nome} ${extra}`.trim() });
const erro = e => avisar({ texto: e.message || String(e), cor: "#ff6b7d", tempo: 7000 });
const corValida = c => typeof c === "string" && /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(c.trim());
const numero = n => (n >= 1e6 ? `${(n / 1e6).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} mi` : n >= 1e3 ? `${(n / 1e3).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} mil` : String(n || 0));

// o que a vista Código lê daqui
export const ext = { temaCores: null, temaIcones: null, contrib: null, linguagens: new Map() };

// ------------------------------------------------------------------ cores do realce (TextMate)

// quando nenhum tema do VS Code está escolhido: as cores do Dark Modern / Light Modern
const PADRAO_ESCURO = [
  ["comment", "#6A9955"], ["string", "#CE9178"], ["string.regexp", "#D16969"], ["constant.numeric", "#B5CEA8"], ["constant.language", "#569CD6"],
  ["constant.character, constant.other.placeholder", "#D7BA7D"], ["keyword", "#569CD6"], ["keyword.control", "#C586C0"], ["keyword.operator", "#D4D4D4"],
  ["keyword.operator.new, keyword.operator.expression, keyword.operator.logical.python, keyword.operator.word", "#569CD6"],
  ["storage, storage.type", "#569CD6"], ["storage.modifier", "#569CD6"], ["entity.name.function, support.function, meta.function-call.generic", "#DCDCAA"],
  ["entity.name.type, entity.name.class, support.class, support.type, entity.other.inherited-class", "#4EC9B0"],
  ["variable, meta.definition.variable.name, support.variable, entity.name.variable", "#9CDCFE"], ["variable.language", "#569CD6"],
  ["variable.other.constant, variable.other.enummember", "#4FC1FF"], ["entity.name.tag", "#569CD6"], ["entity.other.attribute-name", "#9CDCFE"],
  ["punctuation.definition.tag", "#808080"], ["support.type.property-name", "#9CDCFE"], ["meta.object-literal.key", "#9CDCFE"],
  ["markup.heading, entity.name.section", "#569CD6", "bold"], ["markup.bold", null, "bold"], ["markup.italic", null, "italic"], ["markup.inline.raw", "#CE9178"],
  ["markup.underline.link", "#4FC1FF"], ["markup.inserted", "#B5CEA8"], ["markup.deleted", "#CE9178"], ["invalid", "#F44747"],
];
const PADRAO_CLARO = [
  ["comment", "#008000"], ["string", "#A31515"], ["string.regexp", "#811F3F"], ["constant.numeric", "#098658"], ["constant.language", "#0000FF"],
  ["keyword", "#0000FF"], ["keyword.control", "#AF00DB"], ["keyword.operator", "#000000"], ["storage, storage.type", "#0000FF"],
  ["entity.name.function, support.function", "#795E26"], ["entity.name.type, entity.name.class, support.class, support.type", "#267F99"],
  ["variable, meta.definition.variable.name, support.variable", "#001080"], ["variable.other.constant", "#0070C1"], ["entity.name.tag", "#800000"],
  ["entity.other.attribute-name", "#E50000"], ["support.type.property-name", "#0451A5"], ["markup.heading, entity.name.section", "#800000", "bold"],
  ["markup.bold", null, "bold"], ["markup.italic", null, "italic"], ["markup.inline.raw", "#800000"], ["invalid", "#CD3131"],
];
const padraoTm = claro => (claro ? PADRAO_CLARO : PADRAO_ESCURO).map(([scope, foreground, fontStyle]) => ({ scope, settings: { ...(foreground ? { foreground } : {}), ...(fontStyle ? { fontStyle } : {}) } }));

/** As regras do tema (tokenColors) prontas para casar com a pilha de escopos de cada pedaço do código. */
function prepararRegras(tokenColors) {
  const regras = [];
  for (const r of tokenColors || []) {
    if (!r?.settings) continue;
    const lista = Array.isArray(r.scope) ? r.scope : String(r.scope || "").split(",");
    for (const s of lista.map(x => x.trim()).filter(Boolean)) {
      if (/\s-\s|[()|&]/.test(s)) continue; // exclusões e grupos ficam de fora
      regras.push({ partes: s.split(/\s+/).filter(p => p !== ">"), settings: r.settings });
    }
  }
  return regras;
}

const casa = (escopo, seletor) => escopo === seletor || escopo.startsWith(`${seletor}.`);

/** O estilo de uma pilha de escopos, como o VS Code faz: vale a regra que casa mais fundo e mais específica. */
function estiloDe(regras, escopos) {
  let cor = null, corNota = -1, fonte = null, fonteNota = -1;
  for (const r of regras) {
    const ult = r.partes[r.partes.length - 1];
    for (let i = escopos.length - 1; i >= 0; i--) {
      if (!casa(escopos[i], ult)) continue;
      let j = i - 1, ok = true;
      for (let k = r.partes.length - 2; k >= 0; k--) {
        while (j >= 0 && !casa(escopos[j], r.partes[k])) j--;
        if (j < 0) { ok = false; break; }
        j--;
      }
      if (!ok) continue;
      const nota = i * 10_000 + ult.split(".").length * 100 + r.partes.length;
      if (corValida(r.settings.foreground) && nota >= corNota) { cor = r.settings.foreground; corNota = nota; }
      if (typeof r.settings.fontStyle === "string" && nota >= fonteNota) { fonte = r.settings.fontStyle; fonteNota = nota; }
      break;
    }
  }
  return { cor, fonte };
}

// ------------------------------------------------------------------ o tema no Monaco

// os nomes de token das linguagens que o Monaco já conhece (sem gramática TextMate), casados com os escopos
const MAPA_MONARCH = [
  ["comment", "comment"], ["string", "string.quoted"], ["string.escape", "constant.character.escape"], ["number", "constant.numeric"],
  ["regexp", "string.regexp"], ["keyword", "keyword.control", "keyword", "storage.type"], ["operator", "keyword.operator"],
  ["delimiter", "punctuation"], ["type", "entity.name.type", "support.type", "storage.type"], ["type.identifier", "entity.name.type", "support.class"],
  ["identifier", "variable.other", "variable"], ["variable", "variable"], ["variable.predefined", "variable.language"], ["constant", "constant.language"],
  ["tag", "entity.name.tag"], ["metatag", "entity.name.tag"], ["attribute.name", "entity.other.attribute-name"], ["attribute.value", "string.quoted"],
  ["annotation", "meta.decorator", "storage.type.annotation"], ["predefined", "support.function"], ["key", "support.type.property-name"],
  ["string.key.json", "support.type.property-name.json", "support.type.property-name"], ["string.value.json", "string.quoted"],
  ["keyword.json", "constant.language"], ["number.json", "constant.numeric"], ["keyword.md", "markup.heading", "entity.name.section"],
  ["strong", "markup.bold"], ["emphasis", "markup.italic"], ["string.link.md", "markup.underline.link"], ["variable.md", "markup.inline.raw"],
];

let regrasTm = prepararRegras(padraoTm(false));
const tokensTm = new Map(); // pilha de escopos → nome do token no Monaco
const regrasMonacoTm = []; // as regras desses tokens no tema do Monaco
const tokensComRegra = new Set();

/** A cor como o Monaco aceita nas regras: 6 dígitos ("#fff" e "#ffffff80" derrubavam o tema inteiro). */
const hex6 = c => {
  const h = String(c).replace("#", "");
  return (h.length <= 4 ? h.slice(0, 3).split("").map(x => x + x).join("") : h.slice(0, 6)).toLowerCase();
};
const estiloFonte = f => String(f || "").trim().replace(/\s+/g, " ");
// o nome do token diz a cor e o estilo: o mesmo nome vale para qualquer pilha de escopos com esse resultado
const nomeToken = (cor, fonte) => `tm.${cor ? hex6(cor) : "x"}.${estiloFonte(fonte).replace(/ /g, "-") || "n"}`;
const regraToken = (cor, fonte) => ({ token: nomeToken(cor, fonte), ...(cor ? { foreground: hex6(cor) } : {}), fontStyle: estiloFonte(fonte) });

/**
 * Todas as combinações de cor e estilo que o tema pode dar, já no tema do Monaco. Antes elas entravam aos poucos,
 * a cada cor nova encontrada, e cada entrada redefinia o tema: o Monaco recoloria todos os arquivos de novo
 * (o código piscava e ficava com cores trocadas no meio do caminho).
 */
function prepararTokens() {
  tokensTm.clear();
  regrasMonacoTm.length = 0;
  tokensComRegra.clear();
  const cores = new Set([null]), fontes = new Set([null]);
  for (const r of regrasTm) {
    if (corValida(r.settings.foreground)) cores.add(hex6(r.settings.foreground));
    if (typeof r.settings.fontStyle === "string") fontes.add(estiloFonte(r.settings.fontStyle));
  }
  for (const cor of cores) for (const fonte of fontes) {
    if (cor === null && fonte === null) continue;
    const regra = regraToken(cor, fonte);
    if (tokensComRegra.has(regra.token)) continue;
    tokensComRegra.add(regra.token);
    regrasMonacoTm.push(regra);
  }
}

function tokenDe(escopos) {
  const chave = escopos.join(" ");
  let t = tokensTm.get(chave);
  if (t) return t;
  const { cor, fonte } = estiloDe(regrasTm, escopos);
  t = cor || fonte ? nomeToken(cor, fonte) : "tm.padrao";
  tokensTm.set(chave, t);
  if (t !== "tm.padrao" && !tokensComRegra.has(t)) {
    // não deveria acontecer (prepararTokens cobre todas): fica como rede de segurança
    tokensComRegra.add(t);
    regrasMonacoTm.push(regraToken(cor, fonte));
    temaSujo = true;
  }
  return t;
}

let temaSujo = false, base = null; // base: { nome, base, colors, rules } do tema atual do editor
/** Define o tema do editor. colorsEngram vem da vista Código (as cores do tema do Engram) quando não há tema do VS Code. */
export function definirTemaEditor(monaco, { claro = false, contraste = false, colorsEngram = null, colors: coresBase = {} } = {}) {
  colorsEngram = colorsEngram || coresBase;
  const t = ext.temaCores;
  const tipo = t ? t.tipo : contraste ? "contraste" : claro ? "claro" : "escuro";
  regrasTm = prepararRegras(t ? t.tokenColors : padraoTm(tipo === "claro"));
  prepararTokens();
  const regras = [];
  if (t) {
    for (const [token, ...escopos] of MAPA_MONARCH) {
      let s = { cor: null, fonte: null };
      for (const e of escopos) { const x = estiloDe(regrasTm, [e]); if (x.cor || x.fonte) { s = x; break; } }
      if (s.cor || s.fonte) regras.push({ token, ...(s.cor ? { foreground: hex6(s.cor) } : {}), ...(s.fonte ? { fontStyle: estiloFonte(s.fonte) } : {}) });
    }
  }
  const colors = {};
  for (const [k, v] of Object.entries(t ? t.colors || {} : colorsEngram)) if (corValida(v)) colors[k] = v;
  base = { base: tipo === "contraste" ? "hc-black" : tipo === "claro" ? "vs" : "vs-dark", colors, rules: regras };
  // trocar o tema já faz o Monaco recolorir os arquivos abertos, com os nomes de token do tema novo
  aplicarTema(monaco);
}

function aplicarTema(monaco) {
  if (!base) return;
  temaSujo = false;
  const tema = colors => ({ base: base.base, inherit: true, rules: [...base.rules, ...regrasMonacoTm], colors });
  try { monaco.editor.defineTheme("engram", tema(base.colors)); }
  catch {
    try { monaco.editor.defineTheme("engram", tema({})); } // uma cor da interface que o Monaco não aceita
    catch (e) { console.warn("tema do editor:", e); monaco.editor.defineTheme("engram", { base: base.base, inherit: true, rules: base.rules, colors: {} }); }
  }
  monaco.editor.setTheme("engram");
}

let temaAgendado = false;
function agendarTema(monaco) {
  if (temaAgendado) return;
  temaAgendado = true;
  setTimeout(() => { temaAgendado = false; if (temaSujo) aplicarTema(monaco); }, 300);
}

/** As cores do terminal pelo tema do VS Code (null = o terminal segue o tema do Engram). */
export function temaTerminalVscode() {
  const c = ext.temaCores?.colors;
  if (!c) return null;
  const v = (...ks) => { for (const k of ks) if (corValida(c[k])) return c[k]; return undefined; };
  const t = { background: v("terminal.background", "panel.background", "editor.background"), foreground: v("terminal.foreground", "foreground", "editor.foreground"), cursor: v("terminalCursor.foreground", "editorCursor.foreground"), selectionBackground: v("terminal.selectionBackground", "editor.selectionBackground") };
  for (const n of ["Black", "Red", "Green", "Yellow", "Blue", "Magenta", "Cyan", "White"]) {
    t[n.toLowerCase()] = v(`terminal.ansi${n}`);
    t[`bright${n}`] = v(`terminal.ansiBright${n}`);
  }
  return Object.fromEntries(Object.entries(t).filter(([, x]) => x));
}

/** As cores do tema do VS Code na vista Código inteira (lateral, abas, painel, status), ou de volta às do Engram. */
export function pintarVista(raiz) {
  const props = ["--vidro", "--vidro-forte", "--codigo", "--fundo-terminal", "--texto", "--texto-forte", "--discreto", "--apagado", "--borda", "--borda-forte"];
  for (const p of props) raiz.style.removeProperty(p);
  raiz.classList.toggle("tema-vscode", !!ext.temaCores);
  const c = ext.temaCores?.colors;
  if (!c) return;
  const v = (...ks) => { for (const k of ks) if (corValida(c[k])) return c[k]; return null; };
  const comAlfa = (cor, a) => { const h = cor.replace("#", ""); const full = h.length === 3 ? h.split("").map(x => x + x).join("") : h.slice(0, 6); return `#${full}${Math.round(a * 255).toString(16).padStart(2, "0")}`; };
  const editor = v("editor.background") || (ext.temaCores.tipo === "claro" ? "#ffffff" : "#1e1e1e");
  const lado = v("sideBar.background", "editor.background") || editor;
  const set = (p, x) => { if (x) raiz.style.setProperty(p, x); };
  set("--vidro", comAlfa(lado, 0.94));
  set("--vidro-forte", comAlfa(lado, 0.98));
  set("--codigo", editor);
  set("--fundo-terminal", v("terminal.background", "panel.background") || editor);
  set("--texto", v("foreground", "editor.foreground"));
  set("--texto-forte", v("tab.activeForeground", "editor.foreground", "foreground"));
  set("--discreto", v("descriptionForeground", "tab.inactiveForeground"));
  set("--apagado", v("disabledForeground", "editorLineNumber.foreground"));
  set("--borda", v("sideBar.border", "panel.border", "editorGroup.border", "tab.border"));
}

// ------------------------------------------------------------------ ícones

let fontesCarregadas = new Set();
function carregarFontes(t) {
  for (const f of t.fontes || []) {
    const nome = `icones-${t.id}-${f.id}`.replace(/[^a-z0-9-]/gi, "-");
    if (fontesCarregadas.has(nome)) continue;
    fontesCarregadas.add(nome);
    const estilo = document.createElement("style");
    estilo.textContent = `@font-face { font-family: "${nome}"; src: url("${f.url}") format("${f.formato}"); font-weight: ${f.peso}; font-display: block; }`;
    document.head.append(estilo);
  }
}

/** O ícone do arquivo pelo tema de ícones escolhido; null = use o ícone padrão do Engram. */
export function iconeDoTema(nome, { pasta = false, aberta = false, linguagem = null, claro = false } = {}) {
  let t = ext.temaIcones;
  if (!t) return null;
  if (claro && t.light) {
    const l = t.light, j = (a, b) => ({ ...(a || {}), ...(b || {}) });
    t = { ...t, file: l.file || t.file, folder: l.folder || t.folder, folderExpanded: l.folderExpanded || t.folderExpanded, fileExtensions: j(t.fileExtensions, l.fileExtensions), fileNames: j(t.fileNames, l.fileNames), folderNames: j(t.folderNames, l.folderNames), folderNamesExpanded: j(t.folderNamesExpanded, l.folderNamesExpanded), languageIds: j(t.languageIds, l.languageIds) };
  }
  const n = String(nome).toLowerCase();
  let id;
  if (pasta) id = aberta ? (t.folderNamesExpanded?.[n] || t.folderExpanded || t.folder) : (t.folderNames?.[n] || t.folder);
  else {
    id = t.fileNames?.[n];
    const partes = n.split(".");
    for (let i = 1; !id && i < partes.length; i++) id = t.fileExtensions?.[partes.slice(i).join(".")];
    if (!id && linguagem) id = t.languageIds?.[linguagem];
    id = id || t.file;
  }
  const d = t.defs[id] || t.defs[pasta ? t.folder : t.file];
  if (!d) return null;
  if (d.url) return el("img", { class: "cod-ic cod-ic-img", src: d.url, alt: "", draggable: "false" });
  if (d.letra) {
    const fonte = `icones-${t.id}-${d.fonte}`.replace(/[^a-z0-9-]/gi, "-");
    return el("span", { class: "cod-ic cod-ic-fonte", style: { fontFamily: `"${fonte}"`, color: d.cor || "inherit", ...(d.tamanho ? { fontSize: d.tamanho } : {}) }, text: d.letra });
  }
  return null;
}

// ------------------------------------------------------------------ realce TextMate, linguagens e snippets

let tm = null; // { vt, registro }
const gramaticas = new Map(); // escopo → { url, arquivo, linguagem, injetarEm }
let descartaveis = []; // snippets e linguagens registrados (para refazer quando as extensões mudam)

function carregarScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[data-src="${src}"]`)) return resolve();
    const s = document.createElement("script");
    s.src = src; s.dataset.src = src;
    s.onload = resolve; s.onerror = () => reject(new Error(`não carregou ${src}`));
    document.head.append(s);
  });
}

async function prepararTextmate() {
  if (tm) return tm;
  await carregarScript("modulos/vscode-oniguruma/main.js");
  await carregarScript("modulos/vscode-textmate/main.js");
  const onig = window.onig, vt = window.vscodetextmate;
  if (!onig || !vt) throw new Error("as bibliotecas de realce não carregaram");
  await onig.loadWASM(await (await fetch("modulos/vscode-oniguruma/onig.wasm")).arrayBuffer());
  const registro = new vt.Registry({
    onigLib: Promise.resolve({ createOnigScanner: p => new onig.OnigScanner(p), createOnigString: s => new onig.OnigString(s) }),
    loadGrammar: async escopo => {
      const g = gramaticas.get(escopo);
      if (!g) return null;
      try { return vt.parseRawGrammar(await (await fetch(g.url)).text(), g.arquivo); } catch { return null; }
    },
    getInjections: escopo => [...gramaticas.entries()].filter(([, g]) => (g.injetarEm || []).includes(escopo)).map(([e]) => e),
  });
  tm = { vt, registro };
  return tm;
}

class EstadoTm {
  constructor(pilha) { this.pilha = pilha; }
  clone() { return new EstadoTm(this.pilha); }
  equals(o) { return o instanceof EstadoTm && (o.pilha === this.pilha || !!o.pilha?.equals?.(this.pilha)); }
}

/**
 * O realce do VS Code para uma linguagem. Vai como fábrica: o Monaco só a chama quando aparece um arquivo dessa
 * linguagem, e ela toma o lugar do realce próprio dele (Monarch, que também é uma fábrica) de vez. Antes era
 * setTokensProvider, e o Monarch, terminando de carregar depois, passava por cima: daí os timers de 700 ms e
 * 2,5 s e as cores que às vezes ficavam erradas.
 */
function ligarGramatica(monaco, linguagem, escopo) {
  return monaco.languages.registerTokensProviderFactory(linguagem, {
    create: async () => {
      try {
        await prepararTextmate();
        const gramatica = await tm.registro.loadGrammar(escopo);
        if (!gramatica) return null;
        return {
          getInitialState: () => new EstadoTm(tm.vt.INITIAL),
          tokenize: (linha, estado) => {
            const r = gramatica.tokenizeLine(linha, estado.pilha, 500);
            const tokens = r.tokens.map(t => ({ startIndex: t.startIndex, scopes: tokenDe(t.scopes) }));
            if (temaSujo) agendarTema(monaco);
            return { endState: new EstadoTm(r.ruleStack), tokens };
          },
        };
      } catch (e) {
        console.warn(`realce de ${linguagem}:`, e);
        return null;
      }
    },
  });
}

function regex(x) {
  if (!x) return undefined;
  try { return typeof x === "string" ? new RegExp(x) : new RegExp(x.pattern, x.flags || ""); } catch { return undefined; }
}

function configuracaoMonaco(c) {
  const par = p => (Array.isArray(p) ? { open: p[0], close: p[1] } : p);
  const conf = {};
  if (c.comments) conf.comments = { lineComment: c.comments.lineComment, blockComment: c.comments.blockComment };
  if (c.brackets) conf.brackets = c.brackets;
  if (c.autoClosingPairs) conf.autoClosingPairs = c.autoClosingPairs.map(par);
  if (c.surroundingPairs) conf.surroundingPairs = c.surroundingPairs.map(par);
  if (c.wordPattern) conf.wordPattern = regex(c.wordPattern);
  if (c.indentationRules) conf.indentationRules = Object.fromEntries(Object.entries(c.indentationRules).map(([k, v]) => [k, regex(v)]).filter(([, v]) => v));
  if (c.folding?.markers) conf.folding = { markers: { start: regex(c.folding.markers.start), end: regex(c.folding.markers.end) } };
  return conf;
}

function lerJsonc(texto) {
  let s = "", em = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i], p = texto[i + 1];
    if (em) { s += c; if (c === "\\") { s += p ?? ""; i++; } else if (c === '"') em = false; }
    else if (c === '"') { em = true; s += c; }
    else if (c === "/" && p === "/") { while (i < texto.length && texto[i] !== "\n") i++; s += "\n"; }
    else if (c === "/" && p === "*") { i += 2; while (i < texto.length && !(texto[i] === "*" && texto[i + 1] === "/")) i++; i++; }
    else s += c;
  }
  return JSON.parse(s.replace(/^﻿/, "").replace(/,(\s*[}\]])/g, "$1"));
}

/** Liga (ou religa) o que as extensões ativas oferecem ao editor: linguagens, realce e snippets. */
export async function ligarContribuicoes(monaco) {
  let c;
  try { c = await api("/api/extensoes/contribuicoes"); } catch (e) { return erro(e); }
  // resposta incompleta (servidor antigo, erro no meio): segue com o que veio em vez de quebrar ("not iterable")
  c = { ...c, gramaticas: c?.gramaticas || [], linguagens: c?.linguagens || [], snippets: c?.snippets || [] };
  // só desfaz o que havia depois de ter o novo: o realce não fica sem cor enquanto a resposta não chega
  for (const d of descartaveis) try { d.dispose(); } catch { /* segue */ }
  descartaveis = [];
  gramaticas.clear();
  ext.linguagens.clear();
  ext.contrib = c;
  const conhecidas = new Set(monaco.languages.getLanguages().map(l => l.id));
  for (const g of c.gramaticas) gramaticas.set(g.escopo, g);
  const comGramatica = new Map(c.gramaticas.filter(g => g.linguagem).map(g => [g.linguagem, g.escopo]));
  for (const l of c.linguagens) {
    const atual = ext.linguagens.get(l.id) || { id: l.id, extensoes: [], nomes: [], aliases: [], gramatica: comGramatica.has(l.id) };
    atual.extensoes.push(...l.extensoes.map(x => x.toLowerCase()));
    atual.nomes.push(...l.nomes.map(x => x.toLowerCase()));
    atual.aliases.push(...l.aliases);
    ext.linguagens.set(l.id, atual);
    if (!conhecidas.has(l.id)) {
      monaco.languages.register({ id: l.id, extensions: l.extensoes, filenames: l.nomes, aliases: l.aliases });
      conhecidas.add(l.id);
      if (l.configuracao) fetch(l.configuracao).then(r => r.text()).then(t => monaco.languages.setLanguageConfiguration(l.id, configuracaoMonaco(lerJsonc(t)))).catch(() => {});
    }
  }
  for (const [linguagem, escopo] of comGramatica) descartaveis.push(ligarGramatica(monaco, linguagem, escopo));
  // o modo JSON do Monaco registra o realce dele direto, e isso vale mais que qualquer fábrica: com a gramática do
  // VS Code, só o realce dele sai (completar, erros e dobras continuam)
  const json = monaco.json?.jsonDefaults;
  if (json?.setModeConfiguration && json.modeConfiguration) {
    const proprio = !comGramatica.has("json");
    if ((json.modeConfiguration.tokens !== false) !== proprio) json.setModeConfiguration({ ...json.modeConfiguration, tokens: proprio });
  }
  // snippets: um provedor de sugestões por linguagem
  const porLinguagem = new Map();
  await Promise.all(c.snippets.map(async s => {
    try {
      const j = lerJsonc(await (await fetch(s.url)).text());
      for (const [nome, sn] of Object.entries(j)) {
        if (!sn?.body || !sn.prefix) continue;
        const linguagens = sn.scope ? sn.scope.split(",").map(x => x.trim()) : [s.linguagem];
        for (const l of linguagens) {
          if (!porLinguagem.has(l)) porLinguagem.set(l, []);
          for (const prefixo of [].concat(sn.prefix)) porLinguagem.get(l).push({ prefixo, nome, corpo: [].concat(sn.body).join("\n"), descricao: sn.description ? [].concat(sn.description).join("\n") : "", extensao: s.extensao });
        }
      }
    } catch { /* arquivo de snippets ruim: pula */ }
  }));
  for (const [linguagem, lista] of porLinguagem) {
    descartaveis.push(monaco.languages.registerCompletionItemProvider(linguagem, {
      provideCompletionItems: (modelo, pos) => {
        const p = modelo.getWordUntilPosition(pos);
        const range = { startLineNumber: pos.lineNumber, endLineNumber: pos.lineNumber, startColumn: p.startColumn, endColumn: p.endColumn };
        return { suggestions: lista.map(s => ({ label: { label: s.prefixo, description: s.nome }, kind: monaco.languages.CompletionItemKind.Snippet, insertText: s.corpo, insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, detail: `${s.descricao || s.nome} · ${s.extensao}`, documentation: { value: "```\n" + s.corpo.replace(/\$\{?\d+:?([^}]*)\}?/g, "$1") + "\n```" }, range, sortText: `~${s.prefixo}` })) };
      },
    }));
  }
  return { linguagens: ext.linguagens.size, gramaticas: comGramatica.size, snippets: porLinguagem.size };
}

/** A linguagem de um arquivo pelas extensões (associação da pessoa primeiro); null = deixe o Monaco decidir. */
export function linguagemPelasExtensoes(nome) {
  const n = String(nome).split("/").pop().toLowerCase();
  const assoc = ext.contrib?.associacoes || {};
  const partes = n.split(".");
  for (let i = 1; i < partes.length; i++) if (assoc[`.${partes.slice(i).join(".")}`]) return assoc[`.${partes.slice(i).join(".")}`];
  if (assoc[n]) return assoc[n];
  let melhor = null, tamanho = 0;
  for (const l of ext.linguagens.values()) {
    if (!l.gramatica) continue; // sem realce, o Monaco faz melhor sozinho
    if (l.nomes.includes(n)) return l.id;
    for (const e of l.extensoes) if (n.endsWith(e) && e.length > tamanho) { melhor = l.id; tamanho = e.length; }
  }
  return melhor;
}

// ------------------------------------------------------------------ a vista Extensões (barra lateral) e a página de cada uma

export class PainelExtensoes {
  constructor(vista) {
    this.vista = vista; // a VistaCodigo
    this.lista = null;
    this.temas = null;
    this.busca = "";
    this.categoria = "";
    this.resultados = null;
    this.buscando = false;
    this.instalando = new Set();
    this.fechadas = new Set(["embutida"]);
  }

  /** Na abertura: aplica os temas escolhidos e liga o realce e os snippets. */
  async iniciar(monaco) {
    await this.carregarTemas();
    const id = this.temas?.cor;
    ext.temaCores = id ? await api(`/api/extensoes/tema-cores?id=${encodeURIComponent(id)}`).catch(() => null) : null;
    const ii = this.temas?.icone;
    ext.temaIcones = ii ? await api(`/api/extensoes/tema-icones?id=${encodeURIComponent(ii)}`).catch(() => null) : null;
    if (ext.temaIcones) carregarFontes(ext.temaIcones);
    await ligarContribuicoes(monaco);
  }

  async carregarTemas() { this.temas = await api("/api/extensoes/temas").catch(() => ({ cores: [], icones: [], cor: "", icone: "" })); }
  async carregarLista() { this.lista = await api("/api/extensoes").catch(e => { erro(e); return { lista: [], realceVscode: true, temVscode: false }; }); }

  async trocarTemaCores(id, { salvar = true } = {}) {
    ext.temaCores = id ? await api(`/api/extensoes/tema-cores?id=${encodeURIComponent(id)}`).catch(e => { erro(e); return null; }) : null;
    this.vista.aplicarTemas();
    if (salvar) { await api("/api/extensoes/ajustar", { json: { codigo_tema_cores: id || "" } }).catch(erro); if (this.temas) this.temas.cor = id || ""; }
  }

  async trocarTemaIcones(id, { salvar = true } = {}) {
    ext.temaIcones = id ? await api(`/api/extensoes/tema-icones?id=${encodeURIComponent(id)}`).catch(e => { erro(e); return null; }) : null;
    if (ext.temaIcones) carregarFontes(ext.temaIcones);
    this.vista.redesenharIcones();
    if (salvar) { await api("/api/extensoes/ajustar", { json: { codigo_tema_icones: id || "" } }).catch(erro); if (this.temas) this.temas.icone = id || ""; }
  }

  /** Como o Ctrl+K Ctrl+T do VS Code: andar pela lista já mostra o tema; Esc volta ao de antes. */
  async escolherTemaCores() {
    await this.carregarTemas();
    const antes = this.temas.cor;
    const itens = [{ rotulo: "Tema do Engram", detalhe: "as cores do tema do app", icone: "color-mode", id: "" },
      ...this.temas.cores.map(t => ({ rotulo: t.nome, detalhe: `${t.tipo} · ${t.extensao}`, icone: t.id === antes ? "check" : "symbol-color", id: t.id }))];
    let escolheu = false;
    this.vista.abrirPaleta({
      placeholder: "Tema de cores (as setas já mostram como fica)", itens: () => itens,
      aoFocar: it => this.trocarTemaCores(it.id, { salvar: false }),
      aoEscolher: it => { escolheu = true; this.trocarTemaCores(it.id); },
      aoFechar: () => { if (!escolheu) this.trocarTemaCores(antes, { salvar: false }); },
    });
  }

  async escolherTemaIcones() {
    await this.carregarTemas();
    const antes = this.temas.icone;
    const itens = [{ rotulo: "Ícones do Engram", detalhe: "os ícones coloridos padrão", icone: "file-code", id: "" },
      ...this.temas.icones.map(t => ({ rotulo: t.nome, detalhe: t.extensao, icone: t.id === antes ? "check" : "file-media", id: t.id }))];
    let escolheu = false;
    this.vista.abrirPaleta({
      placeholder: "Tema de ícones", itens: () => itens,
      aoFocar: it => this.trocarTemaIcones(it.id, { salvar: false }),
      aoEscolher: it => { escolheu = true; this.trocarTemaIcones(it.id); },
      aoFechar: () => { if (!escolheu) this.trocarTemaIcones(antes, { salvar: false }); },
    });
  }

  async procurar() {
    this.buscando = true;
    this.vista.desenharLado();
    try { this.resultados = await api(`/api/extensoes/loja?texto=${encodeURIComponent(this.busca)}&categoria=${encodeURIComponent(this.categoria)}`); }
    catch (e) { erro(e); this.resultados = []; }
    this.buscando = false;
    this.vista.desenharLado();
  }

  async instalar(namespace, nome, titulo) {
    const chave = `${namespace}.${nome}`.toLowerCase();
    this.instalando.add(chave);
    this.vista.desenharLado();
    this.vista.redesenharPagina?.();
    try {
      const r = await api("/api/extensoes/instalar", { json: { namespace, nome } });
      avisar({ texto: `${titulo} instalada.`, cor: "#4ade9f" });
      await this.aposMudar();
      const c = r.extensao?.contribui;
      if (c?.temas && confirm(`${titulo} traz ${c.temas} tema${c.temas > 1 ? "s" : ""} de cores. Escolher agora?`)) this.escolherTemaCores();
      else if (c?.icones) this.escolherTemaIcones();
    } catch (e) { erro(e); }
    this.instalando.delete(chave);
    this.vista.desenharLado();
    this.vista.redesenharPagina?.();
  }

  async aposMudar() {
    await Promise.all([this.carregarLista(), this.carregarTemas()]);
    if (window.monaco) await ligarContribuicoes(window.monaco);
    if (this.resultados) for (const r of this.resultados) r.instalada = this.lista.lista.find(e => e.id === r.id)?.origem || null;
  }

  // ---------------------------------------------------------------- desenho da barra lateral

  desenhar() {
    if (!this.lista) { this.carregarLista().then(() => this.vista.desenharLado()); return el("p", { class: "cod-texto", text: "Lendo as extensões…" }); }
    const campo = el("input", {
      class: "ext-busca", type: "search", placeholder: "Procurar na loja Open VSX", value: this.busca, spellcheck: "false",
      onkeydown: e => { if (e.key === "Enter") { this.busca = e.target.value.trim(); this.procurar(); } },
    });
    const filtros = [["", "Tudo"], ["Themes", "Temas"], ["Snippets", "Snippets"], ["Programming Languages", "Linguagens"]];
    const nomeTema = (lista, id, padrao) => (id ? lista.find(t => t.id === id)?.nome || id.split("#").pop() : padrao);
    return [
      el("div", { class: "ext-topo" }, el("div", { class: "ext-campo" }, ic("search"), campo),
        el("div", { class: "ext-filtros" }, filtros.map(([v, r]) => el("button", { class: `ext-filtro${this.categoria === v ? " ativo" : ""}`, onclick: () => { this.categoria = v; if (this.busca || v) this.procurar(); else { this.resultados = null; this.vista.desenharLado(); } } }, r)))),
      this.temas ? el("div", { class: "ext-temas" },
        el("button", { class: "ext-tema", onclick: () => this.escolherTemaCores(), title: "Ctrl+K Ctrl+T" }, ic("symbol-color"), el("span", {}, el("small", { text: "Tema de cores" }), el("b", { text: nomeTema(this.temas.cores, this.temas.cor, "Tema do Engram") }))),
        el("button", { class: "ext-tema", onclick: () => this.escolherTemaIcones() }, ic("file-media"), el("span", {}, el("small", { text: "Tema de ícones" }), el("b", { text: nomeTema(this.temas.icones, this.temas.icone, "Ícones do Engram") })))) : null,
      this.resultados || this.buscando ? this.desenharResultados() : this.desenharInstaladas(),
    ];
  }

  desenharResultados() {
    const cab = el("div", { class: "ext-cab" }, el("span", { text: this.buscando ? "Procurando…" : `${this.resultados.length} na loja` }),
      el("button", { class: "cod-bt-icone", title: "Voltar às instaladas", onclick: () => { this.resultados = null; this.busca = ""; this.categoria = ""; this.vista.desenharLado(); } }, ic("close")));
    if (this.buscando) return [cab, el("div", { class: "ext-carregando" }, el("span", { class: "giro" }))];
    return [cab, ...this.resultados.map(r => {
      const chave = r.id, instalando = this.instalando.has(chave);
      return el("div", { class: "ext-item", onclick: () => this.abrirPagina(r.namespace, r.nome) },
        r.icone ? el("img", { class: "ext-icone", src: r.icone, alt: "", loading: "lazy", onerror: e => e.target.replaceWith(ic("extensions", "ext-icone-vazio")) }) : ic("extensions", "ext-icone-vazio"),
        el("div", { class: "ext-textos" },
          el("div", { class: "ext-linha1" }, el("b", { text: r.titulo }), r.nota ? el("span", { class: "ext-nota" }, ic("star-full"), r.nota.toFixed(1)) : null),
          el("div", { class: "ext-desc", text: r.descricao }),
          el("div", { class: "ext-linha3" }, el("span", { text: r.namespace }), el("span", {}, ic("cloud-download"), numero(r.downloads)),
            r.instalada ? el("span", { class: "ext-chip", text: r.instalada === "engram" ? "Instalada" : "No VS Code" })
              : el("button", { class: "ext-instalar", disabled: instalando, onclick: e => { e.stopPropagation(); this.instalar(r.namespace, r.nome, r.titulo); } }, instalando ? el("span", { class: "giro" }) : null, instalando ? " Instalando" : "Instalar"))));
    })];
  }

  desenharInstaladas() {
    const l = this.lista;
    const grupos = [["engram", "Instaladas no Engram"], ["vscode", "Do seu VS Code"], ["cursor", "Do seu Cursor"], ["vscodium", "Do seu VSCodium"], ["embutida", "Embutidas no VS Code"]];
    return [
      this.vista.lsp?.desenharCartoes(),
      l.temVscode ? el("label", { class: "ext-opcao", title: "Usa as gramáticas, linguagens e snippets que vêm com o VS Code instalado: o código fica com as mesmas cores do VS Code" },
        (() => { const i = el("input", { type: "checkbox", ...(l.realceVscode ? { checked: true } : {}), onchange: async e => { await api("/api/extensoes/ajustar", { json: { codigo_realce_vscode: e.target.checked } }).catch(erro); await this.aposMudar(); this.vista.retokenizar(); this.vista.desenharLado(); } }); return el("span", { class: "chave" }, i, el("span")); })(),
        el("span", {}, "Realce de sintaxe do VS Code instalado")) : null,
      ...grupos.map(([origem, titulo]) => {
        const itens = l.lista.filter(e => e.origem === origem);
        if (!itens.length) return null;
        const fechada = this.fechadas.has(origem);
        return el("section", { class: "cod-secao" },
          el("header", { class: "cod-secao-topo ext-grupo", onclick: () => { if (fechada) this.fechadas.delete(origem); else this.fechadas.add(origem); this.vista.desenharLado(); } },
            ic(fechada ? "chevron-right" : "chevron-down"), el("span", { class: "cod-secao-titulo", text: titulo }), el("span", { class: "cod-contador", text: String(itens.length) }),
            origem === "engram" ? el("span", { class: "cod-secao-acoes" }, el("button", { class: "cod-bt-icone", title: "Abrir a pasta das extensões", onclick: e => { e.stopPropagation(); api("/api/extensoes/abrir-pasta", { method: "POST" }).catch(erro); } }, ic("folder-opened"))) : null),
          fechada ? null : el("div", { class: "cod-secao-corpo" }, itens.map(e => this.itemInstalado(e))));
      }),
      l.lista.some(e => e.origem === "engram") ? null : el("p", { class: "cod-texto ext-dica", text: "Procure acima temas (Dracula, One Dark, Material…), ícones e linguagens. Elas ficam guardadas no Engram, sem mexer no seu VS Code." }),
    ];
  }

  itemInstalado(e) {
    const c = e.contribui, chips = [];
    if (c.temas) chips.push(`${c.temas} tema${c.temas > 1 ? "s" : ""}`);
    if (c.icones) chips.push("ícones");
    if (c.gramaticas) chips.push(`realce: ${c.linguagens.slice(0, 3).join(", ") || "sim"}`);
    if (c.snippets.length) chips.push(`snippets: ${c.snippets.slice(0, 3).join(", ")}`);
    return el("div", { class: `ext-item instalada${e.ligada ? "" : " desligada"}`, title: e.descricao, onclick: () => { const [ns, ...n] = e.id.split("."); this.abrirPagina(ns, n.join("."), e); } },
      e.icone ? el("img", { class: "ext-icone", src: e.icone, alt: "" }) : ic("extensions", "ext-icone-vazio"),
      el("div", { class: "ext-textos" },
        el("div", { class: "ext-linha1" }, el("b", { text: e.titulo }), el("small", { text: e.versao })),
        el("div", { class: "ext-chips" }, chips.length ? chips.map(t => el("span", { class: "ext-chip", text: t })) : el("span", { class: "ext-chip fora", text: e.roda ? "roda código: não funciona aqui" : "nada que o Engram use" }))),
      el("span", { class: "ext-acoes" },
        el("button", { class: "cod-bt-icone", title: e.ligada ? "Desligar" : "Ligar", onclick: async ev => { ev.stopPropagation(); await api("/api/extensoes/ligar", { json: { id: e.id, ligada: !e.ligada } }).catch(erro); await this.aposMudar(); this.vista.retokenizar(); this.vista.desenharLado(); } }, ic(e.ligada ? "debug-pause" : "play")),
        e.origem === "engram" ? el("button", { class: "cod-bt-icone", title: "Remover", onclick: async ev => { ev.stopPropagation(); if (!confirm(`Remover ${e.titulo}?`)) return; await api("/api/extensoes/remover", { json: { id: e.id } }).catch(erro); await this.aposMudar(); if (!this.temas.cor) this.trocarTemaCores("", { salvar: false }); if (!this.temas.icone) this.trocarTemaIcones("", { salvar: false }); this.vista.desenharLado(); } }, ic("trash")) : null));
  }

  // ---------------------------------------------------------------- a página de uma extensão (aba no editor)

  abrirPagina(namespace, nome, local = null) {
    this.vista.abrirPagina({
      id: `extensao:${namespace}.${nome}`.toLowerCase(), titulo: local?.titulo || nome, icone: "extensions",
      desenhar: async host => {
        host.replaceChildren(el("div", { class: "ext-pagina-carregando" }, el("span", { class: "giro" })));
        let d = null;
        if (local?.origem === "embutida" || local?.origem && local.origem !== "engram" && !navigator.onLine) d = null;
        else d = await api(`/api/extensoes/loja/${encodeURIComponent(namespace)}/${encodeURIComponent(nome)}`).catch(() => null);
        host.replaceChildren(this.pagina(d, local, namespace, nome));
      },
    });
  }

  pagina(d, local, namespace, nome) {
    const c = d?.contribui || local?.contribui;
    const instalada = d?.instalada || (local ? { origem: local.origem, versao: local.versao } : null);
    const instalando = this.instalando.has(`${namespace}.${nome}`.toLowerCase());
    const md = window.markdownit ? window.markdownit({ html: false, linkify: true }) : null;
    const leiame = el("div", { class: "ext-leiame" });
    if (d?.leiame && md) {
      // monta fora da página (documento inerte: nada carrega) e só depois insere, já sem endereços externos
      const doc = new DOMParser().parseFromString(md.render(d.leiame), "text/html");
      for (const s of doc.querySelectorAll("script, style, iframe, object, embed, form")) s.remove();
      const imagens = [];
      for (const img of doc.querySelectorAll("img")) {
        const src = img.getAttribute("src") || "";
        img.removeAttribute("src");
        img.removeAttribute("srcset");
        if (/^https:\/\//.test(src) && imagens.length < 16) { img.dataset.origem = src; img.classList.add("ext-img-carregando"); imagens.push(img); }
        else img.replaceWith(Object.assign(doc.createElement("span"), { className: "ext-img-fora", textContent: img.alt ? `[imagem: ${img.alt}]` : "" }));
      }
      leiame.append(...doc.body.childNodes);
      for (const a of leiame.querySelectorAll("a[href]")) { const u = a.getAttribute("href"); a.onclick = ev => { ev.preventDefault(); if (/^https:\/\//.test(u)) api("/api/codigo/link", { json: { url: u } }).catch(() => {}); }; }
      // as imagens vêm pelo app (que busca e devolve como data:)
      for (const img of leiame.querySelectorAll("img[data-origem]")) {
        api(`/api/extensoes/imagem?url=${encodeURIComponent(img.dataset.origem)}`)
          .then(r => { img.src = r.url; img.classList.remove("ext-img-carregando"); })
          .catch(() => img.replaceWith(el("span", { class: "ext-img-fora", text: img.alt ? `[imagem: ${img.alt}]` : "" })));
      }
    } else leiame.append(el("p", { class: "cod-texto", text: local ? (local.descricao || "Extensão instalada neste computador.") : "Sem descrição." }));
    const funciona = [];
    if (c) {
      if (c.temas) funciona.push(["symbol-color", `${c.temas} tema${c.temas > 1 ? "s" : ""} de cores`]);
      if (c.icones) funciona.push(["file-media", "tema de ícones"]);
      if (c.gramaticas) funciona.push(["symbol-keyword", `realce de sintaxe${c.linguagens.length ? `: ${c.linguagens.join(", ")}` : ""}`]);
      if (c.snippets.length) funciona.push(["symbol-snippet", `snippets: ${c.snippets.join(", ")}`]);
    }
    const roda = d?.roda || local?.roda;
    const botoes = [];
    if (!instalada && d) botoes.push(el("button", { class: "btn-brilho pequeno", disabled: instalando || !funciona.length, onclick: () => this.instalar(namespace, nome, d.titulo) }, el("span", {}, instalando ? el("span", { class: "giro" }) : ic("cloud-download"), instalando ? " Instalando…" : " Instalar")));
    if (instalada && c?.temas) botoes.push(el("button", { class: "btn pequeno", onclick: () => this.escolherTemaCores() }, ic("symbol-color"), " Escolher o tema de cores"));
    if (instalada && c?.icones) botoes.push(el("button", { class: "btn pequeno", onclick: () => this.escolherTemaIcones() }, ic("file-media"), " Escolher o tema de ícones"));
    if (d?.url) botoes.push(el("button", { class: "btn pequeno", onclick: () => api("/api/codigo/link", { json: { url: d.url } }).catch(erro) }, ic("link-external"), " Ver na Open VSX"));
    return el("div", { class: "ext-pagina" },
      el("div", { class: "ext-pagina-topo" },
        d?.icone ? el("img", { class: "ext-pagina-icone", src: d.icone, alt: "" }) : local?.icone ? el("img", { class: "ext-pagina-icone", src: local.icone, alt: "" }) : el("div", { class: "ext-pagina-icone vazio" }, ic("extensions")),
        el("div", { class: "ext-pagina-titulos" },
          el("h1", { text: d?.titulo || local?.titulo || nome }),
          el("div", { class: "ext-pagina-meta" },
            el("span", {}, d?.verificado ? ic("verified-filled") : null, d?.editor || namespace),
            d ? el("span", {}, ic("cloud-download"), `${numero(d.downloads)} downloads`) : null,
            d?.nota ? el("span", {}, ic("star-full"), `${d.nota.toFixed(1)} (${d.avaliacoes})`) : null,
            el("span", { text: `v${instalada?.versao || d?.versao || "?"}` }),
            d?.licenca ? el("span", { text: d.licenca }) : null,
            instalada ? el("span", { class: "ext-chip", text: { engram: "Instalada no Engram", vscode: "Do seu VS Code", cursor: "Do seu Cursor", vscodium: "Do seu VSCodium", embutida: "Embutida no VS Code" }[instalada.origem] }) : null),
          el("p", { class: "ext-pagina-desc", text: d?.descricao || local?.descricao || "" }),
          el("div", { class: "ext-pagina-botoes" }, botoes))),
      el("div", { class: "ext-funciona" },
        el("h3", { text: "O que funciona no Engram" }),
        funciona.length ? el("ul", {}, funciona.map(([i, t]) => el("li", {}, ic(i), t))) : el("p", { class: "cod-texto", text: "Nada: essa extensão só funciona rodando código dentro do VS Code." }),
        roda ? el("p", { class: "ext-aviso" }, ic("info"), "Ela também tem partes que rodam código (comandos, linter, depurador…). Essas ficam de fora: o Engram não roda código de extensões.") : null),
      d?.tags?.length ? el("div", { class: "ext-tags" }, d.tags.map(t => el("span", { class: "ext-chip", text: t }))) : null,
      leiame);
  }
}
