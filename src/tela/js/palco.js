// Palco: canvas infinito com os agentes (Claude Code de verdade) e as linhas que os ligam.
// Desempenho: vista Conversa por padrão (texto leve); o terminal só existe quando é aberto, com
// renderização WebGL; brilhos por gradiente (sem filtro de blur); pan/zoom no quadro da tela.

import {
  $, el, svg, api, corModelo, nomeModelo, nomePapel, OCUPADO, ATENCAO, COR_LIGACAO,
  limitar, avisar, movimentoReduzido,
} from "./util.js";
import { Conversa } from "./conversa.js";

const TAM = { w: 700, h: 470 };
const ROTULO = {
  iniciando: "iniciando…", pronta: "pronta", pensando: "pensando…", trabalhando: "trabalhando…",
  "esperando você": "esperando você", "precisa de você": "precisa de você", encerrada: "encerrada",
};
const NORMAL = { d: [1, 0], e: [-1, 0], c: [0, -1], b: [0, 1] };
const suave = t => (t <= 0 ? 0 : t >= 1 ? 1 : t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export class Palco {
  constructor({ aoAbrirNota, aoRetomar, aoLer }) {
    this.raiz = $("#palco");
    this.mundo = $("#mundo");
    this.grade = $("#grade");
    this.gFios = $("#fios-g");
    this.gPart = $("#particulas");
    this.gGrad = $("#gradientes");
    this.camada = $("#cartoes");
    this.camadaLemb = $("#lembrancas");
    this.v = { x: innerWidth / 2 - TAM.w / 2, y: innerHeight / 2 - TAM.h / 2 + 30, z: 1 };
    this.cartoes = new Map();
    this.fios = new Map();
    this.brilhos = new Set();
    this.topo = 10;
    this.gesto = null;
    this.aoAbrirNota = aoAbrirNota;
    this.aoRetomar = aoRetomar;
    this.aoLer = aoLer;
    this.instalar();
    this.aplicar();
    this.atualizarVazio();
  }

  // ---------------------------------------------------------------- vista (pan e zoom)

  instalar() {
    this.raiz.addEventListener("wheel", e => this.roda(e), { passive: false });
    this.raiz.addEventListener("pointerdown", e => this.apertar(e));
    window.addEventListener("pointermove", e => this.mover(e));
    window.addEventListener("pointerup", e => this.soltar(e));
    window.addEventListener("keydown", e => { if (e.key === "Escape" && this.gesto?.tipo === "ligar") this.cancelarGesto(); });
    window.addEventListener("resize", () => this.aplicar());
    document.addEventListener("pointerdown", e => { if (!e.target.closest("#menu-fio")) this.fecharMenu(); });
    $("#zoom-mais").onclick = () => this.zoomCentro(1.25);
    $("#zoom-menos").onclick = () => this.zoomCentro(0.8);
    $("#zoom-pct").onclick = () => this.zoomCentro(1 / this.v.z);
    $("#enquadrar").onclick = () => this.enquadrar(true);
    for (const b of document.querySelectorAll("[data-novo]")) b.onclick = () => this.aoNovo?.(b.dataset.novo);
  }

  // Camada acelerada só durante o gesto: no fim o navegador redesenha nítido na escala nova.
  movendo() {
    this.mundo.classList.add("movendo");
    clearTimeout(this.timerMovendo);
    this.timerMovendo = setTimeout(() => this.mundo.classList.remove("movendo"), 220);
  }

  agendar() {
    this.movendo();
    if (this.quadro) return;
    this.quadro = requestAnimationFrame(() => { this.quadro = 0; this.aplicar(); });
  }

  aplicar(animado = false) {
    const { x, y, z } = this.v;
    if (animado && !movimentoReduzido) {
      this.mundo.classList.add("animando", "movendo");
      clearTimeout(this.timerAnim);
      this.timerAnim = setTimeout(() => this.mundo.classList.remove("animando", "movendo"), 760);
    }
    this.mundo.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${z})`;
    this.grade.style.setProperty("--gs", `${28 * z}px`);
    this.grade.style.setProperty("--gx", `${x}px`);
    this.grade.style.setProperty("--gy", `${y}px`);
    $("#zoom-pct").textContent = `${Math.round(z * 100)}%`;
  }

  telaParaMundo(x, y) {
    return { x: (x - this.v.x) / this.v.z, y: (y - this.v.y) / this.v.z };
  }

  roda(e) {
    if (e.target.closest(".term, .conv-rolo")) return; // a roda dentro do cartão rola o conteúdo
    e.preventDefault();
    if (!e.ctrlKey && Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      this.v.x -= e.deltaX;
      this.v.y -= e.deltaY;
      this.agendar();
      return;
    }
    this.zoomNoPonto(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0016)), e.clientX, e.clientY);
  }

  zoomNoPonto(fator, cx, cy, animado = false) {
    const z = limitar(this.v.z * fator, 0.15, 2);
    const k = z / this.v.z;
    this.v.x = cx - (cx - this.v.x) * k;
    this.v.y = cy - (cy - this.v.y) * k;
    this.v.z = z;
    if (animado) this.aplicar(true);
    else this.agendar();
  }

  zoomCentro(fator) {
    this.zoomNoPonto(fator, innerWidth / 2, innerHeight / 2 + 30, true);
  }

  enquadrar(animado = true) {
    const lista = [...this.cartoes.values()];
    if (!lista.length) return;
    const x1 = Math.min(...lista.map(c => c.x)), y1 = Math.min(...lista.map(c => c.y));
    const x2 = Math.max(...lista.map(c => c.x + c.w)), y2 = Math.max(...lista.map(c => c.y + c.h));
    const z = limitar(Math.min((innerWidth - 120) / (x2 - x1), (innerHeight - 200) / (y2 - y1), 1), 0.15, 1);
    this.v = { z, x: innerWidth / 2 - ((x1 + x2) / 2) * z, y: (innerHeight + 50) / 2 - ((y1 + y2) / 2) * z };
    this.aplicar(animado);
  }

  focar(id) {
    const c = this.cartoes.get(id);
    if (!c) return;
    const z = limitar(Math.min(1, (innerWidth - 100) / c.w, (innerHeight - 190) / c.h), 0.2, 1);
    this.v = { z, x: innerWidth / 2 - (c.x + c.w / 2) * z, y: (innerHeight + 60) / 2 - (c.y + c.h / 2) * z };
    this.aplicar(true);
    this.trazerFrente(c);
    this.flash(c, "#ffffff");
    setTimeout(() => (c.modo === "terminal" ? c.term?.focus() : c.conv.focar()), 450);
  }

  // ---------------------------------------------------------------- gestos

  apertar(e) {
    const fundo = !e.target.closest(".cartao, .lembranca, .hud, .hero, .fio");
    if (e.button === 1 || (e.button === 0 && fundo)) {
      this.gesto = { tipo: "pan", x: e.clientX, y: e.clientY, vx: this.v.x, vy: this.v.y };
      this.raiz.classList.add("arrastando");
      e.preventDefault();
    }
  }

  mover(e) {
    const g = this.gesto;
    if (!g) return;
    const dx = e.clientX - g.x, dy = e.clientY - g.y;
    if (g.tipo === "pan") {
      this.v.x = g.vx + dx;
      this.v.y = g.vy + dy;
      this.agendar();
    } else if (g.tipo === "mover") {
      g.c.x = g.cx + dx / this.v.z;
      g.c.y = g.cy + dy / this.v.z;
      this.posicionar(g.c);
      this.redesenharFios(g.c.id);
    } else if (g.tipo === "redim") {
      g.c.w = Math.max(420, g.cw + dx / this.v.z);
      g.c.h = Math.max(300, g.ch + dy / this.v.z);
      this.posicionar(g.c);
      this.redesenharFios(g.c.id);
      cancelAnimationFrame(g.quadro);
      g.quadro = requestAnimationFrame(() => this.ajustarTerm(g.c));
    } else if (g.tipo === "ligar") {
      this.atualizarLigacao(e);
    }
  }

  soltar() {
    const g = this.gesto;
    if (!g) return;
    this.gesto = null;
    this.raiz.classList.remove("arrastando");
    if (g.tipo === "mover" || g.tipo === "redim") {
      if (g.tipo === "redim") this.ajustarTerm(g.c);
      this.salvarPosicao(g.c);
    } else if (g.tipo === "ligar") {
      this.terminarLigacao(g);
    }
  }

  cancelarGesto() {
    const g = this.gesto;
    this.gesto = null;
    if (g?.tipo === "ligar") {
      g.temp.remove();
      g.alvo?.el.classList.remove("alvo-ligacao");
      this.raiz.classList.remove("ligando");
    }
  }

  // ---------------------------------------------------------------- cartões

  carregar({ janelas, conexoes }) {
    janelas.forEach((info, i) => {
      const c = this.adicionar(info);
      if (c) c.el.style.animationDelay = `${i * 90}ms`;
    });
    setTimeout(() => {
      for (const { a, b, revisa } of conexoes) { this.ligar(a, b, { nascendo: true }); if (revisa) this.marcarRevisao(a, b, revisa); }
    }, janelas.length * 90 + 350);
    if (janelas.length) this.enquadrar(false);
  }

  lugarNoCentro() {
    const centro = this.telaParaMundo(innerWidth / 2, innerHeight / 2 + 30);
    let x = centro.x - TAM.w / 2, y = centro.y - TAM.h / 2;
    for (let i = 0; i < 12; i++) {
      const bate = [...this.cartoes.values()].some(c => Math.abs(c.x - x) < TAM.w && Math.abs(c.y - y) < TAM.h);
      if (!bate) break;
      x += TAM.w + 120;
      if (i % 3 === 2) { x -= 3 * (TAM.w + 120); y += TAM.h + 110; }
    }
    return { x, y, w: TAM.w, h: TAM.h };
  }

  adicionar(info) {
    if (this.cartoes.has(info.id)) {
      this.atualizar(info);
      return null;
    }
    const p = info.posicao || this.lugarNoCentro();
    const cor = corModelo(info.modelo);
    const c = {
      id: info.id, info, cor, x: p.x, y: p.y, w: p.w || TAM.w, h: p.h || TAM.h,
      viva: info.aberta !== false && !info.encerrada, fila: 0, lemb: 0, modo: "conversa",
    };
    const maestro = info.papel === "maestro";
    c.elNome = el("span", { class: "cab-nome", text: info.nome, title: info.nome });
    c.elEstado = el("span", { class: "estado" });
    c.btnConversa = el("button", { class: "ativo", text: "Conversa", title: "Texto legível (não gasta token)" });
    c.btnTerminal = el("button", { text: "Terminal", title: `O terminal de verdade do ${info.agente || "agente"}` });
    const btnLer = el("button", { class: "cab-btn", title: "Abrir no leitor grande", text: "⤢" });
    const btnFechar = el("button", { class: "cab-btn fechar", title: "Encerrar a janela", text: "×" });
    const cab = el("header", { class: "cab" },
      el("span", { class: "orbe" }), c.elNome,
      el("span", { class: `tag${maestro ? " maestro" : ""}`, text: maestro ? "♛ Maestro" : nomePapel(info.papel) }),
      info.provedor && info.provedor !== "claude" ? el("span", { class: "tag agente", text: info.agente || info.provedor }) : null,
      el("span", { class: "tag modelo", text: info.nome_modelo || nomeModelo(info.modelo) }),
      c.elEstado,
      el("div", { class: "modos" }, c.btnConversa, c.btnTerminal),
      btnLer, btnFechar);
    c.conv = new Conversa(info.id, { cor, nome: info.nome, aoTerminal: () => this.modo(c, "terminal") });
    c.elTerm = el("div", { class: "term", hidden: true });
    c.elAcao = el("span", { class: "acao" });
    c.elCaixa = el("span", { class: "caixa" });
    const portas = ["d", "e", "c", "b"].map(lado =>
      el("span", { class: `porta ${lado}`, "data-lado": lado, title: "Arraste até outro agente para ligar" }));
    const redim = el("span", { class: "redim", title: "Redimensionar" });
    c.el = el("div", { class: "cartao", "data-id": info.id, style: { "--cor": cor } },
      el("div", { class: "anel" }, el("i")),
      el("div", { class: "cartao-fundo" }),
      cab,
      el("div", { class: "corpo" }, c.conv.el, c.elTerm),
      el("div", { class: "rodape" }, c.elAcao, c.elCaixa),
      ...portas, redim);
    c.el.addEventListener("animationend", ev => { if (ev.animationName === "surgir") c.el.style.animation = "none"; });
    this.camada.append(c.el);
    this.posicionar(c);
    this.cartoes.set(info.id, c);
    this.trazerFrente(c);

    cab.addEventListener("pointerdown", e => {
      if (e.button !== 0 || e.target.closest("button")) return;
      e.stopPropagation();
      this.gesto = { tipo: "mover", c, x: e.clientX, y: e.clientY, cx: c.x, cy: c.y };
    });
    cab.addEventListener("dblclick", e => { if (!e.target.closest("button")) this.focar(c.id); });
    c.btnConversa.onclick = () => this.modo(c, "conversa");
    c.btnTerminal.onclick = () => this.modo(c, "terminal");
    btnLer.onclick = () => this.aoLer?.(c.id);
    btnFechar.onclick = () => this.encerrar(c);
    redim.addEventListener("pointerdown", e => {
      e.stopPropagation();
      this.gesto = { tipo: "redim", c, x: e.clientX, y: e.clientY, cw: c.w, ch: c.h };
    });
    for (const porta of portas) {
      porta.addEventListener("pointerdown", e => {
        e.stopPropagation();
        e.preventDefault();
        this.comecarLigacao(c, porta.dataset.lado, e);
      });
    }
    c.el.addEventListener("pointerdown", () => this.trazerFrente(c));
    // arquivos soltos em qualquer parte do cartão vão para a pasta deste agente
    const temArquivo = e => [...(e.dataTransfer?.types || [])].includes("Files");
    c.el.addEventListener("dragover", e => { if (temArquivo(e)) { e.preventDefault(); c.el.classList.add("soltando"); } });
    c.el.addEventListener("dragleave", e => { if (!c.el.contains(e.relatedTarget)) c.el.classList.remove("soltando"); });
    c.el.addEventListener("drop", e => {
      c.el.classList.remove("soltando");
      if (!temArquivo(e) || !c.viva) return;
      e.preventDefault();
      if (c.modo !== "conversa") this.modo(c, "conversa");
      c.conv.mandarArquivos([...e.dataTransfer.files]);
    });

    c.conv.carregar();
    this.marcarEstado(c, c.viva ? info.estado : "encerrada");
    if (info.pergunta) c.conv.pergunta(info.pergunta);
    if (!c.viva) this.marcarEncerrada(c.id);
    else if (info.tem_conversa === false) this.modo(c, "terminal"); // este CLI não deixa a conversa num arquivo legível
    this.atualizarVazio();
    return c;
  }

  modo(c, modo) {
    if (c.modo === modo) return;
    c.modo = modo;
    c.btnConversa.classList.toggle("ativo", modo === "conversa");
    c.btnTerminal.classList.toggle("ativo", modo === "terminal");
    c.conv.el.hidden = modo !== "conversa";
    c.elTerm.hidden = modo !== "terminal";
    if (modo === "terminal") {
      if (!c.term) this.criarTerminal(c);
      if (c.viva && !c.ws) this.conectarTerm(c);
      requestAnimationFrame(() => { this.ajustarTerm(c); c.term.focus(); });
    } else {
      // terminal escondido não precisa receber nada: corta o WebSocket e o custo de desenhar
      c.ws?.fechar();
      c.ws = null;
      c.conv.atualizar();
      setTimeout(() => c.conv.focar(), 50);
    }
  }

  atualizar(info) {
    const c = this.cartoes.get(info.id);
    if (!c) return;
    c.info = info;
    if (info.aberta && !c.viva) this.reviver(c);
    else if (!info.aberta && c.viva) this.marcarEncerrada(c.id);
  }

  posicionar(c) {
    Object.assign(c.el.style, { left: `${c.x}px`, top: `${c.y}px`, width: `${c.w}px`, height: `${c.h}px` });
  }

  trazerFrente(c) {
    if (c.el.style.zIndex !== String(this.topo)) c.el.style.zIndex = String(++this.topo);
  }

  salvarPosicao(c) {
    api(`/api/posicoes/${c.id}`, {
      method: "PUT", json: { x: Math.round(c.x), y: Math.round(c.y), w: Math.round(c.w), h: Math.round(c.h) },
    }).catch(() => {});
  }

  marcarEstado(c, estado) {
    c.estado = estado;
    const ocupado = OCUPADO.has(estado), atencao = ATENCAO.has(estado);
    c.el.classList.toggle("ocupado", ocupado);
    c.el.classList.toggle("atencao", atencao);
    c.elEstado.className = `estado${ocupado ? " ocupado" : atencao ? " atencao" : ""}`;
    c.elEstado.textContent = ROTULO[estado] || estado || "";
    c.conv.estado(estado);
  }

  estado(id, estado, resumo, pergunta) {
    const c = this.cartoes.get(id);
    if (!c || !c.viva) return;
    if (estado) this.marcarEstado(c, estado);
    if (pergunta !== undefined) c.conv.pergunta(pergunta);
    if (resumo) {
      c.elAcao.textContent = resumo;
      c.elAcao.classList.remove("nova");
      void c.elAcao.offsetWidth;
      c.elAcao.classList.add("nova");
    }
  }

  marcarEncerrada(id) {
    const c = this.cartoes.get(id);
    if (!c) return;
    c.viva = false;
    this.marcarEstado(c, "encerrada");
    c.el.classList.add("encerrada");
    c.ws?.fechar();
    c.ws = null;
    c.elFim?.remove();
    c.elFim = el("div", { class: "fim-janela" },
      el("div", { class: "discreto", text: "Janela encerrada. A conversa ficou salva." }),
      el("div", { class: "linha" },
        el("button", { class: "btn-brilho pequeno", onclick: () => this.aoRetomar(c.info) }, el("span", { text: "Retomar" })),
        el("button", { class: "btn pequeno", onclick: () => this.remover(id), text: "Tirar do palco" })));
    c.el.append(c.elFim);
  }

  reviver(c) {
    c.viva = true;
    c.el.classList.remove("encerrada");
    c.elFim?.remove();
    c.elFim = null;
    this.marcarEstado(c, "iniciando");
    if (c.modo === "terminal") this.conectarTerm(c);
    c.conv.carregar();
    this.flash(c, c.cor);
  }

  remover(id) {
    const c = this.cartoes.get(id);
    if (!c) return;
    for (const f of [...this.fios.values()]) if (f.a === id || f.b === id) this.desligarLocal(f.a, f.b);
    this.cartoes.delete(id);
    c.ws?.fechar();
    c.el.style.transition = "transform .45s var(--suave), opacity .45s";
    c.el.style.transform = "scale(.88)";
    c.el.style.opacity = "0";
    setTimeout(() => { c.term?.dispose(); c.el.remove(); this.atualizarVazio(); }, 460);
  }

  async encerrar(c) {
    if (!c.viva) { this.remover(c.id); return; }
    if (!confirm(`Encerrar “${c.info.nome}”? A conversa fica salva e dá para retomar.`)) return;
    try { await api(`/api/sessoes/${c.id}/encerrar`, { method: "POST" }); }
    catch (e) { avisar({ texto: e.message, cor: "#ff6b7d" }); }
  }

  atualizarVazio() {
    $("#vazio-palco").hidden = this.cartoes.size > 0;
  }

  flash(c, cor) {
    if (movimentoReduzido) return;
    const brilho = el("div", { class: "flash", style: { "--f": cor } });
    c.el.append(brilho);
    brilho.addEventListener("animationend", () => brilho.remove(), { once: true });
  }

  // ---------------------------------------------------------------- terminal

  criarTerminal(c) {
    const term = new Terminal({
      fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, monospace', fontSize: 13, lineHeight: 1.12,
      cursorBlink: true, scrollback: 8000, allowTransparency: false,
      theme: {
        background: "#0b0f17", foreground: "#dfe6f3", cursor: c.cor, cursorAccent: "#0a0d14",
        selectionBackground: "rgba(139,123,255,.35)",
      },
    });
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(c.elTerm);
    try {
      // desenho por GPU: muito mais leve que o padrão (DOM) com o claude atualizando a tela
      const gl = new WebglAddon.WebglAddon();
      gl.onContextLoss(() => gl.dispose());
      term.loadAddon(gl);
    } catch { /* sem WebGL: fica no padrão */ }
    c.term = term;
    c.fit = fit;
    term.onData(d => this.enviarTerm(c, { t: "in", d }));
    term.onResize(({ cols, rows }) => this.enviarTerm(c, { t: "tam", c: cols, l: rows }));
  }

  conectarTerm(c) {
    const canal = window.engram.terminal.abrir(c.id, {
      aoInicio: () => { c.term.reset(); requestAnimationFrame(() => this.ajustarTerm(c)); },
      aoDados: dados => c.term.write(dados),
      aoFim: () => { if (c.ws === canal) c.ws = null; },
    });
    c.ws = canal;
  }

  enviarTerm(c, msg) {
    if (!c.ws) return;
    if (msg.t === "in") c.ws.enviar(msg.d);
    else if (msg.t === "tam") c.ws.tamanho(msg.c, msg.l);
  }

  ajustarTerm(c) {
    if (!c.term || c.modo !== "terminal") return;
    try { c.fit.fit(); } catch { /* cartão ainda sem tamanho */ }
    this.enviarTerm(c, { t: "tam", c: c.term.cols, l: c.term.rows });
  }

  // ---------------------------------------------------------------- linhas entre agentes

  chave(a, b) {
    return a < b ? `${a}|${b}` : `${b}|${a}`;
  }

  ligar(a, b, { nascendo = false } = {}) {
    const k = this.chave(a, b);
    if (this.fios.has(k) || !this.cartoes.has(a) || !this.cartoes.has(b)) return;
    const [pa, pb] = a < b ? [a, b] : [b, a];
    const id = `g${k.replace(/[^a-z0-9]/gi, "")}`;
    const s1 = svg("stop", { offset: "0" }), s2 = svg("stop", { offset: "1" });
    const grad = svg("linearGradient", { id, gradientUnits: "userSpaceOnUse" });
    grad.append(s1, s2);
    this.gGrad.append(grad);
    const url = `url(#${id})`;
    const f = {
      k, a: pa, b: pb, grad, s1, s2,
      halo: svg("path", { class: "halo", stroke: url }),
      linha: svg("path", { class: "linha", stroke: url }),
      fluxo: svg("path", { class: "fluxo" }),
      alvo: svg("path", { class: "alvo" }),
      selo: svg("g", { class: "selo-revisao" }),
      g: svg("g", { class: `fio${nascendo && !movimentoReduzido ? " nascendo" : ""}` }),
      revisa: null,
    };
    const fundo = svg("rect", { x: -38, y: -11, width: 76, height: 22, rx: 11 });
    const rotulo = svg("text", { x: 0, y: 4, "text-anchor": "middle" });
    rotulo.textContent = "✓ revisão";
    f.selo.append(fundo, rotulo);
    f.g.append(f.halo, f.linha, f.fluxo, f.alvo, f.selo);
    this.gFios.append(f.g);
    f.alvo.addEventListener("click", e => this.menuFio(f, e));
    this.fios.set(k, f);
    this.desenharFio(f);
    if (nascendo) {
      f.g.style.setProperty("--len", String(Math.ceil(f.linha.getTotalLength())));
      setTimeout(() => f.g.classList.remove("nascendo"), 1400);
    }
  }

  desligarLocal(a, b) {
    const f = this.fios.get(this.chave(a, b));
    if (!f) return;
    this.fios.delete(f.k);
    f.g.classList.add("morrendo");
    setTimeout(() => { f.g.remove(); f.grad.remove(); }, 470);
  }

  curva(A, B) {
    const ca = { x: A.x + A.w / 2, y: A.y + A.h / 2 }, cb = { x: B.x + B.w / 2, y: B.y + B.h / 2 };
    const dx = cb.x - ca.x, dy = cb.y - ca.y;
    let pa, pb, na, nb;
    if (Math.abs(dx) * (A.h + B.h) >= Math.abs(dy) * (A.w + B.w)) {
      if (dx >= 0) { pa = { x: A.x + A.w, y: ca.y }; na = NORMAL.d; pb = { x: B.x, y: cb.y }; nb = NORMAL.e; }
      else { pa = { x: A.x, y: ca.y }; na = NORMAL.e; pb = { x: B.x + B.w, y: cb.y }; nb = NORMAL.d; }
    } else if (dy >= 0) { pa = { x: ca.x, y: A.y + A.h }; na = NORMAL.b; pb = { x: cb.x, y: B.y }; nb = NORMAL.c; }
    else { pa = { x: ca.x, y: A.y }; na = NORMAL.c; pb = { x: cb.x, y: B.y + B.h }; nb = NORMAL.b; }
    const k = limitar(Math.hypot(pb.x - pa.x, pb.y - pa.y) * 0.45, 50, 320);
    return {
      d: `M ${pa.x} ${pa.y} C ${pa.x + na[0] * k} ${pa.y + na[1] * k}, ${pb.x + nb[0] * k} ${pb.y + nb[1] * k}, ${pb.x} ${pb.y}`,
      pa, pb,
    };
  }

  desenharFio(f) {
    const A = this.cartoes.get(f.a), B = this.cartoes.get(f.b);
    if (!A || !B) return;
    const { d, pa, pb } = this.curva(A, B);
    for (const p of [f.halo, f.linha, f.fluxo, f.alvo]) p.setAttribute("d", d);
    f.grad.setAttribute("x1", pa.x); f.grad.setAttribute("y1", pa.y);
    f.grad.setAttribute("x2", pb.x); f.grad.setAttribute("y2", pb.y);
    f.s1.setAttribute("stop-color", A.cor);
    f.s2.setAttribute("stop-color", B.cor);
    if (f.revisa) {
      // o selo fica perto de quem revisa
      const total = f.linha.getTotalLength();
      const p = f.linha.getPointAtLength(total * (f.revisa === f.b ? 0.72 : 0.28));
      f.selo.setAttribute("transform", `translate(${p.x} ${p.y})`);
    }
  }

  /** A ligação a-b passa a ter revisão (revisa = a ponta que revisa) ou deixa de ter (null). */
  marcarRevisao(a, b, revisa) {
    const f = this.fios.get(this.chave(a, b));
    if (!f) return;
    f.revisa = revisa || null;
    f.g.classList.toggle("revisao", !!f.revisa);
    // o fluxo corre na direção de quem revisa
    f.g.classList.toggle("para-a", f.revisa === f.a);
    this.desenharFio(f);
  }

  redesenharFios(id) {
    for (const f of this.fios.values()) if (!id || f.a === id || f.b === id) this.desenharFio(f);
  }

  pontoPorta(c, lado) {
    return {
      d: { x: c.x + c.w, y: c.y + c.h / 2 }, e: { x: c.x, y: c.y + c.h / 2 },
      c: { x: c.x + c.w / 2, y: c.y }, b: { x: c.x + c.w / 2, y: c.y + c.h },
    }[lado];
  }

  comecarLigacao(c, lado, e) {
    const temp = svg("path", { class: "fio-temp", stroke: c.cor });
    this.gFios.append(temp);
    this.gesto = { tipo: "ligar", c, lado, p: this.pontoPorta(c, lado), temp, alvo: null, x: e.clientX, y: e.clientY };
    this.raiz.classList.add("ligando");
    this.atualizarLigacao(e);
  }

  atualizarLigacao(e) {
    const g = this.gesto;
    const sob = document.elementFromPoint(e.clientX, e.clientY)?.closest(".cartao");
    const alvo = sob && sob.dataset.id !== g.c.id ? this.cartoes.get(sob.dataset.id) : null;
    if (g.alvo !== alvo) {
      g.alvo?.el.classList.remove("alvo-ligacao");
      alvo?.el.classList.add("alvo-ligacao");
      g.alvo = alvo;
    }
    const fim = alvo ? this.curva(g.c, alvo).pb : this.telaParaMundo(e.clientX, e.clientY);
    const n = NORMAL[g.lado];
    const k = limitar(Math.hypot(fim.x - g.p.x, fim.y - g.p.y) * 0.45, 40, 280);
    g.temp.setAttribute("d", `M ${g.p.x} ${g.p.y} C ${g.p.x + n[0] * k} ${g.p.y + n[1] * k}, ${fim.x} ${fim.y}, ${fim.x} ${fim.y}`);
  }

  async terminarLigacao(g) {
    g.temp.remove();
    this.raiz.classList.remove("ligando");
    g.alvo?.el.classList.remove("alvo-ligacao");
    if (!g.alvo) return;
    if (!g.c.viva || !g.alvo.viva) {
      avisar({ texto: "Só dá para ligar janelas abertas.", cor: "#ffc857" });
      return;
    }
    if (this.fios.has(this.chave(g.c.id, g.alvo.id))) return;
    this.ligar(g.c.id, g.alvo.id, { nascendo: true });
    try {
      await api("/api/conexoes", { json: { a: g.c.id, b: g.alvo.id } });
      avisar({ rota: `${g.c.info.nome} ⟷ ${g.alvo.info.nome}`, texto: "ligados: agora eles conversam", cor: g.c.cor });
    } catch (err) {
      this.desligarLocal(g.c.id, g.alvo.id);
      avisar({ texto: err.message, cor: "#ff6b7d" });
    }
  }

  menuFio(f, e) {
    const A = this.cartoes.get(f.a), B = this.cartoes.get(f.b);
    const nA = A?.info.nome || "?", nB = B?.info.nome || "?";
    const menu = $("#menu-fio");
    const revisao = async revisor => {
      this.fecharMenu();
      try { await api("/api/conexoes/revisao", { json: { a: f.a, b: f.b, revisor } }); } catch (err) { avisar({ texto: err.message, cor: "#ff6b7d" }); }
    };
    const opcao = (revisor, texto) => el("button", { class: `revisar${f.revisa === revisor ? " marcado" : ""}`, onclick: () => revisao(revisor) },
      el("b", { text: f.revisa === revisor ? "✓ " : "" }), texto);
    menu.replaceChildren(
      el("small", { class: "menu-titulo", text: "Revisão das entregas" }),
      opcao(f.b, `${nB} revisa o que ${nA} entrega`),
      opcao(f.a, `${nA} revisa o que ${nB} entrega`),
      f.revisa ? el("button", { class: "revisar", onclick: () => revisao(null) }, "Sem revisão") : null,
      el("hr"),
      el("button", {
        text: `Desligar ${nA} ⟷ ${nB}`,
        onclick: async () => {
          this.fecharMenu();
          try { await api("/api/conexoes/remover", { json: { a: f.a, b: f.b } }); } catch { /* some na próxima carga */ }
          this.desligarLocal(f.a, f.b);
        },
      }));
    Object.assign(menu.style, { left: `${e.clientX + 6}px`, top: `${e.clientY + 6}px` });
    menu.hidden = false;
  }

  fecharMenu() {
    $("#menu-fio").hidden = true;
  }

  // ---------------------------------------------------------------- mensagens e pensamentos

  mensagem(de, para, fase) {
    const D = this.cartoes.get(para);
    if (!D) return;
    if (fase === "enviada") {
      D.fila++;
      this.particula(de, para);
    } else if (fase === "entregue") {
      D.fila = Math.max(0, D.fila - 1);
    }
    D.elCaixa.textContent = D.fila > 1 ? `✉ ${D.fila - 1} na fila` : "";
  }

  // brilho por gradiente radial (um por cor), sem filtro de blur
  brilho(cor) {
    const id = `b${cor.replace(/[^a-z0-9]/gi, "")}`;
    if (!this.brilhos.has(id)) {
      const g = svg("radialGradient", { id });
      g.append(svg("stop", { offset: "0", "stop-color": "#ffffff", "stop-opacity": "1" }),
        svg("stop", { offset: ".25", "stop-color": cor, "stop-opacity": ".9" }),
        svg("stop", { offset: "1", "stop-color": cor, "stop-opacity": "0" }));
      this.gGrad.append(g);
      this.brilhos.add(id);
    }
    return `url(#${id})`;
  }

  particula(de, para) {
    const C = this.cartoes.get(de), D = this.cartoes.get(para);
    if (!C || !D) return;
    const f = this.fios.get(this.chave(de, para));
    if (f) {
      f.g.classList.add("ativo");
      clearTimeout(f.timer);
      f.timer = setTimeout(() => f.g.classList.remove("ativo"), 2400);
    }
    if (movimentoReduzido) { this.flash(D, C.cor); return; }
    const caminho = f?.linha;
    const comprimento = caminho ? caminho.getTotalLength() : 0;
    const reverso = f ? f.a !== de : false;
    const ca = { x: C.x + C.w / 2, y: C.y + C.h / 2 }, cb = { x: D.x + D.w / 2, y: D.y + D.h / 2 };
    const pos = t => {
      t = limitar(t, 0, 1);
      if (caminho) return caminho.getPointAtLength((reverso ? 1 - t : t) * comprimento);
      return { x: ca.x + (cb.x - ca.x) * t, y: ca.y + (cb.y - ca.y) * t };
    };
    const preenchimento = this.brilho(C.cor);
    const rastro = [];
    for (let i = 0; i < 6; i++) {
      const p = svg("circle", { r: i === 0 ? 16 : Math.max(4, 12 - i * 1.6), fill: preenchimento, opacity: i === 0 ? 1 : Math.max(0.2, 0.8 - i * 0.12) });
      this.gPart.append(p);
      rastro.push(p);
    }
    const duracao = 1300, atraso = 0.04, t0 = performance.now();
    const quadro = agora => {
      const t = (agora - t0) / duracao;
      rastro.forEach((p, i) => {
        const q = pos(suave(t - i * atraso));
        p.setAttribute("cx", q.x);
        p.setAttribute("cy", q.y);
      });
      if (t < 1 + rastro.length * atraso) requestAnimationFrame(quadro);
      else {
        rastro.forEach(p => p.remove());
        this.onda(pos(1), C.cor);
        this.flash(D, C.cor);
      }
    };
    requestAnimationFrame(quadro);
  }

  onda(p, cor) {
    for (let i = 0; i < 2; i++) {
      const o = svg("circle", { class: "onda", cx: p.x, cy: p.y, r: 4, stroke: cor });
      o.style.animationDelay = `${i * 160}ms`;
      this.gPart.append(o);
      setTimeout(() => o.remove(), 1200);
    }
  }

  lembranca(id, destino, tipo, ehNota) {
    const c = this.cartoes.get(id);
    if (!c) return;
    const i = c.lemb++ % 7;
    const chip = el("div", {
      class: "lembranca",
      style: { "--cor": COR_LIGACAO[tipo] || "#8fb2ff", left: `${c.x + c.w + 22}px`, top: `${c.y + 14 + i * 38}px` },
      title: ehNota ? "Abrir a nota" : "",
    }, el("b", { text: tipo }), destino);
    if (ehNota) chip.onclick = () => this.aoAbrirNota(destino);
    this.camadaLemb.append(chip);
    chip.addEventListener("animationend", () => chip.remove(), { once: true });
  }
}
