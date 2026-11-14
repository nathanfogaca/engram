// Cenas: o desenho de um time guardado para recriar com um clique (aqui, noutro palco ou noutro computador por
// um arquivo .json). A folha de baixo tem duas abas: Cenas (lista com miniaturas vivas, salvar, recriar, exportar,
// importar) e Uso (o painel do medidor). Nada vem de fora sem passar por textContent: o nome da cena, dos agentes e
// os textos podem ter vindo de um arquivo.

import { $, el, svg, api, avisar, corModelo, movimentoReduzido } from "./util.js";
import { PainelUso } from "./uso.js";

const CW = 700, CH = 470;
const COR_MAESTRO = "#f5c451";
const CORES_CENA = ["#8b7bff", "#e879f9", "#4ade9f", "#38d6f5", "#ffc857", "#ff9d6b"];
const OPCOES_SALVAR = [
  ["agentes", "Agentes", "nome, papel, agente (CLI) e modelo", true, ""],
  ["ligacoes", "Ligações e revisões", "quem fala com quem e quem revisa quem", true, ""],
  ["setores", "Setores", "com a instrução e a cor de cada um", true, ""],
  ["posicoes", "Posições", "cada cartão volta onde estava", true, ""],
  ["automacoes", "Automações", "cartões de horário e orientação", false, "opcional"],
  ["postits", "Post-its", "as anotações soltas no palco", false, "opcional"],
];
const dataBr = s => { const d = new Date(s); return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("pt-BR"); };
const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;

export class Cenas {
  constructor({ palco, palcos }) {
    this.palco = palco;
    this.palcos = palcos;
    this.raiz = $("#palco");
    this.folha = $("#folha-cu");
    this.cenas = [];
    this.destinos = [];
    this.aba = "cenas";
    this.aberto = false;
    this.novaId = null;
    this.pedindo = false;
    this.montar();
    this.uso = new PainelUso({ palco, raiz: this.vistaUso });
    this.uso.aberto = () => this.aberto && this.aba === "uso";
    palco.aoUso = id => { this.abrir("uso"); setTimeout(() => this.uso.destacar(id), 400); };
  }

  // ---------------------------------------------------------------- montagem

  montar() {
    this.titulo = el("span", { text: "Cenas" });
    this.abas = el("div", { class: "q-abas" },
      el("button", { "data-aba": "cenas", class: "on", text: "Cenas" }), el("button", { "data-aba": "uso", text: "Uso" }));
    this.abas.onclick = e => { const b = e.target.closest("button"); if (b) this.mostrarAba(b.dataset.aba); };
    this.dir = el("div", { class: "cu-dir" });
    this.lista = el("div", { class: "cenas-lista" });
    this.vistaCenas = el("div", { class: "cu-vista" }, this.lista);
    this.vistaUso = el("div", { class: "cu-vista", hidden: true });
    this.folha.append(
      el("div", { class: "folha-cab" },
        el("h2", {}, el("span", { class: "ic-cenas" }, el("i"), el("i"), el("i"), el("i")), this.titulo), this.abas, this.dir,
        el("button", { class: "q-fechar", title: "Fechar (Esc)", text: "×", onclick: () => this.abrir(false) })),
      this.vistaCenas, this.vistaUso);
    for (const e of ["pointerdown", "wheel"]) this.folha.addEventListener(e, ev => ev.stopPropagation());
    $("#btn-cenas").onclick = () => (this.aberto && this.aba === "cenas" ? this.abrir(false) : this.abrir("cenas"));
    $("#btn-uso").onclick = () => (this.aberto && this.aba === "uso" ? this.abrir(false) : this.abrir("uso"));
    // diálogos e o progresso do recriar
    this.veus = $("#veus");
    this.progresso = el("div", { class: "cena-progresso", hidden: true });
    this.raiz.append(this.progresso);
    this.pintarDir();
  }

  pintarDir() {
    this.dir.replaceChildren(...(this.aba === "cenas" ? [
      el("button", { class: "btn", text: "Importar", title: "Abrir um .json de cena que alguém te mandou", onclick: () => this.dialogoImportar() }),
      el("button", { class: "btn-brilho", onclick: () => this.dialogoSalvar() }, el("span", { text: "Salvar o time como cena" })),
    ] : []));
  }

  abrir(qual, silencioso = false) {
    const sim = qual !== false;
    if (sim) this.aoAbrir?.();
    this.aberto = sim;
    if (sim) this.mostrarAba(qual === "uso" ? "uso" : "cenas");
    this.raiz.classList.toggle("cu-aberto", sim);
    document.body.classList.toggle("folha-aberta", sim);
    this.folha.setAttribute("aria-hidden", String(!sim));
    $("#btn-cenas").classList.toggle("on", sim && this.aba === "cenas");
    $("#btn-uso").classList.toggle("on", sim && this.aba === "uso");
    this.palco.reservaBaixo = sim ? Math.round(innerHeight * 0.52 - 40) : 0;
    if (this.palco.cartoes.size && !silencioso) this.palco.enquadrar(true);
  }

  fechar(silencioso = false) {
    if (this.aberto) this.abrir(false, silencioso);
  }

  escape() {
    if (this.veus.querySelector(".veu.on")) { this.fecharVeus(); return true; }
    if (this.aberto) { this.abrir(false); return true; }
    return false;
  }

  mostrarAba(qual) {
    this.aba = qual;
    for (const b of this.abas.children) b.classList.toggle("on", b.dataset.aba === qual);
    this.vistaCenas.hidden = qual !== "cenas";
    this.vistaUso.hidden = qual !== "uso";
    this.titulo.textContent = qual === "cenas" ? "Cenas" : "Uso por agente";
    $("#btn-cenas").classList.toggle("on", this.aberto && qual === "cenas");
    $("#btn-uso").classList.toggle("on", this.aberto && qual === "uso");
    this.pintarDir();
    if (qual === "cenas") this.carregar(); else this.uso.carregar();
  }

  // ---------------------------------------------------------------- lista

  async carregar() {
    try {
      const d = await api("/api/cenas");
      this.cenas = d?.cenas || [];
      this.destinos = d?.destinos || [];
    } catch (e) { avisar({ texto: `Não li as cenas: ${e.message}`, cor: "#ff6b7d" }); return; }
    this.desenhar();
  }

  desenhar() {
    const cartoes = this.cenas.map((c, i) => this.cartao(c, CORES_CENA[i % CORES_CENA.length]));
    const nova = el("button", { class: "cena-nova", onclick: () => this.dialogoSalvar() }, el("div", {}, el("b", { text: "+" }), "Salvar o time", el("br"), "atual como cena"));
    this.lista.replaceChildren(...cartoes, nova);
    this.novaId = null;
  }

  cartao(c, cor) {
    const r = c.resumo || {};
    const cont = [
      el("span", {}, el("b", { text: r.agentes ?? 0 }), ` agente${r.agentes === 1 ? "" : "s"}`),
      el("span", {}, el("b", { text: r.setores ?? 0 }), ` setor${r.setores === 1 ? "" : "es"}`),
      r.automacoes ? el("span", {}, el("b", { text: r.automacoes }), ` automaç${r.automacoes > 1 ? "ões" : "ão"}`) : null,
      r.postits ? el("span", {}, el("b", { text: r.postits }), ` post-it${r.postits > 1 ? "s" : ""}`) : null,
    ];
    return el("div", { class: `cena${c.id === this.novaId && !movimentoReduzido ? " nasce" : ""}`, style: { "--cc": cor }, "data-id": c.id },
      el("div", { class: "mini" }, this.miniatura(c.dados)),
      el("div", { class: "info" },
        el("h3", {}, el("i"), el("span", { text: c.nome, title: c.nome }), c.origem === "importada" ? el("em", { class: "origem", text: "importada", title: "Esta cena veio de outra pessoa" }) : null),
        el("div", { class: "data", text: c.criada ? `salva em ${dataBr(c.criada)}` : "" }),
        el("div", { class: "cont" }, ...cont)),
      el("div", { class: "acoes" },
        el("button", { class: "btn pequeno", text: "Exportar", title: "Exportar como .json", onclick: () => this.dialogoExportar(c) }),
        el("button", { class: "btn pequeno", text: "Remover", title: "Tirar a cena da lista (os agentes do palco não mudam)", onclick: () => this.remover(c) }),
        el("button", { class: "btn-brilho pequeno", onclick: () => this.dialogoRecriar(c) }, el("span", { text: "Recriar" }))));
  }

  /** Uma miniatura viva do desenho: setores, cartões que pulsam e partículas correndo pelas linhas. */
  miniatura(d) {
    const cartoes = (d?.cartoes || []).map((a, i) => ({ ...a, w: a.w || CW, h: a.h || CH }));
    // sem posições salvas: grade simples só para a miniatura
    if (cartoes.length && cartoes.some(a => !Number.isFinite(a.x))) cartoes.forEach((a, i) => { a.x = (i % 3) * (CW + 120); a.y = Math.floor(i / 3) * (CH + 120); });
    const setores = (d?.setores || []).filter(s => Number.isFinite(s.x));
    const xs = [...cartoes.flatMap(a => [a.x, a.x + a.w]), ...setores.flatMap(s => [s.x, s.x + s.w])];
    const ys = [...cartoes.flatMap(a => [a.y, a.y + a.h]), ...setores.flatMap(s => [s.y, s.y + s.h])];
    const vazio = svg("svg", { viewBox: "0 0 10 10" });
    if (!xs.length) return vazio;
    const x1 = Math.min(...xs) - 90, x2 = Math.max(...xs) + 90, y1 = Math.min(...ys) - 90, y2 = Math.max(...ys) + 90;
    const raiz = svg("svg", { viewBox: `${x1} ${y1} ${x2 - x1} ${y2 - y1}`, preserveAspectRatio: "xMidYMid meet" });
    const cor = a => (a.papel === "maestro" ? COR_MAESTRO : corModelo(a.modelo || a.provedor));
    const por = Object.fromEntries(cartoes.map(a => [a.ref, a]));
    for (const s of setores) {
      raiz.append(svg("rect", { x: s.x, y: s.y, width: s.w, height: s.h, rx: 60, fill: s.cor, "fill-opacity": ".1", stroke: s.cor, "stroke-opacity": ".7", "stroke-width": 8, "stroke-dasharray": "34 22" }));
    }
    (d?.ligacoes || []).forEach((l, i) => {
      const A = por[l.a], B = por[l.b];
      if (!A || !B) return;
      const ca = { x: A.x + A.w / 2, y: A.y + A.h / 2 }, cb = { x: B.x + B.w / 2, y: B.y + B.h / 2 };
      const horiz = Math.abs(cb.x - ca.x) * (A.h + B.h) >= Math.abs(cb.y - ca.y) * (A.w + B.w);
      const p = horiz ? { x: cb.x >= ca.x ? A.x + A.w : A.x, y: ca.y } : { x: ca.x, y: cb.y >= ca.y ? A.y + A.h : A.y };
      const q = horiz ? { x: cb.x >= ca.x ? B.x : B.x + B.w, y: cb.y } : { x: cb.x, y: cb.y >= ca.y ? B.y : B.y + B.h };
      const k = horiz ? [Math.abs(q.x - p.x) * 0.5 * Math.sign(q.x - p.x || 1), 0] : [0, Math.abs(q.y - p.y) * 0.5 * Math.sign(q.y - p.y || 1)];
      const dd = `M${p.x} ${p.y} C${p.x + k[0]} ${p.y + k[1]} ${q.x - k[0]} ${q.y - k[1]} ${q.x} ${q.y}`;
      raiz.append(svg("path", { d: dd, fill: "none", stroke: cor(B), "stroke-opacity": ".25", "stroke-width": 24 }), svg("path", { d: dd, fill: "none", stroke: l.revisa ? "#4ade9f" : cor(B), "stroke-width": 8, "stroke-linecap": "round" }));
      if (!movimentoReduzido) {
        const bolinha = svg("circle", { r: 14, fill: "#fff" });
        bolinha.append(svg("animateMotion", { dur: `${(2.2 + i * 0.45).toFixed(2)}s`, repeatCount: "indefinite", begin: `${(i * 0.3).toFixed(1)}s`, path: dd }));
        raiz.append(bolinha);
      }
    });
    cartoes.forEach(a => {
      const c = cor(a), m = a.papel === "maestro";
      raiz.append(
        svg("rect", { x: a.x, y: a.y, width: a.w, height: a.h, rx: 34, fill: "#10141f", stroke: c, "stroke-width": m ? 10 : 7 }),
        svg("rect", { x: a.x, y: a.y, width: a.w, height: 80, rx: 34, fill: c, "fill-opacity": ".2" }));
      const orbe = svg("circle", { cx: a.x + 50, cy: a.y + 42, r: 16, fill: c });
      if (!movimentoReduzido) orbe.append(svg("animate", { attributeName: "r", values: "16;23;16", dur: `${(1.6 + (a.nome.length % 5) * 0.2).toFixed(1)}s`, repeatCount: "indefinite" }));
      raiz.append(orbe,
        svg("rect", { x: a.x + 90, y: a.y + 28, width: Math.min(a.w - 130, 90 + a.nome.length * 12), height: 24, rx: 12, fill: "#fff", "fill-opacity": ".55" }),
        svg("rect", { x: a.x + 40, y: a.y + 150, width: a.w - 100, height: 28, rx: 14, fill: "#fff", "fill-opacity": ".1" }));
    });
    return raiz;
  }

  async remover(c) {
    if (!confirm(`Tirar a cena “${c.nome}” da lista? Os agentes que estão no palco não mudam.`)) return;
    try { await api(`/api/cenas/${c.id}/remover`, { method: "POST" }); await this.carregar(); }
    catch (e) { avisar({ texto: e.message, cor: "#ff6b7d" }); }
  }

  // ---------------------------------------------------------------- diálogos

  fecharVeus() {
    for (const v of this.veus.querySelectorAll(".veu.on")) { v.classList.remove("on"); setTimeout(() => v.remove(), 380); }
  }

  /** Abre um diálogo (véu + caixa). Esc ou clicar fora fecha. */
  veu(...filhos) {
    this.fecharVeus();
    const caixa = el("div", { class: "cu-dialogo", role: "dialog", "aria-modal": "true" }, ...filhos);
    const v = el("div", { class: "veu" }, caixa);
    v.addEventListener("pointerdown", e => { if (e.target === v) this.fecharVeus(); });
    v.addEventListener("keydown", e => { if (e.key === "Escape") { e.stopPropagation(); this.fecharVeus(); } });
    this.veus.append(v);
    requestAnimationFrame(() => v.classList.add("on"));
    return { v, caixa };
  }

  /** As instruções que a cena leva (setores e automações): viram ordem para os agentes, então vão em textContent e à vista. */
  blocoInstrucoes(c) {
    const lista = c.instrucoes || [];
    if (!lista.length) return null;
    return el("div", { class: "instr-lista" }, ...lista.map(i => el("div", { class: "instr" },
      el("b", { text: `${i.tipo === "setor" ? "Setor" : "Automação"} ${i.nome || ""}` }), i.quando ? el("small", { text: ` · ${i.quando}` }) : null,
      el("p", { text: i.texto || "(sem texto)" }))));
  }

  opcao({ tipo = "checkbox", nome, titulo, sub, marcado = false, desligado = false, tag = "", valor = "", dado = "" }) {
    const input = el("input", { type: tipo, name: nome, value: valor, "data-k": dado, ...(marcado ? { checked: true } : {}), ...(desligado ? { disabled: true } : {}) });
    return el("label", { class: `opc${tipo === "radio" ? " radio" : ""}${desligado ? " off" : ""}` }, input, el("span", { class: "caixa-m" }),
      el("span", {}, el("b", { text: titulo }), el("small", { text: sub })), tag ? el("span", { class: "tag-op", text: tag }) : null);
  }

  dialogoSalvar() {
    const campo = el("input", { type: "text", maxlength: "40", autocomplete: "off", value: "Time completo", id: "cena-nome" });
    const opcs = OPCOES_SALVAR.map(([k, t, s, on, tag]) => this.opcao({ nome: "inc", titulo: t, sub: s, marcado: on, tag, dado: k }));
    const salvar = async () => {
      const incluir = Object.fromEntries(opcs.map(o => { const i = o.querySelector("input"); return [i.dataset.k, i.checked]; }));
      const nome = campo.value.trim() || "Cena sem nome";
      ok.disabled = true;
      try {
        const c = await api("/api/cenas", { json: { nome, palco: this.palcos.atual, incluir } });
        this.novaId = c?.id || null;
        this.fecharVeus();
        const r = c?.resumo || {};
        avisar({ rota: "Cena salva", texto: `“${nome}”: ${plural(r.agentes ?? 0, "agente", "agentes")}. Sem conversa, token, chave nem arquivo.`, cor: "#e879f9", tempo: 6000 });
        await this.carregar();
        if (this.aberto && this.aba === "cenas") setTimeout(() => this.lista.scrollTo({ left: 99999, behavior: movimentoReduzido ? "auto" : "smooth" }), 120);
      } catch (e) { ok.disabled = false; avisar({ texto: `Não salvou: ${e.message}`, cor: "#ff6b7d" }); }
    };
    const ok = el("button", { class: "btn-brilho", onclick: salvar }, el("span", { text: "Salvar cena" }));
    const { v } = this.veu(
      el("h3", { text: "Salvar o time como cena" }),
      el("p", { class: "sub", text: `Guarda o que está em ${this.palcos.nomeDe(this.palcos.atual)} agora para recriar com um clique, aqui ou no computador de outra pessoa.` }),
      el("label", { class: "campo", for: "cena-nome", text: "Nome da cena" }), campo,
      el("div", { class: "opcoes" }, ...opcs),
      el("div", { class: "nunca" }, el("span", { class: "ic", text: "!" }), el("span", {}, el("b", { text: "Nunca entra: conversa, token, chave nem arquivo dos agentes." }), " A cena é só o desenho do time.")),
      el("div", { class: "rodape" }, el("button", { class: "btn", text: "Cancelar", onclick: () => this.fecharVeus() }), ok));
    campo.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); salvar(); } });
    setTimeout(() => { campo.focus(); campo.select(); }, 260);
    return v;
  }

  async dialogoRecriar(c) {
    await this.carregar().catch(() => {}); // destinos de agora (quais palcos estão vazios)
    const d = c.dados || {}, r = c.resumo || {};
    const atual = this.palcos.atual;
    const opcs = [this.opcao({ tipo: "radio", nome: "modo", valor: "ao_lado", titulo: "Neste palco, ao lado do que já está", sub: "os agentes de agora continuam como estão; a cena abre num lugar livre do palco", marcado: true, tag: "padrão" })];
    for (const dest of this.destinos) {
      const nome = dest.nome || `Palco ${dest.n}`;
      opcs.push(this.opcao({ tipo: "radio", nome: "modo", valor: `vazio:${dest.n}`, titulo: `Em ${nome}, vazio`, desligado: !dest.vazio, tag: dest.vazio ? "vazio" : `tem ${plural(dest.agentes ?? 0, "agente", "agentes")}`,
        sub: dest.vazio ? "abre como foi salva, no palco inteiro" : "só num palco sem agente, setor, automação nem post-it. O Engram nunca fecha agente." }));
    }
    const exigeLeitura = c.origem === "importada" && (c.instrucoes || []).length > 0;
    const li = el("input", { type: "checkbox" });
    const ok = el("button", { class: "btn-brilho", ...(exigeLeitura ? { disabled: true } : {}), onclick: () => {
      const escolhido = opcs.map(o => o.querySelector("input")).find(i => i.checked)?.value || "ao_lado";
      this.recriar(c, { ...(escolhido === "ao_lado" ? { palco: atual, modo: "ao_lado" } : { palco: Number(escolhido.split(":")[1]), modo: "vazio" }), ...(exigeLeitura ? { confirmado: true } : {}) });
    } }, el("span", { text: "Recriar agora" }));
    li.onchange = () => { ok.disabled = exigeLeitura && !li.checked; };
    this.veu(
      el("h3", { text: `Recriar “${c.nome}”` }),
      el("p", { class: "sub", text: `${plural(r.agentes ?? d.cartoes?.length ?? 0, "agente", "agentes")}, ${plural(r.setores ?? 0, "setor", "setores")}. Você vê cada peça nascer no palco.` }),
      exigeLeitura ? el("div", { class: "aviso-fora" }, el("span", { class: "ic", text: "!" }), el("span", {}, el("b", { text: "Esta cena veio de outra pessoa: leia as instruções antes de recriar." }), " Elas viram ordem para os agentes que a cena abrir.")) : null,
      exigeLeitura ? this.blocoInstrucoes(c) : null,
      exigeLeitura ? el("label", { class: "opc" }, li, el("span", { class: "caixa-m" }), el("span", {}, el("b", { text: "Li as instruções e quero recriar" }))) : null,
      el("div", { class: "opcoes" }, ...opcs),
      el("div", { class: "rodape" }, el("button", { class: "btn", text: "Cancelar", onclick: () => this.fecharVeus() }), ok));
  }

  async recriar(c, { palco, modo, confirmado }) {
    if (this.pedindo) return;
    this.pedindo = true;
    this.fecharVeus();
    this.abrir(false, true);
    try {
      // noutro palco: vai até lá ANTES, para a pessoa ver cada peça nascer
      if (palco !== this.palcos.atual && !(await this.palcos.trocar(palco))) return;
      this.mostrarProgresso(c.nome, 0, c.resumo?.agentes ?? c.dados?.cartoes?.length ?? 0);
      const r = await api(`/api/cenas/${c.id}/recriar`, { json: { palco, modo, ...(confirmado ? { confirmado: true } : {}) } });
      const parou = r?.completa === false;
      this.esconderProgresso(!parou, parou);
      if (!movimentoReduzido) this.palco.enquadrar(true); else this.palco.enquadrar(false);
      const erros = r?.erros || [];
      avisar({ rota: parou ? "Cena recriada só em parte" : "Cena recriada", cor: parou || erros.length ? "#ffc857" : "#4ade9f", tempo: parou || erros.length ? 14000 : 6500,
        texto: `“${c.nome}”: ${plural(r?.abertos ?? 0, "agente aberto", "agentes abertos")}.${r?.maestro_reaproveitado ? " O maestro que já estava aqui ficou com as linhas." : ""}${erros.length ? ` ${erros.join("; ")}` : ""}` });
      if (r?.aviso) avisar({ rota: "Sobre as automações da cena", texto: String(r.aviso), cor: "#ffc857", tempo: 12000 });
    } catch (e) {
      this.esconderProgresso(false);
      avisar({ rota: "Não recriou", texto: e.message, cor: "#ff6b7d", tempo: 10000 });
    } finally { this.pedindo = false; }
  }

  mostrarProgresso(nome, feitos, total) {
    if (total) feitos = Math.min(feitos, total); // o maestro aproveitado pode contar como feito sem estar no total
    this.progresso.hidden = false;
    this.progresso.classList.remove("fim");
    this.progresso.style.setProperty("--p", `${total ? Math.round((feitos / total) * 100) : 5}%`);
    this.progresso.replaceChildren(el("i"), el("b", { text: `Recriando “${nome}”` }), el("span", { text: total ? `${feitos} de ${total}` : "…" }), el("em"));
  }

  esconderProgresso(ok, parcial = false) {
    if (this.progresso.hidden) return;
    if (!parcial) this.progresso.style.setProperty("--p", "100%");
    this.progresso.classList.toggle("fim", ok);
    this.progresso.classList.toggle("parcial", parcial);
    setTimeout(() => { this.progresso.hidden = true; this.progresso.classList.remove("parcial"); }, ok ? 1200 : parcial ? 3500 : 200);
  }

  async dialogoExportar(c) {
    let obj;
    try { obj = await api(`/api/cenas/${c.id}/exportar`); }
    catch (e) { avisar({ texto: `Não exportou: ${e.message}`, cor: "#ff6b7d" }); return; }
    const texto = JSON.stringify(obj, null, 2);
    const ver = el("div", { class: "json" });
    // colorido, mas só com textContent
    const re = /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+(?:\.\d+)?)|\b(true|false|null)\b/g;
    let fim = 0, m;
    while ((m = re.exec(texto))) {
      if (m.index > fim) ver.append(texto.slice(fim, m.index));
      ver.append(el("span", { class: m[1] ? (m[2] ? "k" : "s") : "n", text: m[1] ? m[1] : m[0] }), m[2] || "");
      fim = re.lastIndex;
    }
    ver.append(texto.slice(fim));
    const baixar = () => {
      const nome = `${String(c.nome).toLowerCase().replace(/[^a-z0-9à-ú]+/gi, "-").replace(/^-+|-+$/g, "") || "cena"}.engram-cena.json`;
      const url = URL.createObjectURL(new Blob([texto], { type: "application/json" }));
      const a = el("a", { href: url, download: nome });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      this.fecharVeus();
      avisar({ rota: "Arquivo gerado", texto: nome, cor: "#e879f9", tempo: 6000 });
    };
    this.veu(
      el("h3", { text: "Exportar cena" }),
      el("p", { class: "sub", text: "Um arquivo .json para passar o time a outra pessoa. Só o desenho: nada de conversa, token ou chave." }),
      ver,
      el("div", { class: "aviso-fora", style: { marginTop: "10px" } }, el("span", { class: "ic", text: "!" }), el("span", { text: "O arquivo leva as instruções dos setores e das automações: revise antes de mandar a alguém." })),
      el("div", { class: "rodape" }, el("button", { class: "btn", text: "Fechar", onclick: () => this.fecharVeus() }), el("button", { class: "btn-brilho", onclick: baixar }, el("span", { text: "Baixar arquivo" }))));
  }

  /** Depois de importar: o que a cena de fora manda os agentes fazerem, para a pessoa ler antes de recriar. */
  dialogoInstrucoes(c) {
    this.veu(
      el("h3", { text: `Cena importada: “${c.nome}”` }),
      el("div", { class: "aviso-fora" }, el("span", { class: "ic", text: "!" }), el("span", {}, el("b", { text: "Esta cena veio de outra pessoa: leia as instruções antes de recriar." }), " Elas viram ordem para os agentes que a cena abrir.")),
      this.blocoInstrucoes(c),
      el("div", { class: "rodape" }, el("button", { class: "btn", text: "Depois", onclick: () => this.fecharVeus() }), el("button", { class: "btn-brilho", onclick: () => this.dialogoRecriar(c) }, el("span", { text: "Recriar…" }))));
  }

  dialogoImportar() {
    const entrada = el("input", { type: "file", accept: ".json,application/json", hidden: true });
    const solta = el("div", { class: "solta", tabindex: "0", role: "button" }, el("div", {}, "Solte o arquivo .json aqui", el("br"), el("small", { text: "ou clique para escolher" })));
    const ler = async arquivo => {
      if (!arquivo) return;
      if (arquivo.size > 2 * 1024 * 1024) { avisar({ texto: "Esse arquivo é grande demais para ser uma cena.", cor: "#ff6b7d" }); return; }
      try {
        const c = await api("/api/cenas/importar", { json: { json: await arquivo.text() } });
        this.novaId = c?.id || null;
        this.fecharVeus();
        avisar({ rota: "Cena importada", texto: `“${c?.nome || arquivo.name}” entrou na lista. Para usar, é só recriar.`, cor: "#e879f9", tempo: 6500 });
        await this.carregar();
        setTimeout(() => this.lista.scrollTo({ left: 99999, behavior: movimentoReduzido ? "auto" : "smooth" }), 120);
        const nova = this.cenas.find(x => x.id === c?.id) || c;
        if (nova?.instrucoes?.length) this.dialogoInstrucoes(nova);
      } catch (e) { avisar({ rota: "Não importou", texto: e.message, cor: "#ff6b7d", tempo: 9000 }); }
    };
    solta.onclick = () => entrada.click();
    solta.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); entrada.click(); } });
    entrada.onchange = () => ler(entrada.files[0]);
    solta.addEventListener("dragover", e => { e.preventDefault(); solta.classList.add("sobre"); });
    solta.addEventListener("dragleave", () => solta.classList.remove("sobre"));
    solta.addEventListener("drop", e => { e.preventDefault(); solta.classList.remove("sobre"); ler(e.dataTransfer.files[0]); });
    this.veu(
      el("h3", { text: "Importar cena" }),
      el("p", { class: "sub", text: "Solte aqui o .json de uma cena que alguém te mandou. Ela entra na lista; para usar, é só recriar. O Engram guarda só o desenho e joga fora o resto." }),
      solta, entrada,
      el("div", { class: "rodape" }, el("button", { class: "btn", text: "Fechar", onclick: () => this.fecharVeus() })));
  }

  /** Troca de palco: o painel de uso e a lista (os destinos mudam) refletem o palco novo. */
  trocouPalco() {
    if (!this.aberto) return;
    if (this.aba === "uso") this.uso.desenhar(true); else this.carregar();
  }

  // ---------------------------------------------------------------- ao vivo

  /** Eventos { tipo: "cena", acao: "salva" | "removida" | "recriando" | "nasceu" | "recriada" }. */
  aoVivo(m) {
    if (m.acao === "salva" || m.acao === "removida") {
      if (this.aberto && this.aba === "cenas") this.carregar();
    } else if (m.acao === "recriando") {
      if (m.palco === this.palcos.atual) this.mostrarProgresso(m.nome || "a cena", 0, m.total || 0);
    } else if (m.acao === "nasceu") {
      if (!this.progresso.hidden) this.mostrarProgresso(this.progresso.querySelector("b")?.textContent.replace(/^Recriando “|”$/g, "") || "a cena", m.feitos || 0, m.total || 0);
    } else if (m.acao === "recriada") {
      if (!this.pedindo) this.esconderProgresso(m.completa !== false, m.completa === false); // a que eu pedi esconde ao receber a resposta
    }
  }
}
