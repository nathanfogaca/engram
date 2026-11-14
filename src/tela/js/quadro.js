// Quadro de tarefas do maestro: uma folha que sobe de baixo, com quatro colunas (delegada, em andamento,
// devolvida, entregue), a devolutiva no cartão, a leitura inteira e o diário do palco guardado no cérebro.
// As tarefas vêm do main (GET /api/tarefas e o evento ao vivo "tarefa"); só as do palco que está na tela.

import { $, el, api, avisar, movimentoReduzido } from "./util.js";

const ESTADOS = ["delegada", "andamento", "devolvida", "entregue"];
const ROTULO = { delegada: "Delegada", andamento: "Em andamento", devolvida: "Devolvida", entregue: "Entregue" };
const DICA = { delegada: "na fila do colega", andamento: "o colega está nela", devolvida: "esperando você", entregue: "conferida" };
const DIAS = { hoje: 1, 3: 3, tudo: 3650 };
const COR_PADRAO = "#8b95aa";

let _md = null;
const md = () => (_md ||= window.markdownit({ html: false, linkify: true, breaks: false }).disable("image")); // sem imagens: o texto é de agente e uma imagem dispararia um GET
function markdown(texto, classe = "md") {
  const caixa = el("div", { class: classe });
  caixa.innerHTML = md().render(texto || ""); // markdown-it com HTML desligado
  for (const a of caixa.querySelectorAll("a")) { a.target = "_blank"; a.rel = "noopener noreferrer"; }
  return caixa;
}

const hh = d => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
const data = s => (s ? new Date(s) : null); // "AAAA-MM-DDTHH:MM:SS" sem fuso = horário local
const dia2 = n => String(n).padStart(2, "0");
const idDiario = (d = new Date()) => `diario-${d.getFullYear()}-${dia2(d.getMonth() + 1)}-${dia2(d.getDate())}`;
function haTexto(d) {
  if (!d) return "";
  const m = Math.max(0, Math.round((Date.now() - d.getTime()) / 60000));
  return m < 1 ? "agora" : m < 60 ? `${m} min` : m < 1440 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${Math.floor(m / 1440)} d`;
}
/** Quando a tarefa chegou no estado em que está. */
function momento(t) {
  const k = { delegada: t.criada, andamento: t.andamento || t.criada, devolvida: t.devolvida || t.andamento || t.criada, entregue: t.entregue || t.devolvida || t.criada }[t.estado];
  return data(k) || new Date(0);
}

export class Quadro {
  constructor({ palco, palcos, aoAbrirNota }) {
    this.palco = palco;
    this.palcos = palcos;
    this.aoAbrirNota = aoAbrirNota;
    this.tarefas = new Map(); // n → tarefa
    this.aberto = false;
    this.aba = "quadro";
    this.filtro = "hoje";
    this.pronto = false; // depois da primeira carga, o que chega de novo nasce com animação
    this.lendo = null;
    this.linhasDiario = new Set();
    this.raiz = $("#palco");
    this.folha = $("#folha");
    this.leitura = $("#q-leitura");
    this.montar();
    palco.aoChip = t => { this.abrir(true); setTimeout(() => this.focar(t.n), 500); };
    setInterval(() => { if (this.aberto && this.aba === "quadro") for (const e of this.folha.querySelectorAll(".ha[data-n]")) { const t = this.tarefas.get(Number(e.dataset.n)); if (t) e.textContent = haTexto(momento(t)); } }, 30000);
  }

  // ---------------------------------------------------------------- montagem

  montar() {
    $("#btn-quadro").onclick = () => this.abrir(!this.aberto);
    $("#q-fechar").onclick = () => this.abrir(false);
    $("#q-abas").onclick = e => { const b = e.target.closest("button"); if (b) this.mostrarAba(b.dataset.aba); };
    $("#q-filtro").onclick = e => {
      const b = e.target.closest("button");
      if (!b) return;
      this.filtro = b.dataset.f;
      for (const x of $("#q-filtro").children) x.classList.toggle("on", x === b);
      this.carregar();
    };
    const box = $("#q-colunas");
    box.replaceChildren(...ESTADOS.map(e => el("div", { class: `q-col ${e}`, style: { "--c": `var(--c-${e})` }, "data-estado": e },
      el("h3", {}, el("i"), ROTULO[e], el("small", { text: `· ${DICA[e]}` }), el("span", { class: "n", text: "0" })),
      el("div", { class: "q-lista" }))));
    this.folha.addEventListener("pointerdown", e => e.stopPropagation()); // não arrasta o palco por baixo
    this.leitura.addEventListener("pointerdown", e => e.stopPropagation());
    this.folha.addEventListener("wheel", e => e.stopPropagation());
    this.leitura.addEventListener("wheel", e => e.stopPropagation());
    $("#folha-palco").textContent = this.palcos.nomeDe(this.palcos.atual);
  }

  abrir(sim, silencioso = false) {
    if (sim) this.aoAbrir?.();
    this.aberto = sim;
    this.raiz.classList.toggle("quadro-aberto", sim);
    document.body.classList.toggle("folha-aberta", sim);
    this.folha.setAttribute("aria-hidden", String(!sim));
    $("#btn-quadro").classList.toggle("on", sim);
    $("#btn-quadro").setAttribute("aria-expanded", String(sim));
    if (!sim) this.fecharLeitura();
    this.palco.reservaBaixo = sim ? Math.round(innerHeight * 0.52 - 40) : 0;
    if (this.palco.cartoes.size && !silencioso) this.palco.enquadrar(true);
    if (sim) { this.carregar(); if (this.aba === "diario") this.carregarDiario(); }
  }

  escape() {
    if (this.leitura.classList.contains("on")) { this.fecharLeitura(); return true; }
    if (this.aberto) { this.abrir(false); return true; }
    return false;
  }

  mostrarAba(qual) {
    this.aba = qual;
    for (const b of $("#q-abas").children) b.classList.toggle("on", b.dataset.aba === qual);
    $("#q-colunas").hidden = qual !== "quadro";
    $("#q-diario").hidden = qual !== "diario";
    $("#q-filtro").style.visibility = qual === "quadro" ? "visible" : "hidden";
    if (qual === "diario") this.carregarDiario();
  }

  // ---------------------------------------------------------------- dados

  async carregar() {
    $("#folha-palco").textContent = this.palcos.nomeDe(this.palcos.atual);
    try {
      const lista = await api(`/api/tarefas?palco=${this.palcos.atual}&dias=${DIAS[this.filtro]}`);
      this.tarefas = new Map((lista || []).map(t => [t.n, t]));
    } catch { return; }
    this.desenhar();
    this.pronto = true;
  }

  /** Troca de palco: o quadro mostra as tarefas do palco novo. */
  trocouPalco() {
    this.tarefas = new Map();
    this.pronto = false;
    this.fecharLeitura();
    this.desenhar();
    this.carregar();
  }

  aoVivo(m) {
    const t = m.tarefa;
    if (!t) return;
    if (Number.isInteger(t.palco) && t.palco !== this.palcos.atual) return;
    const antes = this.tarefas.get(t.n);
    this.tarefas.set(t.n, { ...(antes || {}), ...t });
    this.desenhar();
    if (m.acao === "devolvida") avisar({ rota: `${t.nome_devolutiva_de || t.nome_para || "Um agente"} devolveu`, texto: t.assunto, cor: "#ffc857", tempo: 7000 });
    if (this.lendo === t.n) this.ler(t.n, { manterAberto: true });
    if (this.aberto && this.aba === "diario") setTimeout(() => this.carregarDiario(), 600);
  }

  async entregar(n) {
    try {
      const t = await api(`/api/tarefas/${n}/entregue`, { method: "POST" });
      if (t?.n) { this.tarefas.set(t.n, { ...(this.tarefas.get(t.n) || {}), ...t }); this.desenhar(); }
    } catch (e) { avisar({ texto: `Não marcou como entregue: ${e.message}`, cor: "#ff6b7d" }); }
  }

  // ---------------------------------------------------------------- o quadro

  corDe(id) { return this.palco.cartoes.get(id)?.cor || COR_PADRAO; }
  setorCor(nome) { return [...this.palco.setores.lista.values()].find(s => s.nome === nome)?.cor; }

  visiveis(e) {
    const hoje = idDiario().slice(7);
    return [...this.tarefas.values()].filter(t => t.estado === e && (e !== "entregue" || this.filtro !== "hoje" || String(t.entregue || "").slice(0, 10) === hoje))
      .sort((a, b) => momento(b) - momento(a));
  }

  cartao(t) {
    const ida = t.estado === "delegada" || t.estado === "andamento";
    const pessoa = (nome, id) => el("span", { class: "p", style: { "--pc": this.corDe(id) } }, el("i"), el("span", { text: nome || "?" }));
    const quem = ida ? [pessoa(t.nome_de, t.de), el("span", { class: "seta", text: "→" }), pessoa(t.nome_para, t.para)]
      : [pessoa(t.nome_devolutiva_de || t.nome_para, t.devolutiva_de || t.para), el("span", { class: "seta", text: "↩" }), pessoa(t.nome_de, t.de)];
    const cor = t.setor ? this.setorCor(t.setor) : null;
    const c = el("div", { class: `q-tarefa ${t.estado}`, "data-n": t.n, "data-est": t.estado, style: { "--tc": `var(--c-${t.estado})` } },
      el("div", { class: "q-quem" }, ...quem, el("span", { class: "ha", "data-n": t.n, text: haTexto(momento(t)) })),
      el("p", { class: "q-assunto", text: t.assunto, title: t.assunto }),
      el("div", { class: "q-tags" }, el("span", { text: `#${t.n}` }),
        t.setor ? el("span", { class: "setor-t", style: { "--sc": cor || COR_PADRAO }, text: t.setor }) : null,
        data(t.criada) ? el("span", { text: `delegada às ${hh(data(t.criada))}` }) : null),
      t.devolutiva ? el("div", { class: "q-dev" }, markdown(t.devolutiva, "")) : null,
      t.estado === "devolvida" ? el("div", { class: "q-acoes" }, el("button", { "data-ver": "", text: "Ver tudo" }), el("button", { class: "ok", "data-ok": "", text: "✓ Entregue" })) : null,
      t.estado === "entregue" ? el("div", { class: "q-marcou", text: `marcada como entregue por ${t.marcou === "pessoa" ? "você" : this.palcos.nomeAgente(t.marcou) || "o maestro"}` }) : null);
    c.onclick = ev => {
      if (ev.target.closest("[data-ok]")) { ev.stopPropagation(); this.entregar(t.n); return; }
      if (ev.target.closest("a")) return;
      this.ler(t.n);
    };
    return c;
  }

  desenhar() {
    // posição dos cartões de agora, para eles voarem de uma coluna à outra quando mudam de estado (FLIP)
    const antes = new Map([...this.folha.querySelectorAll(".q-tarefa")].map(c => [Number(c.dataset.n), { r: c.getBoundingClientRect(), est: c.dataset.est }]));
    const rolagem = new Map([...this.folha.querySelectorAll(".q-col")].map(c => [c.dataset.estado, c.querySelector(".q-lista").scrollTop]));
    for (const e of ESTADOS) {
      const col = this.folha.querySelector(`.q-col.${e}`), lista = col.querySelector(".q-lista");
      const doEstado = this.visiveis(e);
      col.querySelector(".n").textContent = doEstado.length;
      col.classList.toggle("tem", doEstado.length > 0);
      lista.replaceChildren(...(doEstado.length ? doEstado.map(t => this.cartao(t)) : [el("div", { class: "q-vazia", text: e === "devolvida" ? "Nenhuma devolutiva esperando você" : "—" })]));
      lista.scrollTop = rolagem.get(e) || 0;
    }
    $("#q-contadores").replaceChildren(...ESTADOS.slice(0, 3).map(e => el("span", { style: { "--c": `var(--c-${e})` } }, el("i"), el("b", { text: [...this.tarefas.values()].filter(t => t.estado === e).length }), ROTULO[e].toLowerCase())));
    if (this.aberto && !movimentoReduzido) {
      for (const c of this.folha.querySelectorAll(".q-tarefa")) {
        const n = Number(c.dataset.n), t = this.tarefas.get(n), a = antes.get(n);
        if (!a && this.pronto) { c.classList.add("nasce"); continue; }
        if (!a || a.est === t.estado) continue;
        const r = c.getBoundingClientRect();
        c.animate([{ transform: `translate(${a.r.left - r.left}px, ${a.r.top - r.top}px) scale(.96)`, zIndex: 5 }, { transform: "translate(0,0) scale(1.04)", offset: 0.8 }, { transform: "none" }],
          { duration: 850, easing: "cubic-bezier(.2,1.1,.3,1)" });
        c.classList.add("q-acende");
        if (t.estado === "entregue") this.faiscas(c);
      }
    }
    this.chipsEBotao();
  }

  faiscas(c) {
    const b = el("div", { class: "q-faiscas" });
    c.append(b);
    for (let i = 0; i < 14; i++) {
      const ang = Math.random() * Math.PI * 2, d = 30 + Math.random() * 50;
      b.append(el("i", { style: { left: `${20 + Math.random() * 80}%`, top: `${30 + Math.random() * 40}%`, "--dx": `${Math.cos(ang) * d}px`, "--dy": `${Math.sin(ang) * d}px` } }));
    }
    setTimeout(() => b.remove(), 1000);
  }

  focar(n) {
    const c = this.folha.querySelector(`.q-tarefa[data-n="${n}"]`);
    if (!c) return;
    c.scrollIntoView({ block: "nearest", behavior: movimentoReduzido ? "auto" : "smooth" });
    c.classList.remove("q-acende");
    void c.offsetWidth;
    c.classList.add("q-acende");
  }

  /** Chips nos cartões dos agentes e o selo (devolutivas esperando você) no botão. */
  chipsEBotao() {
    this.palco.chips.clear();
    for (const t of [...this.tarefas.values()].sort((a, b) => momento(a) - momento(b))) {
      if (t.estado !== "entregue" && t.para) this.palco.chips.set(t.para, t);
    }
    this.palco.pintarChips();
    const dev = [...this.tarefas.values()].filter(t => t.estado === "devolvida").length;
    const selo = $("#selo-quadro"), tinha = !selo.hidden, antes = selo.textContent;
    selo.hidden = !dev;
    selo.textContent = String(dev);
    if (dev && (!tinha || antes !== String(dev)) && !movimentoReduzido) { selo.classList.remove("nasce"); void selo.offsetWidth; selo.classList.add("nasce"); }
    $("#btn-quadro").title = dev ? `Quadro de tarefas: ${dev} devolutiva${dev > 1 ? "s" : ""} esperando você (Q)` : "Quadro de tarefas do maestro e diário (Q)";
  }

  // ---------------------------------------------------------------- leitura

  async ler(n, { manterAberto = false } = {}) {
    this.lendo = n;
    let t = this.tarefas.get(n);
    try { t = { ...t, ...(await api(`/api/tarefas/${n}`)) }; } catch { /* mostra o que o quadro já tem */ }
    if (!t || this.lendo !== n) return;
    const hora = d => (data(d) ? ` · ${hh(data(d))}` : "");
    const nomeP = t.nome_para || "o colega", nomeD = t.nome_de || "o maestro";
    const cab = el("div", { class: "linha-l" }, el("h4", { text: `#${t.n} · ${ROTULO[t.estado]}` }), el("button", { class: "q-fechar", text: "×", title: "Fechar (Esc)", onclick: () => this.fecharLeitura() }));
    const partes = [cab,
      el("h4", { text: `O que ${nomeD} pediu a ${nomeP}${hora(t.criada)}` }),
      el("div", { class: "bloco pedido", text: t.pedido || t.assunto })];
    if (t.devolutiva_inteira || t.devolutiva) {
      partes.push(el("h4", { text: `O que ${t.nome_devolutiva_de || nomeP} devolveu${hora(t.devolvida)}` }));
      const b = el("div", { class: "bloco dev" });
      b.append(markdown(t.devolutiva_inteira || t.devolutiva));
      partes.push(b);
    } else {
      partes.push(el("div", { class: "bloco", text: `Ainda sem devolutiva: ${nomeP} ${t.estado === "delegada" ? "ainda não pegou a tarefa (está na fila dele)" : "está trabalhando nela"}.` }));
    }
    if (t.estado === "devolvida") partes.push(el("div", { class: "q-acoes" }, el("button", { class: "ok", text: "✓ Marcar como entregue", onclick: () => { this.fecharLeitura(); this.entregar(t.n); } })));
    this.leitura.replaceChildren(...partes);
    if (!manterAberto || !this.leitura.classList.contains("on")) { this.leitura.classList.add("on"); this.leitura.setAttribute("aria-hidden", "false"); }
  }

  fecharLeitura() {
    this.lendo = null;
    this.leitura.classList.remove("on");
    this.leitura.setAttribute("aria-hidden", "true");
  }

  // ---------------------------------------------------------------- diário (a nota do dia, no cérebro)

  async carregarDiario() {
    const id = idDiario();
    let n = null;
    try { n = await api(`/api/nota/${id}`); } catch { /* sem nota ainda */ }
    const box = $("#q-diario");
    const corpo = n?.existe && n.corpo ? n.corpo : "";
    const m = corpo ? markdown(corpo) : null;
    const itens = m ? [...m.querySelectorAll("li")] : [];
    const novas = this.diarioPronto ? itens.filter(li => !this.linhasDiario.has(li.textContent)) : [];
    for (const li of novas) li.classList.add("nova");
    this.linhasDiario = new Set(itens.map(li => li.textContent));
    const nota = el("div", { class: "q-nota" },
      el("div", { class: "caminho" }, el("span", { class: `q-neur${novas.length ? " acende" : ""}` }), `cérebro / ${n?.caminho || `sessoes/${id}.md`}`));
    if (m) nota.append(m);
    else nota.append(el("p", { class: "discreto", text: "Nada anotado ainda hoje. Quando o maestro delegar ou receber uma devolutiva, uma linha aparece aqui." }));
    this.diarioPronto = true;
    const lado = el("div", { class: "q-lado" },
      el("div", { class: "q-caixa" }, el("h4", { text: "Ajustes › Geral › Palco" }), "Dá para desligar o diário em Ajustes. Uma nota por dia em ", el("b", { text: "sessoes/" }), ", só com hora, quem, para quem, estado, assunto e a primeira linha da devolutiva.",
        n?.existe ? el("button", { class: "btn pequeno", text: "Abrir a nota no cérebro", onclick: () => this.aoAbrirNota?.(id) }) : null),
      el("div", { class: "q-caixa" }, el("h4", { text: "Por que existe" }), "Quando a conversa do maestro fica grande e é resumida, o que foi delegado e devolvido continua no cérebro: qualquer agente acha procurando “diário”."));
    box.replaceChildren(nota, lado);
    nota.scrollTop = nota.scrollHeight;
  }

  /** Evento "cerebro" com a nota do diário mudando: a aba atualiza na hora. */
  cerebroMudou(mudou) {
    if (this.aberto && this.aba === "diario" && String(mudou || "").includes("diario-")) this.carregarDiario();
  }
}
