// Automações e post-its do palco (menu Ferramentas, na barra de baixo).
// Automação: um cartão com uma orientação e um horário, ligado por uma linha a um agente (de preferência o
// maestro). Na hora, a orientação corre pela linha até ele; o resultado volta pelo enviar e aparece no cartão.
// Post-it: uma nota solta no palco, que pode virar automação.

import { $, el, svg, api, avisar, limitar, movimentoReduzido } from "./util.js";

const DIAS = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
const AMBAR = "#ffc857", VERDE = "#4ade9f";
const NOMES_DIA = { domingo: 0, segunda: 1, "terça": 2, quarta: 3, quinta: 4, sexta: 5, "sábado": 6 };
const dois = n => String(n).padStart(2, "0");
const hhmm = d => `${dois(d.getHours())}:${dois(d.getMinutes())}`;

/** "hoje 10:00", "ontem 10:00" ou "ter 10/11 10:00". */
function quando(iso) {
  if (!iso) return "";
  const d = new Date(iso), hoje = new Date();
  const dia = new Date(hoje); dia.setHours(0, 0, 0, 0);
  const ontem = new Date(dia); ontem.setDate(ontem.getDate() - 1);
  if (d >= dia) return `hoje ${hhmm(d)}`;
  if (d >= ontem) return `ontem ${hhmm(d)}`;
  return `${DIAS[d.getDay()]} ${dois(d.getDate())}/${dois(d.getMonth() + 1)} ${hhmm(d)}`;
}

function diasTexto(d) {
  const s = [...d].sort((a, b) => a - b);
  if (s.join() === "1,2,3,4,5") return "dias úteis";
  if (s.length === 7) return "todo dia";
  return s.length ? s.map(i => DIAS[i]).join(" · ") : "nenhum dia";
}

function proxima(a, agora = new Date()) {
  if (a.manual || !a.dias.length) return null;
  const [h, m] = a.hora.split(":").map(Number);
  for (let k = 0; k < 8; k++) {
    const d = new Date(agora); d.setDate(d.getDate() + k); d.setHours(h, m, 0, 0);
    if (d > agora && a.dias.includes(d.getDay())) return { d, k };
  }
  return null;
}

export class Automacoes {
  constructor(palco) {
    this.palco = palco;
    this.lista = new Map(); // id → automação { ...dados, el, fio }
    this.postits = new Map(); // id → post-it { id, texto, x, y, el }
    this.camada = $("#cartoes");
    this.selecionada = null;
    this.montarMenu();
    this.montarPainel();
    setInterval(() => { for (const a of this.lista.values()) this.pintarTempo(a); }, 1000);
  }

  // ---------------------------------------------------------------- menu Ferramentas

  montarMenu() {
    const botao = $("#btn-ferramentas"), menu = $("#ferramentas-menu");
    const abrir = on => { menu.hidden = !on; botao.classList.toggle("aberto", on); botao.setAttribute("aria-expanded", String(on)); };
    botao.onclick = e => { e.stopPropagation(); abrir(menu.hidden); };
    menu.addEventListener("click", e => { if (e.target.closest(".ferr-item")) abrir(false); });
    document.addEventListener("pointerdown", e => { if (!e.target.closest("#ferramentas")) abrir(false); });
    $("#btn-automacao").onclick = () => this.nova();
    $("#btn-postit").onclick = () => this.novoPostit();
    this.fecharMenu = () => abrir(false);
  }

  // ---------------------------------------------------------------- estado

  carregar(automacoes, postits) {
    for (const p of postits || []) this.receberPostit(p);
    for (const a of automacoes || []) this.receber(a);
  }

  /** Uma automação criada ou mudada (pela tela ou pelo app). */
  receber(d, { nascendo = false, devolveu = null } = {}) {
    let a = this.lista.get(d.id);
    const antes = a?.rodadas?.[0];
    if (!a) {
      a = { ...d };
      this.criarCartao(a, nascendo);
    } else {
      // o eco do próprio salvar não desfaz o que a pessoa continuou digitando nem o lugar do arrasto
      const { x, y } = a;
      Object.assign(a, a.salvando ? { rodadas: d.rodadas, alvo: d.alvo } : d);
      if (a.arrastando) Object.assign(a, { x, y });
    }
    this.pintar(a);
    this.desenharFio(a);
    const nova = a.rodadas?.[0];
    // começou uma rodada: o cartão pulsa; terminou com devolutiva: o resultado corre de volta pela linha
    if (nova && (!antes || nova.n !== antes.n) && nova.estado === "rodando") this.onda(a, AMBAR);
    if (devolveu) this.correr(devolveu, a, VERDE, () => { this.onda(a, VERDE); });
    if (this.selecionada === a) this.pintarPainel({ flash: !!devolveu });
    return a;
  }

  removerLocal(id) {
    const a = this.lista.get(id);
    if (!a) return;
    this.lista.delete(id);
    a.fio?.g.remove();
    a.el.classList.add("saindo");
    setTimeout(() => a.el.remove(), 360);
    if (this.selecionada === a) this.fecharPainel();
  }

  aberta(a) { const r = a.rodadas?.[0]; return r && (r.estado === "rodando" || r.estado === "parou") ? r : null; }
  nomeAlvo(a) { return this.palco.cartoes.get(a.alvo)?.info.nome || "O agente"; }
  caixa(o) { return { x: o.x, y: o.y, w: o.el.offsetWidth || 300, h: o.el.offsetHeight || 200 }; }
  caixas() { return [...this.lista.values(), ...this.postits.values()].map(o => this.caixa(o)); }

  // ---------------------------------------------------------------- o cartão

  criarCartao(a, nascendo) {
    a.el = el("div", { class: `auto-cartao${nascendo && !movimentoReduzido ? " nasce" : ""}`, "data-id": a.id });
    a.elNome = el("b", { class: "auto-nome" });
    a.elEstado = el("span", { class: "auto-estado" });
    a.elQuando = el("div", { class: "auto-quando" });
    a.elInst = el("div", { class: "auto-inst" });
    a.elAlertaTxt = el("span");
    a.elUltima = el("span", { class: "auto-ultima" });
    a.elProxima = el("span", { class: "auto-proxima" });
    a.btnRodar = el("button", { class: "auto-rodar", text: "▶ Rodar já", title: "Roda agora, fora do horário", onclick: () => this.rodar(a) });
    a.elPorta = el("span", { class: "auto-porta", title: "Arraste até um agente para ligar" });
    a.el.append(
      el("div", { class: "auto-cab" }, el("span", { class: "relogio" }), a.elNome, el("span", { class: "auto-tag", text: "automação" }), a.elEstado),
      a.elQuando, a.elInst,
      el("div", { class: "auto-semalvo", text: "Arraste a bolinha ● até o agente que vai receber a orientação" }),
      el("div", { class: "auto-alerta" }, a.elAlertaTxt, el("button", { text: "Abrir", onclick: () => this.palco.focar(a.alvo) })),
      el("div", { class: "auto-rodape" }, el("div", { class: "auto-txt" }, a.elUltima, a.elProxima), a.btnRodar),
      a.elPorta);
    a.el.addEventListener("pointerdown", e => this.arrastar(e, a, () => this.selecionar(a)));
    a.elPorta.addEventListener("pointerdown", e => this.puxarLinha(e, a));
    if (nascendo) setTimeout(() => a.el.classList.remove("nasce"), 900); // presa no fim, a animação impediria o cartão de girar
    this.camada.append(a.el);
    this.lista.set(a.id, a);
  }

  pintar(a) {
    a.el.style.left = `${a.x}px`;
    a.el.style.top = `${a.y}px`;
    a.elNome.textContent = a.nome;
    a.elInst.textContent = a.instrucao;
    a.elQuando.replaceChildren(...(a.manual ? ["só no botão"] : [diasTexto(a.dias), a.hora]).map(t => el("span", { text: t })));
    const aberta = this.aberta(a);
    a.el.classList.toggle("sem-alvo", !a.alvo);
    a.el.classList.toggle("rodando", aberta?.estado === "rodando");
    a.el.classList.toggle("travado", aberta?.estado === "parou");
    a.el.classList.toggle("selecionado", this.selecionada === a);
    a.elEstado.textContent = aberta ? (aberta.estado === "parou" ? "parado" : "rodando") : "";
    a.elEstado.className = `auto-estado ${aberta?.estado || ""}`;
    a.elAlertaTxt.textContent = aberta?.estado === "parou" ? `${this.nomeAlvo(a)} parou: está esperando você` : "";
    a.btnRodar.disabled = !a.alvo || !!aberta;
    this.pintarTempo(a);
  }

  pintarTempo(a) {
    const u = this.ultimaTexto(a);
    a.elUltima.textContent = u.t;
    a.elUltima.className = `auto-ultima ${u.c}`;
    a.elProxima.textContent = this.proximaTexto(a);
  }

  ultimaTexto(a) {
    const r = a.rodadas?.[0];
    if (!r) return { t: "Ainda não rodou", c: "" };
    if (r.estado === "rodando") return { t: `Rodando desde ${quando(r.inicio)}`, c: "" };
    if (r.estado === "parou") return { t: `Parado desde ${quando(r.inicio)}`, c: "ruim" };
    const icone = { ok: "✓", pulou: "↷", falhou: "✕", "sem devolutiva": "⚠" }[r.estado] || "·";
    return { t: `${icone} ${quando(r.fim || r.inicio)} · ${r.resumo || r.estado}`, c: r.estado === "ok" ? "ok" : r.estado === "pulou" ? "" : "ruim" };
  }

  proximaTexto(a) {
    if (a.manual) return "Só roda pelo botão";
    const p = proxima(a);
    if (!p) return "Sem dia marcado";
    const dia = p.k === 0 ? "hoje" : p.k === 1 ? "amanhã" : DIAS[p.d.getDay()];
    const s = Math.ceil((p.d - Date.now()) / 1000), min = Math.ceil(s / 60);
    const falta = s < 60 ? `em ${s} s` : min < 60 ? `em ${min} min` : min < 1440 ? `em ${Math.round(min / 60)} h` : `em ${Math.round(min / 1440)} d`;
    return `Próxima: ${dia} ${a.hora} · ${falta}`;
  }

  onda(a, cor) {
    if (movimentoReduzido) return;
    const o = el("span", { class: "auto-onda", style: { "--oc": cor } });
    a.el.append(o);
    setTimeout(() => o.remove(), 1200);
  }

  // ---------------------------------------------------------------- a linha até o agente

  desenharFio(a) {
    const alvo = a.alvo ? this.palco.cartoes.get(a.alvo) : null;
    if (!alvo) { a.fio?.g.remove(); a.fio = null; return; }
    if (!a.fio) {
      const f = {
        halo: svg("path", { class: "halo", stroke: AMBAR }), linha: svg("path", { class: "linha", stroke: AMBAR }),
        fluxo: svg("path", { class: "fluxo" }), alvo: svg("path", { class: "alvo" }),
        g: svg("g", { class: `fio auto-fio${movimentoReduzido ? "" : " nascendo"}` }),
      };
      f.g.append(f.halo, f.linha, f.fluxo, f.alvo);
      f.alvo.addEventListener("click", e => this.menuFio(a, e));
      this.palco.gFios.append(f.g);
      a.fio = f;
      this.tracar(a, alvo);
      f.g.style.setProperty("--len", String(Math.ceil(f.linha.getTotalLength())));
      setTimeout(() => f.g.classList.remove("nascendo"), 1400);
      return;
    }
    this.tracar(a, alvo);
  }

  tracar(a, alvo) {
    const { d } = this.palco.curva(this.caixa(a), alvo);
    for (const p of [a.fio.halo, a.fio.linha, a.fio.fluxo, a.fio.alvo]) p.setAttribute("d", d);
  }

  /** Um cartão de agente mexeu, nasceu ou saiu: as linhas das automações acompanham. */
  redesenhar(id = null) {
    for (const a of this.lista.values()) if (!id || a.alvo === id) this.desenharFio(a);
  }

  menuFio(a, e) {
    const menu = $("#menu-fio");
    menu.replaceChildren(
      el("small", { class: "menu-titulo", text: `Automação ${a.nome}` }),
      el("button", { text: `Desligar de ${this.nomeAlvo(a)}`, onclick: () => { this.palco.fecharMenu(); this.salvar(a, { alvo: null }); } }));
    Object.assign(menu.style, { left: `${e.clientX + 6}px`, top: `${e.clientY + 6}px` });
    menu.hidden = false;
  }

  /** Um brilho corre pela linha entre a automação e o agente (ida: orientação; volta: devolutiva). */
  correr(agente, a, cor, aoFim) {
    const C = this.palco.cartoes.get(agente);
    if (!a.fio || !C) { aoFim?.(); return; }
    a.fio.g.classList.add("ativo");
    clearTimeout(a.fio.timer);
    a.fio.timer = setTimeout(() => a.fio?.g.classList.remove("ativo"), 2400);
    if (movimentoReduzido) { aoFim?.(); return; }
    const caminho = a.fio.linha, total = caminho.getTotalLength();
    const doAgente = cor === VERDE; // o caminho vai da automação ao agente
    const pos = t => caminho.getPointAtLength((doAgente ? 1 - limitar(t, 0, 1) : limitar(t, 0, 1)) * total);
    const brilho = this.palco.brilho(cor), rastro = [];
    for (let i = 0; i < 6; i++) {
      const p = svg("circle", { r: i === 0 ? 16 : Math.max(4, 12 - i * 1.6), fill: brilho, opacity: i === 0 ? 1 : Math.max(0.2, 0.8 - i * 0.12) });
      this.palco.gPart.append(p);
      rastro.push(p);
    }
    const t0 = performance.now(), duracao = 1300, atraso = 0.04;
    const suave = t => (t <= 0 ? 0 : t >= 1 ? 1 : t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
    const quadro = agora => {
      const t = (agora - t0) / duracao;
      rastro.forEach((p, i) => { const q = pos(suave(t - i * atraso)); p.setAttribute("cx", q.x); p.setAttribute("cy", q.y); });
      if (t < 1 + rastro.length * atraso) { requestAnimationFrame(quadro); return; }
      rastro.forEach(p => p.remove());
      this.palco.onda(pos(1), cor);
      if (!doAgente) this.palco.flash(C, cor);
      aoFim?.();
    };
    requestAnimationFrame(quadro);
  }

  /** Mensagem da automação para o agente (a orientação entrou na caixa dele). */
  mensagem(de, para, fase) {
    const a = this.lista.get(de.replace(/^auto:/, ""));
    if (a && fase === "enviada") this.correr(para, a, AMBAR);
  }

  // ---------------------------------------------------------------- arrastar e ligar

  /** Arrasta o cartão (ou o post-it); um clique sem arrastar chama aoClicar. */
  arrastar(e, o, aoClicar, salvar = () => this.salvar(o, { x: Math.round(o.x), y: Math.round(o.y) })) {
    if (e.button !== 0 || e.target.closest("button, .auto-porta, .postit-texto")) return;
    e.stopPropagation();
    const z = this.palco.v.z, ini = { x: e.clientX, y: e.clientY, ox: o.x, oy: o.y };
    let moveu = false;
    const mover = ev => {
      if (!moveu && Math.hypot(ev.clientX - ini.x, ev.clientY - ini.y) < 4) return;
      if (!moveu) { moveu = true; o.arrastando = true; o.el.classList.add("movendo"); }
      o.x = ini.ox + (ev.clientX - ini.x) / z;
      o.y = ini.oy + (ev.clientY - ini.y) / z;
      o.el.style.left = `${o.x}px`;
      o.el.style.top = `${o.y}px`;
      if (o.fio) this.desenharFio(o);
    };
    const soltar = () => {
      window.removeEventListener("pointermove", mover);
      o.arrastando = false;
      o.el.classList.remove("movendo");
      if (moveu) salvar(); else aoClicar?.();
    };
    window.addEventListener("pointermove", mover);
    window.addEventListener("pointerup", soltar, { once: true });
  }

  puxarLinha(e, a) {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    this.selecionar(a);
    const temp = svg("path", { class: "fio-temp", stroke: AMBAR });
    this.palco.gFios.append(temp);
    this.palco.raiz.classList.add("ligando");
    let alvo = null;
    const mover = ev => {
      const sob = document.elementFromPoint(ev.clientX, ev.clientY)?.closest(".cartao");
      const novo = sob ? this.palco.cartoes.get(sob.dataset.id) : null;
      if (novo !== alvo) { alvo?.el.classList.remove("alvo-ligacao"); alvo = novo; alvo?.el.classList.add("alvo-ligacao"); }
      const m = this.palco.telaParaMundo(ev.clientX, ev.clientY);
      const fim = alvo ? alvo : { x: m.x, y: m.y, w: 0, h: 0 };
      temp.setAttribute("d", this.palco.curva(this.caixa(a), fim).d);
    };
    const soltar = () => {
      window.removeEventListener("pointermove", mover);
      temp.remove();
      this.palco.raiz.classList.remove("ligando");
      alvo?.el.classList.remove("alvo-ligacao");
      if (!alvo) return;
      if (!alvo.viva) { avisar({ texto: "Só dá para ligar a um agente aberto.", cor: AMBAR }); return; }
      if (alvo.id === a.alvo) return;
      this.salvar(a, { alvo: alvo.id }).then(ok => {
        if (!ok) return;
        const maestro = alvo.info.papel === "maestro";
        avisar({ rota: `⏰ ${a.nome} → ${alvo.info.nome}`, texto: maestro ? "na hora marcada, a orientação vai por essa linha e ele distribui para o time" : "ligada: na hora marcada, ele recebe a orientação", cor: AMBAR });
      });
    };
    window.addEventListener("pointermove", mover);
    window.addEventListener("pointerup", soltar, { once: true });
    mover(e);
  }

  // ---------------------------------------------------------------- criar, salvar, rodar

  /** Um lugar livre perto de um ponto (o meio da tela, se nenhum), fora dos cartões e dos setores. */
  lugarLivre(w, h, c = this.palco.telaParaMundo(innerWidth / 2, innerHeight / 2 + 30), ignorar = null) {
    const outros = [...this.lista.values(), ...this.postits.values()].filter(o => o !== ignorar).map(o => this.caixa(o));
    const ocupado = [...this.palco.cartoes.values(), ...outros, ...this.palco.setores.caixas()];
    const livre = (x, y) => !ocupado.some(o => x < o.x + o.w + 30 && x + w + 30 > o.x && y < o.y + o.h + 30 && y + h + 30 > o.y);
    for (let r = 0; r < 40; r++) {
      const n = Math.max(1, r * 8);
      for (let k = 0; k < n; k++) {
        const ang = (k / n) * Math.PI * 2, x = c.x - w / 2 + Math.cos(ang) * r * 70, y = c.y - h / 2 + Math.sin(ang) * r * 70;
        if (livre(x, y)) return { x: Math.round(x), y: Math.round(y) };
      }
    }
    return { x: Math.round(c.x - w / 2), y: Math.round(c.y - h / 2) };
  }

  /** O cartão nasceu fora da tela: a vista vai até ele. */
  mostrar(o) {
    const b = this.caixa(o), { x, y, z } = this.palco.v;
    const sx = b.x * z + x, sy = b.y * z + y;
    if (sx > 20 && sx + b.w * z < innerWidth - 400 && sy > 80 && sy + b.h * z < innerHeight - 80) return;
    this.palco.v.x = (innerWidth - 380) / 2 - (b.x + b.w / 2) * z;
    this.palco.v.y = innerHeight / 2 - (b.y + b.h / 2) * z;
    this.palco.aplicar(true);
  }

  async nova(dados = {}) {
    let nome = dados.nome || "Nova automação";
    for (let i = 2; [...this.lista.values()].some(a => a.nome.toLowerCase() === nome.toLowerCase()); i++) nome = `${dados.nome || "Nova automação"} ${i}`;
    try {
      const d = await api("/api/automacoes", { json: { ...this.lugarLivre(300, 230), dias: [1, 2, 3, 4, 5], hora: "09:00", ...dados, nome } });
      const a = this.receber(d, { nascendo: true });
      this.selecionar(a);
      this.mostrar(a);
      if (!a.alvo) avisar({ rota: "⏰ Automação", texto: "arraste a bolinha ● do cartão até o agente que vai receber a orientação", cor: AMBAR });
      setTimeout(() => { this.campoNome.focus({ preventScroll: true }); this.campoNome.select(); }, 80);
    } catch (e) { avisar({ texto: e.message, cor: "#ff6b7d" }); }
  }

  async salvar(a, mudanca) {
    try {
      this.receber(await api(`/api/automacoes/${a.id}`, { method: "PUT", json: mudanca }));
      return true;
    } catch (e) {
      avisar({ texto: e.message, cor: "#ff6b7d" });
      return false;
    }
  }

  /** Mudança vinda do painel: o cartão muda na hora e o app grava meio segundo depois da última tecla. */
  editar(a, mudanca) {
    Object.assign(a, mudanca);
    a.salvando = true;
    const versao = (a.versao = (a.versao || 0) + 1);
    this.pintar(a);
    this.desenharFio(a);
    this.pintarPainel();
    clearTimeout(a.timerSalvar);
    a.timerSalvar = setTimeout(async () => {
      const { nome, instrucao, dias, hora, manual, perdida, aviso } = a;
      try {
        await api(`/api/automacoes/${a.id}`, { method: "PUT", json: { nome, instrucao, dias, hora, manual, perdida, aviso } });
        this.erro(a, null);
      } catch (e) { this.erro(a, e.message); }
      if (a.versao === versao) a.salvando = false;
    }, 500);
  }

  erro(a, texto) {
    if (this.selecionada !== a) return;
    this.elErro.hidden = !texto;
    this.elErro.textContent = texto ? `Não salvou: ${texto}` : "";
  }

  async rodar(a) {
    try { await api(`/api/automacoes/${a.id}/rodar`, { method: "POST" }); }
    catch (e) { avisar({ rota: `⏰ ${a.nome}`, texto: e.message, cor: "#ff6b7d" }); }
  }

  async remover(a) {
    if (!confirm(`Remover a automação "${a.nome}"? O histórico dela sai junto.`)) return;
    try { await api(`/api/automacoes/${a.id}/remover`, { method: "POST" }); this.removerLocal(a.id); }
    catch (e) { avisar({ texto: e.message, cor: "#ff6b7d" }); }
  }

  /** Aviso do Windows clicado: o palco vai até a automação e abre o painel dela. */
  focar(id) {
    const a = this.lista.get(id);
    if (!a) return;
    this.selecionar(a);
    const b = this.caixa(a), z = Math.max(this.palco.v.z, 0.8);
    this.palco.v = { z, x: (innerWidth - 380) / 2 - (b.x + b.w / 2) * z, y: (innerHeight + 60) / 2 - (b.y + b.h / 2) * z };
    this.palco.aplicar(true);
    this.onda(a, AMBAR);
  }

  // ---------------------------------------------------------------- painel

  montarPainel() {
    const opcoes = (classe, itens) => el("div", { class: `ap-opcoes ${classe}` }, ...itens.map(([v, t]) => el("button", { "data-v": v, text: t })));
    this.campoNome = el("input", { type: "text", class: "ap-nome", maxlength: "40", spellcheck: "false", "aria-label": "Nome da automação" });
    this.elErro = el("p", { class: "ap-nota", style: { color: "var(--perigo)" }, hidden: true });
    this.campoInst = el("textarea", { maxlength: "4000", placeholder: "O que o agente faz quando ela rodar. Ex.: lê a fila de chamados, separa o que cada analista consegue resolver, distribui e me devolve um resumo." });
    this.elModo = opcoes("modo", [["agenda", "No horário"], ["manual", "Só no botão"]]);
    this.elDias = el("div", { class: "ap-dias" }, ...[1, 2, 3, 4, 5, 6, 0].map(d => el("button", { "data-d": d, title: DIAS[d], text: DIAS[d][0].toUpperCase() })));
    this.campoHora = el("input", { type: "time", "aria-label": "Hora" });
    this.elHorario = el("div", { class: "ap-linha" }, this.elDias, this.campoHora);
    this.elVai = el("div", { class: "ap-vai" });
    this.elPerdida = opcoes("perdida", [["rodar", "Roda quando abrir"], ["pular", "Pula a vez"]]);
    this.campoPerdida = el("div", { class: "ap-campo" }, el("span", { class: "ap-rotulo", text: "Se o Engram estava fechado no horário" }), this.elPerdida);
    this.campoAviso = el("input", { type: "checkbox" });
    this.elRecebe = el("div", { class: "ap-recebe" });
    this.elDevolutiva = el("div", { class: "ap-devolutiva conv-md" });
    this.campoDevolutiva = el("div", { class: "ap-campo" }, this.rotuloDevolutiva = el("span", { class: "ap-rotulo" }), this.elDevolutiva);
    this.elHistorico = el("div", { class: "ap-historico" });
    this.btnRodar = el("button", { class: "ap-rodar", text: "▶ Rodar já", onclick: () => this.selecionada && this.rodar(this.selecionada) });
    this.painel = el("aside", { class: "auto-painel", hidden: true },
      el("h2", {}, el("span", { class: "relogio" }), "Automação", el("button", { class: "fechar", title: "Fechar (Esc)", text: "×", onclick: () => this.fecharPainel() })),
      this.campoNome, this.elErro,
      el("div", { class: "ap-campo" }, el("label", { text: "Orientação" }), this.campoInst),
      el("div", { class: "ap-campo" }, el("span", { class: "ap-rotulo", text: "Quando" }), this.elModo, this.elHorario),
      el("div", { class: "ap-campo" }, el("span", { class: "ap-rotulo", text: "Vai para" }), this.elVai),
      this.campoPerdida,
      el("label", { class: "ap-marca" }, this.campoAviso, "Aviso do Windows quando terminar ou parar"),
      el("div", { class: "ap-campo" }, el("span", { class: "ap-rotulo", text: "O que o agente recebe" }), this.elRecebe),
      this.campoDevolutiva,
      el("div", { class: "ap-campo" }, el("span", { class: "ap-rotulo", text: "Histórico" }), this.elHistorico),
      el("div", { class: "ap-acoes" }, this.btnRodar, el("button", { class: "ap-remover", text: "Remover", onclick: () => this.selecionada && this.remover(this.selecionada) })));
    const sel = () => this.selecionada;
    this.campoNome.addEventListener("input", () => sel() && this.editar(sel(), { nome: this.campoNome.value.replace(/\s+/g, " ").trimStart() }));
    this.campoInst.addEventListener("input", () => sel() && this.editar(sel(), { instrucao: this.campoInst.value }));
    this.elModo.addEventListener("click", e => { const b = e.target.closest("button"); if (b && sel()) this.editar(sel(), { manual: b.dataset.v === "manual" }); });
    this.elDias.addEventListener("click", e => {
      const b = e.target.closest("button"), a = sel();
      if (!b || !a) return;
      const d = Number(b.dataset.d);
      this.editar(a, { dias: a.dias.includes(d) ? a.dias.filter(x => x !== d) : [...a.dias, d].sort((x, y) => x - y) });
    });
    this.campoHora.addEventListener("change", () => { if (this.campoHora.value && sel()) this.editar(sel(), { hora: this.campoHora.value }); });
    this.elPerdida.addEventListener("click", e => { const b = e.target.closest("button"); if (b && sel()) this.editar(sel(), { perdida: b.dataset.v }); });
    this.campoAviso.addEventListener("change", () => sel() && this.editar(sel(), { aviso: this.campoAviso.checked }));
    this.painel.addEventListener("pointerdown", e => e.stopPropagation());
    this.painel.addEventListener("keydown", e => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); this.fecharPainel(); } });
    this.palco.raiz.append(this.painel);
  }

  selecionar(a) {
    const antes = this.selecionada;
    this.selecionada = a;
    if (antes && antes !== a) this.pintar(antes);
    if (!a) { this.painel.hidden = true; return; }
    this.pintar(a);
    this.painel.hidden = false;
    if (antes !== a) { this.painel.scrollTop = 0; this.erro(a, null); }
    this.pintarPainel({ campos: antes !== a });
  }

  fecharPainel() { this.selecionar(null); }

  /** Atualiza o painel; os campos de texto só mudam ao trocar de automação (ou quando ninguém digita neles). */
  pintarPainel({ campos = false, flash = false } = {}) {
    const a = this.selecionada;
    if (!a) return;
    const foco = document.activeElement;
    if ((campos || (foco !== this.campoNome && !a.salvando)) && this.campoNome.value !== a.nome) this.campoNome.value = a.nome;
    if ((campos || (foco !== this.campoInst && !a.salvando)) && this.campoInst.value !== a.instrucao) this.campoInst.value = a.instrucao;
    if (foco !== this.campoHora) this.campoHora.value = a.hora;
    for (const b of this.elModo.children) b.classList.toggle("on", (b.dataset.v === "manual") === a.manual);
    for (const b of this.elDias.children) b.classList.toggle("on", a.dias.includes(Number(b.dataset.d)));
    for (const b of this.elPerdida.children) b.classList.toggle("on", b.dataset.v === a.perdida);
    this.elHorario.hidden = a.manual;
    this.campoPerdida.hidden = a.manual;
    this.campoAviso.checked = a.aviso;
    const c = a.alvo ? this.palco.cartoes.get(a.alvo) : null;
    this.elVai.classList.toggle("nenhum", !c);
    if (c) this.elVai.replaceChildren(el("i", { style: { "--c": c.cor } }), c.info.nome, c.info.papel === "maestro" ? " · maestro, distribui para o time" : "");
    else this.elVai.textContent = a.alvo ? "O agente ligado não está aberto no palco" : "Ninguém ainda: arraste a bolinha ● do cartão até um agente";
    this.pintarRecebe(a);
    const ultimaOk = (a.rodadas || []).find(r => r.devolutiva);
    this.campoDevolutiva.hidden = !ultimaOk;
    if (ultimaOk && this.elDevolutiva.dataset.n !== String(ultimaOk.n)) {
      this.elDevolutiva.dataset.n = String(ultimaOk.n);
      this.elDevolutiva.innerHTML = window.markdownit({ html: false, linkify: true }).render(ultimaOk.devolutiva); // HTML desligado no markdown-it
      for (const l of this.elDevolutiva.querySelectorAll("a")) { l.target = "_blank"; l.rel = "noopener noreferrer"; }
      this.rotuloDevolutiva.textContent = `Última devolutiva · ${quando(ultimaOk.fim || ultimaOk.inicio)}`;
    }
    if (flash && !movimentoReduzido) {
      const d = this.elDevolutiva;
      d.classList.remove("flash"); void d.offsetWidth; d.classList.add("flash");
      d.addEventListener("animationend", () => d.classList.remove("flash"), { once: true });
    }
    const rodadas = a.rodadas || [];
    const classe = r => (r.estado === "ok" ? "ok" : r.estado === "pulou" ? "pulou" : r.estado === "rodando" ? "aberta" : "ruim");
    const texto = r => (r.estado === "rodando" ? "rodando…" : r.estado === "parou" ? "parado: o agente pediu permissão" : r.resumo || r.estado)
      + (r.motivo === "atrasada" && r.estado !== "pulou" ? " · rodou atrasada" : r.motivo === "botão" ? " · pelo botão" : "");
    this.elHistorico.replaceChildren(...(rodadas.length
      ? rodadas.map(r => el("div", {}, el("span", { text: quando(r.inicio) }), el("span", { class: classe(r), text: texto(r) })))
      : [el("div", {}, el("span", { text: "—" }), el("span", { class: "pulou", text: "Ainda não rodou" }))]));
    this.btnRodar.disabled = !a.alvo || !!this.aberta(a);
    this.btnRodar.textContent = this.aberta(a) ? "Rodando…" : "▶ Rodar já";
  }

  pintarRecebe(a) {
    if (this.selecionada !== a) return;
    const q = a.manual ? "rodada pedida agora pela pessoa" : `${diasTexto(a.dias)}, ${a.hora}`;
    this.elRecebe.textContent = `[Engram · automação "${a.nome}" · ${q}]\n${a.instrucao || "(escreva a orientação acima)"}\n\n(Quando terminar, devolva o resultado com enviar para="${a.nome}".)`;
  }

  /** Esc: fecha o painel. Diz se fez algo. */
  escape() {
    if (!this.painel.hidden) { this.fecharPainel(); return true; }
    return false;
  }

  // ---------------------------------------------------------------- post-its

  receberPostit(d, nascendo = false) {
    let p = this.postits.get(d.id);
    if (!p) {
      p = { ...d };
      p.elTexto = el("div", { class: "postit-texto", contenteditable: "plaintext-only", spellcheck: "false" });
      p.el = el("div", { class: `postit${nascendo && !movimentoReduzido ? " nasce" : ""}`, "data-id": d.id }, p.elTexto,
        el("div", { class: "postit-acoes" },
          el("button", { class: "tirar", text: "Tirar", title: "Tirar o post-it do palco", onclick: () => this.removerPostit(p) }),
          el("button", { text: "⏰ Virar automação", onclick: () => this.virarAutomacao(p) })));
      p.elTexto.textContent = p.texto;
      p.elTexto.addEventListener("input", () => {
        p.texto = p.elTexto.innerText.replace(/\n$/, "");
        clearTimeout(p.timer);
        p.timer = setTimeout(() => api(`/api/postits/${p.id}`, { method: "PUT", json: { texto: p.texto } }).catch(e => avisar({ texto: e.message, cor: "#ff6b7d" })), 600);
      });
      p.elTexto.addEventListener("keydown", e => { if (e.key === "Escape") { e.preventDefault(); p.elTexto.blur(); } });
      p.el.addEventListener("pointerdown", e => this.arrastar(e, p, () => p.elTexto.focus({ preventScroll: true }),
        () => api(`/api/postits/${p.id}`, { method: "PUT", json: { x: Math.round(p.x), y: Math.round(p.y) } }).catch(() => {})));
      if (nascendo) setTimeout(() => p.el.classList.remove("nasce"), 900);
      this.camada.append(p.el);
      this.postits.set(p.id, p);
    } else {
      if (!p.arrastando) Object.assign(p, { x: d.x, y: d.y });
      if (document.activeElement !== p.elTexto && !p.timer) { p.texto = d.texto; p.elTexto.textContent = d.texto; }
    }
    p.el.style.left = `${p.x}px`;
    p.el.style.top = `${p.y}px`;
    return p;
  }

  removerPostitLocal(id) {
    const p = this.postits.get(id);
    if (!p) return;
    this.postits.delete(id);
    p.el.remove();
  }

  async novoPostit() {
    try {
      const p = this.receberPostit(await api("/api/postits", { json: { texto: "", ...this.lugarLivre(210, 150) } }), true);
      this.mostrar(p);
      setTimeout(() => p.elTexto.focus({ preventScroll: true }), 80);
    } catch (e) { avisar({ texto: e.message, cor: "#ff6b7d" }); }
  }

  async removerPostit(p) {
    if (p.texto.trim() && !confirm("Tirar este post-it do palco?")) return;
    try { await api(`/api/postits/${p.id}/remover`, { method: "POST" }); this.removerPostitLocal(p.id); }
    catch (e) { avisar({ texto: e.message, cor: "#ff6b7d" }); }
  }

  /** O post-it vira um cartão de automação: o texto é a orientação; um dia da semana citado vira o dia. */
  async virarAutomacao(p) {
    const t = p.texto.trim(), baixo = t.toLowerCase();
    const dias = Object.entries(NOMES_DIA).filter(([n]) => baixo.includes(n)).map(([, d]) => d);
    const resto = t.includes(":") ? t.slice(t.indexOf(":") + 1).trim() : t;
    let nome = resto.split("\n")[0].replace(/^./, c => c.toUpperCase());
    if (nome.length > 40) nome = `${nome.slice(0, 38).replace(/\s+\S*$/, "")}…`;
    clearTimeout(p.timer);
    p.el.classList.add("virando");
    await new Promise(r => setTimeout(r, 450));
    const lugar = this.lugarLivre(300, 230, { x: p.x + 105, y: p.y + 100 }, p); // onde estava o post-it, se couber
    await this.nova({ nome: nome || "Nova automação", instrucao: t, dias: dias.length ? dias : [1, 2, 3, 4, 5], ...lugar });
    try { await api(`/api/postits/${p.id}/remover`, { method: "POST" }); } catch { /* sai na próxima carga */ }
    this.removerPostitLocal(p.id);
  }
}
