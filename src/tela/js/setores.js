// Setores do palco: áreas com nome, cor e instrução, desenhadas pela pessoa (MKT, Dev...). Quem tem o
// centro do cartão dentro faz parte: o maestro vê os setores no equipe e as tarefas chegam com a
// instrução do setor de quem recebe.
// O mouse não muda: arrastar o fundo continua movendo o palco, inclusive dentro de um setor. Só a
// etiqueta (move o setor com os agentes; com Alt, só a área) e o canto (tamanho) respondem.
// Criar: botão Setor (ou tecla S) e arrastar, Shift + arrastar no fundo, ou Ctrl + clique nos cartões
// e "Agrupar em setor".

import { $, el, api, avisar, movimentoReduzido } from "./util.js";

export const CORES_SETOR = ["#8b7bff", "#38d6f5", "#e879f9", "#ffc857", "#4ade9f", "#ff7a6b"];
const MIN = { w: 200, h: 140 };

export class Setores {
  constructor(palco) {
    this.palco = palco;
    this.lista = new Map(); // id → setor { id, nome, cor, instrucao, x, y, w, h, el }
    this.modo = false;
    this.selecao = new Set();
    this.camada = $("#setores");
    this.montar();
  }

  montar() {
    $("#btn-setor").onclick = () => this.alternarModo();
    this.dica = el("div", { class: "setor-dica" }, "Arraste no palco para desenhar o setor · ", el("kbd", { text: "Esc" }), " cancela");
    this.btnAgrupar = el("button", { class: "setor-agrupar", onclick: () => this.agruparSelecao() });
    this.campoNome = el("input", { maxlength: "24", placeholder: "Nome (ex.: MKT)", autocomplete: "off", spellcheck: "false" });
    this.caixaCores = el("div", { class: "setor-cores" });
    this.campoInst = el("textarea", { maxlength: "2000", placeholder: "O que esse setor faz (opcional). Ex.: textos e campanhas; não mexe em código." });
    this.tituloPop = el("h3", { text: "Novo setor" });
    this.btnOk = el("button", { class: "setor-ok", text: "Criar setor", onclick: () => this.fecharPop(true) });
    this.pop = el("div", { class: "setor-pop", hidden: true },
      this.tituloPop, this.campoNome, this.caixaCores, this.campoInst,
      el("p", { class: "setor-nota", text: "As tarefas que chegam aos agentes deste setor levam essa instrução, e o maestro vê quem é de qual setor." }),
      el("div", { class: "setor-acoes" }, el("button", { class: "btn", text: "Cancelar", onclick: () => this.fecharPop(false) }), this.btnOk));
    this.pop.addEventListener("keydown", e => {
      if (e.key === "Enter" && (e.target === this.campoNome || e.ctrlKey)) { e.preventDefault(); this.fecharPop(true); } // Ctrl+Enter salva de qualquer campo
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); this.fecharPop(false); }
    });
    this.pop.addEventListener("pointerdown", e => e.stopPropagation());
    this.palco.raiz.append(this.dica, this.btnAgrupar, this.pop);
  }

  // ---------------------------------------------------------------- estado

  carregar(setores) {
    for (const s of setores || []) this.receber(s, false);
    this.atualizarMembros(false);
  }

  /** Um setor criado ou mudado (pela tela ou pelo app): cria ou atualiza no lugar. */
  receber(dados, nascendo = true) {
    let s = this.lista.get(dados.id);
    if (!s) {
      s = { ...dados };
      s.el = el("div", { class: `setor${nascendo && !movimentoReduzido ? " nasce" : ""}` });
      s.elMarca = el("div", { class: "setor-marca" });
      s.elNome = el("b");
      s.elQtd = el("span", { class: "qtd" });
      s.elEtiqueta = el("div", { class: "setor-etiqueta", title: "Arraste para mover o setor com os agentes · Shift + arrastar move só a área · duplo clique edita" },
        el("i", { class: "ponto" }), s.elNome, s.elQtd,
        el("button", { title: "Editar o setor", text: "✎", onclick: () => this.editar(s) }),
        el("button", { title: "Remover o setor (os agentes ficam no palco)", text: "×", onclick: () => this.remover(s) }));
      const canto = el("div", { class: "setor-canto", title: "Mudar o tamanho" });
      s.el.append(el("div", { class: "setor-fundo" }), s.elMarca, s.elEtiqueta, canto);
      s.elEtiqueta.addEventListener("pointerdown", e => this.arrastar(e, s));
      s.elEtiqueta.addEventListener("dblclick", e => { if (!e.target.closest("button")) this.editar(s); });
      canto.addEventListener("pointerdown", e => this.redimensionar(e, s));
      s.el.addEventListener("animationend", ev => { if (ev.animationName === "setor-nasce") s.el.classList.remove("nasce"); });
      this.camada.append(s.el);
      this.lista.set(s.id, s);
    } else if (s.arrastando) {
      return; // o eco do próprio salvar chega no meio de um gesto: o gesto manda
    } else Object.assign(s, dados);
    this.pintar(s);
    this.atualizarMembros(nascendo);
  }

  removerLocal(id) {
    const s = this.lista.get(id);
    if (!s) return;
    this.lista.delete(id);
    s.el.classList.add("saindo");
    setTimeout(() => s.el.remove(), 380);
    this.atualizarMembros(false);
  }

  pintar(s) {
    Object.assign(s.el.style, { left: `${s.x}px`, top: `${s.y}px`, width: `${s.w}px`, height: `${s.h}px` });
    s.el.style.setProperty("--sc", s.cor);
    s.elNome.textContent = s.nome;
    s.elMarca.textContent = s.nome;
    s.elMarca.style.fontSize = `${Math.round(Math.min(s.h * 0.5, s.w / Math.max(2, s.nome.length * 0.72)))}px`;
  }

  caixas() { return [...this.lista.values()].map(s => ({ x: s.x, y: s.y - 60, w: s.w, h: s.h + 60 })); }

  /** O setor de um cartão: o menor que contém o centro dele (a mesma regra do app). */
  setorDe(c) {
    const cx = c.x + c.w / 2, cy = c.y + c.h / 2;
    return [...this.lista.values()].filter(s => cx > s.x && cx < s.x + s.w && cy > s.y && cy < s.y + s.h)
      .sort((a, b) => a.w * a.h - b.w * b.h)[0] || null;
  }

  /** Recalcula quem está em cada setor: selo no cartão, contagem na etiqueta. */
  atualizarMembros(brilhar = true) {
    const contagem = new Map();
    for (const c of this.palco.cartoes.values()) {
      const s = this.setorDe(c);
      if (s) contagem.set(s.id, (contagem.get(s.id) || 0) + 1);
      if (!c.chipSetor) {
        c.chipSetor = el("span", { class: "chip-setor" });
        c.el.querySelector(".cab")?.insertBefore(c.chipSetor, c.elEstado);
      }
      const antes = c.setorAtual || null, agora = s ? s.id : null;
      if (s) { c.chipSetor.textContent = s.nome; c.chipSetor.style.setProperty("--sc", s.cor); c.chipSetor.title = s.instrucao ? `Setor ${s.nome}: ${s.instrucao}` : `Setor ${s.nome}`; }
      c.chipSetor.classList.toggle("on", !!s);
      if (antes !== agora) {
        c.setorAtual = agora;
        if (brilhar && s) { c.chipSetor.classList.remove("chegou"); void c.chipSetor.offsetWidth; c.chipSetor.classList.add("chegou"); this.palco.flash(c, s.cor); }
      }
    }
    for (const s of this.lista.values()) {
      const n = contagem.get(s.id) || 0;
      s.elQtd.textContent = n === 1 ? "1 agente" : `${n} agentes`;
    }
  }

  aoCamera(z) {
    this.camada.style.setProperty("--zi", String(Math.min(2.4, Math.max(1, 1 / z))));
    this.palco.raiz.classList.toggle("setores-longe", z < 0.55);
    this.posicionarAgrupar();
  }

  // ---------------------------------------------------------------- desenhar

  alternarModo(ligar = !this.modo) {
    this.modo = ligar;
    $("#btn-setor").classList.toggle("ligado", ligar);
    this.palco.raiz.classList.toggle("desenhando-setor", ligar);
    this.dica.classList.toggle("on", ligar);
  }

  comecarDesenho(e) {
    const m = this.palco.telaParaMundo(e.clientX, e.clientY);
    const r = { x0: m.x, y0: m.y, x: m.x, y: m.y, w: 0, h: 0, medida: el("span", { class: "setor-medida" }) };
    r.el = el("div", { class: "setor rascunho" }, el("div", { class: "setor-fundo" }), r.medida);
    this.camada.append(r.el);
    const mover = ev => {
      const p = this.palco.telaParaMundo(ev.clientX, ev.clientY);
      Object.assign(r, { x: Math.min(r.x0, p.x), y: Math.min(r.y0, p.y), w: Math.abs(p.x - r.x0), h: Math.abs(p.y - r.y0) });
      Object.assign(r.el.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
      r.medida.textContent = `${Math.round(r.w)} × ${Math.round(r.h)}`;
    };
    const soltar = async () => {
      window.removeEventListener("pointermove", mover);
      if (r.w < MIN.w || r.h < MIN.h) { r.el.remove(); return; } // clique ou risco curto não vira setor
      this.alternarModo(false);
      const dados = await this.pedir(r, null);
      r.el.remove();
      if (dados) this.criar({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h), ...dados });
    };
    window.addEventListener("pointermove", mover);
    window.addEventListener("pointerup", soltar, { once: true });
  }

  async criar(dados) {
    try { this.receber(await api("/api/setores", { json: dados })); }
    catch (e) { avisar({ texto: e.message, cor: "#ff6b7d" }); }
  }

  salvar(s) {
    api(`/api/setores/${s.id}`, { method: "PUT", json: { nome: s.nome, cor: s.cor, instrucao: s.instrucao, x: Math.round(s.x), y: Math.round(s.y), w: Math.round(s.w), h: Math.round(s.h) } })
      .catch(e => avisar({ texto: e.message, cor: "#ff6b7d" }));
  }

  async editar(s) {
    const d = await this.pedir(s, s);
    if (!d) return;
    Object.assign(s, d);
    this.pintar(s);
    this.atualizarMembros(false);
    this.salvar(s);
  }

  async remover(s) {
    if (!confirm(`Remover o setor ${s.nome}? Os agentes continuam no palco, só saem do setor.`)) return;
    try { await api(`/api/setores/${s.id}/remover`, { method: "POST" }); this.removerLocal(s.id); }
    catch (e) { avisar({ texto: e.message, cor: "#ff6b7d" }); }
  }

  // ---------------------------------------------------------------- mover e redimensionar

  /** A etiqueta leva o setor com os agentes de dentro; com Shift, só a área (para reorganizar o time). */
  arrastar(e, s) {
    if (e.button !== 0 || e.target.closest("button")) return;
    e.stopPropagation();
    e.preventDefault();
    const soArea = e.shiftKey; // Alt não: no Windows ele ativa o menu escondido da janela e come o clique seguinte
    const z = this.palco.v.z;
    const membros = soArea ? [] : [...this.palco.cartoes.values()].filter(c => this.setorDe(c) === s).map(c => [c, c.x, c.y]);
    const ini = { x: e.clientX, y: e.clientY, sx: s.x, sy: s.y };
    s.arrastando = true;
    s.el.classList.add("movendo", soArea ? "so-area" : "com-agentes");
    const mover = ev => {
      const dx = (ev.clientX - ini.x) / z, dy = (ev.clientY - ini.y) / z;
      s.x = ini.sx + dx; s.y = ini.sy + dy;
      this.pintar(s);
      for (const [c, cx, cy] of membros) { c.x = cx + dx; c.y = cy + dy; this.palco.posicionar(c); }
      if (membros.length) this.palco.redesenharFios();
    };
    const soltar = () => {
      window.removeEventListener("pointermove", mover);
      s.arrastando = false;
      s.el.classList.remove("movendo", "so-area", "com-agentes");
      if (s.x === ini.sx && s.y === ini.sy) return;
      this.salvar(s);
      for (const [c] of membros) this.palco.salvarPosicao(c);
      this.atualizarMembros();
      this.posicionarAgrupar();
    };
    window.addEventListener("pointermove", mover);
    window.addEventListener("pointerup", soltar, { once: true });
  }

  redimensionar(e, s) {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const z = this.palco.v.z, ini = { x: e.clientX, y: e.clientY, w: s.w, h: s.h };
    s.arrastando = true;
    s.el.classList.add("redimensionando");
    const mover = ev => {
      s.w = Math.max(MIN.w, ini.w + (ev.clientX - ini.x) / z);
      s.h = Math.max(MIN.h, ini.h + (ev.clientY - ini.y) / z);
      this.pintar(s);
    };
    const soltar = () => {
      window.removeEventListener("pointermove", mover);
      s.arrastando = false;
      s.el.classList.remove("redimensionando");
      this.salvar(s);
      this.atualizarMembros();
    };
    window.addEventListener("pointermove", mover);
    window.addEventListener("pointerup", soltar, { once: true });
  }

  /** Um cartão está sendo arrastado: o setor em que ele vai cair acende. */
  aoMoverCartao(c) {
    const alvo = this.setorDe(c);
    for (const s of this.lista.values()) s.el.classList.toggle("alvo", s === alvo && alvo.id !== c.setorAtual);
  }

  aoSoltarCartao() {
    for (const s of this.lista.values()) s.el.classList.remove("alvo");
    this.atualizarMembros();
    this.posicionarAgrupar();
  }

  // ---------------------------------------------------------------- agrupar a seleção

  alternarSelecao(c) {
    if (this.selecao.has(c.id)) this.selecao.delete(c.id); else this.selecao.add(c.id);
    c.el.classList.toggle("selecionado", this.selecao.has(c.id));
    this.posicionarAgrupar();
  }

  limparSelecao() {
    if (!this.selecao.size) return;
    for (const id of this.selecao) this.palco.cartoes.get(id)?.el.classList.remove("selecionado");
    this.selecao.clear();
    this.posicionarAgrupar();
  }

  caixaSelecao() {
    const cs = [...this.selecao].map(id => this.palco.cartoes.get(id)).filter(Boolean);
    if (!cs.length) return null;
    const folga = 50;
    const x = Math.min(...cs.map(c => c.x)) - folga, y = Math.min(...cs.map(c => c.y)) - folga;
    return { x, y, w: Math.max(...cs.map(c => c.x + c.w)) + folga - x, h: Math.max(...cs.map(c => c.y + c.h)) + folga - y, n: cs.length };
  }

  posicionarAgrupar() {
    const r = this.selecao.size ? this.caixaSelecao() : null;
    this.btnAgrupar.classList.toggle("on", !!r);
    if (!r) return;
    const { x, y, z } = this.palco.v;
    this.btnAgrupar.style.left = `${(r.x + r.w / 2) * z + x}px`;
    this.btnAgrupar.style.top = `${Math.max(90, r.y * z + y - 12)}px`;
    this.btnAgrupar.textContent = `▢ Agrupar ${r.n === 1 ? "1 agente" : `${r.n} agentes`} em setor`;
  }

  async agruparSelecao() {
    const r = this.caixaSelecao();
    if (!r) return;
    this.limparSelecao();
    const dados = await this.pedir(r, null);
    if (dados) this.criar({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h), ...dados });
  }

  // ---------------------------------------------------------------- nome, cor e instrução

  pedir(r, s) {
    this.resolver?.(null);
    this.tituloPop.textContent = s ? `Editar o setor ${s.nome}` : "Novo setor";
    this.btnOk.textContent = s ? "Salvar" : "Criar setor";
    this.campoNome.value = s ? s.nome : "";
    this.campoInst.value = s ? s.instrucao || "" : "";
    this.caixaCores.replaceChildren(...CORES_SETOR.map(c => el("button", { class: "cor", title: c, style: { "--c": c }, "data-cor": c, onclick: () => this.escolherCor(c) })));
    this.escolherCor(s ? s.cor : CORES_SETOR[this.lista.size % CORES_SETOR.length]);
    const { x, y, z } = this.palco.v;
    this.pop.hidden = false;
    // ao lado do setor, sem sair da tela e sem encostar na barra do palco (embaixo) nem no topo
    this.pop.style.left = `${Math.min(innerWidth - this.pop.offsetWidth - 16, Math.max(14, (r.x + r.w) * z + x + 16))}px`;
    this.pop.style.top = `${Math.max(80, Math.min(innerHeight - this.pop.offsetHeight - 80, r.y * z + y))}px`;
    setTimeout(() => this.campoNome.focus(), 30);
    return new Promise(res => { this.resolver = res; });
  }

  escolherCor(c) {
    this.cor = c;
    this.pop.style.setProperty("--pc", c);
    for (const b of this.caixaCores.children) b.classList.toggle("on", b.dataset.cor === c);
  }

  fecharPop(ok) {
    const nome = this.campoNome.value.trim();
    if (ok && !nome) {
      this.campoNome.focus();
      this.campoNome.animate([{ transform: "translateX(-5px)" }, { transform: "translateX(5px)" }, { transform: "none" }], { duration: 220 });
      return;
    }
    this.pop.hidden = true;
    const res = this.resolver;
    this.resolver = null;
    res?.(ok ? { nome: nome.toUpperCase().slice(0, 24), cor: this.cor, instrucao: this.campoInst.value.trim() } : null);
  }

  /** Esc: fecha o que estiver aberto (modo de desenhar, seleção). Diz se fez algo. */
  escape() {
    if (!this.pop.hidden) { this.fecharPop(false); return true; }
    if (this.modo) { this.alternarModo(false); return true; }
    if (this.selecao.size) { this.limparSelecao(); return true; }
    return false;
  }
}
