// A vista Código: o lado "VS Code" do Engram. Explorador de arquivos, editor Monaco (o do VS Code) com abas e
// comparação de mudanças, git como o Controle de Código, terminais de verdade e a busca rápida (Ctrl+P).
// Trabalha numa pasta (a de trabalho dos agentes, ou outra que a pessoa abrir). Quando um agente mexe num
// arquivo aberto, o editor recarrega sozinho. Veio do Orbion (Lucas Lessa), que passou a fazer parte do Engram.

import { $, el, api, avisar } from "./util.js";
import { ext, PainelExtensoes, definirTemaEditor, temaTerminalVscode, pintarVista, iconeDoTema, linguagemPelasExtensoes } from "./extensoes.js";

const ic = (nome, extra = "") => el("i", { class: `codicon codicon-${nome} ${extra}`.trim() });
const nomeDe = rel => String(rel || "").split("/").pop();
const pastaDe = rel => String(rel || "").split("/").slice(0, -1).join("/");
const q = rel => encodeURIComponent(rel || "");
const erro = e => avisar({ texto: e.message || String(e), cor: "#ff6b7d", tempo: 7000 });
const ok = texto => avisar({ texto, cor: "#4ade9f" });

// ícone e cor de cada tipo de arquivo (sem tema de ícones: o próprio conjunto do VS Code, colorido)
const ICONES = [
  [/\.(m?js|cjs|jsx)$/i, "file-code", "#f1e05a"], [/\.(ts|tsx|mts)$/i, "file-code", "#4f9cf3"],
  [/\.json$/i, "json", "#e2c541"], [/\.(md|markdown)$/i, "markdown", "#5fb3d4"], [/\.sql$/i, "database", "#f0a04b"],
  [/\.py$/i, "file-code", "#5b9bd5"], [/\.html?$/i, "code", "#f0653c"], [/\.(css|scss|less)$/i, "symbol-color", "#b48cf2"],
  [/\.(png|jpe?g|gif|webp|svg|ico|bmp)$/i, "file-media", "#c08bf0"], [/\.pdf$/i, "file-pdf", "#ef5350"],
  [/\.(zip|7z|rar|gz|tar)$/i, "file-zip", "#c9a26b"], [/\.(ps1|sh|bat|cmd)$/i, "terminal", "#7ee0c3"],
  [/\.(csv|xlsx?|tsv)$/i, "table", "#4ade9f"], [/\.(ya?ml|toml|ini|cfg|conf)$/i, "settings", "#a3b1c6"],
  [/\.(txt|log)$/i, "file-text", "#a3b1c6"], [/^\.(gitignore|gitattributes|env.*|editorconfig)$/i, "gear", "#8a95aa"],
  [/\.(cs|java|go|rs|rb|php|c|cpp|h|kt|swift|vb)$/i, "file-code", "#7ee0c3"], [/\.(exe|dll|bin)$/i, "file-binary", "#8a95aa"],
];
function iconeDe(nome, { pasta = false, aberta = false } = {}) {
  const claro = ext.temaCores ? ext.temaCores.tipo === "claro" : document.documentElement.dataset.tema === "claro";
  const doTema = iconeDoTema(nome, { pasta, aberta, claro });
  if (doTema) return doTema;
  if (pasta) return el("i", { class: `codicon codicon-${aberta ? "folder-opened" : "folder"} cod-ic`, style: { color: "#e8b75a" } });
  const achado = ICONES.find(([re]) => re.test(nome));
  return el("i", { class: `codicon codicon-${achado ? achado[1] : "file"} cod-ic`, style: { color: achado ? achado[2] : "#a3b1c6" } });
}

const ROTULO_GIT = { M: "Modificado", A: "Adicionado", D: "Apagado", U: "Novo, fora do git", R: "Renomeado", "!": "Em conflito" };
const PRIORIDADE_GIT = { D: 4, M: 3, A: 2, U: 2, R: 1 };

function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

// ------------------------------------------------------------------ Monaco (carrega só quando a vista abre)

let monacoPronto = null;
function carregarMonaco() {
  if (monacoPronto) return monacoPronto;
  monacoPronto = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "monaco/vs/loader.js";
    s.onerror = () => reject(new Error("não carregou o editor"));
    s.onload = () => {
      window.require.config({ paths: { vs: "monaco/vs" } });
      window.require(["vs/editor/editor.main"], m => {
        if (!window.monaco) window.monaco = m;
        // o carregador do Monaco é AMD: sem isto, scripts UMD carregados depois se registrariam nele
        try { window.define.amd = undefined; } catch { /* segue */ }
        resolve(window.monaco);
      }, reject);
    };
    document.head.append(s);
  });
  return monacoPronto;
}

function corHex(cor) {
  const t = document.createElement("i");
  t.style.color = cor;
  document.body.append(t);
  const c = getComputedStyle(t).color;
  t.remove();
  const m = c.match(/\d+(\.\d+)?/g) || ["0", "0", "0"];
  return "#" + m.slice(0, 3).map(n => Math.round(+n).toString(16).padStart(2, "0")).join("");
}

/** As cores do editor pelo tema do Engram (quando não há tema do VS Code escolhido). */
function coresDoEngram() {
  const cs = getComputedStyle(document.documentElement);
  const tema = document.documentElement.dataset.tema || "aurora";
  const v = n => cs.getPropertyValue(n).trim();
  const canais = n => corHex(`rgb(${v(n).split(/\s+/).join(",")})`);
  const fundo = corHex(v("--codigo") || "#070a10");
  const a1 = canais("--acento1"), a2 = canais("--acento2");
  const claro = tema === "claro";
  return {
    claro, contraste: tema === "alto-contraste",
    colors: {
      "editor.background": fundo, "editorGutter.background": fundo, "minimap.background": fundo,
      "editor.lineHighlightBackground": claro ? "#0000000a" : "#ffffff09", "editor.lineHighlightBorder": "#00000000",
      "editorCursor.foreground": a2, "editor.selectionBackground": `${a1}55`, "editor.inactiveSelectionBackground": `${a1}2a`,
      "editorLineNumber.activeForeground": a2, "editorLineNumber.foreground": claro ? "#9aa3b2" : "#4a5468",
      "editorIndentGuide.activeBackground1": `${a1}88`, "scrollbarSlider.background": `${a1}33`, "scrollbarSlider.hoverBackground": `${a1}55`,
      "editorWidget.background": corHex(`rgb(${v("--superficie-alta").split(/\s+/).join(",")})`), "focusBorder": `${a1}aa`,
    },
  };
}

function temaTerminal() {
  const cs = getComputedStyle(document.documentElement);
  const v = n => cs.getPropertyValue(n).trim();
  const canais = n => `rgb(${v(n).split(/\s+/).join(",")})`;
  const fundo = corHex(v("--fundo-terminal") || "#0b0f17");
  // o texto acompanha o fundo do terminal (que fica escuro mesmo no tema claro)
  const [r, g, b] = [1, 3, 5].map(i => parseInt(fundo.slice(i, i + 2), 16) / 255);
  const escuro = 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.5;
  return { background: fundo, foreground: escuro ? "#e7ecf6" : "#1b2230", cursor: canais("--acento2"), selectionBackground: "rgba(139,123,255,.35)" };
}

// ------------------------------------------------------------------ a vista

export class VistaCodigo {
  constructor(raiz, { agentes } = {}) {
    this.raiz = raiz;
    this.agentes = agentes || (() => []); // os agentes abertos no palco (para "mandar para um agente")
    this.info = null;
    this.git = null;
    this.arvore = { abertas: new Set(), filhos: new Map(), selecionado: null };
    this.abas = [];
    this.ativa = null;
    this.lado = "arquivos";
    this.terminais = []; // { id, nome, term, fit, canal, el, vivo }
    this.termAtivo = null;
    this.painel = true;
    this.cursor = null;
    this.mensagem = "";
    this.ocupado = null;
    this.montado = false;
    this.atualizarGit = debounce(() => this.carregarGit(), 400);
    this.ext = new PainelExtensoes(this);
  }

  // ---------------------------------------------------------------- montar e ligar

  ligar() {
    if (!this.pronto) this.pronto = this.iniciar();
    else { this.editor?.layout(); this.ajustarTerminais(); }
    return this.pronto;
  }

  async iniciar() {
    this.montado = true;
    this.montar();
    try {
      await carregarMonaco();
      this.criarEditores();
      await this.ext.iniciar(window.monaco);
      this.aplicarTemas();
    } catch (e) { erro(e); }
    await this.abrirProjeto();
  }

  /** Abre um arquivo vindo de outra vista (um bloco dos Fluxos, por exemplo). */
  async abrirDeFora(rel) {
    await this.ligar();
    await this.abrirArquivo(rel);
    this.revelar(rel);
  }

  montar() {
    this.raiz.replaceChildren(
      el("div", { class: "cod" },
        el("aside", { class: "cod-lado" },
          el("div", { class: "cod-lado-abas" },
            el("button", { class: "ativo", "data-lado": "arquivos", title: "Explorador (Ctrl+Shift+E)", onclick: () => this.trocarLado("arquivos") }, ic("files"), el("span", { text: "Arquivos" })),
            el("button", { "data-lado": "git", title: "Git (Ctrl+Shift+G)", onclick: () => this.trocarLado("git") }, ic("source-control"), el("span", { text: "Git" }), el("b", { class: "cod-contador", id: "cod-contador-git" })),
            el("button", { "data-lado": "extensoes", title: "Extensões (Ctrl+Shift+X)", onclick: () => this.trocarLado("extensoes") }, ic("extensions"), el("span", { text: "Extensões" }))),
          el("div", { class: "cod-lado-corpo", id: "cod-lado-corpo" })),
        el("main", { class: "cod-centro" },
          el("div", { class: "cod-editor-caixa" },
            el("div", { class: "cod-abas", id: "cod-abas" }),
            el("div", { class: "cod-migalhas", id: "cod-migalhas", hidden: true }),
            el("div", { class: "cod-hosts" },
              el("div", { class: "cod-host", id: "cod-host-editor", hidden: true }),
              el("div", { class: "cod-host", id: "cod-host-diff", hidden: true }),
              el("div", { class: "cod-host cod-host-pagina", id: "cod-host-pagina", hidden: true }),
              el("div", { class: "cod-inicio", id: "cod-inicio" }))),
          el("div", { class: "cod-divisor", id: "cod-divisor", title: "Arraste para mudar o tamanho do terminal" }),
          el("div", { class: "cod-painel", id: "cod-painel" },
            el("div", { class: "cod-painel-topo" },
              el("span", { class: "cod-painel-titulo" }, ic("terminal"), "Terminal"),
              el("div", { class: "cod-term-abas", id: "cod-term-abas" }),
              el("span", { class: "cod-empurra" }),
              el("button", { class: "cod-bt-icone", title: "Novo terminal (Ctrl+Shift+')", onclick: () => this.novoTerminal() }, ic("add")),
              el("button", { class: "cod-bt-icone", title: "Escolher o terminal", onclick: e => this.menuShells(e.currentTarget) }, ic("chevron-down")),
              el("button", { class: "cod-bt-icone", title: "Esconder o terminal (Ctrl+')", onclick: () => this.alternarPainel(false) }, ic("close"))),
            el("div", { class: "cod-terms", id: "cod-terms" })))),
      el("footer", { class: "cod-status", id: "cod-status" }),
      el("div", { class: "cod-menu", id: "cod-menu", hidden: true }),
      el("div", { class: "cod-paleta-fundo", id: "cod-paleta", hidden: true, onmousedown: e => { if (e.target.id === "cod-paleta") this.fecharPaleta(); } },
        el("div", { class: "cod-paleta" },
          el("div", { class: "cod-paleta-campo" }, ic("search"), el("input", { id: "cod-paleta-entrada", spellcheck: "false", autocomplete: "off" })),
          el("div", { class: "cod-paleta-lista", id: "cod-paleta-lista" }))));
    this.ligarDivisor();
    document.addEventListener("mousedown", e => { if (!e.target.closest("#cod-menu")) this.fecharMenu(); });
    window.addEventListener("blur", () => this.fecharMenu());
    new ResizeObserver(debounce(() => this.ajustarTerminais(), 60)).observe($("#cod-terms"));
    new MutationObserver(() => this.aplicarTemas())
      .observe(document.documentElement, { attributes: true, attributeFilter: ["data-tema"] });
    this.desenharAbas();
    this.mostrarAba();
    this.desenharStatus();
  }

  criarEditores() {
    const monaco = window.monaco;
    definirTemaEditor(monaco, coresDoEngram());
    const opcoes = {
      fontFamily: '"Cascadia Code", "Cascadia Mono", Consolas, monospace', fontSize: 13.5, fontLigatures: true, automaticLayout: true,
      minimap: { enabled: true, renderCharacters: false }, smoothScrolling: true, cursorSmoothCaretAnimation: "on", cursorBlinking: "smooth",
      renderWhitespace: "selection", bracketPairColorization: { enabled: true }, guides: { bracketPairs: "active", indentation: true },
      stickyScroll: { enabled: true }, scrollBeyondLastLine: false, fixedOverflowWidgets: true, padding: { top: 10 }, tabSize: 2,
    };
    this.editor = monaco.editor.create($("#cod-host-editor"), { ...opcoes, model: null });
    this.diff = monaco.editor.createDiffEditor($("#cod-host-diff"), { ...opcoes, readOnly: true, originalEditable: false, renderSideBySide: true, minimap: { enabled: false } });
    this.editor.onDidChangeCursorPosition(e => { this.cursor = { linha: e.position.lineNumber, coluna: e.position.column }; this.desenharStatus(); });
    this.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => this.salvarAtiva());
    this.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyP, () => this.buscaRapida());
    this.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyP, () => this.comandos());
    this.editor.addAction({ id: "engram.tema", label: "Tema de cores…", keybindings: [monaco.KeyMod.chord(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK, monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyT)], run: () => this.ext.escolherTemaCores() });
  }

  async abrirProjeto() {
    try { this.info = await api("/api/codigo"); } catch (e) { return erro(e); }
    this.arvore = { abertas: new Set(), filhos: new Map(), selecionado: null };
    this.todos = null;
    await this.carregarPasta("");
    await this.carregarGit();
    this.desenharLado();
    this.mostrarAba();
    this.desenharStatus();
    if (!this.terminais.length && this.painel) this.mostrarPainelVazio();
  }

  async trocarPasta(caminho) {
    if (this.abas.some(a => a.sujo) && !confirm("Há arquivos com mudanças não salvas. Trocar de pasta e perder essas mudanças?")) return;
    try { await api("/api/codigo/pasta", { json: { caminho } }); } catch (e) { return erro(e); }
    for (const a of [...this.abas]) this.descartarAba(a);
    this.abas = []; this.ativa = null;
    this.desenharAbas();
    await this.abrirProjeto();
  }

  async escolherPasta() {
    try {
      const r = await api("/api/escolher-pasta", { json: { titulo: "Abrir pasta no Código" } });
      if (r.caminho) await this.trocarPasta(r.caminho);
    } catch (e) { erro(e); }
  }

  // ---------------------------------------------------------------- eventos ao vivo e teclas

  aoVivo(m) {
    if (!this.montado) return;
    if (m.evento === "fs" && m.raiz === this.info?.raiz) {
      const pastas = new Set((m.rels || []).map(pastaDe));
      for (const p of pastas) if (p === "" || this.arvore.filhos.has(p)) this.carregarPasta(p).then(() => this.lado === "arquivos" && this.desenharLado());
      for (const rel of m.rels || []) this.arquivoMudou(rel);
      this.todos = null;
      if (m.git) this.atualizarGit();
    } else if (m.evento === "extensoes") {
      this.ext.aposMudar().then(() => { this.desenharLado(); this.retokenizar(); });
    } else if (m.evento === "terminal-fim") {
      const t = this.terminais.find(x => x.id === m.id);
      if (t) { t.vivo = false; this.desenharTerminais(); }
    }
  }

  /** Atalhos quando a vista está à frente. Devolve true se tratou. */
  tecla(e) {
    const ctrl = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
    if (!$("#cod-paleta")?.hidden && e.key === "Escape") { this.fecharPaleta(); return true; }
    if (ctrl && !e.shiftKey && k === "p") { e.preventDefault(); this.buscaRapida(); return true; }
    if (ctrl && e.shiftKey && k === "p") { e.preventDefault(); this.comandos(); return true; }
    if (ctrl && !e.shiftKey && k === "s") { e.preventDefault(); this.salvarAtiva(); return true; }
    if (ctrl && !e.shiftKey && k === "w") { e.preventDefault(); if (this.ativa) this.fecharAba(this.ativa); return true; }
    if (ctrl && e.shiftKey && (e.key === "'" || e.key === '"' || e.code === "Backquote")) { e.preventDefault(); this.novoTerminal(); return true; }
    if (ctrl && !e.shiftKey && (e.key === "'" || e.code === "Backquote")) { e.preventDefault(); this.alternarPainel(); return true; }
    if (ctrl && e.shiftKey && k === "e") { e.preventDefault(); this.trocarLado("arquivos"); return true; }
    if (ctrl && e.shiftKey && k === "g") { e.preventDefault(); this.trocarLado("git"); return true; }
    if (ctrl && e.shiftKey && k === "x") { e.preventDefault(); this.trocarLado("extensoes"); return true; }
    if (ctrl && !e.shiftKey && k === "b") { e.preventDefault(); this.raiz.querySelector(".cod").classList.toggle("sem-lado"); setTimeout(() => this.editor?.layout(), 260); return true; }
    return false;
  }

  // ---------------------------------------------------------------- barra lateral

  trocarLado(lado) {
    this.lado = lado;
    for (const b of this.raiz.querySelectorAll(".cod-lado-abas button")) b.classList.toggle("ativo", b.dataset.lado === lado);
    this.raiz.querySelector(".cod").classList.remove("sem-lado");
    this.desenharLado();
  }

  desenharLado() {
    const corpo = $("#cod-lado-corpo");
    if (!corpo) return;
    corpo.replaceChildren(...[this.lado === "git" ? this.vistaGit() : this.lado === "extensoes" ? this.ext.desenhar() : this.vistaArquivos()].flat(Infinity).filter(Boolean));
    const n = this.git ? Object.keys(this.git.alterados || {}).length + Object.keys(this.git.preparados || {}).length : 0;
    const cont = $("#cod-contador-git");
    if (cont) { cont.textContent = n ? String(n) : ""; cont.hidden = !n; }
  }

  secao(titulo, conteudo, { acoes = [], contador = null, cresce = false } = {}) {
    return el("section", { class: `cod-secao${cresce ? " cresce" : ""}` },
      el("header", { class: "cod-secao-topo" },
        el("span", { class: "cod-secao-titulo", text: titulo }),
        contador ? el("span", { class: "cod-contador", text: String(contador) }) : null,
        el("span", { class: "cod-secao-acoes" }, acoes.map(([icone, dica, fn]) => el("button", { class: "cod-bt-icone", title: dica, disabled: !!this.ocupado, onclick: e => { e.stopPropagation(); fn(e); } }, ic(icone))))),
      el("div", { class: "cod-secao-corpo" }, conteudo));
  }

  // ---------------------------------------------------------------- árvore de arquivos

  async carregarPasta(rel) {
    try { this.arvore.filhos.set(rel, await api(`/api/codigo/listar?rel=${q(rel)}`)); } catch { this.arvore.filhos.delete(rel); }
  }

  async alternarPasta(rel) {
    if (this.arvore.abertas.has(rel)) this.arvore.abertas.delete(rel);
    else { this.arvore.abertas.add(rel); if (!this.arvore.filhos.has(rel)) await this.carregarPasta(rel); }
    this.desenharLado();
  }

  async revelar(rel) {
    const partes = rel.split("/");
    for (let i = 1; i < partes.length; i++) {
      const p = partes.slice(0, i).join("/");
      this.arvore.abertas.add(p);
      if (!this.arvore.filhos.has(p)) await this.carregarPasta(p);
    }
    this.arvore.selecionado = rel;
    if (this.lado === "arquivos") this.desenharLado();
  }

  async recarregarArvore() {
    await Promise.all(["", ...this.arvore.abertas].map(p => this.carregarPasta(p)));
    this.desenharLado();
  }

  gitDasPastas() {
    const mapa = new Map();
    for (const [rel, letra] of Object.entries(this.git?.arquivos || {})) {
      for (let p = pastaDe(rel); p; p = pastaDe(p)) if ((PRIORIDADE_GIT[letra] || 0) > (PRIORIDADE_GIT[mapa.get(p)] || 0)) mapa.set(p, letra);
    }
    return mapa;
  }

  linhasDaArvore(rel, nivel, pastasGit, saida) {
    const ativa = this.abaAtiva();
    for (const item of this.arvore.filhos.get(rel) || []) {
      const aberta = item.pasta && this.arvore.abertas.has(item.rel);
      const letra = item.pasta ? pastasGit.get(item.rel) : this.git?.arquivos?.[item.rel];
      const sel = this.arvore.selecionado === item.rel || (!this.arvore.selecionado && ativa?.rel === item.rel);
      saida.push(el("div", {
        class: `cod-item${sel ? " selecionado" : ""}${letra ? ` git-${letra === "!" ? "C" : letra}` : ""}`, title: item.rel,
        onclick: () => { this.arvore.selecionado = item.rel; if (item.pasta) this.alternarPasta(item.rel); else { this.abrirArquivo(item.rel); this.desenharLado(); } },
        oncontextmenu: e => this.menuItem(e, item),
      },
      Array.from({ length: nivel }, () => el("span", { class: "cod-guia" })),
      el("span", { class: "cod-seta" }, item.pasta ? ic(aberta ? "chevron-down" : "chevron-right") : null),
      iconeDe(item.nome, { pasta: item.pasta, aberta }),
      el("span", { class: "cod-item-nome", text: item.nome }),
      letra && !item.pasta ? el("span", { class: "cod-letra", title: ROTULO_GIT[letra], text: letra }) : letra ? el("span", { class: "cod-ponto-git" }) : null));
      if (aberta) this.linhasDaArvore(item.rel, nivel + 1, pastasGit, saida);
    }
    return saida;
  }

  vistaArquivos() {
    if (!this.info) return el("p", { class: "cod-texto", text: "Abrindo…" });
    const abertos = this.abas.filter(a => a.tipo === "arquivo");
    return [
      el("div", { class: "cod-projeto" },
        el("button", { class: "cod-projeto-nome", title: `${this.info.raiz}\nClique para abrir outra pasta`, onclick: e => this.menuPastas(e.currentTarget) },
          ic("folder-opened"), el("b", { text: this.info.nome }), ic("chevron-down")),
        el("span", { class: "cod-empurra" }),
        ...[["new-file", "Novo arquivo", () => this.novoItem(false)], ["new-folder", "Nova pasta", () => this.novoItem(true)],
          ["refresh", "Atualizar", () => this.recarregarArvore()], ["collapse-all", "Recolher tudo", () => { this.arvore.abertas.clear(); this.desenharLado(); }]]
          .map(([i, d, f]) => el("button", { class: "cod-bt-icone", title: d, onclick: f }, ic(i)))),
      abertos.length ? this.secao("Editores abertos", abertos.map(a => el("div", { class: `cod-item${a.id === this.ativa ? " selecionado" : ""}`, title: a.rel, onclick: () => this.ativarAba(a.id) },
        el("button", { class: "cod-bt-icone mini", title: "Fechar", onclick: e => { e.stopPropagation(); this.fecharAba(a.id); } }, ic(a.sujo ? "circle-filled" : "close")),
        iconeDe(a.titulo), el("span", { class: "cod-item-nome", text: a.titulo }), el("span", { class: "cod-item-dica", text: pastaDe(a.rel) }))), { contador: abertos.length }) : null,
      el("div", { class: "cod-arvore", oncontextmenu: e => { if (e.target.classList.contains("cod-arvore")) this.menuItem(e, { pasta: true, rel: "", nome: this.info.nome }); } },
        this.linhasDaArvore("", 0, this.gitDasPastas(), [])),
    ];
  }

  menuPastas(ancora) {
    const r = ancora.getBoundingClientRect();
    this.abrirMenu({ clientX: r.left, clientY: r.bottom + 4, preventDefault() {}, stopPropagation() {} }, [
      ["folder-opened", "Abrir outra pasta…", () => this.escolherPasta()],
      ["folder", "Mostrar no Explorador do Windows", () => api("/api/codigo/revelar", { json: { rel: "" } }).catch(erro)],
      ...(this.info.recentes.length ? ["-", ...this.info.recentes.map(p => ["history", p, () => this.trocarPasta(p)])] : []),
    ]);
  }

  menuItem(e, item) {
    const onde = item.pasta ? item.rel : pastaDe(item.rel);
    this.abrirMenu(e, [
      !item.pasta && ["go-to-file", "Abrir", () => this.abrirArquivo(item.rel)],
      !item.pasta && this.git?.arquivos?.[item.rel] && ["git-compare", "Ver mudanças", () => this.abrirDiff(item.rel)],
      ["new-file", "Novo arquivo aqui", () => this.novoItem(false, onde)],
      ["new-folder", "Nova pasta aqui", () => this.novoItem(true, onde)],
      "-",
      ["sparkle", "Mandar para um agente…", () => this.mandarParaAgente(item.rel || ".")],
      ["terminal", "Abrir terminal aqui", () => this.novoTerminal()],
      "-",
      item.rel && ["edit", "Renomear", () => this.renomear(item)],
      ["copy", "Copiar caminho relativo", () => navigator.clipboard.writeText(item.rel || ".")],
      ["copy", "Copiar caminho completo", () => navigator.clipboard.writeText(`${this.info.raiz}${item.rel ? `\\${item.rel.replace(/\//g, "\\")}` : ""}`)],
      ["folder-opened", "Mostrar no Explorador do Windows", () => api("/api/codigo/revelar", { json: { rel: item.rel } }).catch(erro)],
      !item.pasta && ["link-external", "Abrir no programa padrão", () => api("/api/codigo/externo", { json: { rel: item.rel } }).catch(erro)],
      item.rel && "-",
      item.rel && ["trash", "Mandar para a lixeira", async () => {
        if (!confirm(`Mandar "${item.nome}" para a lixeira?`)) return;
        try {
          await api("/api/codigo/lixeira", { json: { rel: item.rel } });
          for (const a of this.abas.filter(x => x.rel === item.rel || x.rel?.startsWith(`${item.rel}/`))) this.fecharAba(a.id, true);
        } catch (er) { erro(er); }
      }],
    ]);
  }

  novoItem(pasta, onde = null) {
    const sel = this.arvore.selecionado;
    const base = onde ?? (sel ? (this.arvore.filhos.has(sel) && this.arvore.abertas.has(sel) ? sel : pastaDe(sel)) : "");
    this.pedirTexto({
      placeholder: pasta ? `Nome da nova pasta${base ? ` em ${base}` : ""}` : `Nome do novo arquivo${base ? ` em ${base}` : ""}`,
      aoConfirmar: async nome => {
        const rel = [base, nome.trim().replace(/\\/g, "/")].filter(Boolean).join("/");
        try {
          await api("/api/codigo/criar", { json: { rel, pasta } });
          await this.carregarPasta(pastaDe(rel));
          await this.revelar(rel);
          if (!pasta) this.abrirArquivo(rel);
        } catch (e) { erro(e); }
      },
    });
  }

  renomear(item) {
    this.pedirTexto({
      placeholder: "Novo nome", valor: item.nome,
      aoConfirmar: async nome => {
        const para = [pastaDe(item.rel), nome.trim()].filter(Boolean).join("/");
        if (para === item.rel) return;
        if (this.abas.some(a => (a.rel === item.rel || a.rel?.startsWith(`${item.rel}/`)) && a.sujo)) return avisar({ texto: "Salve os arquivos abertos antes de renomear.", cor: "#ffc857" });
        try {
          await api("/api/codigo/renomear", { json: { de: item.rel, para } });
          for (const a of this.abas.filter(x => x.rel === item.rel || x.rel?.startsWith(`${item.rel}/`))) this.fecharAba(a.id, true);
          await this.carregarPasta(pastaDe(item.rel));
          if (!item.pasta) this.abrirArquivo(para);
          this.desenharLado();
        } catch (e) { erro(e); }
      },
    });
  }

  /** Manda um arquivo (ou pasta) para um agente aberto no palco, com o caminho completo. */
  mandarParaAgente(rel) {
    const lista = this.agentes();
    if (!lista.length) return avisar({ texto: "Não há agente aberto no palco. Crie um com + Agente.", cor: "#ffc857" });
    const caminho = `${this.info.raiz}${rel && rel !== "." ? `\\${rel.replace(/\//g, "\\")}` : ""}`;
    this.abrirPaleta({
      placeholder: "Mandar para qual agente?",
      itens: () => lista.map(a => ({ rotulo: a.nome, detalhe: a.estado, icone: "hubot", id: a.id })),
      aoEscolher: ag => setTimeout(() => this.pedirTexto({
        placeholder: `O que ${ag.rotulo} deve fazer com ${nomeDe(rel) || "esta pasta"}?`,
        aoConfirmar: async texto => {
          try {
            await api(`/api/sessoes/${ag.id}/prompt`, { json: { texto: `${texto.trim()}\n\nArquivo: ${caminho}` } });
            ok(`Mandei para ${ag.rotulo}.`);
          } catch (e) { erro(e); }
        },
      }), 0),
    });
  }

  // ---------------------------------------------------------------- abas e editor

  abaAtiva() { return this.abas.find(a => a.id === this.ativa) || null; }

  abrirAba(aba) {
    if (!this.abas.some(a => a.id === aba.id)) {
      const i = this.abas.findIndex(a => a.id === this.ativa);
      this.abas.splice(i < 0 ? this.abas.length : i + 1, 0, aba);
    }
    this.ativarAba(aba.id);
  }

  ativarAba(id) {
    const anterior = this.abaAtiva();
    if (anterior && anterior.id !== id && anterior.tipo === "arquivo" && this.editor?.getModel() === anterior.modelo) anterior.vista = this.editor.saveViewState();
    this.ativa = id;
    this.mostrarAba();
    this.desenharAbas();
    this.desenharStatus();
    if (this.lado === "arquivos") this.desenharLado();
  }

  mostrarAba() {
    const a = this.abaAtiva();
    const ed = $("#cod-host-editor"), df = $("#cod-host-diff"), ini = $("#cod-inicio"), pg = $("#cod-host-pagina");
    if (!ed) return;
    ed.hidden = df.hidden = ini.hidden = pg.hidden = true;
    this.desenharMigalhas();
    if (!a || !this.editor) { ini.hidden = false; this.desenharInicio(); return; }
    if (a.tipo === "arquivo") {
      ed.hidden = false;
      this.editor.setModel(a.modelo);
      if (a.vista) this.editor.restoreViewState(a.vista);
      const p = this.editor.getPosition();
      this.cursor = p ? { linha: p.lineNumber, coluna: p.column } : null;
      requestAnimationFrame(() => { this.editor.layout(); this.editor.focus(); });
    } else if (a.tipo === "pagina") {
      pg.hidden = false;
      a.desenhar(pg);
    } else if (a.tipo === "diff") {
      df.hidden = false;
      this.diff.setModel({ original: a.original, modified: a.modificado });
      requestAnimationFrame(() => this.diff.layout());
    }
  }

  desenharInicio() {
    const i = this.info;
    const atalho = (teclas, texto, fn) => el("button", { class: "cod-atalho", onclick: fn }, el("span", { text: texto }), el("kbd", { text: teclas }));
    $("#cod-inicio").replaceChildren(el("div", { class: "cod-inicio-miolo" },
      el("div", { class: "cod-inicio-icone" }, ic("code")),
      el("h2", { text: i ? i.nome : "Código" }),
      el("p", { class: "cod-texto", text: i ? i.raiz : "" }),
      el("div", { class: "cod-atalhos" },
        atalho("Ctrl P", "Abrir um arquivo", () => this.buscaRapida()),
        atalho("Ctrl Shift P", "Todos os comandos", () => this.comandos()),
        atalho("Ctrl '", "Terminal", () => this.alternarPainel(true)),
        atalho("Ctrl Shift G", "Git", () => this.trocarLado("git"))),
      el("div", { class: "cod-inicio-botoes" },
        el("button", { class: "btn pequeno", onclick: () => this.novoItem(false) }, ic("new-file"), " Novo arquivo"),
        el("button", { class: "btn pequeno", onclick: () => this.escolherPasta() }, ic("folder-opened"), " Abrir outra pasta")),
      i?.recentes?.length ? el("div", { class: "cod-recentes" }, el("small", { text: "Pastas recentes" }),
        i.recentes.slice(0, 5).map(p => el("button", { class: "cod-recente", title: p, onclick: () => this.trocarPasta(p) }, ic("folder"), el("span", { text: p.split(/[\\/]/).pop() }), el("small", { text: p })))) : null));
  }

  desenharAbas() {
    const caixa = $("#cod-abas");
    if (!caixa) return;
    caixa.replaceChildren(...this.abas.map(a => el("div", {
      class: `cod-aba${a.id === this.ativa ? " ativa" : ""}${a.sujo ? " suja" : ""}${a.tipo === "diff" ? " italica" : ""}`,
      title: a.rel || a.titulo, onclick: () => this.ativarAba(a.id), onauxclick: e => { if (e.button === 1) this.fecharAba(a.id); },
    }, a.tipo === "pagina" ? ic(a.icone || "file") : iconeDe(nomeDe(a.rel || a.titulo)), el("span", { class: "cod-aba-titulo", text: a.titulo }),
    el("button", { class: "cod-aba-fechar", title: "Fechar (Ctrl+W)", onclick: e => { e.stopPropagation(); this.fecharAba(a.id); } }, ic(a.sujo ? "circle-filled" : "close")))));
    caixa.querySelector(".ativa")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  desenharMigalhas() {
    const a = this.abaAtiva(), box = $("#cod-migalhas");
    if (!box) return;
    box.hidden = !a?.rel;
    if (!a?.rel) return box.replaceChildren();
    const partes = a.rel.split("/");
    box.replaceChildren(...[...partes.flatMap((p, i) => [i ? ic("chevron-right", "cod-migalha-sep") : null,
      el("span", { class: "cod-migalha" }, i === partes.length - 1 ? iconeDe(p) : null, p)]),
    a.tipo === "diff" ? el("span", { class: "cod-migalha-acoes" }, el("button", { class: "cod-bt-mini", onclick: () => this.abrirArquivo(a.rel) }, ic("go-to-file"), " Abrir o arquivo")) : null].filter(Boolean));
  }

  linguagem(nome) {
    const monaco = window.monaco;
    if (!monaco) return undefined;
    const dasExtensoes = linguagemPelasExtensoes(nome);
    if (dasExtensoes && monaco.languages.getLanguages().some(l => l.id === dasExtensoes)) return dasExtensoes;
    if (!this.mapaLing) {
      this.mapaLing = { ext: {}, nomes: {}, rotulo: {} };
      for (const l of monaco.languages.getLanguages()) {
        this.mapaLing.rotulo[l.id] = l.aliases?.[0] || l.id;
        for (const e of l.extensions || []) this.mapaLing.ext[e.toLowerCase()] ??= l.id;
        for (const f of l.filenames || []) this.mapaLing.nomes[f.toLowerCase()] ??= l.id;
      }
    }
    const n = nomeDe(nome).toLowerCase();
    if (this.mapaLing.nomes[n]) return this.mapaLing.nomes[n];
    const partes = n.split(".");
    for (let i = 1; i < partes.length; i++) { const id = this.mapaLing.ext[`.${partes.slice(i).join(".")}`]; if (id) return id; }
    return undefined;
  }

  async abrirArquivo(rel) {
    if (!this.editor) return;
    const id = `arquivo:${rel}`;
    if (this.abas.some(a => a.id === id)) return this.ativarAba(id);
    let r;
    try { r = await api(`/api/codigo/ler?rel=${q(rel)}`); } catch (e) { return erro(e); }
    if (r.binario || r.grande) {
      avisar({ texto: r.grande ? "Arquivo grande demais para o editor: abrindo no programa padrão." : "Esse arquivo não é de texto: abrindo no programa padrão.", cor: "#ffc857" });
      return api("/api/codigo/externo", { json: { rel } }).catch(erro);
    }
    const monaco = window.monaco;
    const uri = monaco.Uri.file(`${this.info.raiz}/${rel}`);
    monaco.editor.getModel(uri)?.dispose();
    const modelo = monaco.editor.createModel(r.texto, this.linguagem(rel), uri);
    const aba = { id, tipo: "arquivo", rel, titulo: nomeDe(rel), modelo, versaoSalva: modelo.getAlternativeVersionId(), sujo: false, textoDisco: r.texto };
    modelo.onDidChangeContent(() => {
      const sujo = modelo.getAlternativeVersionId() !== aba.versaoSalva;
      if (sujo !== aba.sujo) { aba.sujo = sujo; this.desenharAbas(); }
    });
    this.abrirAba(aba);
  }

  /** O antes e o depois. modo "tudo": último commit → disco; "preparado": commit → índice; "alterado": índice → disco. */
  async abrirDiff(rel, modo = "tudo") {
    if (!this.editor) return;
    const id = modo === "tudo" ? `diff:${rel}` : `diff:${modo}:${rel}`;
    const doCommit = () => api(`/api/codigo/git/original?rel=${q(rel)}`).catch(() => "");
    const doIndice = () => api(`/api/codigo/git/indice?rel=${q(rel)}`).catch(() => "");
    const doDisco = () => api(`/api/codigo/ler?rel=${q(rel)}`).then(r => r.texto ?? "").catch(() => "");
    const [original, atual] = await Promise.all(modo === "preparado" ? [doCommit(), doIndice()]
      : modo === "alterado" && this.git?.preparados?.[rel] ? [doIndice(), doDisco()] : [doCommit(), doDisco()]);
    const existente = this.abas.find(a => a.id === id);
    if (existente) { existente.original.setValue(original || ""); existente.modificado.setValue(atual || ""); return this.ativarAba(id); }
    const lang = this.linguagem(rel);
    this.abrirAba({
      id, tipo: "diff", rel, modo, titulo: `${nomeDe(rel)} (${modo === "preparado" ? "preparado" : "mudanças"})`,
      original: window.monaco.editor.createModel(original || "", lang), modificado: window.monaco.editor.createModel(atual || "", lang),
    });
  }

  /** Uma página como aba do editor (a de uma extensão, por exemplo). desenhar(host) monta o conteúdo. */
  abrirPagina({ id, titulo, icone, desenhar }) {
    const existente = this.abas.find(a => a.id === id);
    if (existente) { existente.desenhar = desenhar; return this.ativarAba(id); }
    this.abrirAba({ id, tipo: "pagina", titulo, icone, desenhar });
  }

  redesenharPagina() { const a = this.abaAtiva(); if (a?.tipo === "pagina") a.desenhar($("#cod-host-pagina")); }

  /** O tema de cores (do VS Code ou do Engram) no editor, no terminal e na vista inteira. */
  aplicarTemas() {
    pintarVista(this.raiz);
    if (window.monaco) definirTemaEditor(window.monaco, coresDoEngram());
    const vs = temaTerminalVscode();
    for (const t of this.terminais) t.term.options.theme = vs ? { ...temaTerminal(), ...vs } : temaTerminal();
    this.redesenharIcones();
  }

  redesenharIcones() { this.desenharLado(); this.desenharAbas(); this.desenharMigalhas(); }

  /** Depois que as extensões mudam: cada arquivo aberto pega a linguagem (e o realce) de novo. */
  retokenizar() {
    if (!window.monaco) return;
    this.mapaLing = null;
    for (const a of this.abas) {
      if (a.tipo !== "arquivo") continue;
      const nova = this.linguagem(a.rel) || "plaintext";
      window.monaco.editor.setModelLanguage(a.modelo, "plaintext");
      window.monaco.editor.setModelLanguage(a.modelo, nova);
    }
    this.desenharStatus();
  }

  /** Como o "Change Language Mode" do VS Code: troca a linguagem do arquivo aberto (e, se quiser, de todos com a mesma extensão). */
  escolherLinguagem() {
    const a = this.abaAtiva();
    if (a?.tipo !== "arquivo" || !window.monaco) return;
    const exts = nomeDe(a.rel).includes(".") ? `.${nomeDe(a.rel).split(".").pop().toLowerCase()}` : null;
    const atual = a.modelo.getLanguageId();
    const lista = window.monaco.languages.getLanguages().map(l => ({ rotulo: l.aliases?.[0] || l.id, detalhe: `${l.id}${l.id === atual ? " · atual" : ""}`, icone: l.id === atual ? "check" : "symbol-keyword", id: l.id }))
      .sort((x, y) => x.rotulo.localeCompare(y.rotulo, "pt-BR"));
    this.abrirPaleta({
      placeholder: `Linguagem de ${nomeDe(a.rel)}`, itens: () => lista,
      aoEscolher: it => {
        window.monaco.editor.setModelLanguage(a.modelo, it.id);
        this.desenharStatus();
        if (exts && confirm(`Usar sempre "${it.rotulo}" para os arquivos ${exts}?`)) {
          const assoc = { ...(ext.contrib?.associacoes || {}), [exts]: it.id };
          api("/api/extensoes/ajustar", { json: { codigo_associacoes: assoc } }).then(() => { if (ext.contrib) ext.contrib.associacoes = assoc; }).catch(erro);
        }
      },
    });
  }

  descartarAba(a) {
    if (a.tipo === "arquivo") { if (this.editor?.getModel() === a.modelo) this.editor.setModel(null); a.modelo.dispose(); }
    else if (a.tipo === "diff") { if (this.diff?.getModel()?.modified === a.modificado) this.diff.setModel(null); a.original.dispose(); a.modificado.dispose(); }
  }

  fecharAba(id, forcar = false) {
    const i = this.abas.findIndex(a => a.id === id);
    if (i < 0) return;
    const a = this.abas[i];
    if (a.sujo && !forcar && !confirm(`"${a.titulo}" tem mudanças que não foram salvas. Fechar e perder essas mudanças?`)) return;
    this.descartarAba(a);
    this.abas.splice(i, 1);
    if (this.ativa === id) {
      const vizinha = this.abas[i] || this.abas[i - 1];
      this.ativa = null;
      if (vizinha) return this.ativarAba(vizinha.id);
      this.mostrarAba();
    }
    this.desenharAbas();
    this.desenharStatus();
    if (this.lado === "arquivos") this.desenharLado();
  }

  async salvarAtiva() {
    const a = this.abaAtiva();
    if (!a || a.tipo !== "arquivo") return;
    try {
      const texto = a.modelo.getValue(), versao = a.modelo.getAlternativeVersionId();
      a.textoDisco = texto; // o aviso do vigia sobre este salvamento não é mudança de fora
      await api("/api/codigo/salvar", { json: { rel: a.rel, texto } });
      a.versaoSalva = versao;
      a.sujo = a.modelo.getAlternativeVersionId() !== versao; // continuou digitando enquanto salvava
      this.desenharAbas();
      this.atualizarGit();
    } catch (e) { erro(e); }
  }

  /** Um arquivo aberto mudou no disco (um agente mexeu, por exemplo): recarrega, mantendo o desfazer. */
  async arquivoMudou(rel) {
    for (const a of this.abas) {
      if (a.rel !== rel) continue;
      if (a.tipo === "diff") { this.abrirDiff(rel, a.modo || "tudo"); continue; }
      if (a.tipo !== "arquivo") continue;
      let r;
      try { r = await api(`/api/codigo/ler?rel=${q(rel)}`); } catch { continue; }
      if (r.texto == null || r.texto === a.textoDisco) continue; // nada novo (ou foi o próprio salvamento daqui)
      a.textoDisco = r.texto;
      if (r.texto === a.modelo.getValue()) continue;
      if (a.sujo) { avisar({ texto: `"${a.titulo}" mudou no disco, mas tem mudanças suas não salvas. Salvar vai sobrescrever.`, cor: "#ffc857" }); continue; }
      a.modelo.pushEditOperations([], [{ range: a.modelo.getFullModelRange(), text: r.texto }], () => null);
      a.versaoSalva = a.modelo.getAlternativeVersionId();
      a.sujo = false;
      a.mudouEm = Date.now();
    }
    this.desenharAbas();
  }

  // ---------------------------------------------------------------- git

  async carregarGit() {
    this.git = await api("/api/codigo/git").catch(() => null);
    this.desenharLado();
    this.desenharStatus();
  }

  async operacao(nome, fn, sucesso) {
    if (this.ocupado) return undefined;
    this.ocupado = nome;
    if (this.lado === "git") this.desenharLado();
    try {
      const r = await fn();
      if (sucesso) ok(typeof sucesso === "function" ? sucesso(r) : sucesso);
      return r ?? true;
    } catch (e) { erro(e); return undefined; } finally {
      this.ocupado = null;
      await this.carregarGit();
    }
  }

  gitApi(op, corpo = {}) { return api(`/api/codigo/git/${op}`, { json: corpo }); }

  async commit(depois = null) {
    const msg = this.mensagem.trim();
    if (!msg) { avisar({ texto: "Escreva a mensagem do commit (ou clique na estrela para a IA escrever).", cor: "#ffc857" }); return $("#cod-git-msg")?.focus(); }
    const g = this.git;
    let tudo = false;
    if (!Object.keys(g.preparados || {}).length) {
      if (!Object.keys(g.alterados || {}).length) return avisar({ texto: "Não há mudanças para o commit.", cor: "#ffc857" });
      if (!confirm("Nada está preparado. Preparar todas as mudanças e fazer o commit?")) return;
      tudo = true;
    }
    const ramo = g.ramo || "main";
    const r = await this.operacao("commit", () => this.gitApi("commit", { mensagem: msg, tudo }));
    if (!r?.hash) return;
    this.mensagem = "";
    ok(`Commit ${r.hash} feito em ${ramo}.`);
    if (depois === "enviar") await this.enviar();
    if (depois === "sincronizar") await this.sincronizar();
    this.desenharLado();
  }

  async mensagemComIa() {
    const r = await this.operacao("mensagem", () => this.gitApi("mensagem"));
    if (r?.mensagem) { this.mensagem = r.mensagem; this.desenharLado(); }
  }

  enviar() { return this.operacao("enviar", () => this.gitApi("enviar"), this.git?.upstream ? "Commits enviados." : "Branch publicada no servidor."); }
  sincronizar() { return this.operacao("sincronizar", () => this.gitApi("sincronizar"), "Sincronizado com o servidor."); }
  puxar() { return this.operacao("puxar", () => this.gitApi("puxar"), "Atualizado com o servidor."); }
  buscar() { return this.operacao("buscar", () => this.gitApi("buscar"), "Buscou as novidades do servidor."); }

  async descartar(rels) {
    const novos = rels.filter(r => this.git.alterados[r] === "U");
    const texto = rels.length === 1
      ? (novos.length ? `Apagar o arquivo novo ${rels[0]}? Ele vai para a lixeira.` : `Descartar as mudanças em ${rels[0]}? Isso não pode ser desfeito.`)
      : `Descartar as mudanças em ${rels.length} arquivos?${novos.length ? ` Os ${novos.length} novos vão para a lixeira.` : ""} Isso não pode ser desfeito.`;
    if (!confirm(texto)) return;
    await this.operacao("descartar", () => this.gitApi("descartar", { rels, novos }));
  }

  async escolherRamo() {
    let r;
    try { r = await api("/api/codigo/git/ramos"); } catch (e) { return erro(e); }
    const locais = new Set(r.locais.map(b => b.nome));
    this.abrirPaleta({
      placeholder: "Trocar de branch (ou criar uma)",
      itens: () => [
        { rotulo: "Criar branch…", icone: "add", id: "__criar" },
        ...r.locais.map(b => ({ rotulo: b.nome, detalhe: b.atual ? "atual" : b.upstream || "só neste computador", icone: "git-branch", id: b.nome })),
        ...r.remotos.filter(n => !locais.has(n.replace(/^[^/]+\//, ""))).map(n => ({ rotulo: n, detalhe: "no servidor", icone: "cloud", id: n })),
      ],
      aoEscolher: it => {
        if (it.id === "__criar") return setTimeout(() => this.criarRamo(), 0);
        if (it.id !== this.git?.ramo) this.operacao("ramo", () => this.gitApi("trocar-ramo", { nome: it.id }), `Agora em ${it.id.replace(/^[^/]+\//, "")}.`);
      },
    });
  }

  criarRamo() {
    this.pedirTexto({
      placeholder: `Nome da branch nova (sai de ${this.git?.ramo || "main"})`,
      aoConfirmar: nome => this.operacao("ramo", () => this.gitApi("criar-ramo", { nome }), r => `Branch ${r.nome} criada.`),
    });
  }

  async publicar() {
    if (!this.git) {
      if (!confirm("Iniciar um repositório git nesta pasta?")) return;
      if (!(await this.operacao("iniciar", () => this.gitApi("iniciar")))) return;
    }
    if (!this.git?.temCommits) {
      if (!confirm("O GitHub precisa de pelo menos um commit. Fazer o primeiro commit com todos os arquivos?")) return;
      if (!(await this.operacao("commit", () => this.gitApi("commit", { mensagem: "Primeiro commit", tudo: true })))) return;
    }
    this.abrirPaleta({
      placeholder: "Publicar no GitHub como…",
      itens: () => [
        { rotulo: "Repositório privado", detalhe: "só você e quem você convidar", icone: "lock", id: "privado" },
        { rotulo: "Repositório público", detalhe: "qualquer pessoa vê", icone: "globe", id: "publico" },
      ],
      aoEscolher: it => setTimeout(() => this.pedirTexto({
        placeholder: "Nome do repositório no GitHub", valor: (this.info.nome || "projeto").replace(/\s+/g, "-"),
        aoConfirmar: async nome => {
          const r = await this.operacao("publicar", () => this.gitApi("publicar", { nome, privado: it.id === "privado" }));
          if (r) ok(r.url ? `Publicado em ${r.url}` : "Publicado no GitHub.");
        },
      }), 0),
    });
  }

  urlGitHub() {
    const m = /github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/.exec(this.git?.remoto || "");
    return m ? `https://github.com/${m[1]}` : null;
  }

  menuGit(ancora) {
    const g = this.git, url = this.urlGitHub();
    const r = ancora.getBoundingClientRect();
    this.abrirMenu({ clientX: r.left, clientY: r.bottom + 4, preventDefault() {}, stopPropagation() {} }, [
      ["arrow-down", "Puxar (pull)", () => this.puxar()],
      ["arrow-up", g?.upstream ? "Enviar (push)" : "Publicar a branch", () => this.enviar()],
      ["sync", "Sincronizar (puxar e enviar)", () => this.sincronizar()],
      ["repo-fetch", "Buscar (fetch)", () => this.buscar()],
      "-",
      ["git-branch", "Trocar de branch…", () => this.escolherRamo()],
      ["add", "Criar branch…", () => this.criarRamo()],
      "-",
      ["check", "Commit e enviar", () => this.commit("enviar")],
      ["check-all", "Commit e sincronizar", () => this.commit("sincronizar")],
      "-",
      ["add", "Preparar tudo", () => this.operacao("preparar", () => this.gitApi("preparar", { rels: [] }))],
      ["remove", "Despreparar tudo", () => this.operacao("despreparar", () => this.gitApi("despreparar", { rels: [] }))],
      ["discard", "Descartar todas as mudanças…", () => this.descartar(Object.keys(g?.alterados || {}))],
      "-",
      url ? ["github", "Abrir no GitHub", () => api("/api/codigo/link", { json: { url } }).catch(erro)] : ["github", "Publicar no GitHub…", () => this.publicar()],
    ]);
  }

  vistaGit() {
    const g = this.git, ocupado = this.ocupado;
    const girando = nome => (ocupado === nome ? ic("loading", "codicon-modifier-spin") : null);
    if (!this.info) return el("p", { class: "cod-texto", text: "Abrindo…" });
    if (!g) {
      return el("div", { class: "cod-git-vazio" },
        el("p", { class: "cod-texto", text: "Esta pasta ainda não está no git. Com o git você vê o antes e o depois de tudo o que os agentes mudarem, e pode desfazer." }),
        el("button", { class: "btn-brilho pequeno", disabled: !!ocupado, onclick: () => this.operacao("iniciar", () => this.gitApi("iniciar"), "Repositório iniciado.") }, el("span", {}, girando("iniciar") || ic("git-commit"), " Inicializar repositório")),
        el("button", { class: "btn pequeno", disabled: !!ocupado, onclick: () => this.publicar() }, girando("publicar") || ic("github"), " Publicar no GitHub"));
    }
    const ordenar = o => Object.entries(o || {}).sort(([a], [b]) => a.localeCompare(b));
    const preparados = ordenar(g.preparados), alterados = ordenar(g.alterados);
    const letra = l => el("span", { class: "cod-letra", title: ROTULO_GIT[l], text: l });
    const linha = (rel, l, acao, acoes) => el("div", { class: `cod-item cod-item-git git-${l === "!" ? "C" : l}`, title: rel, onclick: acao },
      iconeDe(nomeDe(rel)), el("span", { class: "cod-item-nome", text: nomeDe(rel) }), el("span", { class: "cod-item-dica", text: pastaDe(rel) }),
      el("span", { class: "cod-git-acoes" }, acoes.map(([i, d, f]) => el("button", { class: "cod-bt-icone", title: d, disabled: !!ocupado, onclick: e => { e.stopPropagation(); f(); } }, ic(i)))),
      letra(l));
    const campo = el("textarea", {
      id: "cod-git-msg", rows: 1, spellcheck: "true", disabled: !!ocupado,
      placeholder: `Mensagem (Ctrl+Enter faz o commit em "${g.ramo || "main"}")`,
      oninput: e => { this.mensagem = e.target.value; e.target.style.height = "auto"; e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`; },
      onkeydown: e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this.commit(); } },
    });
    campo.value = this.mensagem;
    requestAnimationFrame(() => { campo.style.height = "auto"; campo.style.height = `${Math.min(campo.scrollHeight, 160)}px`; });
    const sync = !g.remoto
      ? el("button", { class: "btn pequeno cod-git-sync", disabled: !!ocupado || !g.temCommits, onclick: () => this.publicar() }, girando("publicar") || ic("github"), " Publicar no GitHub")
      : !g.upstream ? el("button", { class: "btn pequeno cod-git-sync", disabled: !!ocupado || !g.temCommits, onclick: () => this.enviar() }, girando("enviar") || ic("cloud-upload"), " Publicar a branch")
        : g.atras || g.frente ? el("button", { class: "btn pequeno cod-git-sync", disabled: !!ocupado, onclick: () => this.sincronizar(), title: `${g.atras} para puxar, ${g.frente} para enviar` }, girando("sincronizar") || ic("sync"), ` Sincronizar ${g.atras}↓ ${g.frente}↑`) : null;
    return [
      el("div", { class: "cod-git-topo" },
        el("button", { class: "cod-git-ramo", title: "Trocar de branch", disabled: !!ocupado, onclick: () => this.escolherRamo() }, girando("ramo") || ic("git-branch"), el("span", { text: g.ramo || "(sem branch)" }), ic("chevron-down")),
        g.upstream ? el("span", { class: "cod-git-upstream", title: "A branch no servidor" }, ic("cloud"), g.upstream) : null,
        el("span", { class: "cod-empurra" }),
        el("button", { class: "cod-bt-icone", title: "Atualizar", onclick: () => this.carregarGit() }, ic("refresh")),
        el("button", { class: "cod-bt-icone", title: "Mais ações do git", onclick: e => this.menuGit(e.currentTarget) }, ic("ellipsis"))),
      el("div", { class: "cod-git-commit" },
        el("div", { class: "cod-git-campo" }, campo,
          el("button", { class: "cod-bt-icone cod-git-ia", title: "A IA escreve a mensagem a partir das mudanças", disabled: !!ocupado, onclick: () => this.mensagemComIa() }, girando("mensagem") || ic("sparkle"))),
        el("div", { class: "cod-git-botoes" },
          el("button", { class: "btn-brilho pequeno cod-git-bt", disabled: !!ocupado || (!preparados.length && !alterados.length), onclick: () => this.commit() },
            el("span", {}, girando("commit") || ic("check"), preparados.length || !alterados.length ? " Commit" : " Commit de tudo")),
          el("button", { class: "btn pequeno cod-git-mais", title: "Commit e enviar, ou commit e sincronizar", disabled: !!ocupado, onclick: e => {
            const r = e.currentTarget.getBoundingClientRect();
            this.abrirMenu({ clientX: r.left, clientY: r.bottom + 4, preventDefault() {}, stopPropagation() {} }, [
              ["check", "Commit", () => this.commit()], ["arrow-up", "Commit e enviar", () => this.commit("enviar")], ["sync", "Commit e sincronizar", () => this.commit("sincronizar")]]);
          } }, ic("chevron-down"))),
        sync),
      preparados.length ? this.secao("Preparadas para o commit", preparados.map(([rel, l]) => linha(rel, l, () => this.abrirDiff(rel, "preparado"), [
        ["go-to-file", "Abrir o arquivo", () => this.abrirArquivo(rel)],
        ["remove", "Despreparar", () => this.operacao("despreparar", () => this.gitApi("despreparar", { rels: [rel] }))],
      ])), { contador: preparados.length, acoes: [["remove", "Despreparar tudo", () => this.operacao("despreparar", () => this.gitApi("despreparar", { rels: [] }))]] }) : null,
      this.secao("Alterações", alterados.length
        ? alterados.map(([rel, l]) => linha(rel, l, () => (l === "U" || l === "D" ? this.abrirDiff(rel) : this.abrirDiff(rel, "alterado")), [
          ["go-to-file", "Abrir o arquivo", () => this.abrirArquivo(rel)],
          ["discard", l === "U" ? "Apagar (vai para a lixeira)" : "Descartar as mudanças", () => this.descartar([rel])],
          ["add", "Preparar para o commit", () => this.operacao("preparar", () => this.gitApi("preparar", { rels: [rel] }))],
        ]))
        : el("p", { class: "cod-texto", text: preparados.length ? "O resto já está preparado." : "Nenhuma mudança desde o último commit." }), {
        contador: alterados.length, cresce: true,
        acoes: alterados.length ? [["discard", "Descartar todas", () => this.descartar(alterados.map(([rel]) => rel))], ["add", "Preparar todas", () => this.operacao("preparar", () => this.gitApi("preparar", { rels: [] }))]] : [],
      }),
    ];
  }

  // ---------------------------------------------------------------- terminais

  alternarPainel(abrir = !this.painel) {
    this.painel = abrir;
    this.raiz.querySelector(".cod")?.classList.toggle("sem-painel", !abrir);
    if (abrir && !this.terminais.length) this.novoTerminal();
    if (abrir) setTimeout(() => { this.ajustarTerminais(); this.terminais.find(t => t.id === this.termAtivo)?.term.focus(); }, 220);
    setTimeout(() => this.editor?.layout(), 240);
  }

  mostrarPainelVazio() {
    const caixa = $("#cod-terms");
    if (caixa && !this.terminais.length) caixa.replaceChildren(el("div", { class: "cod-term-vazio" },
      el("button", { class: "btn pequeno", onclick: () => this.novoTerminal() }, ic("terminal"), " Abrir um terminal nesta pasta")));
  }

  menuShells(ancora) {
    const r = ancora.getBoundingClientRect();
    this.abrirMenu({ clientX: r.left - 160, clientY: r.bottom + 4, preventDefault() {}, stopPropagation() {} },
      (this.info?.shells || []).map(s => ["terminal", s.nome, () => this.novoTerminal(s.id)]));
  }

  async novoTerminal(shell = null) {
    if (!this.painel) { this.painel = true; this.raiz.querySelector(".cod")?.classList.remove("sem-painel"); }
    let r;
    try { r = await api("/api/codigo/terminais", { json: { shell } }); } catch (e) { return erro(e); }
    const caixa = $("#cod-terms");
    caixa.querySelector(".cod-term-vazio")?.remove();
    const alvo = el("div", { class: "cod-term" });
    caixa.append(alvo);
    const term = new Terminal({ fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, monospace', fontSize: 13, lineHeight: 1.15, cursorBlink: true, scrollback: 8000, theme: { ...temaTerminal(), ...(temaTerminalVscode() || {}) } });
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(alvo);
    const t = { id: r.id, nome: r.nome, term, fit, el: alvo, vivo: true, canal: null };
    t.canal = window.engram.terminal.abrir(r.id, {
      aoInicio: () => { term.reset(); requestAnimationFrame(() => this.ajustarTerminal(t)); },
      aoDados: d => term.write(d),
      aoFim: () => { t.vivo = false; this.desenharTerminais(); },
    });
    term.onData(d => t.canal.enviar(d));
    this.terminais.push(t);
    this.ativarTerminal(t.id);
  }

  ativarTerminal(id) {
    this.termAtivo = id;
    for (const t of this.terminais) t.el.hidden = t.id !== id;
    this.desenharTerminais();
    const t = this.terminais.find(x => x.id === id);
    if (t) requestAnimationFrame(() => { this.ajustarTerminal(t); t.term.focus(); });
  }

  fecharTerminal(id) {
    const i = this.terminais.findIndex(t => t.id === id);
    if (i < 0) return;
    const t = this.terminais[i];
    try { t.canal.fechar(); } catch { /* já fechou */ }
    api(`/api/codigo/terminais/${encodeURIComponent(id)}/fechar`, { method: "POST" }).catch(() => {});
    t.term.dispose();
    t.el.remove();
    this.terminais.splice(i, 1);
    if (this.termAtivo === id) {
      const outro = this.terminais[i] || this.terminais[i - 1];
      if (outro) return this.ativarTerminal(outro.id);
      this.termAtivo = null;
      this.mostrarPainelVazio();
    }
    this.desenharTerminais();
  }

  desenharTerminais() {
    const caixa = $("#cod-term-abas");
    if (!caixa) return;
    caixa.replaceChildren(...this.terminais.map((t, i) => el("div", { class: `cod-term-aba${t.id === this.termAtivo ? " ativa" : ""}${t.vivo ? "" : " morto"}`, onclick: () => this.ativarTerminal(t.id) },
      ic("terminal"), el("span", { text: `${i + 1}: ${t.nome}` }),
      el("button", { class: "cod-aba-fechar", title: "Fechar o terminal", onclick: e => { e.stopPropagation(); this.fecharTerminal(t.id); } }, ic("close")))));
  }

  ajustarTerminal(t) {
    if (!t || t.el.hidden || !t.el.offsetWidth) return;
    try { t.fit.fit(); t.canal.tamanho(t.term.cols, t.term.rows); } catch { /* ainda sem tamanho */ }
  }

  ajustarTerminais() { this.ajustarTerminal(this.terminais.find(t => t.id === this.termAtivo)); }

  ligarDivisor() {
    const divisor = $("#cod-divisor"), painel = $("#cod-painel");
    divisor.addEventListener("pointerdown", e => {
      e.preventDefault();
      divisor.setPointerCapture(e.pointerId);
      const y0 = e.clientY, h0 = painel.offsetHeight;
      const mover = ev => { painel.style.height = `${Math.max(90, Math.min(window.innerHeight * 0.75, h0 + (y0 - ev.clientY)))}px`; };
      const soltar = () => { divisor.removeEventListener("pointermove", mover); this.ajustarTerminais(); this.editor?.layout(); };
      divisor.addEventListener("pointermove", mover);
      divisor.addEventListener("pointerup", soltar, { once: true });
    });
  }

  // ---------------------------------------------------------------- barra de status

  desenharStatus() {
    const s = $("#cod-status");
    if (!s) return;
    const g = this.git, a = this.abaAtiva();
    const idLang = a?.modelo ? a.modelo.getLanguageId() : null;
    const lang = idLang ? window.monaco?.languages.getLanguages().find(l => l.id === idLang)?.aliases?.[0] || idLang : null;
    s.replaceChildren(...[
      g ? el("button", { class: "cod-status-item", title: "Trocar de branch", onclick: () => this.escolherRamo() }, ic("git-branch"), g.ramo || "(sem branch)") : null,
      g && g.upstream && (g.atras || g.frente) ? el("button", { class: "cod-status-item", title: "Sincronizar", onclick: () => this.sincronizar() }, ic("sync"), `${g.atras}↓ ${g.frente}↑`) : null,
      g ? el("span", { class: "cod-status-item" }, ic("diff"), String(Object.keys(g.arquivos || {}).length)) : null,
      el("span", { class: "cod-empurra" }),
      a?.tipo === "arquivo" && this.cursor ? el("span", { class: "cod-status-item", text: `Ln ${this.cursor.linha}, Col ${this.cursor.coluna}` }) : null,
      lang ? el("button", { class: "cod-status-item", title: "Mudar a linguagem do arquivo", onclick: () => this.escolherLinguagem(), text: lang }) : null,
      this.info ? el("button", { class: "cod-status-item", title: this.info.raiz, onclick: e => this.menuPastas(e.currentTarget) }, ic("folder"), this.info.nome) : null,
      el("button", { class: "cod-status-item", title: "Terminal (Ctrl+')", onclick: () => this.alternarPainel() }, ic("terminal"))].filter(Boolean));
  }

  // ---------------------------------------------------------------- menu, paleta e pedir texto

  abrirMenu(e, itens) {
    e.preventDefault(); e.stopPropagation();
    const menu = $("#cod-menu");
    menu.replaceChildren(...itens.filter(Boolean).map(it => (it === "-" ? el("div", { class: "cod-menu-sep" })
      : el("button", { class: "cod-menu-item", onclick: () => { this.fecharMenu(); it[2](); } }, ic(it[0]), el("span", { text: it[1] })))));
    menu.hidden = false;
    const r = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(4, Math.min(e.clientX, innerWidth - r.width - 6))}px`;
    menu.style.top = `${Math.max(4, Math.min(e.clientY, innerHeight - r.height - 6))}px`;
  }

  fecharMenu() { const m = $("#cod-menu"); if (m) m.hidden = true; }

  /** Lista com busca, no estilo da paleta do VS Code. itens: () => [{ rotulo, detalhe, icone, id }]. */
  abrirPaleta({ placeholder, itens, aoEscolher, texto = false, valor = "", aoFocar = null, aoFechar = null }) {
    const fundo = $("#cod-paleta"), entrada = $("#cod-paleta-entrada"), lista = $("#cod-paleta-lista");
    if (!fundo.hidden) this.fecharPaleta();
    fundo.hidden = false;
    this.aoCancelarPaleta = aoFechar;
    let focoTimer = null;
    const focou = () => { if (!aoFocar || !visiveis[foco]) return; clearTimeout(focoTimer); focoTimer = setTimeout(() => aoFocar(visiveis[foco]), 140); };
    entrada.placeholder = placeholder;
    entrada.value = valor;
    let foco = 0, visiveis = [];
    const desenhar = () => {
      if (texto) { lista.replaceChildren(el("div", { class: "cod-paleta-dica", text: "Enter confirma · Esc cancela" })); return; }
      const termo = entrada.value.trim().toLowerCase();
      const todos = itens();
      visiveis = (termo ? todos.filter(it => `${it.rotulo} ${it.detalhe || ""}`.toLowerCase().includes(termo))
        .sort((a, b) => (a.rotulo.toLowerCase().startsWith(termo) ? 0 : 1) - (b.rotulo.toLowerCase().startsWith(termo) ? 0 : 1)) : todos).slice(0, 80);
      foco = Math.min(foco, Math.max(0, visiveis.length - 1));
      lista.replaceChildren(...(visiveis.length ? visiveis.map((it, i) => el("button", { class: `cod-paleta-item${i === foco ? " foco" : ""}`, onmousedown: e => { e.preventDefault(); escolher(i); } },
        it.icone ? (it.icone.startsWith("arquivo:") ? iconeDe(it.icone.slice(8)) : ic(it.icone)) : null,
        el("span", { class: "cod-paleta-rotulo", text: it.rotulo }), it.detalhe ? el("span", { class: "cod-paleta-detalhe", text: it.detalhe }) : null,
        it.tecla ? el("kbd", { text: it.tecla }) : null)) : [el("div", { class: "cod-paleta-dica", text: "Nada encontrado" })]));
      lista.querySelector(".foco")?.scrollIntoView({ block: "nearest" });
    };
    const escolher = i => {
      const v = entrada.value;
      clearTimeout(focoTimer);
      this.aoCancelarPaleta = null; // escolheu: não é cancelamento
      this.fecharPaleta();
      if (texto) { if (v.trim()) aoEscolher(v); return; }
      const it = visiveis[i];
      if (it) aoEscolher(it);
    };
    entrada.oninput = () => { foco = 0; desenhar(); };
    entrada.onkeydown = e => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); if (visiveis.length) { foco = (foco + (e.key === "ArrowDown" ? 1 : -1) + visiveis.length) % visiveis.length; desenhar(); focou(); } }
      else if (e.key === "Enter") { e.preventDefault(); escolher(foco); }
      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); this.fecharPaleta(); }
    };
    desenhar();
    requestAnimationFrame(() => { entrada.focus(); if (valor) entrada.select(); });
  }

  fecharPaleta() {
    const fundo = $("#cod-paleta");
    if (!fundo || fundo.hidden) return;
    fundo.hidden = true;
    const cancelou = this.aoCancelarPaleta;
    this.aoCancelarPaleta = null;
    cancelou?.();
    const a = this.abaAtiva();
    if (a?.tipo === "arquivo") this.editor?.focus();
  }

  pedirTexto({ placeholder, valor = "", aoConfirmar }) {
    this.abrirPaleta({ placeholder, texto: true, valor, itens: () => [], aoEscolher: aoConfirmar });
  }

  async buscaRapida() {
    if (!this.todos) { try { this.todos = await api("/api/codigo/todos"); } catch (e) { return erro(e); } }
    const recentes = this.abas.filter(a => a.tipo === "arquivo").map(a => a.rel);
    const lista = [...new Set([...recentes, ...this.todos])].map(rel => ({ rotulo: nomeDe(rel), detalhe: pastaDe(rel), icone: `arquivo:${rel}`, id: rel }));
    this.abrirPaleta({
      placeholder: "Buscar arquivo pelo nome (Ctrl+Shift+P para os comandos)",
      itens: () => lista,
      aoEscolher: it => { this.abrirArquivo(it.id); this.revelar(it.id); },
    });
  }

  comandos() {
    const lista = [
      ["Abrir arquivo…", "go-to-file", () => this.buscaRapida(), "Ctrl P"],
      ["Salvar", "save", () => this.salvarAtiva(), "Ctrl S"],
      ["Fechar a aba", "close", () => this.ativa && this.fecharAba(this.ativa), "Ctrl W"],
      ["Novo arquivo", "new-file", () => this.novoItem(false)],
      ["Nova pasta", "new-folder", () => this.novoItem(true)],
      ["Abrir outra pasta…", "folder-opened", () => this.escolherPasta()],
      ["Novo terminal", "terminal", () => this.novoTerminal(), "Ctrl Shift '"],
      ["Mostrar ou esconder o terminal", "layout-panel", () => this.alternarPainel(), "Ctrl '"],
      ["Mostrar ou esconder a barra lateral", "layout-sidebar-left", () => this.tecla({ key: "b", ctrlKey: true, preventDefault() {} }), "Ctrl B"],
      ["Git: commit", "check", () => this.commit()],
      ["Git: escrever a mensagem com a IA", "sparkle", () => this.mensagemComIa()],
      ["Git: puxar (pull)", "arrow-down", () => this.puxar()],
      ["Git: enviar (push)", "arrow-up", () => this.enviar()],
      ["Git: sincronizar", "sync", () => this.sincronizar()],
      ["Git: trocar de branch…", "git-branch", () => this.escolherRamo()],
      ["Git: criar branch…", "add", () => this.criarRamo()],
      ["Mandar o arquivo aberto para um agente…", "sparkle", () => this.abaAtiva()?.rel && this.mandarParaAgente(this.abaAtiva().rel)],
      ["Recarregar os arquivos", "refresh", () => this.recarregarArvore()],
      ["Tema de cores…", "symbol-color", () => this.ext.escolherTemaCores(), "Ctrl K Ctrl T"],
      ["Tema de ícones…", "file-media", () => this.ext.escolherTemaIcones()],
      ["Extensões: procurar na loja", "extensions", () => this.trocarLado("extensoes"), "Ctrl Shift X"],
      ["Mudar a linguagem do arquivo…", "symbol-keyword", () => this.escolherLinguagem()],
    ];
    this.abrirPaleta({
      placeholder: "Digite um comando",
      itens: () => lista.map(([rotulo, icone, , tecla], i) => ({ rotulo, icone, tecla, id: i })),
      aoEscolher: it => setTimeout(() => lista[it.id][2](), 0),
    });
  }
}
