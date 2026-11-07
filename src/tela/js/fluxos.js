// A vista Fluxos: o projeto em blocos ligados, no estilo do n8n (tela → rota → tratamento → banco → volta).
// Uma IA monta o mapa lendo a pasta; os agentes do palco desenham planos e marcam o bloco em que estão
// mexendo, e ele acende com o nome e a cor de quem trabalha. Clicar num bloco mostra o que ele faz, os
// arquivos (que abrem na vista Código) e deixa pedir uma mudança só nele a um agente.
// O desenho veio do Orbion (Lucas Lessa), que passou a fazer parte do Engram.

import { $, el, svg, api, avisar } from "./util.js";

const ic = (nome, extra = "") => el("i", { class: `codicon codicon-${nome} ${extra}`.trim() });
const erro = e => avisar({ texto: e.message || String(e), cor: "#ff6b7d", tempo: 7000 });
const nomeDe = rel => String(rel || "").split("/").pop();

export const TIPOS = {
  tela: { nome: "Tela", icone: "browser", cor: "#4f8cff" },
  componente: { nome: "Componente", icone: "layout", cor: "#7aa2ff" },
  rota: { nome: "Rota", icone: "radio-tower", cor: "#f59e0b" },
  servico: { nome: "Tratamento", icone: "symbol-method", cor: "#a78bfa" },
  banco: { nome: "Banco", icone: "database", cor: "#22c55e" },
  fila: { nome: "Fila", icone: "list-tree", cor: "#14b8a6" },
  ia: { nome: "IA", icone: "sparkle", cor: "#ec4899" },
  externo: { nome: "Sistema de fora", icone: "cloud", cor: "#94a3b8" },
  evento: { nome: "Gatilho", icone: "zap", cor: "#f97316" },
  arquivo: { nome: "Arquivo", icone: "file-code", cor: "#64748b" },
};
const tipoDe = b => TIPOS[b.tipo] || TIPOS.servico;
const ESTADO = {
  trabalhando: ["loading", "Trabalhando agora"], feito: ["pass-filled", "Feito"], falhou: ["error", "Deu problema"],
  previsto: ["circle-large-outline", "Previsto, ainda sem arquivos"], existe: ["check", "Já existe no projeto"],
};
const LARG = 232, ALT = 72, VAO_X = 96, VAO_Y = 44, VAO_FAIXA = 92, COLUNAS_POR_FAIXA = 4;
const MODELOS = [["sonnet", "Sonnet"], ["haiku", "Haiku (mais barato)"], ["opus", "Opus (mais caprichado)"], ["", "Padrão do agente"]];

/** Arrumação automática: camadas da esquerda para a direita, quebrando em faixas quando o fluxo é comprido. */
function arrumar(fluxo) {
  const ids = fluxo.blocos.map(b => b.id);
  const saem = new Map(ids.map(i => [i, []]));
  for (const l of fluxo.ligacoes) saem.get(l.de)?.push(l.para);
  // a ligação que volta para quem ainda está no caminho (o banco devolve para a rota) não conta nas camadas
  const entram = new Map(ids.map(i => [i, []]));
  const situacao = new Map();
  const andar = id => {
    situacao.set(id, "no-caminho");
    for (const p of saem.get(id) || []) {
      if (situacao.get(p) === "no-caminho") continue;
      entram.get(p).push(id);
      if (!situacao.has(p)) andar(p);
    }
    situacao.set(id, "feito");
  };
  ids.forEach(id => { if (!situacao.has(id)) andar(id); });
  const nivel = new Map();
  const calcular = id => {
    if (nivel.has(id)) return nivel.get(id);
    nivel.set(id, 0);
    const n = Math.max(0, ...(entram.get(id) || []).map(p => calcular(p) + 1));
    nivel.set(id, n);
    return n;
  };
  ids.forEach(calcular);
  const colunas = [];
  for (const id of ids) (colunas[nivel.get(id)] ||= []).push(id);
  const indice = new Map();
  colunas.forEach(c => c?.forEach((id, i) => indice.set(id, i)));
  for (let passada = 0; passada < 2; passada++) {
    for (let c = 1; c < colunas.length; c++) {
      if (!colunas[c]) continue;
      const media = id => { const ps = (entram.get(id) || []).filter(p => nivel.get(p) < c).map(p => indice.get(p)); return ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : indice.get(id); };
      colunas[c].sort((a, b) => media(a) - media(b));
      colunas[c].forEach((id, i) => indice.set(id, i));
    }
  }
  const pos = {};
  let topo = 0;
  for (let inicio = 0; inicio < colunas.length; inicio += COLUNAS_POR_FAIXA) {
    const faixa = colunas.slice(inicio, inicio + COLUNAS_POR_FAIXA);
    const maior = Math.max(1, ...faixa.map(c => c?.length || 0));
    const altura = maior * ALT + (maior - 1) * VAO_Y;
    faixa.forEach((c, x) => {
      if (!c) return;
      const alt = c.length * ALT + (c.length - 1) * VAO_Y;
      c.forEach((id, i) => { pos[id] = { x: x * (LARG + VAO_X), y: Math.round(topo + (altura - alt) / 2 + i * (ALT + VAO_Y)) }; });
    });
    topo += altura + VAO_FAIXA;
  }
  return pos;
}

function caminho(a, b) {
  const x0 = a.x + LARG, y0 = a.y + ALT / 2, x3 = b.x, y3 = b.y + ALT / 2;
  if (x3 >= x0 + 24) {
    const dx = Math.max(50, (x3 - x0) / 2);
    return { d: `M${x0},${y0} C${x0 + dx},${y0} ${x3 - dx},${y3} ${x3},${y3}`, meio: [(x0 + x3) / 2, (y0 + y3) / 2] };
  }
  // volta para a esquerda (faixa de baixo ou ciclo): desce pelo vão, anda e entra
  const entre = b.y > a.y + ALT + 10 ? (a.y + ALT + b.y) / 2 : a.y > b.y + ALT + 10 ? (b.y + ALT + a.y) / 2 : Math.max(a.y, b.y) + ALT + 40;
  return { d: `M${x0},${y0} C${x0 + 56},${y0} ${x0 + 56},${entre} ${x0},${entre} L${x3},${entre} C${x3 - 56},${entre} ${x3 - 56},${y3} ${x3},${y3}`, meio: [(x0 + x3) / 2, entre] };
}

export class VistaFluxos {
  constructor(raiz, { agentes, corDe, abrirArquivo }) {
    this.raiz = raiz;
    this.agentes = agentes; // () => [{ id, nome, estado }]
    this.corDe = corDe; // sessão → cor do cartão no palco
    this.abrirArquivo = abrirArquivo;
    this.dados = null;
    this.atual = null; // id do fluxo aberto
    this.bloco = null; // id do bloco selecionado
    this.vistas = new Map(); // fluxo → { x, y, z }
    this.pos = {};
    this.montado = false;
  }

  async ligar() {
    if (!this.montado) { this.montado = true; this.montar(); }
    await this.carregar();
  }

  montar() {
    this.raiz.replaceChildren(el("div", { class: "flx" },
      el("aside", { class: "flx-lado", id: "flx-lado" }),
      el("main", { class: "flx-palco" },
        el("div", { class: "flx-barra", id: "flx-barra" }),
        el("div", { class: "flx-tela", id: "flx-tela" },
          el("div", { class: "flx-mundo", id: "flx-mundo" }),
          el("div", { class: "flx-legenda", id: "flx-legenda" }),
          el("div", { class: "flx-vazio", id: "flx-vazio", hidden: true }))),
      el("aside", { class: "flx-gaveta", id: "flx-gaveta", hidden: true })));
    this.ligarTela();
  }

  async carregar() {
    try { this.dados = await api("/api/fluxos"); } catch (e) { return erro(e); }
    if (!this.dados.fluxos.some(f => f.id === this.atual)) { this.atual = this.dados.fluxos[0]?.id || null; this.bloco = null; }
    this.desenharLado();
    this.pintar(true);
  }

  fluxo() { return this.dados?.fluxos.find(f => f.id === this.atual) || null; }

  /** Situação de cada bloco: a marca ao vivo de um agente, ou se já existe (tem arquivo) ou é só previsto. */
  situacao(f, b) {
    const marca = this.dados?.vivos?.[f.id]?.[b.id];
    if (marca) return { ...marca, cor: this.corDe(marca.sessao) };
    return { estado: b.arquivos.length ? "existe" : "previsto" };
  }

  // ---------------------------------------------------------------- lateral: o projeto e a lista de fluxos

  desenharLado() {
    const d = this.dados, lado = $("#flx-lado");
    if (!lado || !d) return;
    const mapeando = d.mapeando;
    const modelo = el("select", { class: "flx-modelo", title: "Modelo que monta o mapa", onchange: e => api("/api/fluxos/modelo", { json: { modelo: e.target.value } }).catch(erro) },
      MODELOS.map(([v, r]) => el("option", { value: v, ...(v === (d.modelo ?? "sonnet") ? { selected: true } : {}) }, r)));
    const vivosDe = f => Object.values(d.vivos?.[f.id] || {}).filter(m => m.estado === "trabalhando").length;
    lado.replaceChildren(...[
      el("div", { class: "flx-projeto" }, ic("folder-opened"), el("b", { text: d.nome, title: d.raiz })),
      el("small", { class: "flx-dica", text: "A pasta é a mesma da vista Código (troque por lá)." }),
      mapeando
        ? el("div", { class: "flx-mapeando" },
          el("div", { class: "flx-mapeando-topo" }, el("span", { class: "giro" }), el("b", { text: "A IA está lendo o projeto" })),
          el("small", { id: "flx-passo", text: mapeando.passo || "…" }),
          el("button", { class: "btn pequeno", onclick: () => api("/api/fluxos/parar", { method: "POST" }).catch(erro) }, ic("debug-stop"), " Parar"))
        : el("div", { class: "flx-mapear" },
          el("button", { class: "btn-brilho pequeno", onclick: () => this.mapear() }, el("span", {}, ic("sparkle"), d.mapeadoEm ? " Mapear de novo com IA" : " Mapear o projeto com IA")),
          el("label", { class: "flx-modelo-rotulo" }, "Modelo", modelo)),
      d.resumo ? el("p", { class: "flx-resumo", text: d.resumo }) : null,
      el("div", { class: "flx-titulo-lista" }, el("span", { text: "Fluxos" }), d.fluxos.length ? el("b", { class: "cod-contador", text: String(d.fluxos.length) }) : null),
      el("div", { class: "flx-lista" }, d.fluxos.length ? d.fluxos.map(f => el("button", {
        class: `flx-item${f.id === this.atual ? " ativo" : ""}`, onclick: () => { this.atual = f.id; this.bloco = null; this.desenharLado(); this.pintar(true); },
        oncontextmenu: e => { e.preventDefault(); if (confirm(`Apagar o fluxo "${f.nome}"?`)) api(`/api/fluxos/${encodeURIComponent(f.id)}/remover`, { method: "POST" }).catch(erro); },
      },
      el("span", { class: "flx-item-cores" }, [...new Set(f.blocos.map(b => tipoDe(b).cor))].slice(0, 5).map(c => el("i", { style: { background: c } }))),
      el("span", { class: "flx-item-nome", text: f.nome }),
      vivosDe(f) ? el("span", { class: "flx-item-vivo", title: "Alguém está trabalhando neste fluxo" }) : null,
      el("small", { text: `${f.blocos.length} blocos${f.origem === "agente" ? " · agente" : ""}` }))) : el("p", { class: "flx-dica", text: "Nenhum fluxo ainda." }))].flat().filter(Boolean));
  }

  async mapear() {
    try {
      const sel = $("#flx-lado .flx-modelo");
      await api("/api/fluxos/mapear", { json: { modelo: sel ? sel.value : undefined } });
      this.dados.mapeando = { passo: "Começando…" };
      this.desenharLado();
    } catch (e) { erro(e); }
  }

  // ---------------------------------------------------------------- a tela: blocos, ligações, zoom

  vista() {
    if (!this.vistas.has(this.atual)) this.vistas.set(this.atual, { x: 40, y: 60, z: 1 });
    return this.vistas.get(this.atual);
  }

  aplicarVista() {
    const v = this.vista(), mundo = $("#flx-mundo"), tela = $("#flx-tela");
    if (!mundo) return;
    mundo.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.z})`;
    tela.style.backgroundSize = `${24 * v.z}px ${24 * v.z}px`;
    tela.style.backgroundPosition = `${v.x}px ${v.y}px`;
    const z = $("#flx-zoom");
    if (z) z.textContent = `${Math.round(v.z * 100)}%`;
  }

  zoom(cx, cy, fator) {
    const v = this.vista(), z = Math.min(2, Math.max(0.25, v.z * fator));
    v.x = cx - ((cx - v.x) * z) / v.z;
    v.y = cy - ((cy - v.y) * z) / v.z;
    v.z = z;
    this.aplicarVista();
  }

  encaixar() {
    const f = this.fluxo(), tela = $("#flx-tela");
    if (!f?.blocos.length || !tela) return;
    const W = tela.clientWidth, H = tela.clientHeight;
    if (!W || !H) return requestAnimationFrame(() => this.encaixar());
    const ps = f.blocos.map(b => this.pos[b.id]).filter(Boolean);
    const x0 = Math.min(...ps.map(p => p.x)), y0 = Math.min(...ps.map(p => p.y)) - 14;
    const x1 = Math.max(...ps.map(p => p.x + LARG)), y1 = Math.max(...ps.map(p => p.y + ALT));
    const z = Math.max(0.3, Math.min(1.1, (W - 90) / (x1 - x0), (H - 110) / (y1 - y0)));
    this.vistas.set(this.atual, { z, x: (W - (x1 - x0) * z) / 2 - x0 * z, y: (H - (y1 - y0) * z) / 2 - y0 * z });
    this.aplicarVista();
  }

  rearrumar() {
    const f = this.fluxo();
    if (!f) return;
    f.posicoes = {};
    api(`/api/fluxos/${encodeURIComponent(f.id)}/posicoes`, { json: { posicoes: {}, trocar: true } }).catch(() => {});
    this.pintar(true);
  }

  pintar(enquadrar = false) {
    const f = this.fluxo(), mundo = $("#flx-mundo"), vazio = $("#flx-vazio");
    if (!mundo) return;
    this.desenharBarra();
    if (!f) {
      mundo.replaceChildren();
      $("#flx-legenda").replaceChildren();
      vazio.hidden = false;
      vazio.replaceChildren(el("div", { class: "flx-vazio-miolo" },
        el("div", { class: "flx-vazio-icone" }, ic("type-hierarchy-sub")),
        el("h2", { text: "Os fluxos do projeto" }),
        el("p", { text: "Cada funcionalidade vira um caminho de blocos: tela → rota → tratamento → banco → volta. Uma IA lê a pasta e monta o mapa; depois, os agentes do palco marcam o bloco em que estão mexendo e ele acende." }),
        this.dados?.mapeando ? el("p", { class: "flx-dica", text: "Mapeando agora…" })
          : el("button", { class: "btn-brilho", onclick: () => this.mapear() }, el("span", {}, ic("sparkle"), " Mapear o projeto com IA"))));
      this.fecharGaveta();
      return;
    }
    vazio.hidden = true;
    this.pos = { ...arrumar(f), ...(f.posicoes || {}) };
    const linhas = svg("svg", { class: "flx-linhas", width: 1, height: 1 });
    mundo.replaceChildren(linhas, ...f.blocos.map(b => this.elBloco(f, b)));
    this.pintarLinhas(f, linhas);
    $("#flx-legenda").replaceChildren(...[...new Set(f.blocos.map(b => b.tipo))].map(t => el("span", {}, el("i", { style: { background: (TIPOS[t] || TIPOS.servico).cor } }), (TIPOS[t] || TIPOS.servico).nome)));
    if (enquadrar || !this.vistas.has(f.id)) requestAnimationFrame(() => this.encaixar()); else this.aplicarVista();
    if (this.bloco) this.desenharGaveta(); else this.fecharGaveta();
  }

  desenharBarra() {
    const f = this.fluxo(), barra = $("#flx-barra");
    if (!barra) return;
    const trabalhando = f ? f.blocos.filter(b => this.situacao(f, b).estado === "trabalhando").length : 0;
    barra.replaceChildren(...[
      ic("type-hierarchy-sub"),
      el("b", { class: "flx-nome", text: f ? f.nome : "Fluxos" }),
      f ? el("span", { class: "flx-status", text: `${f.blocos.length} blocos · ${f.ligacoes.length} ligações` }) : null,
      trabalhando ? el("span", { class: "flx-status vivo" }, el("span", { class: "flx-item-vivo" }), `${trabalhando} ${trabalhando > 1 ? "blocos" : "bloco"} em trabalho`) : null,
      el("span", { class: "cod-empurra" }),
      f ? el("button", { class: "cod-bt-icone", title: "Limpar as marcas dos agentes", onclick: () => api("/api/fluxos/limpar-marcas", { method: "POST" }).catch(erro) }, ic("clear-all")) : null,
      f ? el("button", { class: "cod-bt-icone", title: "Rearrumar os blocos", onclick: () => this.rearrumar() }, ic("layout")) : null,
      f ? el("button", { class: "cod-bt-icone", title: "Diminuir", onclick: () => this.zoomMeio(1 / 1.2) }, ic("zoom-out")) : null,
      f ? el("span", { class: "flx-zoom", id: "flx-zoom" }) : null,
      f ? el("button", { class: "cod-bt-icone", title: "Aumentar", onclick: () => this.zoomMeio(1.2) }, ic("zoom-in")) : null,
      f ? el("button", { class: "cod-bt-icone", title: "Enquadrar (duplo clique na tela)", onclick: () => this.encaixar() }, ic("screen-full")) : null].flat().filter(Boolean));
  }

  zoomMeio(fator) { const t = $("#flx-tela"); this.zoom(t.clientWidth / 2, t.clientHeight / 2, fator); }

  elBloco(f, b) {
    const s = this.situacao(f, b), tipo = tipoDe(b), p = this.pos[b.id] || { x: 0, y: 0 };
    const [icone, dica] = ESTADO[s.estado] || ESTADO.existe;
    const sub = s.estado === "trabalhando" ? `${s.nome} está mexendo` : b.arquivos.length ? `${nomeDe(b.arquivos[0])}${b.arquivos.length > 1 ? ` +${b.arquivos.length - 1}` : ""}` : tipo.nome;
    const e = el("div", {
      class: `flx-bloco st-${s.estado}${this.bloco === b.id ? " selecionado" : ""}`, "data-id": b.id,
      style: { left: `${p.x}px`, top: `${p.y}px`, "--cor": tipo.cor, ...(s.cor ? { "--agente": s.cor } : {}) }, title: b.detalhe || b.titulo,
    },
    s.nome && s.estado !== "existe" && s.estado !== "previsto" ? el("div", { class: "flx-quem" }, el("span", { text: s.nome })) : null,
    el("span", { class: "flx-porta entrada" }),
    el("div", { class: "flx-icone" }, ic(tipo.icone)),
    el("div", { class: "flx-textos" }, el("div", { class: "flx-titulo", text: b.titulo }), el("div", { class: "flx-sub", text: sub })),
    s.estado === "existe" ? null : el("span", { class: "flx-selo", title: dica }, ic(icone, s.estado === "trabalhando" ? "codicon-modifier-spin" : "")),
    el("span", { class: "flx-porta saida" }));
    e.addEventListener("pointerdown", ev => this.arrastar(f, b.id, e, ev));
    return e;
  }

  pintarLinhas(f, linhas) {
    const mundo = $("#flx-mundo");
    for (const r of mundo.querySelectorAll(".flx-rotulo")) r.remove();
    const seta = (id, classe) => svg("marker", { id, viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" });
    const defs = svg("defs", {});
    for (const [id, classe] of [["flx-seta", ""], ["flx-seta-ativa", "ativa"], ["flx-seta-destaque", "destaque"]]) {
      const m = seta(id);
      m.append(svg("path", { d: "M0,0 L10,5 L0,10 z", class: `flx-seta ${classe}` }));
      defs.append(m);
    }
    linhas.replaceChildren(defs);
    for (const l of f.ligacoes) {
      const a = this.pos[l.de], b = this.pos[l.para];
      if (!a || !b) continue;
      const { d, meio } = caminho(a, b);
      const ativa = [l.de, l.para].some(id => this.dados?.vivos?.[f.id]?.[id]?.estado === "trabalhando");
      const destaque = this.bloco && (l.de === this.bloco || l.para === this.bloco);
      const tipo = destaque ? "destaque" : ativa ? "ativa" : "";
      linhas.append(svg("path", { d, class: `flx-linha ${tipo}`, "marker-end": `url(#flx-seta${tipo ? `-${tipo}` : ""})` }));
      if (ativa) linhas.append(svg("path", { d, class: "flx-cometa" }));
      if (l.rotulo) mundo.append(el("div", { class: `flx-rotulo${destaque ? " destaque" : ""}`, style: { left: `${meio[0]}px`, top: `${meio[1]}px` }, title: l.rotulo, text: l.rotulo }));
    }
  }

  arrastar(f, id, elBloco, e) {
    if (e.button !== 0) return;
    e.stopPropagation();
    const v = this.vista(), inicio = { ...this.pos[id] }, x0 = e.clientX, y0 = e.clientY;
    let moveu = false;
    elBloco.setPointerCapture(e.pointerId);
    const mover = ev => {
      const dx = (ev.clientX - x0) / v.z, dy = (ev.clientY - y0) / v.z;
      if (!moveu && Math.hypot(dx, dy) < 4) return;
      moveu = true;
      elBloco.classList.add("arrastando");
      this.pos[id] = { x: Math.round(inicio.x + dx), y: Math.round(inicio.y + dy) };
      elBloco.style.left = `${this.pos[id].x}px`;
      elBloco.style.top = `${this.pos[id].y}px`;
      this.pintarLinhas(f, $("#flx-mundo .flx-linhas"));
    };
    const soltar = () => {
      elBloco.removeEventListener("pointermove", mover);
      elBloco.classList.remove("arrastando");
      if (moveu) {
        f.posicoes = { ...(f.posicoes || {}), [id]: this.pos[id] };
        api(`/api/fluxos/${encodeURIComponent(f.id)}/posicoes`, { json: { posicoes: { [id]: this.pos[id] } } }).catch(() => {});
      } else this.selecionar(id);
    };
    elBloco.addEventListener("pointermove", mover);
    elBloco.addEventListener("pointerup", soltar, { once: true });
  }

  ligarTela() {
    const tela = $("#flx-tela");
    tela.addEventListener("wheel", e => {
      e.preventDefault();
      const r = tela.getBoundingClientRect();
      this.zoom(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0016)));
    }, { passive: false });
    tela.addEventListener("pointerdown", e => {
      if (e.target.closest(".flx-bloco, .flx-vazio button, .flx-legenda") || e.button !== 0) return;
      const v = this.vista(), x0 = e.clientX - v.x, y0 = e.clientY - v.y;
      let moveu = false;
      tela.setPointerCapture(e.pointerId);
      tela.classList.add("arrastando");
      const mover = ev => { moveu = true; v.x = ev.clientX - x0; v.y = ev.clientY - y0; this.aplicarVista(); };
      tela.addEventListener("pointermove", mover);
      tela.addEventListener("pointerup", () => {
        tela.removeEventListener("pointermove", mover);
        tela.classList.remove("arrastando");
        if (!moveu && this.bloco) { this.bloco = null; this.pintar(); }
      }, { once: true });
    });
    tela.addEventListener("dblclick", e => { if (!e.target.closest(".flx-bloco")) this.encaixar(); });
    new ResizeObserver(() => { if (this.fluxo() && !this.vistas.has(this.atual)) this.encaixar(); }).observe(tela);
  }

  // ---------------------------------------------------------------- o bloco escolhido

  selecionar(id) {
    this.bloco = this.bloco === id ? null : id;
    this.pintar();
  }

  fecharGaveta() { const g = $("#flx-gaveta"); if (g) g.hidden = true; this.raiz.querySelector(".flx")?.classList.remove("com-gaveta"); }

  desenharGaveta() {
    const f = this.fluxo(), b = f?.blocos.find(x => x.id === this.bloco), g = $("#flx-gaveta");
    if (!b || !g) return this.fecharGaveta();
    g.hidden = false;
    this.raiz.querySelector(".flx")?.classList.add("com-gaveta");
    const s = this.situacao(f, b), tipo = tipoDe(b);
    const nome = id => f.blocos.find(x => x.id === id)?.titulo || id;
    const entram = f.ligacoes.filter(l => l.para === b.id), saem = f.ligacoes.filter(l => l.de === b.id);
    const ligacao = (l, outro, seta) => el("button", { class: "flx-ligacao", onclick: () => { this.bloco = outro; this.pintar(); } }, ic(seta), el("span", { text: nome(outro) }), l.rotulo ? el("small", { text: l.rotulo }) : null);
    const agentes = this.agentes();
    const quem = el("select", { class: "flx-quem-sel" }, agentes.length ? agentes.map(a => el("option", { value: a.id, ...(s.sessao === a.id ? { selected: true } : {}) }, `${a.nome} (${a.estado})`)) : el("option", { value: "" }, "Nenhum agente aberto no palco"));
    const pedido = el("textarea", { rows: 3, placeholder: `O que mudar em "${b.titulo}"?` });
    const enviar = async () => {
      if (!quem.value) return avisar({ texto: "Abra um agente no palco antes.", cor: "#ffc857" });
      try {
        await api("/api/fluxos/pedir", { json: { fluxo: f.id, bloco: b.id, sessao: quem.value, texto: pedido.value } });
        avisar({ texto: `Pedido enviado a ${quem.selectedOptions[0]?.textContent || "o agente"}.`, cor: "#4ade9f" });
        pedido.value = "";
      } catch (e) { erro(e); }
    };
    g.replaceChildren(...[
      el("div", { class: "flx-gaveta-topo", style: { "--cor": tipo.cor } },
        el("div", { class: "flx-icone" }, ic(tipo.icone)),
        el("div", { class: "flx-gaveta-titulos" }, el("b", { text: b.titulo }), el("small", { text: `${tipo.nome} · ${b.id}` })),
        el("button", { class: "cod-bt-icone", title: "Fechar", onclick: () => { this.bloco = null; this.pintar(); } }, ic("close"))),
      el("div", { class: `flx-estado st-${s.estado}`, style: s.cor ? { "--agente": s.cor } : {} }, ic((ESTADO[s.estado] || ESTADO.existe)[0], s.estado === "trabalhando" ? "codicon-modifier-spin" : ""),
        s.nome && !["existe", "previsto"].includes(s.estado) ? `${(ESTADO[s.estado] || ESTADO.existe)[1]} · ${s.nome}` : (ESTADO[s.estado] || ESTADO.existe)[1]),
      b.detalhe ? el("p", { class: "flx-detalhe", text: b.detalhe }) : null,
      el("h4", { text: "Arquivos" }),
      b.arquivos.length ? el("div", { class: "flx-arquivos" }, b.arquivos.map(a => el("button", { class: "flx-arquivo", title: `Abrir ${a} na vista Código`, onclick: () => this.abrirArquivo(a) }, ic("go-to-file"), el("span", { text: a }))))
        : el("p", { class: "flx-dica", text: "Ainda sem arquivos: é um bloco previsto." }),
      entram.length || saem.length ? el("h4", { text: "Ligações" }) : null,
      ...entram.map(l => ligacao(l, l.de, "arrow-left")), ...saem.map(l => ligacao(l, l.para, "arrow-right")),
      el("h4", { text: "Pedir uma mudança neste bloco" }),
      el("div", { class: "flx-pedido" }, quem, pedido,
        el("button", { class: "btn-brilho pequeno", onclick: enviar }, el("span", {}, ic("send"), " Mandar ao agente")),
        el("small", { class: "flx-dica", text: "O agente recebe o pedido com o fluxo inteiro e os arquivos do bloco." }))].flat().filter(Boolean));
  }

  // ---------------------------------------------------------------- ao vivo

  aoVivo(m) {
    if (!this.montado || (this.dados && m.raiz && m.raiz !== this.dados.raiz)) return;
    if (m.evento === "passo") {
      if (this.dados) this.dados.mapeando = { passo: m.texto };
      const p = $("#flx-passo");
      if (p) p.textContent = m.texto; else this.desenharLado();
    } else if (m.evento === "mapa-fim") {
      if (m.erro) avisar({ texto: `O mapa não ficou pronto: ${m.erro}`, cor: "#ff6b7d", tempo: 8000 });
      else if (!m.parado) avisar({ texto: `Mapa pronto: ${m.total} fluxos.`, cor: "#4ade9f" });
      this.carregar();
    } else if (m.evento === "bloco") {
      if (!this.dados) return;
      ((this.dados.vivos ||= {})[m.fluxo] ||= {})[m.bloco] = { estado: m.estado, sessao: m.sessao, nome: m.nome, quando: m.quando };
      if (m.fluxo !== this.atual && m.estado === "trabalhando" && !this.bloco) this.atual = m.fluxo; // segue o trabalho
      this.desenharLado();
      this.pintar(m.fluxo === this.atual && !this.vistas.has(m.fluxo));
    } else if (m.evento === "mudou" || m.evento === "desenhado") {
      if (m.evento === "desenhado" && m.fluxo) { this.atual = m.fluxo; this.vistas.delete(m.fluxo); }
      this.carregar();
    }
  }
}
