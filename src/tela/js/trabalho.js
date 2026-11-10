// A janela "Visualizar trabalho": ver um agente escrevendo código. Cada edição chega com o antes e o depois
// (o Engram lê do disco); aqui as linhas que saem ficam vermelhas e somem, e as novas aparecem sendo
// digitadas, com um cursor brilhando, no mesmo editor e com o mesmo tema da vista Código. Do lado, os
// arquivos que ele mexeu; na direita, a linha do tempo do que ele está fazendo; e as abas Mudanças (o antes
// e o depois) e Terminal (o terminal dele, só para olhar).

import { $, el, api, avisar, corModelo } from "./util.js";
import { carregarMonaco, coresDoEngram, iconeDe, irParaPrimeiraMudanca } from "./codigo.js";
import { PainelExtensoes, definirTemaEditor, linguagemPelasExtensoes } from "./extensoes.js";

const ic = (nome, extra = "") => el("i", { class: `codicon codicon-${nome} ${extra}`.trim() });
const nomeDe = rel => String(rel || "").split(/[\\/]/).pop();
const pastaDe = rel => String(rel || "").split(/[\\/]/).slice(0, -1).join("/");
const sessao = new URLSearchParams(location.search).get("sessao");
const ESTADOS = { pensando: ["Pensando", "sparkle"], trabalhando: ["Trabalhando", "gear"], iniciando: ["Abrindo", "loading"], "esperando você": ["Esperando você", "comment"], pronta: ["Pronta", "check"], "precisa de você": ["Precisa de você", "bell"], encerrada: ["Encerrada", "circle-slash"] };
const VELOCIDADES = { lenta: [1, 360], normal: [2, 150], rapida: [6, 60], nenhuma: [0, 0] }; // [letras por quadro no mínimo, quadros no máximo]
const ICONE_FERRAMENTA = { Read: "eye", Write: "new-file", Edit: "edit", MultiEdit: "edit", Bash: "terminal", PowerShell: "terminal", Grep: "search", Glob: "search", WebFetch: "globe", WebSearch: "globe", Task: "hubot", TodoWrite: "checklist" };

/** As diferenças entre duas listas de linhas, em blocos { a, aFim, b, bFim } (o que sai e o que entra). */
function blocosDeDiferenca(A, B) {
  let ini = 0;
  while (ini < A.length && ini < B.length && A[ini] === B[ini]) ini++;
  let fa = A.length, fb = B.length;
  while (fa > ini && fb > ini && A[fa - 1] === B[fb - 1]) { fa--; fb--; }
  const a = A.slice(ini, fa), b = B.slice(ini, fb);
  if (!a.length && !b.length) return [];
  if (a.length * b.length > 250_000) return [{ a: ini, aFim: fa, b: ini, bFim: fb }];
  // o miolo: maior subsequência comum, para separar os pedaços que mudaram de verdade
  const n = a.length, m = b.length, t = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) t[i][j] = a[i] === b[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
  const blocos = [];
  let i = 0, j = 0, bloco = null;
  const fechar = () => { if (bloco) { blocos.push(bloco); bloco = null; } };
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { fechar(); i++; j++; continue; }
    if (!bloco) bloco = { a: ini + i, aFim: ini + i, b: ini + j, bFim: ini + j };
    if (j < m && (i >= n || t[i][j + 1] >= t[i + 1][j])) { j++; bloco.bFim = ini + j; } else { i++; bloco.aFim = ini + i; }
  }
  fechar();
  return blocos;
}

class JanelaTrabalho {
  constructor() {
    this.info = null;
    this.arquivos = new Map(); // arquivo → { rel, modelo, primeiro, ultimo, mais, menos, quando }
    this.fila = [];
    this.animando = false;
    this.atual = null;
    this.seguir = true;
    this.aba = "codigo";
    this.velocidade = (() => { try { return localStorage.getItem("engram.trabalho.velocidade") || "normal"; } catch { return "normal"; } })();
    this.linhaTempo = [];
  }

  async iniciar() {
    try { this.info = await api(`/api/trabalho/${encodeURIComponent(sessao)}`); } catch (e) { document.body.append(el("p", { class: "trab-erro", text: e.message })); return; }
    document.title = `Trabalho de ${this.info.nome}`;
    this.montar();
    window.engram.aoVivo(m => { try { this.aoVivo(m); } catch (e) { console.error(e); } });
    try {
      const monaco = await carregarMonaco();
      this.criarEditores(monaco);
      // o mesmo tema e o mesmo realce da vista Código (extensões do VS Code)
      const painel = new PainelExtensoes({ aplicarTemas: () => this.aplicarTema(), redesenharIcones: () => this.desenharArquivos(), desenharLado() {}, redesenharPagina() {}, abrirPaleta() {}, retokenizar() {} });
      await painel.iniciar(monaco);
      this.aplicarTema();
      new MutationObserver(() => this.aplicarTema()).observe(document.documentElement, { attributes: true, attributeFilter: ["data-tema"] });
    } catch (e) { console.error(e); }
    this.carregarHistorico();
    this.desenhar();
  }

  aplicarTema() { if (window.monaco) definirTemaEditor(window.monaco, coresDoEngram()); }

  montar() {
    const cor = corModelo(this.info.modelo);
    document.body.style.setProperty("--cor", cor);
    $("#trab").replaceChildren(
      el("header", { class: "trab-topo" },
        el("div", { class: "trab-olho" }, ic("eye")),
        el("div", { class: "trab-titulos" }, el("b", { text: `Trabalho de ${this.info.nome}` }), el("small", { id: "trab-agora", text: "Acompanhando…" })),
        el("span", { class: "trab-chip", text: this.info.modelo || this.info.provedor }),
        el("span", { class: "trab-estado", id: "trab-estado" })),
      el("div", { class: "trab-corpo" },
        el("aside", { class: "trab-lado" },
          el("div", { class: "trab-sec-titulo", text: "Arquivos que ele mexeu" }),
          el("div", { class: "trab-arquivos", id: "trab-arquivos" })),
        el("main", { class: "trab-centro" },
          el("div", { class: "trab-abas" },
            ...[["codigo", "Escrevendo", "edit"], ["mudancas", "Mudanças", "diff"], ["terminal", "Terminal", "terminal"]].map(([id, rotulo, icone]) =>
              el("button", { "data-aba": id, class: this.aba === id ? "ativo" : "", onclick: () => this.trocarAba(id) }, ic(icone), rotulo)),
            el("span", { class: "cod-empurra" }),
            el("span", { class: "trab-arquivo-atual", id: "trab-arquivo-atual" })),
          el("div", { class: "trab-hosts" },
            el("div", { class: "trab-host", id: "trab-editor" }),
            el("div", { class: "trab-host", id: "trab-diff", hidden: true }),
            el("div", { class: "trab-host trab-term", id: "trab-term", hidden: true }),
            el("div", { class: "trab-vazio", id: "trab-vazio" },
              el("div", { class: "trab-vazio-olho" }, ic("eye")),
              el("h2", { text: "Esperando o agente escrever" }),
              el("p", { text: this.info.ganchos ? "Quando ele editar ou criar um arquivo, você vê aqui cada linha sendo escrita." : "Este agente não avisa cada edição: o Engram vigia a pasta dele e mostra o que mudar no disco." })))),
        el("aside", { class: "trab-tempo" },
          el("div", { class: "trab-sec-titulo", text: "Linha do tempo" }),
          el("div", { class: "trab-feed", id: "trab-feed" }))),
      el("footer", { class: "trab-rodape" },
        el("label", { class: "trab-opcao" }, el("input", { type: "checkbox", checked: true, onchange: e => { this.seguir = e.target.checked; } }), "Acompanhar o arquivo que ele está mexendo"),
        el("span", { class: "cod-empurra" }),
        el("span", { class: "trab-vel-rotulo", text: "Animação" }),
        el("div", { class: "trab-vel" }, ...[["lenta", "Lenta"], ["normal", "Normal"], ["rapida", "Rápida"], ["nenhuma", "Sem"]].map(([id, r]) =>
          el("button", { class: this.velocidade === id ? "ativo" : "", onclick: e => { this.velocidade = id; try { localStorage.setItem("engram.trabalho.velocidade", id); } catch { /* sem armazenamento */ } for (const b of e.currentTarget.parentNode.children) b.classList.toggle("ativo", b === e.currentTarget); } }, r))),
        el("span", { class: "trab-pasta", title: this.info.pasta }, ic("folder"), this.info.pasta)));
    this.mostrarEstado(this.info.estado);
  }

  criarEditores(monaco) {
    const opcoes = { fontFamily: '"Cascadia Code", "Cascadia Mono", Consolas, monospace', fontSize: 14, fontLigatures: true, automaticLayout: true, readOnly: true, domReadOnly: true,
      minimap: { enabled: true, renderCharacters: false }, smoothScrolling: true, scrollBeyondLastLine: false, padding: { top: 10 }, renderLineHighlight: "none", glyphMargin: true };
    this.editor = monaco.editor.create($("#trab-editor"), { ...opcoes, model: null });
    this.diff = monaco.editor.createDiffEditor($("#trab-diff"), { ...opcoes, renderSideBySide: true, minimap: { enabled: false }, originalEditable: false });
    this.decoracoes = this.editor.createDecorationsCollection();
    this.cursor = this.editor.createDecorationsCollection();
  }

  trocarAba(id) {
    this.aba = id;
    for (const b of document.querySelectorAll(".trab-abas button")) b.classList.toggle("ativo", b.dataset.aba === id);
    $("#trab-editor").hidden = id !== "codigo";
    $("#trab-diff").hidden = id !== "mudancas";
    $("#trab-term").hidden = id !== "terminal";
    $("#trab-vazio").hidden = id === "terminal" || this.arquivos.size > 0;
    if (id === "terminal") this.abrirTerminal();
    if (id === "mudancas") this.mostrarMudancas();
    if (id === "codigo") requestAnimationFrame(() => this.editor?.layout());
  }

  // ---------------------------------------------------------------- terminal (só para olhar)

  // O espelho tem de ter exatamente as colunas e linhas do terminal do agente: o CLI desenha a tela contando
  // com esse tamanho, e num espelho de outro tamanho as linhas quebram em outro lugar e tudo embaralha.
  // Então o tamanho vem do agente e, para caber na janela, o que muda é o tamanho da letra.
  abrirTerminal() {
    if (this.term) { requestAnimationFrame(() => this.ajustarTerminal()); return; }
    const term = new Terminal({ fontFamily: '"Cascadia Mono", Consolas, monospace', fontSize: 13, lineHeight: 1.12, scrollback: 6000, disableStdin: true, cursorBlink: false, cols: 100, rows: 28,
      theme: { background: "#070a10", foreground: "#dfe6f3", cursor: getComputedStyle(document.body).getPropertyValue("--cor") || "#8b7bff" } });
    term.open($("#trab-term"));
    this.term = term;
    window.engram.terminal.abrir(sessao, {
      aoInicio: tam => { term.reset(); if (tam?.colunas) this.tamanhoTerminal(tam.colunas, tam.linhas); },
      aoDados: d => term.write(d),
      aoFim: () => term.write("\r\n\x1b[2m[a janela do agente fechou]\x1b[0m\r\n"),
    });
    new ResizeObserver(() => this.ajustarTerminal()).observe($("#trab-term"));
    requestAnimationFrame(() => this.ajustarTerminal());
  }

  tamanhoTerminal(colunas, linhas) {
    if (!this.term || !colunas || !linhas) return;
    if (this.term.cols !== colunas || this.term.rows !== linhas) this.term.resize(colunas, linhas);
    requestAnimationFrame(() => this.ajustarTerminal());
  }

  /** Escolhe o tamanho da letra para o terminal inteiro caber na área (entre 7 e 16). */
  ajustarTerminal() {
    const caixa = $("#trab-term"), t = this.term;
    if (!t || caixa.hidden) return;
    const tela = caixa.querySelector(".xterm-screen");
    const largura = caixa.clientWidth - 22, altura = caixa.clientHeight - 14;
    if (!tela || !tela.offsetWidth || largura <= 0 || altura <= 0) return;
    const letra = t.options.fontSize;
    const porLetraL = tela.offsetWidth / t.cols / letra, porLetraA = tela.offsetHeight / t.rows / letra; // quanto cada célula mede por ponto de letra
    const nova = Math.max(7, Math.min(16, Math.floor(Math.min(largura / (t.cols * porLetraL), altura / (t.rows * porLetraA)) * 2) / 2));
    if (nova !== letra) t.options.fontSize = nova;
  }

  // ---------------------------------------------------------------- arquivos e mudanças

  modeloDe(arq, rel) {
    const monaco = window.monaco;
    let a = this.arquivos.get(arq);
    if (!a) {
      const uri = monaco.Uri.parse(`engram-trabalho:///${encodeURIComponent(arq)}`);
      const nome = nomeDe(rel);
      let lang = linguagemPelasExtensoes(nome);
      if (!lang || !monaco.languages.getLanguages().some(l => l.id === lang)) {
        const ext = `.${nome.split(".").pop().toLowerCase()}`;
        lang = monaco.languages.getLanguages().find(l => (l.extensions || []).includes(ext))?.id || "plaintext";
      }
      a = { rel, modelo: monaco.editor.createModel("", lang, uri), primeiro: null, ultimo: "", mais: 0, menos: 0, quando: Date.now() };
      a.modelo.setEOL(monaco.editor.EndOfLineSequence.LF);
      this.arquivos.set(arq, a);
    }
    return a;
  }

  desenharArquivos() {
    const caixa = $("#trab-arquivos");
    if (!caixa) return;
    const lista = [...this.arquivos.entries()].sort((x, y) => y[1].quando - x[1].quando);
    caixa.replaceChildren(...(lista.length ? lista.map(([arq, a]) => el("button", {
      class: `trab-arq${this.atual === arq ? " atual" : ""}${a.escrevendo ? " escrevendo" : ""}`, title: a.rel,
      onclick: () => { this.seguir = false; document.querySelector(".trab-opcao input").checked = false; this.mostrar(arq); },
    }, iconeDe(nomeDe(a.rel)), el("span", { class: "trab-arq-nome" }, el("b", { text: nomeDe(a.rel) }), el("small", { text: pastaDe(a.rel) })),
    el("span", { class: "trab-cont" }, a.mais ? el("i", { class: "mais", text: `+${a.mais}` }) : null, a.menos ? el("i", { class: "menos", text: `−${a.menos}` }) : null)))
      : [el("p", { class: "trab-dica", text: "Nenhum ainda." })]));
  }

  mostrar(arq) {
    const a = this.arquivos.get(arq);
    if (!a || !this.editor) return;
    this.atual = arq;
    if (this.editor.getModel() !== a.modelo) { this.decoracoes.clear(); this.cursor.clear(); this.editor.setModel(a.modelo); }
    $("#trab-vazio").hidden = true;
    $("#trab-arquivo-atual").replaceChildren(iconeDe(nomeDe(a.rel)), el("span", { text: a.rel }));
    this.desenharArquivos();
    if (this.aba === "mudancas") this.mostrarMudancas();
  }

  mostrarMudancas() {
    const a = this.atual && this.arquivos.get(this.atual);
    if (!a || !this.diff) return;
    const monaco = window.monaco;
    const lang = a.modelo.getLanguageId(), velhos = this.diffModelos;
    this.diffModelos = [monaco.editor.createModel(a.primeiro ?? "", lang), monaco.editor.createModel(a.ultimo, lang)];
    irParaPrimeiraMudanca(this.diff);
    this.diff.setModel({ original: this.diffModelos[0], modified: this.diffModelos[1] });
    velhos?.forEach(m => m.dispose()); // só depois de o diff largar os antigos

    $("#trab-vazio").hidden = true;
  }

  // ---------------------------------------------------------------- a escrita animada

  receberEdicao(m) {
    this.fila.push(m);
    this.adicionarTempo({ icone: m.ferramenta === "Write" ? "new-file" : m.ferramenta === "disco" ? "save" : "edit", texto: `${m.ferramenta === "Write" ? "Escreveu" : "Editou"} ${nomeDe(m.rel)}`, detalhe: pastaDe(m.rel), arquivo: m.arquivo });
    if (!this.animando) this.proxima();
  }

  async proxima() {
    const m = this.fila.shift();
    if (!m) { this.animando = false; return; }
    this.animando = true;
    try { await this.animar(m, this.fila.length > 2); } catch (e) { console.error(e); }
    this.proxima();
  }

  async animar(m, depressa) {
    if (!window.monaco || !this.editor) return;
    const CRLF = new RegExp(String.fromCharCode(13) + String.fromCharCode(10), "g");
    m = { ...m, antes: String(m.antes ?? "").replace(CRLF, "\n"), depois: String(m.depois ?? "").replace(CRLF, "\n") };
    const a = this.modeloDe(m.arquivo, m.rel);
    if (a.primeiro == null) a.primeiro = m.antes;
    a.quando = Date.now();
    const A = m.antes.split("\n"), B = m.depois.split("\n");
    const blocos = blocosDeDiferenca(A, B);
    for (const b of blocos) { a.mais += b.bFim - b.b; a.menos += b.aFim - b.a; }
    a.ultimo = m.depois;
    const visivel = this.seguir || this.atual === m.arquivo;
    if (this.seguir) this.mostrar(m.arquivo);
    $("#trab-agora").textContent = `${m.ferramenta === "Write" ? "Escrevendo" : "Editando"} ${m.rel}`;
    if (!visivel || depressa || this.velocidade === "nenhuma" || this.aba !== "codigo") {
      a.modelo.setValue(m.depois);
      if (this.atual === m.arquivo) this.marcarNovas(blocos);
      this.desenharArquivos();
      return;
    }
    a.escrevendo = true;
    this.desenharArquivos();
    a.modelo.setValue(m.antes);
    // setValue de um texto sem quebras volta ao padrão do sistema (CRLF no Windows): as contas abaixo são em LF
    a.modelo.setEOL(window.monaco.editor.EndOfLineSequence.LF);
    const monaco = window.monaco, modelo = a.modelo;
    const total = blocos.reduce((s, b) => s + B.slice(b.b, b.bFim).join("\n").length, 0);
    const [minimo, quadros] = VELOCIDADES[this.velocidade] || VELOCIDADES.normal;
    const porQuadro = Math.max(minimo, Math.ceil(total / quadros));
    const quadro = () => new Promise(r => requestAnimationFrame(r));
    const esperar = ms => new Promise(r => setTimeout(r, ms));
    const novas = [];
    // o texto atual em "linhas" (texto = linhas unidas por \n); onde começa a linha k
    const inicioDaLinha = k => { const L = modelo.getValue().split("\n"); let o = 0; for (let i = 0; i < k && i < L.length; i++) o += L[i].length + 1; return o; };
    const decorarNovas = ate => this.decoracoes.set([...novas, ...ate].map(l => ({ range: new monaco.Range(l, 1, l, 1), options: { isWholeLine: true, className: "trab-linha-entra", linesDecorationsClassName: "trab-barra entra", overviewRuler: { color: "#4ade9f", position: 4 } } })));
    for (const b of blocos) {
      // depois dos blocos anteriores, as linhas antes deste já são as do texto novo: o bloco começa na linha b.b
      const k = b.b, saem = b.aFim - b.a, entram = B.slice(b.b, b.bFim);
      this.editor.revealLineInCenterIfOutsideViewport(Math.min(k + 1, modelo.getLineCount()));
      if (saem) {
        // as linhas que saem ficam vermelhas por um instante e somem
        this.decoracoes.set([...novas.map(l => ({ range: new monaco.Range(l, 1, l, 1), options: { isWholeLine: true, className: "trab-linha-entra", linesDecorationsClassName: "trab-barra entra" } })),
          { range: new monaco.Range(k + 1, 1, k + saem, 1), options: { isWholeLine: true, className: "trab-linha-sai", linesDecorationsClassName: "trab-barra sai", overviewRuler: { color: "#ff6b7d", position: 4 } } }]);
        await esperar(this.velocidade === "lenta" ? 650 : 320);
        const n = modelo.getValue().split("\n").length, texto = modelo.getValue();
        let de = inicioDaLinha(k), ate = k + saem < n ? inicioDaLinha(k + saem) : texto.length;
        if (k + saem >= n && k > 0) de -= 1; // tirando até a última linha: leva junto a quebra antes dela
        modelo.applyEdits([{ range: monaco.Range.fromPositions(modelo.getPositionAt(de), modelo.getPositionAt(ate)), text: "" }]);
      }
      if (entram.length) {
        // as novas aparecem sendo digitadas
        const texto = modelo.getValue(), n = texto.split("\n").length;
        let inserir = entram.join("\n"), o;
        if (texto === "") o = 0;
        else if (k < n && !(saem && k >= n)) { o = inicioDaLinha(k); inserir += "\n"; }
        else { o = texto.length; inserir = "\n" + inserir; }
        let feito = 0;
        while (feito < inserir.length) {
          const pedaco = inserir.slice(feito, feito + porQuadro);
          const pos = modelo.getPositionAt(o + feito);
          modelo.applyEdits([{ range: monaco.Range.fromPositions(pos, pos), text: pedaco }]);
          feito += pedaco.length;
          const agora = modelo.getPositionAt(o + feito);
          this.cursor.set([{ range: monaco.Range.fromPositions(agora, agora), options: { beforeContentClassName: "trab-cursor" } }]);
          const ate = [];
          for (let l = k + 1; l <= Math.min(agora.lineNumber, k + entram.length); l++) ate.push(l);
          decorarNovas(ate);
          this.editor.revealLineInCenterIfOutsideViewport(agora.lineNumber);
          await quadro();
        }
        for (let l = k + 1; l <= k + entram.length; l++) novas.push(l);
      }
    }
    this.cursor.clear();
    // garante o texto final exato (o arquivo como está no disco)
    if (modelo.getValue() !== m.depois) modelo.setValue(m.depois);
    this.marcarNovas(blocos);
    a.escrevendo = false;
    this.desenharArquivos();
    if (this.aba === "mudancas" && this.atual === m.arquivo) this.mostrarMudancas();
  }

  /** Deixa marcadas (verde, sumindo devagar) as linhas que acabaram de entrar. */
  marcarNovas(blocos) {
    const monaco = window.monaco;
    const marcas = [];
    for (const b of blocos) for (let l = b.b + 1; l <= b.bFim; l++) marcas.push({ range: new monaco.Range(l, 1, l, 1), options: { isWholeLine: true, className: "trab-linha-entra fim", linesDecorationsClassName: "trab-barra entra fim", overviewRuler: { color: "#4ade9f", position: 4 } } });
    this.decoracoes.set(marcas);
    clearTimeout(this.timerMarcas);
    this.timerMarcas = setTimeout(() => this.decoracoes.clear(), 9000);
  }

  // ---------------------------------------------------------------- estado e linha do tempo

  mostrarEstado(estado) {
    const [rotulo, icone] = ESTADOS[estado] || [estado || "—", "circle-outline"];
    const e = $("#trab-estado");
    if (!e) return;
    e.className = `trab-estado ${String(estado || "").replace(/\s+/g, "-")}`;
    e.replaceChildren(ic(icone, ["pensando", "trabalhando", "iniciando"].includes(estado) ? "codicon-modifier-spin" : ""), rotulo);
    document.body.classList.toggle("ocupado", ["pensando", "trabalhando"].includes(estado));
  }

  adicionarTempo({ icone, texto, detalhe = "", arquivo = null, quando = Date.now() }) {
    this.linhaTempo.unshift({ icone, texto, detalhe, arquivo, quando });
    if (this.linhaTempo.length > 300) this.linhaTempo.pop();
    this.desenharTempo();
  }

  desenharTempo() {
    const caixa = $("#trab-feed");
    if (!caixa) return;
    caixa.replaceChildren(...(this.linhaTempo.length ? this.linhaTempo.slice(0, 150).map((x, i) => el("div", { class: `trab-item${i === 0 ? " novo" : ""}${x.arquivo ? " clicavel" : ""}`, onclick: () => x.arquivo && this.mostrar(x.arquivo) },
      el("span", { class: "trab-item-icone" }, ic(x.icone)),
      el("span", { class: "trab-item-texto" }, el("b", { text: x.texto }), x.detalhe ? el("small", { text: x.detalhe }) : null),
      el("time", { text: new Date(x.quando).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) })))
      : [el("p", { class: "trab-dica", text: "Nada ainda." })]));
  }

  async carregarHistorico() {
    try {
      const eventos = await api(`/api/sessoes/${encodeURIComponent(sessao)}/eventos`);
      // vêm do mais antigo ao mais novo; cada um entra no topo, então o mais novo fica em cima
      for (const e of (eventos || []).slice(-40)) this.eventoNoTempo(e.evento, e.ferramenta, e.resumo, e.quando ? new Date(e.quando).getTime() : Date.now());
    } catch { /* sem histórico */ }
  }

  /** Caminhos absolutos no resumo ficam curtos: relativos ao projeto, ou só a pasta e o arquivo. */
  encurtar(texto) {
    const pasta = String(this.info?.pasta || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    return String(texto || "").replace(/(?<=^|[\s(])(?:[A-Za-z]:[\\/]|\/)[^\s"']+/g, caminho => {
      const c = caminho.replace(/\\/g, "/");
      if (pasta && c.toLowerCase().startsWith(pasta + "/")) return c.slice(pasta.length + 1);
      const partes = c.split("/").filter(Boolean);
      return partes.length > 2 ? `…/${partes.slice(-2).join("/")}` : caminho;
    });
  }

  eventoNoTempo(evento, ferramenta, resumo, quando = Date.now()) {
    resumo = this.encurtar(resumo);
    if (evento === "PreToolUse" && ferramenta && !["Write", "Edit", "MultiEdit"].includes(ferramenta)) {
      this.adicionarTempo({ icone: ICONE_FERRAMENTA[ferramenta] || (String(ferramenta).startsWith("mcp__") ? "plug" : "tools"), texto: resumo || ferramenta, quando });
      $("#trab-agora").textContent = resumo || ferramenta;
    } else if (evento === "UserPromptSubmit") this.adicionarTempo({ icone: "mail", texto: "Recebeu um pedido", quando });
    else if (evento === "Stop") { this.adicionarTempo({ icone: "pass", texto: "Terminou o turno", quando }); $("#trab-agora").textContent = "Terminou: esperando o próximo pedido"; }
  }

  aoVivo(m) {
    if (m.tipo === "trabalho" && m.sessao === sessao) {
      if (m.fase === "vai-escrever") { $("#trab-agora").textContent = `Vai editar ${m.rel}`; return; }
      if (m.fase === "escreveu") this.receberEdicao(m);
    } else if (m.tipo === "evento" && m.sessao_id === sessao) {
      if (m.estado) this.mostrarEstado(m.estado);
      this.eventoNoTempo(m.evento, m.ferramenta, m.resumo);
    } else if (m.tipo === "terminal" && m.evento === "tamanho" && m.id === sessao) {
      this.tamanhoTerminal(m.colunas, m.linhas); // o terminal do agente mudou de tamanho: o espelho acompanha
    } else if (m.tipo === "sessao" && m.sessao?.id === sessao) {
      this.mostrarEstado(m.sessao.aberta === false ? "encerrada" : m.sessao.estado);
    }
  }

  desenhar() { this.desenharArquivos(); this.desenharTempo(); }
}

new JanelaTrabalho().iniciar();
