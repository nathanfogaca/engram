// O painel de prévia, como os artefatos do Claude: desliza da direita sobre qualquer vista e mostra o
// resultado pronto do que os agentes criam. HTML rodando de verdade (numa caixa isolada), imagens, vídeo,
// áudio, PDF, Markdown e CSV. Alterna entre Prévia e Código, recarrega sozinho quando o arquivo muda, guarda
// as últimas versões (dá para ver e restaurar), tem tamanhos de tela e mostra os erros do console da página.
// Qualquer vista abre com: window.dispatchEvent(new CustomEvent("engram:previa", { detail: origem })),
// com origem = { raiz: "p", rel } (pasta do projeto) ou { raiz: "a", sessao, qual, nome } (arquivos de um agente).

import { $, el, api, avisar } from "./util.js";

const ic = (nome, extra = "") => el("i", { class: `codicon codicon-${nome} ${extra}`.trim() });
const erro = e => avisar({ texto: e.message || String(e), cor: "#ff6b7d", tempo: 7000 });
const PREVISUALIZAVEL = /\.(html?|svg|png|jpe?g|gif|webp|avif|bmp|ico|mp4|m4v|webm|ogv|mov|mp3|wav|ogg|oga|m4a|flac|pdf|md|markdown|csv|tsv)$/i;
export const temPrevia = nome => PREVISUALIZAVEL.test(String(nome || ""));

const ICONE = { html: "globe", svg: "symbol-color", imagem: "file-media", video: "device-camera-video", audio: "unmute", pdf: "file-pdf", markdown: "markdown", tabela: "table" };
const LINGUAGEM = { html: "html", svg: "xml", markdown: "markdown", tabela: "plaintext" };
const TELAS = [["computador", "device-desktop", null, "Tela cheia"], ["tablet", "device-mobile", [820, 1180], "Tablet (820 × 1180)"], ["celular", "device-mobile", [390, 844], "Celular (390 × 844)"]];
// no navegador, tablet e celular também "se apresentam" como tablet e celular (sites que olham o aparelho)
const AGENTE = {
  tablet: "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  celular: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
};
const chaveDe = o => (o.url ? `u:${o.url}` : o.raiz === "a" ? `a:${o.sessao}:${o.qual}:${o.nome}` : `p:${o.rel}`);
const consulta = o => new URLSearchParams(o.raiz === "a" ? { raiz: "a", sessao: o.sessao, qual: o.qual, nome: o.nome } : { raiz: "p", rel: o.rel }).toString();

/** CSV/TSV simples (aspas, separador adivinhado), até 2.000 linhas. */
function lerTabela(texto, nome) {
  const primeira = texto.split(/\r?\n/, 1)[0] || "";
  const sep = /\.tsv$/i.test(nome) ? "\t" : [";", ",", "\t", "|"].map(s => [s, primeira.split(s).length]).sort((a, b) => b[1] - a[1])[0][0];
  const linhas = [];
  let campo = "", linha = [], aspas = false;
  for (let i = 0; i < texto.length && linhas.length < 2001; i++) {
    const c = texto[i];
    if (aspas) { if (c === '"' && texto[i + 1] === '"') { campo += '"'; i++; } else if (c === '"') aspas = false; else campo += c; continue; }
    if (c === '"') aspas = true;
    else if (c === sep) { linha.push(campo); campo = ""; }
    else if (c === "\n") { linha.push(campo.replace(/\r$/, "")); linhas.push(linha); linha = []; campo = ""; }
    else campo += c;
  }
  if (campo || linha.length) { linha.push(campo); linhas.push(linha); }
  return linhas;
}

export class PainelPrevia {
  constructor() {
    this.origem = null;
    this.info = null;
    this.modo = "previa"; // previa | codigo
    this.tela = "computador";
    this.versoes = new Map(); // chave → [{ texto, quando }]
    this.vendo = null; // índice da versão vista (null = a atual)
    this.erros = [];
    this.sozinha = (() => { try { return localStorage.getItem("engram.previa.sozinha") !== "nao"; } catch { return true; } })();
    this.largura = (() => { try { return Number(localStorage.getItem("engram.previa.largura")) || 0; } catch { return 0; } })();
    this.montar();
    window.addEventListener("engram:previa", e => this.abrir(e.detail));
    window.addEventListener("engram:navegador", e => (e.detail?.url ? this.navegar(e.detail.url) : this.pedirEndereco()));
    window.addEventListener("message", e => this.mensagem(e));
    document.addEventListener("keydown", e => { if (e.key === "Escape" && this.aberto && !e.target.closest?.("input, textarea, .monaco-editor, .xterm, dialog")) this.fechar(); });
  }

  get aberto() { return !this.el.hidden; }

  montar() {
    this.el = el("aside", { class: "previa", id: "previa", hidden: true },
      el("div", { class: "previa-alca", title: "Arraste para mudar a largura" }),
      el("div", { class: "previa-topo", id: "previa-topo" }),
      el("div", { class: "previa-barra", id: "previa-barra" }),
      el("div", { class: "previa-corpo", id: "previa-corpo" }),
      el("div", { class: "previa-console", id: "previa-console", hidden: true }));
    document.body.append(this.el);
    if (this.largura) this.el.style.width = `${this.largura}px`;
    const alca = this.el.querySelector(".previa-alca");
    alca.addEventListener("pointerdown", e => {
      e.preventDefault();
      alca.setPointerCapture(e.pointerId);
      this.el.classList.add("redimensionando");
      const mover = ev => { this.largura = Math.max(360, Math.min(innerWidth - 120, innerWidth - ev.clientX - 14)); this.el.style.width = `${this.largura}px`; };
      alca.addEventListener("pointermove", mover);
      alca.addEventListener("pointerup", () => {
        alca.removeEventListener("pointermove", mover);
        this.el.classList.remove("redimensionando");
        try { localStorage.setItem("engram.previa.largura", String(this.largura)); } catch { /* sem armazenamento */ }
      }, { once: true });
    });
  }

  /** Abre (ou troca) o arquivo do painel. */
  async abrir(origem, { sozinha = false } = {}) {
    if (!origem) return;
    if (sozinha && !this.sozinha) return;
    if (origem.url) return this.navegar(origem.url);
    // aberto sozinho (um agente entregou) não rouba a vez de quem está olhando outra prévia mexer
    const outra = this.aberto && this.origem && chaveDe(this.origem) !== chaveDe(origem);
    this.origem = origem;
    this.vendo = null;
    this.erros = [];
    this.modo = "previa";
    this.el.hidden = false;
    requestAnimationFrame(() => this.el.classList.add("visivel"));
    if (outra || !this.info) this.mostrarCarregando();
    await this.carregar();
    api("/api/previa/vigiar", { json: { origem } }).catch(() => {});
  }

  /** O navegador da prévia: o site rodando no seu computador (localhost) ou qualquer endereço. */
  navegar(url) {
    url = String(url || "").trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
    try { localStorage.setItem("engram.previa.endereco", url); } catch { /* sem armazenamento */ }
    const jaNavegando = this.info?.tipo === "navegador" && this.webview?.isConnected;
    this.origem = { url };
    this.info = { tipo: "navegador", nome: url, url };
    this.urlAtual = url;
    this.modo = "previa"; this.vendo = null; this.erros = [];
    this.el.hidden = false;
    requestAnimationFrame(() => this.el.classList.add("visivel"));
    api("/api/previa/vigiar", { json: { origem: null } }).catch(() => {});
    this.garantirWebview();
    if (jaNavegando && this.webviewPronto) this.webview.loadURL(url).catch(() => {});
    else this.webview.setAttribute("src", url);
    this.desenhar();
  }

  /** Pergunta o endereço (com o último usado já preenchido) e abre no navegador da prévia. */
  pedirEndereco() {
    let ultimo = "http://localhost:3000";
    try { ultimo = localStorage.getItem("engram.previa.endereco") || ultimo; } catch { /* sem armazenamento */ }
    if (this.info?.tipo === "navegador" && this.webview) { this.el.querySelector(".previa-endereco")?.focus(); return; }
    // abre o navegador com a barra de endereço pronta para digitar (Enter abre)
    this.origem = { url: "" };
    this.info = { tipo: "navegador", nome: "", url: "" };
    this.urlAtual = ultimo;
    this.erros = [];
    this.el.hidden = false;
    requestAnimationFrame(() => this.el.classList.add("visivel"));
    api("/api/previa/vigiar", { json: { origem: null } }).catch(() => {});
    this.desenhar();
    requestAnimationFrame(() => { const c = this.el.querySelector(".previa-endereco"); c?.focus(); c?.select(); });
  }

  garantirWebview() {
    if (this.webview) return;
    const wv = document.createElement("webview");
    wv.className = "previa-webview";
    wv.setAttribute("partition", "persist:engram-navegador");
    if (AGENTE[this.tela]) wv.setAttribute("useragent", AGENTE[this.tela]);
    wv.addEventListener("dom-ready", () => { this.webviewPronto = true; });
    wv.addEventListener("did-navigate", e => this.aoNavegar(e.url));
    wv.addEventListener("did-navigate-in-page", e => { if (e.isMainFrame) this.aoNavegar(e.url); });
    wv.addEventListener("did-start-loading", () => { this.carregandoPagina = true; this.erros = []; this.atualizarEndereco(); this.atualizarSelo(); });
    wv.addEventListener("did-stop-loading", () => { this.carregandoPagina = false; this.atualizarEndereco(); });
    wv.addEventListener("did-fail-load", e => {
      if (!e.isMainFrame || e.errorCode === -3) return; // -3: navegação cancelada (normal)
      this.erros.push({ tipo: "erro", texto: `Não abriu ${e.validatedURL || ""}: ${e.errorDescription} (${e.errorCode}). O servidor está rodando?` });
      this.atualizarSelo();
    });
    wv.addEventListener("console-message", e => {
      const nivel = typeof e.level === "string" ? e.level : ["verbose", "info", "warning", "error"][e.level] || "info";
      if (nivel !== "warning" && nivel !== "error") return;
      if (this.erros.length < 200) this.erros.push({ tipo: nivel === "error" ? "erro" : "aviso", texto: `${e.message}${e.sourceId ? ` (${String(e.sourceId).split("/").pop()}:${e.line})` : ""}` });
      this.atualizarSelo();
    });
    wv.addEventListener("page-title-updated", e => { this.tituloPagina = e.title; this.atualizarEndereco(); });
    this.webview = wv;
    this.molduraNav = el("div", { class: "previa-moldura" }, wv);
    this.palcoNav = el("div", { class: "previa-palco navegador" }, this.molduraNav);
    new ResizeObserver(() => this.ajustarEscala()).observe(this.palcoNav);
  }

  aoNavegar(url) { this.urlAtual = url; this.atualizarEndereco(); }

  // o histórico do navegador (o Electron novo guarda em navigationHistory; o antigo, no próprio webview)
  historico(acao) {
    const wv = this.webview;
    if (!wv || !this.webviewPronto) return false;
    try {
      const h = wv.navigationHistory;
      if (h && typeof h[acao] === "function") return h[acao]();
      return typeof wv[acao] === "function" ? wv[acao]() : false;
    } catch { return false; }
  }

  atualizarEndereco() {
    const campo = this.el.querySelector(".previa-endereco");
    if (campo && document.activeElement !== campo) campo.value = this.urlAtual || "";
    const icone = this.el.querySelector(".previa-endereco-caixa > .codicon");
    if (icone) icone.className = `codicon codicon-${this.carregandoPagina ? "loading codicon-modifier-spin" : /^https:/.test(this.urlAtual || "") ? "lock" : "globe"}`;
    const titulo = this.el.querySelector(".previa-titulo-pagina");
    if (titulo) titulo.textContent = this.tituloPagina || "";
    for (const [bt, acao] of [[".previa-voltar", "canGoBack"], [".previa-avancar", "canGoForward"]]) {
      const b = this.el.querySelector(bt);
      if (b) b.disabled = !this.historico(acao);
    }
  }

  /** Tablet e celular: a moldura do aparelho cabe no painel (diminui, sem rolar). */
  ajustarEscala() {
    const palco = this.el.querySelector(".previa-palco.aparelho");
    const moldura = palco?.querySelector(".previa-moldura");
    if (!moldura) return;
    const tam = TELAS.find(t => t[0] === this.tela)?.[2];
    if (!tam) { moldura.style.transform = ""; return; }
    const escala = Math.min(1, (palco.clientWidth - 48) / tam[0], (palco.clientHeight - 48) / tam[1]);
    moldura.style.transform = `scale(${Math.max(0.2, escala)})`;
    const dim = this.el.querySelector(".previa-escala");
    if (dim) dim.textContent = escala < 1 ? `${Math.round(escala * 100)}%` : "";
  }

  trocarTela(id) {
    this.tela = id;
    if (this.info?.tipo === "navegador" && this.webview) {
      const ua = AGENTE[id] || navigator.userAgent.replace(/\s*(Electron|engram)\/\S+/gi, "");
      if (this.webviewPronto) { try { this.webview.setUserAgent(ua); this.webview.reload(); } catch { /* ainda abrindo */ } }
      else if (AGENTE[id]) this.webview.setAttribute("useragent", ua); else this.webview.removeAttribute("useragent");
    }
    this.desenhar();
  }

  desenharNavegador() {
    const botao = (icone, titulo, fn, extra = "") => el("button", { class: `previa-bt ${extra}`.trim(), title: titulo, onclick: fn }, ic(icone));
    const endereco = el("input", { class: "previa-endereco", value: this.urlAtual || this.info.url, spellcheck: "false", placeholder: "http://localhost:3000",
      onkeydown: e => { if (e.key === "Enter") { e.preventDefault(); this.navegar(e.target.value); } else if (e.key === "Escape") { e.stopPropagation(); e.target.blur(); } },
      onfocus: e => e.target.select() });
    $("#previa-topo").replaceChildren(
      el("div", { class: "previa-icone" }, ic("browser")),
      el("div", { class: "previa-navegacao" },
        botao("arrow-left", "Voltar", () => this.historico("canGoBack") && this.historico("goBack"), "previa-voltar"),
        botao("arrow-right", "Avançar", () => this.historico("canGoForward") && this.historico("goForward"), "previa-avancar"),
        botao("refresh", "Recarregar", () => this.webview?.reload()),
        el("div", { class: "previa-endereco-caixa" }, ic("globe"), endereco)),
      botao("close", "Fechar (Esc)", () => this.fechar(), "fechar"));
    const n = this.erros.filter(x => x.tipo === "erro").length, a = this.erros.length - n;
    $("#previa-barra").replaceChildren(
      el("div", { class: "previa-telas" }, TELAS.map(([id, icone, , titulo]) => el("button", { class: `previa-bt${this.tela === id ? " ativo" : ""}${id === "celular" ? " pequeno" : ""}`, title: titulo, onclick: () => this.trocarTela(id) }, ic(icone)))),
      el("span", { class: "previa-escala" }),
      el("span", { class: "previa-titulo-pagina" }),
      el("span", { class: "previa-empurra" }),
      el("button", { class: `previa-erros${n ? " tem-erro" : a ? " tem-aviso" : ""}`, title: "Erros e avisos do console da página", onclick: () => this.alternarConsole() },
        ic(n ? "error" : a ? "warning" : "pass"), n || a ? `${n ? `${n} erro${n > 1 ? "s" : ""}` : ""}${n && a ? " · " : ""}${a ? `${a} aviso${a > 1 ? "s" : ""}` : ""}` : "Sem erros"),
      botao("debug-console", "Inspecionar (ferramentas de desenvolvedor)", () => { try { this.webview.isDevToolsOpened() ? this.webview.closeDevTools() : this.webview.openDevTools(); } catch { /* ainda abrindo */ } }),
      botao("link-external", "Abrir no navegador do sistema", () => api("/api/previa/abrir-url", { json: { url: this.urlAtual || this.info.url } }).catch(erro)),
      botao("copy", "Copiar o endereço", () => { navigator.clipboard.writeText(this.urlAtual || this.info.url); avisar({ texto: "Endereço copiado.", cor: "#4ade9f", tempo: 2500 }); }),
      botao(this.el.classList.contains("larga") ? "screen-normal" : "screen-full", "Ocupar mais espaço", () => { this.el.classList.toggle("larga"); this.desenhar(); }));
    const tam = TELAS.find(t => t[0] === this.tela)?.[2];
    if (!this.webview) {
      $("#previa-corpo").replaceChildren(el("div", { class: "previa-vazia" }, ic("browser"),
        el("p", { text: "Digite o endereço do site e aperte Enter." }),
        el("small", { class: "previa-dim", text: "Por exemplo, o site que está rodando no seu computador: http://localhost:3000, http://localhost:5173…" })));
      return;
    }
    this.palcoNav.classList.toggle("aparelho", !!tam);
    Object.assign(this.molduraNav.style, tam ? { width: `${tam[0]}px`, height: `${tam[1]}px` } : { width: "", height: "", transform: "" });
    const corpo = $("#previa-corpo");
    if (this.palcoNav.parentNode !== corpo) corpo.replaceChildren(this.palcoNav); // o webview não é recriado (não recarrega a página)
    this.atualizarEndereco();
    requestAnimationFrame(() => this.ajustarEscala());
    this.desenharConsole();
  }

  /** Um terminal subiu um servidor local: oferece abrir no navegador do Engram. */
  mostrarServidor(url) {
    this.el.parentNode.querySelector(".previa-servidor")?.remove();
    const chip = el("div", { class: "previa-servidor" },
      el("span", { class: "previa-servidor-ponto" }),
      el("div", { class: "previa-servidor-texto" }, el("b", { text: "Servidor rodando" }), el("small", { text: url })),
      el("button", { class: "btn-brilho pequeno", onclick: () => { chip.remove(); this.navegar(url); } }, el("span", {}, ic("browser"), " Abrir no Engram")),
      el("button", { class: "previa-bt", title: "Dispensar", onclick: () => chip.remove() }, ic("close")));
    document.body.append(chip);
    setTimeout(() => chip.classList.add("saindo"), 25_000);
    setTimeout(() => chip.remove(), 25_600);
  }

  fechar() {
    this.el.classList.remove("visivel");
    setTimeout(() => {
      if (this.el.classList.contains("visivel")) return;
      this.el.hidden = true;
      $("#previa-corpo").replaceChildren();
      this.webview = null; this.palcoNav = null; this.molduraNav = null; this.webviewPronto = false;
    }, 280);
    this.origem = null;
    this.info = null;
    api("/api/previa/vigiar", { json: { origem: null } }).catch(() => {});
  }

  mostrarCarregando() { $("#previa-corpo").replaceChildren(el("div", { class: "previa-carregando" }, el("span", { class: "giro" }))); }

  async carregar(recarregando = false) {
    const origem = this.origem;
    let info;
    try { info = await api(`/api/previa?${consulta(origem)}`); } catch (e) {
      if (this.origem !== origem) return;
      this.info = null;
      $("#previa-corpo").replaceChildren(el("div", { class: "previa-vazia" }, ic("warning"), el("p", { text: e.message })));
      return;
    }
    if (this.origem !== origem) return;
    this.info = info;
    if (info.texto != null) {
      const chave = chaveDe(origem), lista = this.versoes.get(chave) || [];
      if (!lista.length || lista[lista.length - 1].texto !== info.texto) {
        lista.push({ texto: info.texto, quando: Date.now() });
        while (lista.length > 10) lista.shift();
        this.versoes.set(chave, lista);
      }
    }
    if (recarregando) this.erros = [];
    this.desenhar();
  }

  versoesAtuais() { return this.origem ? this.versoes.get(chaveDe(this.origem)) || [] : []; }

  desenhar() {
    const i = this.info;
    if (!i) return;
    if (i.tipo === "navegador") return this.desenharNavegador();
    const versoes = this.versoesAtuais();
    const vendoAntiga = this.vendo != null && this.vendo < versoes.length - 1;
    const temCodigo = i.texto != null;
    const botao = (icone, titulo, fn, extra = "") => el("button", { class: `previa-bt ${extra}`.trim(), title: titulo, onclick: fn }, ic(icone));
    $("#previa-topo").replaceChildren(...[
      el("div", { class: "previa-icone" }, ic(ICONE[i.tipo] || "file")),
      el("div", { class: "previa-titulos" }, el("b", { text: i.nome, title: i.caminho }),
        el("small", { text: this.origem.raiz === "a" ? `${this.origem.qual === "entregues" ? "Entregue pelo agente" : "Mandado ao agente"} · ${(i.tamanho / 1024).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} KB` : this.origem.rel })),
      temCodigo ? el("div", { class: "previa-seg" },
        el("button", { class: this.modo === "previa" ? "ativo" : "", onclick: () => { this.modo = "previa"; this.desenhar(); } }, "Prévia"),
        el("button", { class: this.modo === "codigo" ? "ativo" : "", onclick: () => { this.modo = "codigo"; this.desenhar(); } }, "Código")) : null,
      botao("close", "Fechar (Esc)", () => this.fechar(), "fechar"),
    ].filter(Boolean));
    const barra = [];
    if (versoes.length > 1) {
      const n = this.vendo ?? versoes.length - 1;
      barra.push(el("div", { class: "previa-versoes", title: "Versões deste arquivo desde que a prévia abriu" },
        el("button", { class: "previa-bt", disabled: n === 0, onclick: () => { this.vendo = Math.max(0, n - 1); this.desenhar(); } }, ic("chevron-left")),
        el("span", { text: `Versão ${n + 1} de ${versoes.length}` }),
        el("button", { class: "previa-bt", disabled: n === versoes.length - 1, onclick: () => { this.vendo = n + 1 >= versoes.length - 1 ? null : n + 1; this.desenhar(); } }, ic("chevron-right")),
        vendoAntiga ? el("button", { class: "previa-restaurar", onclick: () => this.restaurar(versoes[n].texto) }, ic("history"), "Restaurar") : null));
    }
    if (i.tipo === "html" && this.modo === "previa") barra.push(el("div", { class: "previa-telas" }, TELAS.map(([id, icone, , titulo]) => el("button", { class: `previa-bt${this.tela === id ? " ativo" : ""}${id === "celular" ? " pequeno" : ""}`, title: titulo, onclick: () => this.trocarTela(id) }, ic(icone)))), el("span", { class: "previa-escala" }));
    barra.push(el("span", { class: "previa-empurra" }));
    if (i.tipo === "html") {
      const n = this.erros.filter(x => x.tipo === "erro").length, a = this.erros.length - n;
      barra.push(el("button", { class: `previa-erros${n ? " tem-erro" : a ? " tem-aviso" : ""}`, title: "Erros e avisos do console da página", onclick: () => this.alternarConsole() },
        ic(n ? "error" : a ? "warning" : "pass"), n || a ? `${n ? `${n} erro${n > 1 ? "s" : ""}` : ""}${n && a ? " · " : ""}${a ? `${a} aviso${a > 1 ? "s" : ""}` : ""}` : "Sem erros"));
    }
    barra.push(
      botao("refresh", "Recarregar", () => { this.mostrarCarregando(); this.carregar(true); }),
      i.tipo === "html" ? botao("globe", "Abrir no navegador", () => api("/api/previa/externo", { json: { origem: this.origem, navegador: true } }).catch(erro)) : null,
      botao("link-external", "Abrir no programa padrão", () => api("/api/previa/externo", { json: { origem: this.origem } }).catch(erro)),
      botao("browser", "Navegador do Engram: abrir um endereço (o site rodando no seu computador)", () => this.pedirEndereco()),
      botao("folder-opened", "Mostrar na pasta", () => api("/api/previa/mostrar", { json: { origem: this.origem } }).catch(erro)),
      botao("copy", "Copiar o caminho", () => { navigator.clipboard.writeText(i.caminho); avisar({ texto: "Caminho copiado.", cor: "#4ade9f", tempo: 2500 }); }),
      botao(this.el.classList.contains("larga") ? "screen-normal" : "screen-full", "Ocupar mais espaço", () => { this.el.classList.toggle("larga"); this.desenhar(); }),
      el("label", { class: "previa-sozinha", title: "Abrir a prévia sozinha quando um agente entregar um arquivo" },
        el("input", { type: "checkbox", ...(this.sozinha ? { checked: true } : {}), onchange: e => { this.sozinha = e.target.checked; try { localStorage.setItem("engram.previa.sozinha", this.sozinha ? "sim" : "nao"); } catch { /* sem armazenamento */ } } }),
        "Abrir sozinha"));
    $("#previa-barra").replaceChildren(...barra.filter(Boolean));
    const texto = vendoAntiga ? versoes[this.vendo].texto : i.texto;
    const corpo = $("#previa-corpo");
    if (this.modo === "codigo" && temCodigo) return this.mostrarCodigo(corpo, texto);
    corpo.replaceChildren(this.conteudo(i, texto, vendoAntiga));
    this.desenharConsole();
  }

  conteudo(i, texto, antiga) {
    const v = `?v=${Math.round(i.modificado)}`;
    switch (i.tipo) {
      case "html": {
        const tam = TELAS.find(t => t[0] === this.tela)?.[2];
        const quadro = el("iframe", {
          class: "previa-quadro", title: i.nome, sandbox: "allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads",
          ...(antiga ? { srcdoc: `<base href="${i.pasta}">${texto}` } : { src: i.url + v }),
        });
        this.quadro = quadro;
        requestAnimationFrame(() => this.ajustarEscala());
        return el("div", { class: `previa-palco${tam ? " aparelho" : ""}` }, el("div", { class: "previa-moldura", ...(tam ? { style: { width: `${tam[0]}px`, height: `${tam[1]}px` } } : {}) }, quadro));
      }
      case "svg": case "imagem": {
        const img = el("img", { class: "previa-img", src: antiga ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(texto)}` : i.url + v, alt: i.nome, onclick: e => e.currentTarget.classList.toggle("real") });
        const tamanho = el("span", { class: "previa-dim" });
        img.addEventListener("load", () => { tamanho.textContent = `${img.naturalWidth} × ${img.naturalHeight} · clique para ver no tamanho real`; });
        return el("div", { class: "previa-imagem" }, img, tamanho);
      }
      case "video": return el("div", { class: "previa-midia" }, el("video", { src: i.url + v, controls: true, autoplay: false, preload: "metadata" }));
      case "audio": return el("div", { class: "previa-midia audio" }, ic("unmute", "previa-audio-icone"), el("audio", { src: i.url + v, controls: true, preload: "metadata" }));
      case "pdf": return el("iframe", { class: "previa-quadro pdf", src: i.url + v, title: i.nome });
      case "markdown": return this.markdown(texto || "", i);
      case "tabela": return this.tabela(texto || "", i);
      default: return el("div", { class: "previa-vazia" }, ic("file"), el("p", { text: "Esse tipo de arquivo não tem prévia. Abra no programa padrão." }));
    }
  }

  markdown(texto, i) {
    const caixa = el("article", { class: "previa-md" });
    if (!window.markdownit) { caixa.append(el("pre", { text: texto })); return caixa; }
    const doc = new DOMParser().parseFromString(window.markdownit({ html: false, linkify: true }).render(texto), "text/html");
    for (const img of doc.querySelectorAll("img")) {
      const src = img.getAttribute("src") || "";
      if (!/^https?:|^data:/.test(src)) img.setAttribute("src", new URL(src, i.pasta).href); // relativa: pelo servidor local
      else if (!/^data:/.test(src)) img.replaceWith(Object.assign(doc.createElement("span"), { className: "previa-img-fora", textContent: img.alt ? `[imagem: ${img.alt}]` : "[imagem da internet]" }));
    }
    caixa.append(...doc.body.childNodes);
    for (const a of caixa.querySelectorAll("a[href]")) {
      const u = a.getAttribute("href");
      a.onclick = ev => { ev.preventDefault(); if (/^https:\/\//.test(u)) api("/api/codigo/link", { json: { url: u } }).catch(() => {}); };
    }
    return caixa;
  }

  tabela(texto, i) {
    const linhas = lerTabela(texto, i.nome);
    if (!linhas.length) return el("div", { class: "previa-vazia" }, el("p", { text: "Arquivo vazio." }));
    const [cab, ...resto] = linhas;
    return el("div", { class: "previa-tabela" },
      el("table", {}, el("thead", {}, el("tr", {}, el("th", { text: "#" }), cab.map(c => el("th", { text: c })))),
        el("tbody", {}, resto.slice(0, 2000).map((l, n) => el("tr", {}, el("td", { class: "num", text: String(n + 1) }), l.map(c => el("td", { text: c })))))),
      el("small", { class: "previa-dim", text: `${resto.length >= 2000 ? "Mostrando as primeiras 2.000 linhas · " : ""}${resto.length.toLocaleString("pt-BR")} linhas · ${cab.length} colunas` }));
  }

  async mostrarCodigo(corpo, texto) {
    const pre = el("pre", { class: "previa-codigo" }, el("code", { text: texto }));
    corpo.replaceChildren(pre);
    if (window.monaco) {
      try {
        const html = await window.monaco.editor.colorize(texto.length > 400_000 ? texto.slice(0, 400_000) : texto, LINGUAGEM[this.info?.tipo] || "plaintext", { tabSize: 2 });
        const c = el("code");
        c.innerHTML = html; // gerado pelo próprio Monaco a partir do texto (escapado)
        pre.replaceChildren(c);
      } catch { /* fica sem cor */ }
    }
  }

  async restaurar(texto) {
    if (!confirm("Gravar esta versão de volta no arquivo? A versão atual vira a anterior.")) return;
    try {
      await api("/api/previa/salvar", { json: { origem: this.origem, texto } });
      this.vendo = null;
      avisar({ texto: "Versão restaurada.", cor: "#4ade9f" });
    } catch (e) { erro(e); }
  }

  // ---------------------------------------------------------------- console da página

  mensagem(e) {
    if (!this.quadro || e.source !== this.quadro.contentWindow || !e.data?.engramPrevia) return;
    const { engramPrevia: tipo, texto } = e.data;
    if (tipo === "pronta") return;
    if (this.erros.length < 200) this.erros.push({ tipo, texto, quando: Date.now() });
    this.atualizarSelo();
  }

  atualizarSelo() {
    const n = this.erros.filter(x => x.tipo === "erro").length, a = this.erros.length - n;
    const b = this.el.querySelector(".previa-erros");
    if (!b) return;
    b.className = `previa-erros${n ? " tem-erro" : a ? " tem-aviso" : ""}`;
    b.replaceChildren(ic(n ? "error" : a ? "warning" : "pass"), n || a ? `${n ? `${n} erro${n > 1 ? "s" : ""}` : ""}${n && a ? " · " : ""}${a ? `${a} aviso${a > 1 ? "s" : ""}` : ""}` : "Sem erros");
    this.desenharConsole();
  }

  alternarConsole() { const c = $("#previa-console"); c.hidden = !c.hidden; this.desenharConsole(); }

  desenharConsole() {
    const c = $("#previa-console");
    if (!c || c.hidden) return;
    c.replaceChildren(this.erros.length ? el("div", { class: "previa-console-lista" }, this.erros.map(x => el("div", { class: `previa-console-linha ${x.tipo}` }, ic(x.tipo === "erro" ? "error" : "warning"), el("span", { text: x.texto }))))
      : el("div", { class: "previa-console-linha" }, ic("pass"), el("span", { text: "A página não mostrou erros nem avisos no console." })));
  }

  // ---------------------------------------------------------------- ao vivo

  aoVivo(m) {
    if (m.evento === "servidor" && m.url) { if (this.info?.tipo !== "navegador" || this.urlAtual !== m.url) this.mostrarServidor(m.url); return; }
    if (m.evento === "mudou" && this.aberto && this.info) {
      clearTimeout(this.timerMudou);
      this.timerMudou = setTimeout(() => this.carregar(true), 150);
    }
  }
}
