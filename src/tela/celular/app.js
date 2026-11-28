// Engram no celular: o modo dispatch. Fala com o Engram do PC pela rede local, com o token deste aparelho.
// Três abas: Conversa (com o maestro ou quem a pessoa escolher), Palco (o mapa do time ao vivo, com as linhas
// e os setores) e Entregas (o que os agentes entregaram, aberto aqui mesmo). O que chega da conversa é texto:
// só o markdown-it (sem HTML) vira página. Os arquivos dos agentes abrem em outra origem (a porta de arquivos).

import { avatar } from "./avatar.js";

const $ = s => document.querySelector(s);

function el(tag, at = {}, ...filhos) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(at)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k === "style") for (const [p, x] of Object.entries(v)) e.style.setProperty(p, x);
    else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? "" : String(v));
  }
  for (const f of filhos.flat()) if (f !== null && f !== undefined && f !== false) e.append(f instanceof Node ? f : String(f));
  return e;
}
const SVG = "http://www.w3.org/2000/svg";
function sv(tag, at = {}, ...filhos) {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(at)) {
    if (v === undefined || v === null) continue;
    // style como atributo o CSP barra: as variáveis entram pelo CSSOM
    if (k === "style") for (const [p, x] of Object.entries(v)) e.style.setProperty(p, x);
    else e.setAttribute(k, String(v));
  }
  for (const f of filhos) if (f) e.append(f);
  return e;
}

const CHAVE = "engram.celular.token";
const CHAVE_ALVO = "engram.celular.alvo";
const CHAVE_ABA = "engram.celular.aba";
const CHAVE_VISTO = "engram.celular.entregas-vistas";
const OCUPADO = new Set(["pensando", "trabalhando", "iniciando"]);
const ATENCAO = "precisa de você";
// a mesma tabela do palco do PC (util.js); a ordem importa: "carbon" antes de "gemini"
const COR_MODELO = { opus: "#f5c451", sonnet: "#38d6f5", haiku: "#8ef06a", fable: "#e879f9", gpt: "#7ee0c3", codex: "#7ee0c3", carbon: "#6aa8ff", argon: "#8fb2ff", hydrogen: "#38d6f5", flash: "#4ade9f", orchestrator: "#f5c451", antigravity: "#6aa8ff", gemini: "#6aa8ff", opencode: "#fbbf24" };
const CHAVE_MODO = "engram.celular.modo-palco";
const guardado = {
  ler(k) { try { return localStorage.getItem(k); } catch { return null; } },
  gravar(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* sem armazenamento */ } },
};
const dormir = ms => new Promise(r => setTimeout(r, ms));
const hora = iso => (iso ? new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : "");
const toqueFino = matchMedia("(pointer: fine)").matches;
// o navegador só deixa vibrar depois que a pessoa tocou na página (e o iPhone não vibra por aqui)
const vibrar = p => { try { if (navigator.userActivation?.hasBeenActive !== false) navigator.vibrate?.(p); } catch { /* sem vibração */ } };
// "mcp__engram__enviar para X" -> "enviar para X"; "mcp__ponte__nbs_sql: ..." -> "ponte · nbs_sql: ..."
const acaoLegivel = t => String(t || "").replace(/mcp__engram__/g, "").replace(/mcp__([A-Za-z0-9-]+)__/g, "$1 · ");
const tamanhoLegivel = n => (n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const extensao = nome => (String(nome).match(/\.([a-z0-9]{1,8})$/i)?.[1] || "").toLowerCase();

let token = guardado.ler(CHAVE);
let time = null;          // o que /api/estado devolveu
let alvo = null;          // com quem a conversa está aberta
let aba = guardado.ler(CHAVE_ABA) || "conversa";
let palcoVisto = null;    // o palco que o mapa mostra
let conv = { id: null, ate: 0, carregando: false, pendente: false };
let fila = new Map();     // n -> texto: o que a pessoa mandou e ainda não entrou no agente
const parando = {};       // id -> até quando o botão Parar fica "parando"
let entregas = null;      // lista de /api/arquivos (null = ainda não carregou ou mudou)
let fluxo = null;         // AbortController dos avisos ao vivo
let fluxoOk = false;
let ultimoSinal = 0;
let fios = new Map();     // "a|b" -> <path> do mapa, para o pulso de mensagem
let nosMapa = new Map();  // id -> <g> do nó no mapa

const md = window.markdownit ? window.markdownit({ html: false, linkify: true, breaks: true }).disable("image") : null;
if (md) {
  const padrao = md.renderer.rules.link_open || ((t, i, o, _e, s) => s.renderToken(t, i, o));
  md.renderer.rules.link_open = (t, i, o, e, s) => { t[i].attrSet("target", "_blank"); t[i].attrSet("rel", "noopener noreferrer"); return padrao(t, i, o, e, s); };
}

// ---------------------------------------------------------------- conversa com o Engram do PC

async function api(caminho, { json, metodo } = {}) {
  const cab = {};
  if (token) cab.Authorization = `Bearer ${token}`;
  if (json !== undefined) cab["Content-Type"] = "application/json";
  let r;
  try {
    r = await fetch(`/api/${caminho}`, { method: metodo || (json !== undefined ? "POST" : "GET"), headers: cab, body: json !== undefined ? JSON.stringify(json) : undefined, cache: "no-store" });
  } catch { throw Object.assign(new Error("sem conexão com o PC"), { status: 0 }); }
  let d = {};
  try { d = await r.json(); } catch { /* corpo vazio */ }
  if (r.status === 401 && token && caminho !== "parear") desparear("Este aparelho não está mais pareado. Gere um código novo no PC e conecte de novo.");
  if (!r.ok) throw Object.assign(new Error(d.erro || `erro ${r.status}`), { status: r.status });
  return d;
}

function toast(texto, tipo = "") {
  const t = $("#toast");
  t.textContent = texto;
  t.className = `toast on ${tipo}`;
  clearTimeout(toast.tempo);
  toast.tempo = setTimeout(() => { t.className = "toast"; }, tipo === "erro" ? 5000 : 3200);
}

// ---------------------------------------------------------------- pareamento

function nomeDoAparelho() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  const m = /Android[^;)]*;\s*([^;)]+?)(?:\s+Build|\))/.exec(ua);
  if (m && m[1].trim().length > 2) return m[1].trim().slice(0, 40);
  if (/Android/.test(ua)) return "Android";
  return "Celular";
}

const formatarCodigo = v => {
  const c = String(v || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
  return c.length > 4 ? `${c.slice(0, 4)}-${c.slice(4)}` : c;
};

function mostrarParear(msg = "") {
  fluxo?.abort();
  fecharVisor(true);
  $("#app").hidden = true;
  $("#parear").hidden = false;
  $("#parear-erro").textContent = msg;
  if (!$("#aparelho").value) $("#aparelho").value = nomeDoAparelho();
  const p = /[#&]p=([A-Za-z0-9-]{8,9})/.exec(location.hash);
  if (p) {
    $("#codigo").value = formatarCodigo(p[1]);
    history.replaceState(null, "", "/");
    parear();
  }
}

async function parear(ev) {
  ev?.preventDefault();
  const codigo = $("#codigo").value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const erro = $("#parear-erro");
  if (codigo.length !== 8) { erro.textContent = "O código tem 8 letras e números (aparece no PC, em Ajustes › Celular)."; return; }
  const b = $("#btn-parear");
  b.disabled = true;
  b.firstChild.textContent = "Conectando…";
  erro.textContent = "";
  try {
    const r = await api("parear", { json: { codigo, nome: $("#aparelho").value } });
    token = r.token;
    guardado.gravar(CHAVE, token);
    vibrar([30, 40, 30]);
    iniciar();
  } catch (e) {
    erro.textContent = e.status === 403 ? "Código errado. Confira no PC." : e.message;
  } finally {
    b.disabled = false;
    b.firstChild.textContent = "Conectar";
  }
}

function desparear(msg) {
  token = null;
  guardado.gravar(CHAVE, null);
  time = null;
  entregas = null;
  conv = { id: null, ate: 0, carregando: false, pendente: false };
  mostrarParear(msg);
}

// ---------------------------------------------------------------- o time

const agente = id => time?.agentes.find(a => a.id === id) || null;
const agentePorNome = nome => time?.agentes.find(a => a.nome === nome) || null;
const corModelo = a => {
  const id = `${a?.modelo || ""} ${a?.nome_modelo || ""} ${a?.provedor || ""}`.toLowerCase();
  for (const [k, c] of Object.entries(COR_MODELO)) if (id.includes(k)) return c;
  return "#a5b4fc";
};
const classeEstado = e => (OCUPADO.has(e) ? "ocupado" : e === ATENCAO ? "atencao" : e === "pronta" || e === "esperando você" ? "livre" : "outro");
const textoEstado = e => ({ pensando: "pensando", trabalhando: "trabalhando", iniciando: "abrindo", pronta: "pronto", "esperando você": "pronto", [ATENCAO]: "precisa de você" }[e] || e || "—");
const subtitulo = a => [a.papel_nome, a.nome_modelo || a.agente].filter(Boolean).join(" · ");

/** O rosto do agente, com o anel do estado. `a` pode ser só { nome } (colega que já saiu). */
function rosto(a, tamanho = 40, extra = "") {
  const caixa = el("span", { class: `av ${extra}`, "data-estado": classeEstado(a?.estado), style: { "--cor": corModelo(a), "--t": `${tamanho}px` } });
  caixa.append(avatar({ semente: a?.id || a?.nome || "?", cor: corModelo(a), papel: a?.papel || "", tamanho }));
  return caixa;
}

function escolherPadrao() {
  const ag = time?.agentes || [];
  const atual = time?.palco_atual;
  return (ag.find(a => a.papel === "maestro" && a.palco === atual) || ag.find(a => a.papel === "maestro") || ag.find(a => a.palco === atual) || ag[0])?.id || null;
}

async function carregarTime() {
  try { time = await api("estado"); } catch (e) { if (e.status !== 401) marcarVivo(false); return; }
  document.documentElement.dataset.tema = time.tema || "aurora";
  $("#pc").textContent = time.pc;
  const ids = new Set(time.agentes.map(a => a.id));
  if (!alvo || !ids.has(alvo)) {
    const salvo = guardado.ler(CHAVE_ALVO);
    alvo = salvo && ids.has(salvo) ? salvo : escolherPadrao();
  }
  const palcos = new Set(time.agentes.map(a => a.palco));
  if (!palcoVisto || !palcos.has(palcoVisto)) palcoVisto = agente(alvo)?.palco || time.palco_atual;
  sincronizarFila();
  desenharAlvo();
  desenharSelos();
  if (aba === "palco") desenharPalco();
  if (alvo && conv.id !== alvo) abrirConversa(alvo);
  else if (!alvo) semAgentes();
}

let timeAgendado = null;
const agendarTime = () => { clearTimeout(timeAgendado); timeAgendado = setTimeout(carregarTime, 250); };

function sincronizarFila() {
  fila = new Map((agente(alvo)?.fila || []).map(m => [m.n, m.texto]));
  desenharFila();
}

function desenharAlvo() {
  const a = agente(alvo);
  const b = $("#alvo");
  $("#texto").disabled = !a;
  $("#enviar").disabled = !a;
  if (!a) {
    b.dataset.estado = "outro";
    b.replaceChildren(el("span", { class: "alvo-texto" }, el("b", { text: "Nenhum agente aberto no PC" }), el("small", { text: "Abra um agente no palco do Engram para mandar pedidos." })));
    $("#situacao").hidden = true;
    $("#pergunta").hidden = true;
    return;
  }
  b.dataset.estado = classeEstado(a.estado);
  b.style.setProperty("--cor", corModelo(a));
  b.replaceChildren(
    rosto(a, 40),
    el("span", { class: "alvo-texto" }, el("b", { text: a.nome }), el("small", { text: subtitulo(a) })),
    el("span", { class: "alvo-estado", text: textoEstado(a.estado) }),
    el("span", { class: "seta", "aria-hidden": "true", text: "⌄" }));
  $("#texto").placeholder = a.papel === "maestro" ? "Peça algo ao maestro…" : `Peça algo a ${a.nome}…`;
  desenharSituacao(a);
  desenharPergunta(a);
}

function desenharSituacao(a) {
  const s = $("#situacao");
  if (!a || !OCUPADO.has(a.estado)) { s.hidden = true; return; }
  s.hidden = false;
  const emParada = (parando[a.id] || 0) > Date.now();
  const parar = el("button", { type: "button", class: "parar", disabled: emParada, onclick: () => pararAgente(a.id) }, el("i"), emParada ? "parando" : "Parar");
  const texto = a.estado === "iniciando" ? "abrindo o agente…" : acaoLegivel(a.acao) || (a.estado === "pensando" ? "pensando…" : "trabalhando…");
  s.replaceChildren(el("span", { class: "onda", "aria-hidden": "true" }, el("i"), el("i"), el("i")), el("span", { class: "sit-texto", text: texto }), parar);
}

async function pararAgente(id) {
  parando[id] = Date.now() + 15_000;
  desenharSituacao(agente(id));
  vibrar(25);
  try { await api(`sessoes/${id}/interromper`, { json: {} }); } catch (e) { parando[id] = 0; toast(e.message, "erro"); desenharSituacao(agente(id)); }
}

function desenharPergunta(a) {
  const c = $("#pergunta");
  const p = a?.pergunta;
  if (!a || a.estado !== ATENCAO || !p) { c.hidden = true; c.replaceChildren(); return; }
  c.hidden = false;
  const botoes = el("div", { class: "perg-opcoes" });
  const opcao = (rotulo, n, corpo, atual = false) => el("button", { type: "button", class: `opcao${atual ? " atual" : ""}`, onclick: ev => responder(a.id, corpo, ev.currentTarget) }, el("em", { text: n }), el("span", { text: rotulo }));
  if (p.tipo === "confiar_pasta") botoes.append(opcao("Confiar na pasta e seguir", "✓", "confiar", true));
  else if (p.opcoes?.length) {
    for (const o of p.opcoes) botoes.append(opcao(o.texto, String(o.n), { opcao: o.n }, o.atual));
    if (!p.opcoes.some(o => /\besc\b/i.test(o.texto))) botoes.append(opcao("Cancelar", "esc", { tecla: "esc" }));
  } else {
    botoes.append(opcao("Confirmar", "↵", { tecla: "enter" }, true), opcao("Cancelar", "esc", { tecla: "esc" }));
  }
  c.replaceChildren(
    el("div", { class: "perg-cab" }, el("span", { class: "perg-sino", text: "!" }), el("b", { text: p.titulo || p.texto || "O agente precisa de você" })),
    p.detalhe?.length ? el("pre", { class: "perg-detalhe", text: p.detalhe.join("\n") }) : null,
    botoes);
}

async function responder(id, corpo, botao) {
  for (const b of $("#pergunta").querySelectorAll("button")) b.disabled = true;
  botao?.classList.add("indo");
  try {
    if (corpo === "confiar") await api(`sessoes/${id}/confiar`, { json: {} });
    else await api(`sessoes/${id}/responder`, { json: corpo });
    vibrar(20);
  } catch (e) {
    toast(e.message, "erro");
    for (const b of $("#pergunta").querySelectorAll("button")) b.disabled = false;
    botao?.classList.remove("indo");
  }
}

function selecionar(id) {
  if (id !== alvo) {
    alvo = id;
    guardado.gravar(CHAVE_ALVO, id);
    sincronizarFila();
    desenharAlvo();
    abrirConversa(id);
  }
  mostrarAba("conversa");
}

// ---------------------------------------------------------------- abas

function mostrarAba(nome) {
  aba = nome;
  guardado.gravar(CHAVE_ABA, nome);
  for (const b of document.querySelectorAll("#abas button")) b.classList.toggle("on", b.dataset.aba === nome);
  for (const v of ["conversa", "palco", "entregas"]) $(`#v-${v}`).hidden = v !== nome;
  moverLuz();
  if (nome === "palco") desenharPalco();
  if (nome === "entregas") carregarEntregas();
  if (nome === "conversa" && pertoDoFim()) rolarFim(true);
}

function moverLuz() {
  const b = document.querySelector("#abas button.on");
  const luz = $("#abas-luz");
  if (!b) return;
  luz.style.setProperty("--x", `${b.offsetLeft}px`);
  luz.style.setProperty("--w", `${b.offsetWidth}px`);
}

function desenharSelos() {
  if (!time) return;
  const ocupados = time.agentes.filter(a => OCUPADO.has(a.estado)).length;
  const atencao = time.agentes.filter(a => a.estado === ATENCAO).length;
  const selo = $("#selo-palco");
  selo.hidden = !ocupados && !atencao;
  selo.textContent = atencao ? "!" : String(ocupados);
  selo.className = atencao ? "atencao" : "";
  const novas = entregas ? entregas.filter(e => e.quando > (guardado.ler(CHAVE_VISTO) || "")).length : 0;
  const se = $("#selo-entregas");
  se.hidden = !novas || aba === "entregas";
  se.textContent = String(novas);
}

// ---------------------------------------------------------------- palco: o mapa e o time

function desenharPalco() {
  if (!time) return;
  const palcos = [...new Set(time.agentes.map(a => a.palco))].sort((a, b) => a - b);
  const abas = $("#palco-abas");
  abas.hidden = palcos.length < 2;
  abas.replaceChildren(...palcos.map(n => el("button", {
    type: "button", class: n === palcoVisto ? "on" : "",
    onclick: () => { palcoVisto = n; desenharPalco(); },
  }, time.palcos.find(p => p.n === n)?.nome || `Palco ${n}`, el("em", { text: String(time.agentes.filter(a => a.palco === n).length) }))));
  const ags = time.agentes.filter(a => a.palco === palcoVisto);
  // a pessoa escolheu? vale a escolha. Senão: mapa para time pequeno, grupos para time grande
  modoPalco = guardado.ler(CHAVE_MODO) || (ags.length > 8 ? "grupos" : "mapa");
  for (const b of document.querySelectorAll("#palco-modo button")) b.classList.toggle("on", b.dataset.modo === modoPalco);
  fios = new Map();
  nosMapa = new Map();
  grupoDe = new Map();
  noTopo = new Set();
  $("#mapa").classList.toggle("em-grupos", modoPalco === "grupos");
  if (!ags.length) $("#mapa").replaceChildren(el("p", { class: "vazio", text: "Nenhum agente aberto neste palco." }));
  else if (modoPalco === "grupos") desenharGrupos(ags);
  else desenharMapa(ags);
  desenharLista();
}

const TAMANHO = [700, 470];
let modoPalco = "mapa";
let grupoDe = new Map();  // id do agente -> id do grupo (visão Grupos), para o pulso descer pela linha certa
let noTopo = new Set();   // quem fica no alto da visão Grupos (os maestros)

/** O setor de um agente: o centro do cartão dele dentro da área do setor (a mesma regra do palco do PC). */
function setorDe(a, setores) {
  const p = a.posicao;
  if (!p) return null;
  const cx = p.x + (p.w || TAMANHO[0]) / 2, cy = p.y + (p.h || TAMANHO[1]) / 2;
  return setores.find(s => cx >= s.x && cx <= s.x + s.w && cy >= s.y && cy <= s.y + s.h) || null;
}

/** Visão Grupos: o maestro no alto e cada setor num cartão, com uma linha de luz descendo até cada um. */
function desenharGrupos(ags) {
  const caixa = $("#mapa");
  const setores = time.setores.filter(s => s.palco === palcoVisto);
  const topo = ags.filter(a => a.papel === "maestro");
  const grupos = setores.map(s => ({ s, membros: [] }));
  const soltos = [];
  for (const a of ags.filter(x => x.papel !== "maestro")) {
    const s = setorDe(a, setores);
    const g = s && grupos.find(x => x.s.id === s.id);
    (g ? g.membros : soltos).push(a);
  }
  const lista = grupos.filter(g => g.membros.length);
  if (soltos.length) lista.push({ s: { id: "_soltos", nome: setores.length ? "Sem setor" : "Time", cor: "#8b7bff" }, membros: soltos });
  const ordem = a => (OCUPADO.has(a.estado) ? 0 : a.estado === ATENCAO ? 0 : 1);
  const raiz = el("div", { class: "grupos" });
  const fiosSvg = sv("svg", { class: "grupos-fios", "aria-hidden": "true" });
  raiz.append(fiosSvg);
  const cab = el("div", { class: "grupos-topo" });
  if (topo.length) for (const a of topo) {
    const b = el("button", { type: "button", class: `topo-membro${a.id === alvo ? " atual" : ""}`, "data-estado": classeEstado(a.estado), style: { "--cor": corModelo(a) }, onclick: () => selecionar(a.id) },
      rosto(a, 58, "grande"),
      el("span", { class: "topo-texto" }, el("b", { text: a.nome }), el("small", { text: OCUPADO.has(a.estado) ? (acaoLegivel(a.acao) || textoEstado(a.estado)) : subtitulo(a) })),
      el("span", { class: "alvo-estado", text: textoEstado(a.estado) }));
    cab.append(b);
    nosMapa.set(a.id, b);
    noTopo.add(a.id);
  } else cab.append(el("div", { class: "topo-palco" }, el("span", { class: "topo-ponto" }), el("b", { text: time.palcos.find(p => p.n === palcoVisto)?.nome || `Palco ${palcoVisto}` })));
  raiz.append(cab);
  let i = 0;
  for (const g of lista) {
    const cor = /^#[0-9a-f]{6}$/i.test(g.s.cor) ? g.s.cor : "#8b7bff";
    const ocupados = g.membros.filter(a => OCUPADO.has(a.estado)).length;
    const atencao = g.membros.filter(a => a.estado === ATENCAO).length;
    const membros = [...g.membros].sort((x, y) => ordem(x) - ordem(y) || x.nome.localeCompare(y.nome));
    const cartao = el("section", { class: `grupo${ocupados ? " em-acao" : ""}`, "data-grupo": g.s.id, style: { "--c": cor, "--i": String(i++) } },
      el("header", {}, el("b", { text: g.s.nome }), el("em", { text: String(g.membros.length) }),
        atencao ? el("small", { class: "grupo-atencao" }, el("i"), `${atencao} precisa${atencao > 1 ? "m" : ""} de você`)
          : ocupados ? el("small", { class: "grupo-ocupados" }, el("i"), `${ocupados} trabalhando`) : null),
      el("div", { class: "grupo-membros" }, ...membros.map(a => {
        const b = el("button", { type: "button", class: `mini-membro${a.id === alvo ? " atual" : ""}`, "data-estado": classeEstado(a.estado), style: { "--cor": corModelo(a) }, onclick: () => selecionar(a.id), "aria-label": `${a.nome}, ${textoEstado(a.estado)}` },
          rosto(a, 46), el("span", { class: "mini-nome", text: a.nome }),
          a.fila?.length ? el("em", { class: "mini-fila", text: String(a.fila.length) }) : null);
        nosMapa.set(a.id, b);
        grupoDe.set(a.id, g.s.id);
        return b;
      })));
    raiz.append(cartao);
  }
  caixa.replaceChildren(raiz);
  requestAnimationFrame(() => fiosDosGrupos(raiz, fiosSvg));
}

/** As linhas da visão Grupos: um tronco que desce do maestro e um galho para cada setor. */
function fiosDosGrupos(raiz, svg) {
  if (!raiz.isConnected) return;
  const W = raiz.clientWidth, H = raiz.scrollHeight;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("width", W);
  svg.setAttribute("height", H);
  svg.replaceChildren();
  const base = raiz.getBoundingClientRect();
  const origem = raiz.querySelector(".grupos-topo .av, .topo-ponto");
  const o = origem.getBoundingClientRect();
  const X = o.left + o.width / 2 - base.left;
  const Y0 = o.bottom - base.top + 4;
  const corTopo = getComputedStyle(origem).getPropertyValue("--cor").trim() || "rgb(139,123,255)";
  const defs = sv("defs");
  svg.append(defs, sv("g", { id: "pulsos" }));
  for (const c of raiz.querySelectorAll(".grupo")) {
    const r = c.getBoundingClientRect();
    const y = r.top - base.top + 22, x = r.left - base.left;
    const cor = c.style.getPropertyValue("--c") || "#8b7bff";
    const gid = `gr-${c.dataset.grupo}`;
    defs.append(sv("linearGradient", { id: gid, gradientUnits: "userSpaceOnUse", x1: X, y1: Y0, x2: x, y2: y },
      sv("stop", { offset: 0, "stop-color": corTopo }), sv("stop", { offset: 1, "stop-color": cor })));
    const d = `M${X} ${Y0} L${X} ${y - 16} Q${X} ${y} ${X + 16} ${y} L${x} ${y}`;
    const fio = sv("path", { d, class: "fio", stroke: `url(#${gid})` });
    svg.insertBefore(fio, svg.lastChild);
    svg.insertBefore(sv("path", { d, class: `fio-fluxo${c.classList.contains("em-acao") ? " ativo" : ""}`, stroke: `url(#${gid})` }), svg.lastChild);
    svg.insertBefore(sv("circle", { cx: x, cy: y, r: 3.5, fill: cor, class: "fio-ponta" }), svg.lastChild);
    fios.set(`grupo:${c.dataset.grupo}`, fio);
  }
}

function desenharMapa(ags) {
  const caixa = $("#mapa");
  const muitos = ags.length > 8;
  const W = Math.max(280, caixa.clientWidth || 340);
  const H = Math.round(Math.max(300, Math.min(W * (muitos ? 1.3 : 1.05), innerHeight * (muitos ? 0.72 : 0.55))));
  // onde cada cartão está no palco do PC (o centro dele); quem não tem lugar vai para uma fileira embaixo
  const pts = ags.map((a, i) => {
    const p = a.posicao;
    const w = p?.w || TAMANHO[0], h = p?.h || TAMANHO[1];
    return p ? { a, x: p.x + w / 2, y: p.y + h / 2 } : { a, x: i * 800, y: 99999 };
  });
  const semLugar = pts.filter(p => p.y === 99999);
  if (semLugar.length) {
    const comLugar = pts.filter(p => p.y !== 99999);
    const base = comLugar.length ? Math.max(...comLugar.map(p => p.y)) + 700 : 0;
    semLugar.forEach((p, i) => { p.y = base; p.x = i * 800; });
  }
  const setores = time.setores.filter(s => s.palco === palcoVisto);
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const pad = 58;
  const bw = Math.max(x1 - x0, 1), bh = Math.max(y1 - y0, 1);
  const esc = Math.min((W - 2 * pad) / bw, (H - 2 * pad - 20) / bh);
  const offX = pad + ((W - 2 * pad) - bw * esc) / 2, offY = pad - 6 + ((H - 2 * pad - 20) - bh * esc) / 2;
  for (const p of pts) { p.X = offX + (p.x - x0) * esc; p.Y = offY + (p.y - y0) * esc; }
  // afasta quem ficou em cima do outro (o mapa é pequeno; o palco do PC é grande)
  const MIN = muitos ? 82 : 96;
  for (let volta = 0; volta < 90; volta++) {
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
      const a = pts[i], b = pts[j];
      let dx = b.X - a.X, dy = b.Y - a.Y, d = Math.hypot(dx, dy);
      if (d >= MIN) continue;
      if (d < .01) { dx = Math.cos(i + j); dy = Math.sin(i + j); d = 1; }
      const empurra = (MIN - d) / 2;
      a.X -= dx / d * empurra; a.Y -= dy / d * empurra; b.X += dx / d * empurra; b.Y += dy / d * empurra;
    }
    for (const p of pts) { p.X = Math.min(W - 46, Math.max(46, p.X)); p.Y = Math.min(H - 62, Math.max(40, p.Y)); }
  }
  const porId = new Map(pts.map(p => [p.a.id, p]));

  const svg = sv("svg", { class: "mapa-svg", viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img", "aria-label": "Mapa do palco" });
  const defs = sv("defs", {},
    sv("pattern", { id: "m-pontos", width: 18, height: 18, patternUnits: "userSpaceOnUse" }, sv("circle", { cx: 1, cy: 1, r: 1, fill: "rgba(255,255,255,.07)" })),
    sv("filter", { id: "m-brilho", x: "-50%", y: "-50%", width: "200%", height: "200%" }, sv("feGaussianBlur", { stdDeviation: 3 })));
  svg.append(defs, sv("rect", { x: 0, y: 0, width: W, height: H, rx: 22, fill: "url(#m-pontos)" }));

  // setores: a área em volta de quem está dentro (o centro do cartão dentro do setor, como no PC)
  for (const s of setores) {
    const dentro = pts.filter(p => p.x >= s.x && p.x <= s.x + s.w && p.y >= s.y && p.y <= s.y + s.h);
    let r;
    if (dentro.length) {
      const sx = dentro.map(p => p.X), sy = dentro.map(p => p.Y);
      r = { x: Math.min(...sx) - 42, y: Math.min(...sy) - 52, w: Math.max(...sx) - Math.min(...sx) + 84, h: Math.max(...sy) - Math.min(...sy) + 112 };
    } else r = { x: offX + (s.x - x0) * esc, y: offY + (s.y - y0) * esc, w: s.w * esc, h: s.h * esc };
    r.x = Math.max(6, r.x); r.y = Math.max(6, r.y); r.w = Math.min(W - 6 - r.x, r.w); r.h = Math.min(H - 6 - r.y, r.h);
    if (r.w < 30 || r.h < 30) continue;
    svg.append(sv("g", { class: "setor", style: { "--c": /^#[0-9a-f]{6}$/i.test(s.cor) ? s.cor : "#8b7bff" } },
      sv("rect", { x: r.x, y: r.y, width: r.w, height: r.h, rx: 18 }),
      Object.assign(sv("text", { x: r.x + 12, y: r.y + 17 }), { textContent: s.nome })));
  }

  // as linhas: quem fala com quem (a revisão em âmbar)
  const camadaFios = sv("g", { class: "fios" });
  for (const c of time.conexoes) {
    const a = porId.get(c.a), b = porId.get(c.b);
    if (!a || !b) continue;
    const mx = (a.X + b.X) / 2, my = (a.Y + b.Y) / 2, dx = b.X - a.X, dy = b.Y - a.Y, d = Math.hypot(dx, dy) || 1;
    const curva = Math.min(36, d * .18);
    const d2 = `M${a.X.toFixed(1)} ${a.Y.toFixed(1)} Q${(mx - dy / d * curva).toFixed(1)} ${(my + dx / d * curva).toFixed(1)} ${b.X.toFixed(1)} ${b.Y.toFixed(1)}`;
    const gid = `g-${c.a.slice(0, 8)}-${c.b.slice(0, 8)}`;
    defs.append(sv("linearGradient", { id: gid, gradientUnits: "userSpaceOnUse", x1: a.X, y1: a.Y, x2: b.X, y2: b.Y },
      sv("stop", { offset: 0, "stop-color": corModelo(a.a) }), sv("stop", { offset: 1, "stop-color": corModelo(b.a) })));
    const ativo = OCUPADO.has(a.a.estado) || OCUPADO.has(b.a.estado);
    const base = sv("path", { d: d2, class: `fio${c.revisa ? " revisao" : ""}`, stroke: c.revisa ? "#ffc857" : `url(#${gid})` });
    const corre = sv("path", { d: d2, class: `fio-fluxo${ativo ? " ativo" : ""}`, stroke: c.revisa ? "#ffc857" : `url(#${gid})` });
    camadaFios.append(base, corre);
    fios.set(`${c.a}|${c.b}`, base);
  }
  svg.append(camadaFios);
  svg.append(sv("g", { class: "pulsos", id: "pulsos" }));

  // os agentes
  for (const p of pts) {
    const a = p.a;
    const maestro = a.papel === "maestro";
    const t = muitos ? (maestro ? 48 : 38) : (maestro ? 60 : 50);
    const g = sv("g", { class: `no${a.id === alvo ? " atual" : ""}${maestro ? " maestro" : ""}`, "data-estado": classeEstado(a.estado), transform: `translate(${p.X.toFixed(1)} ${p.Y.toFixed(1)})`, style: { "--cor": corModelo(a) }, tabindex: 0, role: "button", "aria-label": `${a.nome}, ${textoEstado(a.estado)}` });
    g.append(sv("circle", { class: "halo", r: t / 2 + 9 }), sv("circle", { class: "anel", r: t / 2 + 4 }));
    const rostoSvg = avatar({ semente: a.id, cor: corModelo(a), papel: a.papel, tamanho: t });
    rostoSvg.setAttribute("x", -t / 2); rostoSvg.setAttribute("y", -t / 2);
    g.append(rostoSvg);
    const corte = muitos ? 11 : 16;
    g.append(Object.assign(sv("text", { class: "no-nome", y: t / 2 + 16 }), { textContent: a.nome.length > corte ? `${a.nome.slice(0, corte - 1)}…` : a.nome }));
    // com muita gente, só o nome (o estado já está no anel; o resto, na lista embaixo)
    if (!muitos) g.append(Object.assign(sv("text", { class: "no-sub", y: t / 2 + 29 }), { textContent: OCUPADO.has(a.estado) ? textoEstado(a.estado) : a.estado === ATENCAO ? "precisa de você" : (a.nome_modelo || a.papel_nome || "") }));
    if (a.fila?.length) g.append(sv("circle", { class: "no-fila", cx: t / 2 - 2, cy: -t / 2 + 2, r: 8 }), Object.assign(sv("text", { class: "no-fila-n", x: t / 2 - 2, y: -t / 2 + 6 }), { textContent: String(a.fila.length) }));
    g.addEventListener("click", () => selecionar(a.id));
    g.addEventListener("keydown", e => { if (e.key === "Enter") selecionar(a.id); });
    svg.append(g);
    nosMapa.set(a.id, g);
  }
  caixa.replaceChildren(svg);
}

/** A mensagem andando pela linha, de quem mandou para quem recebeu. */
function pulsar(de, para) {
  const alvoNo = nosMapa.get(para);
  if (!alvoNo) return;
  let caminho, invertido;
  if (modoPalco === "grupos") {
    // nos grupos a linha vai do maestro ao setor: desce se o maestro mandou, sobe se mandaram a ele
    if (noTopo.has(de) && grupoDe.has(para)) { caminho = fios.get(`grupo:${grupoDe.get(para)}`); invertido = false; }
    else if (noTopo.has(para) && grupoDe.has(de)) { caminho = fios.get(`grupo:${grupoDe.get(de)}`); invertido = true; }
  } else {
    caminho = fios.get(`${de}|${para}`) || fios.get(`${para}|${de}`);
    invertido = !fios.get(`${de}|${para}`);
  }
  const acender = () => { alvoNo.classList.remove("recebeu"); void alvoNo.getBoundingClientRect(); alvoNo.classList.add("recebeu"); setTimeout(() => alvoNo.classList.remove("recebeu"), 1300); };
  if (!caminho || matchMedia("(prefers-reduced-motion: reduce)").matches) { acender(); return; }
  const total = caminho.getTotalLength();
  const cor = corModelo(agente(de));
  const bola = sv("circle", { r: 4.5, class: "pulso", fill: cor });
  const rastro = sv("circle", { r: 9, class: "pulso-rastro", fill: cor });
  $("#pulsos")?.append(rastro, bola);
  const t0 = performance.now(), dur = 950;
  const passo = agora => {
    const k = Math.min(1, (agora - t0) / dur);
    const e = k < .5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
    const pt = caminho.getPointAtLength((invertido ? 1 - e : e) * total);
    for (const c of [bola, rastro]) { c.setAttribute("cx", pt.x); c.setAttribute("cy", pt.y); }
    if (k < 1) requestAnimationFrame(passo); else { bola.remove(); rastro.remove(); acender(); }
  };
  requestAnimationFrame(passo);
}

function desenharLista() {
  const ags = time.agentes.filter(a => a.palco === palcoVisto).sort((x, y) => (x.papel === "maestro" ? -1 : y.papel === "maestro" ? 1 : x.nome.localeCompare(y.nome)));
  const ocupados = time.agentes.filter(a => OCUPADO.has(a.estado)).length;
  $("#time-resumo").textContent = `${time.agentes.length} aberto${time.agentes.length === 1 ? "" : "s"}${ocupados ? ` · ${ocupados} trabalhando` : ""}`;
  $("#time-lista").replaceChildren(...ags.map((a, i) => el("button", {
    type: "button", class: `membro${a.id === alvo ? " atual" : ""}`, "data-estado": classeEstado(a.estado), style: { "--cor": corModelo(a), "--i": String(i) },
    onclick: () => selecionar(a.id),
  },
  rosto(a, 50),
  el("span", { class: "membro-texto" },
    el("span", { class: "membro-linha" }, el("b", { text: a.nome }), el("span", { class: "alvo-estado", text: textoEstado(a.estado) })),
    el("span", { class: "chips" }, a.papel_nome ? el("i", { class: "chip papel", text: a.papel_nome }) : null, el("i", { class: "chip modelo", text: a.nome_modelo || a.agente })),
    OCUPADO.has(a.estado) && a.acao ? el("small", { class: "membro-acao", text: acaoLegivel(a.acao) }) : a.estado === ATENCAO ? el("small", { class: "membro-acao atencao", text: "esperando a sua resposta" }) : null,
    a.fila?.length ? el("small", { class: "membro-fila", text: `${a.fila.length} pedido${a.fila.length > 1 ? "s" : ""} na fila` }) : null),
  el("span", { class: "seta-dir", "aria-hidden": "true", text: "›" }))));
}

// ---------------------------------------------------------------- entregas e o visor de arquivos

const TIPO_ICONE = {
  html: ["HTML", "#f97316"], htm: ["HTML", "#f97316"], pdf: ["PDF", "#ef4444"], png: ["IMG", "#22c55e"], jpg: ["IMG", "#22c55e"], jpeg: ["IMG", "#22c55e"],
  gif: ["GIF", "#22c55e"], webp: ["IMG", "#22c55e"], svg: ["SVG", "#14b8a6"], mp4: ["VÍDEO", "#a855f7"], webm: ["VÍDEO", "#a855f7"], mov: ["VÍDEO", "#a855f7"],
  mp3: ["ÁUDIO", "#ec4899"], wav: ["ÁUDIO", "#ec4899"], csv: ["CSV", "#10b981"], xlsx: ["XLSX", "#16a34a"], xls: ["XLS", "#16a34a"], docx: ["DOCX", "#3b82f6"],
  doc: ["DOC", "#3b82f6"], pptx: ["PPTX", "#f59e0b"], md: ["MD", "#94a3b8"], txt: ["TXT", "#94a3b8"], json: ["JSON", "#eab308"], sql: ["SQL", "#06b6d4"],
  js: ["JS", "#eab308"], py: ["PY", "#3b82f6"], zip: ["ZIP", "#78716c"],
};
const IMAGEM = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"]);
const VIDEO = new Set(["mp4", "webm", "mov"]);
const AUDIO = new Set(["mp3", "wav", "ogg", "m4a"]);
const TEXTO = new Set(["txt", "md", "csv", "json", "log", "sql", "py", "js", "ts", "css", "xml", "yml", "yaml", "ini", "ps1", "sh", "bat"]);

function icone(nome) {
  const [rotulo, cor] = TIPO_ICONE[extensao(nome)] || [extensao(nome).toUpperCase().slice(0, 4) || "ARQ", "#64748b"];
  return el("span", { class: "icone", style: { "--c": cor } }, el("b", { text: rotulo }));
}

async function carregarEntregas() {
  const caixa = $("#entregas");
  if (!entregas) caixa.replaceChildren(el("div", { class: "carregando" }, el("i"), el("i"), el("i")));
  try { entregas = (await api("arquivos")).itens; } catch (e) { caixa.replaceChildren(el("p", { class: "aviso-conv", text: `Não deu para ler as entregas: ${e.message}` })); return; }
  primeiraVez();
  if (aba === "entregas") {
    desenharEntregas();
    if (entregas[0]) guardado.gravar(CHAVE_VISTO, entregas[0].quando);
  }
  desenharSelos();
}

/** No primeiro uso o que já estava entregue não conta como novo (só o que chegar depois ganha o selo). */
function primeiraVez() {
  if (guardado.ler(CHAVE_VISTO) === null) guardado.gravar(CHAVE_VISTO, entregas?.[0]?.quando || new Date(0).toISOString());
}

function rotuloDia(iso) {
  const d = new Date(iso), hoje = new Date();
  const ontem = new Date(hoje); ontem.setDate(hoje.getDate() - 1);
  if (d.toDateString() === hoje.toDateString()) return "Hoje";
  if (d.toDateString() === ontem.toDateString()) return "Ontem";
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "long" });
}

function desenharEntregas() {
  const caixa = $("#entregas");
  if (!entregas.length) {
    caixa.replaceChildren(el("div", { class: "boas-vindas" }, el("div", { class: "logo-grande pequeno" }, el("img", { src: "engram.png", alt: "" })),
      el("p", { text: "Ainda nada entregue. Quando um agente devolver um arquivo (um HTML, uma planilha, uma imagem), ele aparece aqui e abre no celular." })));
    return;
  }
  const visto = guardado.ler(CHAVE_VISTO) || "";
  const partes = [];
  let dia = null, i = 0;
  for (const e of entregas) {
    const r = rotuloDia(e.quando);
    if (r !== dia) { dia = r; partes.push(el("h3", { class: "dia", text: r })); }
    const a = agente(e.sessao) || { nome: e.agente, id: e.sessao };
    const tile = icone(e.nome);
    if (IMAGEM.has(extensao(e.nome)) && i < 30) miniatura(tile, e);
    partes.push(el("button", { type: "button", class: `entrega${e.quando > visto ? " nova" : ""}`, style: { "--i": String(i++) }, onclick: () => abrirArquivo(e) },
      tile,
      el("span", { class: "entrega-texto" }, el("b", { text: e.nome }),
        el("small", {}, rosto(a, 18, "mini"), `${e.agente} · ${hora(e.quando)} · ${tamanhoLegivel(e.tamanho)}`)),
      el("span", { class: "seta-dir", "aria-hidden": "true", text: "›" })));
  }
  caixa.replaceChildren(...partes);
}

async function miniatura(tile, e) {
  try {
    const r = await api("link", { json: { sessao: e.sessao, qual: e.qual || "entregues", nome: e.nome } });
    const img = el("img", { src: r.url, alt: "", loading: "lazy" });
    img.addEventListener("load", () => tile.classList.add("com-foto"));
    tile.append(img);
  } catch { /* fica o ícone */ }
}

async function abrirArquivo({ sessao, qual = "entregues", nome, agente: quem }) {
  const visor = $("#visor");
  const corpo = $("#visor-corpo");
  const a = agente(sessao) || { nome: quem || "", id: sessao };
  $("#visor-nome").textContent = nome;
  $("#visor-de").replaceChildren(rosto(a, 16, "mini"), a.nome || "");
  $("#visor-fora").removeAttribute("href");
  corpo.replaceChildren(el("div", { class: "carregando" }, el("i"), el("i"), el("i")));
  if (visor.hidden) { visor.hidden = false; requestAnimationFrame(() => visor.classList.add("aberto")); history.pushState({ visor: 1 }, ""); }
  let r;
  try { r = await api("link", { json: { sessao, qual, nome } }); } catch (e) {
    corpo.replaceChildren(el("div", { class: "visor-aviso" }, icone(nome), el("p", { text: e.status === 404 ? "Não achei este arquivo no PC (ele pode ter sido renomeado). Veja a lista em Entregas." : e.message })));
    return;
  }
  $("#visor-fora").href = r.url;
  const ext = extensao(nome);
  if (["html", "htm"].includes(ext) || ext === "svg") {
    const f = el("iframe", { src: r.url, title: nome, sandbox: `allow-scripts allow-forms allow-popups allow-modals allow-downloads${r.separado ? " allow-same-origin" : ""}`, referrerpolicy: "no-referrer" });
    corpo.replaceChildren(f);
  } else if (IMAGEM.has(ext)) {
    corpo.replaceChildren(el("div", { class: "visor-imagem" }, el("img", { src: r.url, alt: nome })));
  } else if (VIDEO.has(ext)) {
    corpo.replaceChildren(el("video", { src: r.url, controls: true, playsinline: true, preload: "metadata" }));
  } else if (AUDIO.has(ext)) {
    corpo.replaceChildren(el("div", { class: "visor-aviso" }, icone(nome), el("audio", { src: r.url, controls: true })));
  } else if (TEXTO.has(ext)) {
    try {
      const t = await (await fetch(r.url, { cache: "no-store" })).text();
      const texto = t.length > 400_000 ? `${t.slice(0, 400_000)}\n\n… (cortado: abra fora para ver tudo)` : t;
      if (ext === "md" && md) { const d = el("div", { class: "visor-texto md" }); d.innerHTML = md.render(texto); corpo.replaceChildren(d); }
      else if (ext === "csv") corpo.replaceChildren(tabelaCsv(texto));
      else corpo.replaceChildren(el("pre", { class: "visor-texto", text: texto }));
    } catch { corpo.replaceChildren(el("div", { class: "visor-aviso" }, icone(nome), el("p", { text: "Não deu para ler o texto. Use Abrir fora." }))); }
  } else {
    corpo.replaceChildren(el("div", { class: "visor-aviso" }, icone(nome),
      el("p", { text: ext === "pdf" ? "O PDF abre no leitor do celular." : "Este tipo de arquivo abre no app que o celular tiver para ele." }),
      el("a", { class: "brilho", href: r.url, target: "_blank", rel: "noopener noreferrer" }, el("span", { text: ext === "pdf" ? "Abrir o PDF" : "Abrir / baixar" }))));
  }
}

function tabelaCsv(texto) {
  const sep = (texto.split("\n")[0].match(/;/g) || []).length > (texto.split("\n")[0].match(/,/g) || []).length ? ";" : ",";
  const linhas = texto.split(/\r?\n/).filter(l => l.trim()).slice(0, 300).map(l => {
    const cel = []; let atual = "", aspas = false;
    for (const ch of l) {
      if (ch === '"') aspas = !aspas;
      else if (ch === sep && !aspas) { cel.push(atual); atual = ""; }
      else atual += ch;
    }
    cel.push(atual);
    return cel;
  });
  const [cab, ...resto] = linhas;
  return el("div", { class: "visor-texto md" }, el("table", {},
    el("thead", {}, el("tr", {}, ...(cab || []).map(c => el("th", { text: c })))),
    el("tbody", {}, ...resto.map(l => el("tr", {}, ...l.map(c => el("td", { text: c })))))));
}

function fecharVisor(semHistorico = false) {
  const visor = $("#visor");
  if (visor.hidden) return;
  visor.classList.remove("aberto");
  setTimeout(() => { if (!visor.classList.contains("aberto")) { visor.hidden = true; $("#visor-corpo").replaceChildren(); } }, 280);
  if (!semHistorico && history.state?.visor) history.back();
}
window.addEventListener("popstate", () => { if (!$("#visor").hidden) fecharVisor(true); });

// ---------------------------------------------------------------- conversa

const caixa = () => $("#conversa");
const pertoDoFim = () => { const c = caixa(); return c.scrollHeight - c.scrollTop - c.clientHeight < 140; };
function rolarFim(sem = false) {
  const c = caixa();
  if (sem) c.style.scrollBehavior = "auto";
  c.scrollTop = c.scrollHeight;
  if (sem) requestAnimationFrame(() => { c.style.scrollBehavior = ""; });
  $("#novas").hidden = true;
}

function semAgentes() {
  conv = { id: null, ate: 0, carregando: false, pendente: false };
  $("#itens").replaceChildren(el("div", { class: "boas-vindas" }, el("div", { class: "logo-grande pequeno" }, el("img", { src: "engram.png", alt: "" })),
    el("p", { text: "Nenhum agente aberto no PC. Abra o maestro no palco do Engram e ele aparece aqui." })));
}

async function abrirConversa(id) {
  conv = { id, ate: 0, carregando: true, pendente: false };
  const itens = $("#itens");
  itens.replaceChildren(el("div", { class: "carregando" }, el("i"), el("i"), el("i")));
  const a = agente(id);
  if (a && !a.tem_conversa) {
    itens.replaceChildren(el("p", { class: "aviso-conv", text: `${a.agente || "Este agente"} não grava a conversa num arquivo que o Engram lê. O pedido chega do mesmo jeito; a resposta você vê no PC.` }));
    conv.carregando = false;
    return;
  }
  try {
    const r = await api(`sessoes/${id}/conversa?ultimos=150`);
    if (conv.id !== id) return;
    itens.replaceChildren();
    conv.ate = r.ate;
    desenharItens(r.itens, false);
    if (!r.itens.length) itens.append(el("div", { class: "boas-vindas" }, a ? rosto(a, 72, "grande") : null, el("p", { text: a?.papel === "maestro" ? "Mande o primeiro pedido: o maestro divide o trabalho com o time e responde aqui." : `Mande o primeiro pedido para ${a?.nome || "o agente"}.` })));
    rolarFim(true);
  } catch (e) {
    if (conv.id === id) itens.replaceChildren(el("p", { class: "aviso-conv", text: `Não deu para ler a conversa: ${e.message}` }));
  }
  conv.carregando = false;
  if (conv.pendente) { conv.pendente = false; atualizarConversa(); }
}

async function atualizarConversa() {
  if (!conv.id || agente(conv.id)?.tem_conversa === false) return;
  if (conv.carregando) { conv.pendente = true; return; }
  conv.carregando = true;
  const id = conv.id;
  try {
    const perto = pertoDoFim();
    const r = await api(`sessoes/${id}/conversa?desde=${conv.ate}`);
    if (conv.id === id) {
      conv.ate = r.ate;
      if (r.itens.length) {
        $("#itens").querySelector(".boas-vindas")?.remove();
        desenharItens(r.itens, true);
        if (perto) rolarFim(); else $("#novas").hidden = false;
      }
    }
  } catch { /* volta na próxima mudança */ }
  conv.carregando = false;
  if (conv.pendente) { conv.pendente = false; atualizarConversa(); }
}

function balaoLongo(conteudo, longo) {
  if (!longo) return conteudo;
  conteudo.classList.add("dobrado");
  const ver = el("button", { type: "button", class: "ver-tudo", text: "ver tudo", onclick: () => { conteudo.classList.toggle("dobrado"); ver.textContent = conteudo.classList.contains("dobrado") ? "ver tudo" : "recolher"; } });
  return [conteudo, ver];
}

/** O arquivo que a ferramenta entregou (entregar_arquivo, ou escrever direto na pasta entregues). */
function arquivoDaFerramenta(it) {
  let e = {};
  try { e = JSON.parse(it.entrada || "{}"); } catch {
    const m = /"(nome|caminho|file_path)"\s*:\s*"([^"]+)"/.exec(it.entrada || "");
    if (m) e = { [m[1]]: m[2] };
  }
  const base = c => String(c || "").replace(/\\\\/g, "\\").split(/[\\/]/).pop();
  if (/entregar_arquivo$/.test(it.nome)) return e.nome || base(e.caminho) || null;
  if (/^(Write|Edit|MultiEdit)$/.test(it.nome) && /[\\/]entregues[\\/]/i.test(String(e.file_path || ""))) return base(e.file_path);
  return null;
}

function cartaoArquivo(nome, sessao) {
  return el("div", { class: "msg arquivo", "data-nome": nome },
    el("button", { type: "button", class: "cartao-arquivo", onclick: () => abrirArquivo({ sessao, nome }) },
      icone(nome), el("span", { class: "entrega-texto" }, el("b", { text: nome }), el("small", { text: "entregue · toque para abrir" })), el("span", { class: "seta-dir", text: "›" })));
}

function desenharItens(lista, animar) {
  const itens = $("#itens");
  const dono = agente(conv.id);
  for (const it of lista) {
    const ultimo = itens.lastElementChild;
    if (it.tipo === "ferramenta") {
      const trilha = ultimo?.classList.contains("trilha") ? ultimo : itens.appendChild(el("div", { class: "trilha" }));
      trilha.append(el("div", { class: "acao", "data-ref": it.id || "" }, el("b", { text: acaoLegivel(it.nome) }), el("span", { text: acaoLegivel(it.resumo) })));
      const n = trilha.children.length;
      trilha.classList.toggle("muitas", n > 3);
      trilha.dataset.mais = n > 3 ? `+${n - 3} ações` : "";
      if (!trilha.onclick) trilha.onclick = () => trilha.classList.toggle("aberta");
      const arq = arquivoDaFerramenta(it);
      // gravar direto em entregues e depois chamar entregar_arquivo é o mesmo arquivo: um cartão só
      if (arq && !itens.querySelector(`.msg.arquivo[data-nome="${CSS.escape(arq)}"]`)) { const c = cartaoArquivo(arq, conv.id); if (!animar) c.classList.add("sem-animar"); itens.append(c); }
      continue;
    }
    if (it.tipo === "resultado") {
      if (it.erro && it.ref) itens.querySelector(`.acao[data-ref="${CSS.escape(it.ref)}"]`)?.classList.add("erro");
      continue;
    }
    let no = null;
    if (it.tipo === "voce") {
      const b = el("div", { class: "balao", text: it.texto });
      no = el("div", { class: "msg voce" }, balaoLongo(b, it.texto.length > 900), el("small", { class: "meta", text: hora(it.quando) }));
    } else if (it.tipo === "agente") {
      const b = el("div", { class: "balao md" });
      if (md) b.innerHTML = md.render(it.texto); else b.textContent = it.texto;
      const seguido = ultimo?.classList.contains("agente");
      no = el("div", { class: `msg agente${seguido ? " seguido" : ""}` }, rosto(dono || { id: conv.id }, 30, "mini"),
        el("div", { class: "corpo" }, balaoLongo(b, it.texto.length > 2200), el("small", { class: "meta", text: hora(it.quando) })));
    } else if (it.tipo === "colega") {
      const b = el("div", { class: "balao", text: it.texto });
      const quem = agentePorNome(it.de) || { nome: it.de };
      no = el("div", { class: "msg colega" }, rosto(quem, 30, "mini"),
        el("div", { class: "corpo" }, el("small", { class: "de", text: `${it.de}${it.papel ? ` · ${it.papel}` : ""}` }), balaoLongo(b, it.texto.length > 700), el("small", { class: "meta", text: hora(it.quando) })));
    } else if (it.tipo === "marco") {
      no = el("div", { class: "marco", text: it.texto });
    } else if (it.tipo === "resumo") {
      no = el("details", { class: "resumo" }, el("summary", { text: "conversa resumida (compactação)" }), el("div", { class: "balao", text: it.texto.slice(0, 6000) }));
    }
    if (!no) continue;
    if (!animar) no.classList.add("sem-animar");
    itens.append(no);
  }
}

function desenharFila() {
  $("#fila").replaceChildren(...[...fila.values()].map(texto => el("div", { class: "msg voce na-fila" },
    el("div", { class: "balao", text: texto }), el("small", { class: "meta", text: "na fila · entra quando o agente terminar o turno" }))));
}

// ---------------------------------------------------------------- mandar

function autoAltura() {
  const t = $("#texto");
  t.style.height = "auto";
  t.style.height = `${Math.min(t.scrollHeight, 168)}px`;
}

async function enviar(ev) {
  ev?.preventDefault();
  const t = $("#texto");
  const texto = t.value.trim();
  if (!texto || !alvo) return;
  const b = $("#enviar");
  b.disabled = true;
  b.classList.add("indo");
  try {
    const r = await api(`sessoes/${alvo}/prompt`, { json: { texto } });
    t.value = "";
    autoAltura();
    vibrar(15);
    if (r.na_frente > 0) toast(r.na_frente === 1 ? "Na fila: entra quando o agente terminar o turno" : `Na fila: ${r.na_frente} na frente`);
    if (!fluxoOk) carregarTime();
    rolarFim();
  } catch (e) {
    toast(e.message, "erro");
  } finally {
    b.disabled = false;
    setTimeout(() => b.classList.remove("indo"), 400);
  }
}

// ---------------------------------------------------------------- ao vivo

function marcarVivo(ok) {
  fluxoOk = ok;
  const v = $("#vivo");
  v.className = `vivo${ok ? " ok" : ""}`;
  v.title = ok ? "ao vivo" : "reconectando";
}

let palcoAgendado = null;
const redesenharPalco = () => { if (aba !== "palco") return; clearTimeout(palcoAgendado); palcoAgendado = setTimeout(desenharPalco, 150); };

function tratar(m) {
  if (m.tipo === "evento") {
    const a = agente(m.id);
    if (!a) { agendarTime(); return; }
    const antes = a.estado;
    if (m.estado && !OCUPADO.has(antes) && OCUPADO.has(m.estado)) a.acao = null; // turno novo: a ação de antes não vale
    if (m.estado) a.estado = m.estado;
    if ("pergunta" in m) a.pergunta = m.pergunta;
    if (m.acao) a.acao = m.acao;
    if (!OCUPADO.has(a.estado)) parando[a.id] = 0;
    if (a.id === alvo) {
      desenharAlvo();
      if (OCUPADO.has(antes) && !OCUPADO.has(a.estado) && a.estado !== ATENCAO) chamar(`${a.nome} terminou`, [40, 60, 40]);
      if (a.estado === ATENCAO && antes !== ATENCAO) chamar(`${a.nome} precisa de você`, [80, 60, 80]);
    }
    if (m.estado && m.estado !== antes) redesenharPalco();
    desenharSelos();
  } else if (m.tipo === "conversa") {
    if (m.id === conv.id) { if (m.trocou) abrirConversa(conv.id); else atualizarConversa(); }
  } else if (m.tipo === "mensagem") {
    if (m.fase === "enviada" && aba === "palco") pulsar(m.de, m.para);
    const a = agente(m.para);
    if (a && m.de === "pessoa") {
      if (m.fase === "enviada" && !a.fila?.some(f => f.n === m.n)) a.fila = [...(a.fila || []), { n: m.n, texto: m.texto || "" }];
      if (m.fase === "entregue") a.fila = (a.fila || []).filter(f => f.n !== m.n);
    }
    if (m.para !== alvo) return;
    if (m.fase === "enviada" && m.de === "pessoa") { fila.set(m.n, m.texto || ""); desenharFila(); if (pertoDoFim()) rolarFim(); }
    if (m.fase === "entregue" && fila.delete(m.n)) desenharFila();
  } else if (m.tipo === "arquivos") {
    entregas = null; // a lista muda: lê de novo quando abrir (ou já, se estiver aberta)
    if (aba === "entregas") carregarEntregas(); else api("arquivos").then(r => { entregas = r.itens; desenharSelos(); }).catch(() => {});
    const a = agente(m.id);
    if (m.id === conv.id) {
      const perto = pertoDoFim();
      for (const nome of m.entregues) if (!document.querySelector(`#itens .msg.arquivo[data-nome="${CSS.escape(nome)}"]`)) $("#itens").append(cartaoArquivo(nome, m.id));
      if (perto) rolarFim();
    }
    chamar(`${a?.nome || "Um agente"} entregou ${m.entregues[0]}${m.entregues.length > 1 ? ` e mais ${m.entregues.length - 1}` : ""}`, [30, 40, 30]);
  } else if (m.tipo === "time") agendarTime();
  else if (m.tipo === "aviso") toast(m.texto);
}

function chamar(texto, padrao) {
  vibrar(padrao);
  if (document.hidden) document.title = `● ${texto}`;
  else toast(texto);
}

async function ligarAoVivo() {
  fluxo?.abort();
  const ctrl = new AbortController();
  fluxo = ctrl;
  let espera = 1000;
  let primeira = true;
  while (!ctrl.signal.aborted && token) {
    try {
      const r = await fetch("/api/aovivo", { headers: { Authorization: `Bearer ${token}` }, signal: ctrl.signal, cache: "no-store" });
      if (r.status === 401) { desparear("Este aparelho não está mais pareado. Gere um código novo no PC e conecte de novo."); return; }
      if (!r.ok || !r.body) throw new Error("sem fluxo");
      marcarVivo(true);
      ultimoSinal = Date.now();
      espera = 1000;
      // voltou depois de cair: o que mudou enquanto estava fora
      if (!primeira) { carregarTime(); atualizarConversa(); }
      primeira = false;
      const leitor = r.body.pipeThrough(new TextDecoderStream()).getReader();
      let resto = "";
      for (;;) {
        const { value, done } = await leitor.read();
        if (done) break;
        ultimoSinal = Date.now();
        resto += value;
        let i;
        while ((i = resto.indexOf("\n\n")) >= 0) {
          const bloco = resto.slice(0, i);
          resto = resto.slice(i + 2);
          for (const linha of bloco.split("\n")) {
            if (!linha.startsWith("data: ")) continue;
            try { tratar(JSON.parse(linha.slice(6))); } catch { /* aviso estranho */ }
          }
        }
      }
    } catch { if (ctrl.signal.aborted) return; }
    marcarVivo(false);
    primeira = false;
    await dormir(espera);
    espera = Math.min(espera * 2, 10_000);
  }
}

// o celular dorme e a conexão fica pendurada sem erro: sem sinal (o PC manda um a cada 20 s), reconecta
setInterval(() => {
  if (token && fluxoOk && Date.now() - ultimoSinal > 50_000) { marcarVivo(false); ligarAoVivo(); }
}, 10_000);

document.addEventListener("visibilitychange", () => {
  if (document.hidden || !token) return;
  document.title = "Engram";
  if (!fluxoOk || Date.now() - ultimoSinal > 25_000) ligarAoVivo();
  carregarTime();
  atualizarConversa();
});
let larguraAntes = innerWidth;
addEventListener("resize", () => { moverLuz(); if (innerWidth !== larguraAntes) { larguraAntes = innerWidth; redesenharPalco(); } });

// ---------------------------------------------------------------- começo

function iniciar() {
  $("#parear").hidden = true;
  $("#app").hidden = false;
  mostrarAba(["conversa", "palco", "entregas"].includes(aba) ? aba : "conversa");
  carregarTime();
  ligarAoVivo();
  api("arquivos").then(r => { if (!entregas) { entregas = r.itens; primeiraVez(); desenharSelos(); } }).catch(() => {});
}

$("#form-parear").addEventListener("submit", parear);
$("#codigo").addEventListener("input", e => {
  const v = formatarCodigo(e.target.value);
  if (v !== e.target.value) e.target.value = v;
});
$("#compor").addEventListener("submit", enviar);
$("#texto").addEventListener("input", autoAltura);
$("#texto").addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey && (toqueFino || e.ctrlKey || e.metaKey)) { e.preventDefault(); enviar(); }
});
for (const b of document.querySelectorAll("#abas button")) b.addEventListener("click", () => mostrarAba(b.dataset.aba));
for (const b of document.querySelectorAll("#palco-modo button")) b.addEventListener("click", () => { guardado.gravar(CHAVE_MODO, b.dataset.modo); desenharPalco(); });
$("#alvo").addEventListener("click", () => mostrarAba("palco"));
$("#novas").addEventListener("click", () => rolarFim());
$("#visor-voltar").addEventListener("click", () => fecharVisor());
caixa().addEventListener("scroll", () => { if (pertoDoFim()) $("#novas").hidden = true; }, { passive: true });
$("#sair").addEventListener("click", async e => {
  const b = e.currentTarget;
  if (!b.dataset.armado) {
    b.dataset.armado = "1";
    b.textContent = "Toque de novo para desconectar";
    setTimeout(() => { delete b.dataset.armado; b.textContent = "Desconectar este aparelho"; }, 3500);
    return;
  }
  try { await api("sair", { json: {} }); } catch { /* sai do mesmo jeito */ }
  desparear("Aparelho desconectado. Para voltar, gere um código no PC.");
});

if (/[#&]p=/.test(location.hash) || !token) mostrarParear();
else iniciar();
