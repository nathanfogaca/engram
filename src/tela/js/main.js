// Engram: liga o palco, o cérebro, a gaveta, a busca e o canal ao vivo.

import {
  $, $$, el, api, app, avisar, corModelo, nomeModelo, RESUMO_MODELO, destacar, COR_TIPO, NOME_TIPO,
  COR_LIGACAO, encurtar,
} from "./util.js";
import { Palco } from "./palco.js";
import { Cerebro } from "./cerebro.js";
import { Gaveta } from "./gaveta.js";
import { Leitor } from "./conversa.js";
import { Contas, COR_AGENTE, iconeAgente } from "./contas.js";
import { Ajustes } from "./ajustes.js";
import { aplicarTema } from "./geral.js";
import { PrimeiroUso } from "./primeiro-uso.js";
import { VistaCodigo } from "./codigo.js";
import { VistaFluxos } from "./fluxos.js";
import { PainelPrevia, temPrevia } from "./previa.js";

let palco, cerebro, gaveta, leitor, contas, ajustes, codigo, fluxos, previa;
let idsNotas = new Set();
let contagemTipos = {};

// ------------------------------------------------------------------ navegação

function trocarVista(vista) {
  if (app.vista === vista) return;
  app.vista = vista;
  $("#palco").classList.toggle("oculta", vista !== "palco");
  $("#cerebro").classList.toggle("oculta", vista !== "cerebro");
  $("#codigo").classList.toggle("oculta", vista !== "codigo");
  $("#fluxos").classList.toggle("oculta", vista !== "fluxos");
  if (vista === "codigo") codigo.ligar();
  if (vista === "fluxos") fluxos.ligar();
  for (const b of $$("#seg button")) b.classList.toggle("ativo", b.dataset.vista === vista);
  moverPilula();
  if (vista === "cerebro") cerebro.ligar();
  else setTimeout(() => { if (app.vista !== "cerebro") cerebro.desligar(); }, 700);
}

function moverPilula() {
  const ativo = $("#seg button.ativo"), pilula = $(".seg-pilula");
  pilula.style.width = `${ativo.offsetWidth}px`;
  pilula.style.transform = `translateX(${ativo.offsetLeft - 4}px)`;
}

async function abrirNota(id) {
  await gaveta.nota(id);
  if (app.vista === "cerebro") cerebro.focar(id);
}

function focarAgente(id) {
  trocarVista("palco");
  setTimeout(() => palco.focar(id), app.vista === "palco" ? 0 : 200);
}

function abrirLeitor(id) {
  gaveta.fechar();
  leitor.abrir(id);
}

// ------------------------------------------------------------------ cérebro

async function carregarGrafo() {
  const g = await api("/api/grafo");
  idsNotas = new Set(g.nos.filter(n => n.tipo !== "agente").map(n => n.id));
  contagemTipos = {};
  for (const n of g.nos) contagemTipos[n.tipo] = (contagemTipos[n.tipo] || 0) + 1;
  cerebro.definir(g);
  cerebro.mostrarResumo();
  montarLegenda();
}

let timerGrafo = null;
function agendarGrafo() {
  clearTimeout(timerGrafo);
  timerGrafo = setTimeout(() => carregarGrafo().catch(() => {}), 450);
}

function montarLegenda() {
  const ordem = ["agente", "chamado", "tabela", "padrao", "sistema", "projeto", "sessao", "guia", "pendente"];
  $("#legenda").replaceChildren(...ordem.filter(t => contagemTipos[t]).map((t, i) => el("button", {
    class: cerebro.ocultos.has(t) ? "desligado" : "", style: { animationDelay: `${i * 40}ms` },
    onclick: () => {
      cerebro.ocultos.has(t) ? cerebro.ocultos.delete(t) : cerebro.ocultos.add(t);
      cerebro.calor = Math.max(cerebro.calor, 0.4);
      montarLegenda();
    },
  }, el("span", { class: "ponto", style: { "--c": COR_TIPO[t] } }), NOME_TIPO[t], el("span", { class: "n", text: contagemTipos[t] }))));
}

// ------------------------------------------------------------------ novo agente

let papelEscolhido = "livre";
const lembrar = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch { return null; } return null; };

function dialogoAgente(papel = "livre") {
  papelEscolhido = papel;
  const dlg = $("#dlg-agente");
  const abertos = [...palco.cartoes.values()].filter(c => c.viva).length;
  $("#ag-nome").value = papel === "maestro" ? "maestro" : `agente ${abertos + 1}`;
  const instalados = app.provedores.filter(p => p.instalado);
  const ultimo = lembrar("engram.agente");
  const escolhido = (instalados.find(p => p.id === ultimo) || instalados.find(p => p.id === app.padraoAgente) || instalados[0] || { id: "claude" }).id;
  $("#ag-agentes").replaceChildren(...app.provedores.map(p => el("label", {
    class: `op agente${p.instalado ? "" : " indisponivel"}`, style: { "--cor": COR_AGENTE[p.id] || "#a5b4fc" },
    title: p.instalado ? "" : "Não instalado neste computador: veja em Contas",
  },
    el("input", { type: "radio", name: "agente", value: p.id, checked: p.id === escolhido, disabled: !p.instalado, onchange: () => { desenharModelos(p.id, papel); desenharMcps(p.id); } }),
    el("b", {}, iconeAgente(p.id, "ag-logo"), p.nome),
    el("small", { text: !p.instalado ? "não instalado · ver Contas" : p.conectado === false ? "sem login · ver Contas" : p.experimental ? "experimental" : "pronto" }))));
  desenharModelos(escolhido, papel);
  desenharMcps(escolhido);
  $("#ag-papeis").replaceChildren(...app.papeis.map(p => el("label", { class: "op", style: { "--cor": p.id === "maestro" ? "#f5c451" : "#8b7bff" } },
    el("input", { type: "radio", name: "papel", value: p.id, checked: p.id === papel }),
    el("b", { text: p.id === "maestro" ? "♛ Maestro" : p.nome }),
    el("small", { text: p.resumo || "" }))));
  dlg.returnValue = "";
  dlg.showModal();
  $("#ag-nome").select();
}

function desenharMcps(provedor) {
  const validos = (app.mcps || []).filter(m => m.agentes.includes("todos") || m.agentes.includes(provedor));
  $("#ag-mcps-campo").hidden = !validos.length;
  $("#ag-mcps").replaceChildren(...validos.map(m => {
    const b = el("button", { type: "button", class: "aj-chip ativo", "data-id": m.id, style: { "--c": "#38d6f5" }, title: m.id }, m.nome);
    b.onclick = () => b.classList.toggle("ativo");
    return b;
  }));
}

function desenharModelos(provedor, papel) {
  const prov = app.provedores.find(p => p.id === provedor) || { modelos: app.modelos };
  const modelos = prov.modelos.length ? prov.modelos : [{ id: "", nome: "Padrão" }];
  let padrao = "";
  if (provedor === "claude") padrao = (papel === "maestro" ? modelos.find(m => m.id.includes("opus")) : modelos.find(m => m.id.includes("sonnet")))?.id ?? "";
  // o padrão escolhido no primeiro uso (ou em Ajustes) vale, menos para o maestro do Claude, que vai de Opus
  if (provedor === app.padraoAgente && app.padraoModelo != null && modelos.some(m => m.id === app.padraoModelo) && !(provedor === "claude" && papel === "maestro")) padrao = app.padraoModelo;
  const livre = $("#ag-modelo-livre");
  livre.hidden = true;
  livre.value = "";
  $("#ag-modelos").replaceChildren(...modelos.map(m => {
    const chave = Object.keys(RESUMO_MODELO).find(k => m.id.includes(k));
    return el("label", { class: "op", style: { "--cor": corModelo(m.id) } },
      el("input", { type: "radio", name: "modelo", value: m.id, checked: m.id === padrao, onchange: () => { livre.hidden = true; } }),
      el("b", {}, el("span", { class: "ponto", style: { "--c": corModelo(m.id) } }), m.nome),
      el("small", { text: m.resumo || (chave ? RESUMO_MODELO[chave] : m.id ? "" : `O que o ${prov.nome || "agente"} usa por padrão`) }));
  }), el("label", { class: "op", style: { "--cor": "#a5b4fc" } },
    el("input", { type: "radio", name: "modelo", value: "__outro", onchange: () => { livre.hidden = false; livre.focus(); } }),
    el("b", {}, el("span", { class: "ponto", style: { "--c": "#a5b4fc" } }), "Outro…"),
    el("small", { text: "Digite o id do modelo" })));
}

async function confirmarAgente() {
  const dlg = $("#dlg-agente");
  if (dlg.returnValue !== "abrir") return;
  let modelo = $("#ag-modelos input:checked")?.value ?? "";
  if (modelo === "__outro") modelo = $("#ag-modelo-livre").value.trim();
  const papel = $("#ag-papeis input:checked")?.value ?? "livre";
  const provedor = $("#ag-agentes input:checked")?.value ?? "claude";
  lembrar("engram.agente", provedor);
  // só manda a lista se a pessoa tirou algum MCP (senão a janela pega todos os ativos, inclusive os que vierem depois)
  const chips = $$("#ag-mcps .aj-chip");
  const mcps = chips.some(c => !c.classList.contains("ativo")) ? chips.filter(c => c.classList.contains("ativo")).map(c => c.dataset.id) : undefined;
  trocarVista("palco");
  try {
    const info = await api("/api/sessoes", { json: {
      nome: $("#ag-nome").value, modelo, papel, provedor, mcps, posicao: palco.lugarNoCentro(),
    } });
    palco.adicionar(info);
    setTimeout(() => palco.focar(info.id), 120);
    agendarGrafo();
  } catch (e) {
    avisar({ texto: `Não abriu: ${e.message}`, cor: "#ff6b7d", tempo: 7000 });
  }
}

async function retomar(s) {
  trocarVista("palco");
  try {
    const info = await api("/api/sessoes", { json: { nome: s.nome, modelo: s.modelo, papel: s.papel, retomar: s.id } });
    if (palco.cartoes.has(info.id)) palco.atualizar(info);
    else palco.adicionar(info);
    setTimeout(() => palco.focar(info.id), 150);
    if (info.conversa_nova) avisar({ texto: `${info.nome} não tinha conversa gravada para retomar, então começou uma nova.`, cor: "#ffc857", tempo: 7000 });
    if (gaveta.aba === "time" && gaveta.aberta) gaveta.time();
  } catch (e) {
    avisar({ texto: `Não retomou: ${e.message}`, cor: "#ff6b7d", tempo: 7000 });
  }
}

// ------------------------------------------------------------------ busca

let timerBusca = null, resultados = [], focoBusca = -1;
async function buscar() {
  const q = $("#busca").value.trim();
  const caixa = $("#resultados");
  if (!q) { caixa.hidden = true; cerebro.realcarBusca(null); return; }
  try { resultados = await api(`/api/busca?q=${encodeURIComponent(q)}`); }
  catch { return; }
  focoBusca = resultados.length ? 0 : -1;
  caixa.replaceChildren(...(resultados.length ? resultados.map((r, i) => el("button", {
    class: `resultado${i === 0 ? " foco" : ""}`, style: { animationDelay: `${i * 22}ms` },
    onmousedown: e => { e.preventDefault(); escolher(i); },
  },
    el("div", { class: "r-topo" },
      el("span", { class: "ponto", style: { "--c": COR_TIPO[r.tipo] || "#8b95aa" } }),
      el("span", { class: "r-id", text: r.id }),
      el("span", { text: encurtar(r.titulo, 64) })),
    el("div", { class: "r-trecho" }, destacar(r.trecho)))) : [el("div", { class: "pad discreto", text: `Nada no cérebro para “${q}”.` })]));
  caixa.hidden = false;
  cerebro.realcarBusca(resultados.map(r => r.id));
}

function escolher(i) {
  const r = resultados[i];
  if (!r) return;
  $("#resultados").hidden = true;
  $("#busca").blur();
  abrirNota(r.id);
}

function instalarBusca() {
  const entrada = $("#busca");
  entrada.addEventListener("input", () => { clearTimeout(timerBusca); timerBusca = setTimeout(buscar, 180); });
  entrada.addEventListener("focus", () => { if (entrada.value.trim()) buscar(); });
  entrada.addEventListener("blur", () => setTimeout(() => { $("#resultados").hidden = true; }, 120));
  entrada.addEventListener("keydown", e => {
    const itens = $$("#resultados .resultado");
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!itens.length) return;
      focoBusca = (focoBusca + (e.key === "ArrowDown" ? 1 : -1) + itens.length) % itens.length;
      itens.forEach((b, i) => b.classList.toggle("foco", i === focoBusca));
      itens[focoBusca].scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      escolher(Math.max(0, focoBusca));
    } else if (e.key === "Escape") {
      entrada.value = "";
      $("#resultados").hidden = true;
      cerebro.realcarBusca(null);
      entrada.blur();
    }
  });
}

// ------------------------------------------------------------------ sincronização

function mostrarSinc(m) {
  const botao = $("#sinc"), texto = $("#sinc-texto");
  botao.classList.toggle("rodando", !!m.rodando);
  const r = m.resultado || {};
  const erro = r.erro || m.erro;
  botao.classList.toggle("erro", !m.rodando && !!erro);
  if (m.rodando) { texto.textContent = "sincronizando…"; return; }
  if (erro) { texto.textContent = "cérebro fora"; botao.title = `Servidor do cérebro: ${erro}`; return; }
  if (r.total === undefined) return;
  texto.textContent = `${r.total} notas`;
  botao.title = `Sincronizado às ${new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`
    + (r.erros?.length ? `\n${r.erros.join("\n")}` : "");
}

// ------------------------------------------------------------------ atualização

let avisouPronta = null;
function mostrarAtualizacao(a) {
  const b = $("#atualizacao");
  b.classList.remove("pronta", "baixando", "erro");
  b.onclick = null;
  if (a.estado === "baixando") {
    b.hidden = false;
    b.classList.add("baixando");
    b.textContent = `baixando a ${a.versao_nova}… ${a.progresso || 0}%`;
    b.title = "A atualização baixa em segundo plano";
  } else if (a.estado === "pronta" || a.estado === "instalando") {
    b.hidden = false;
    b.classList.add("pronta");
    b.textContent = a.estado === "instalando" ? `instalando a ${a.versao_nova}…` : `Atualização ${a.versao_nova} pronta · atualizar agora`;
    b.title = `${a.notas || ""}

Ela também instala sozinha quando você não estiver usando a janela. Os agentes continuam rodando.`.trim();
    b.onclick = async () => { try { await api("/api/atualizacao/instalar", { method: "POST" }); } catch (e) { avisar({ texto: e.message, cor: "#ff6b7d" }); } };
    if (a.estado === "pronta" && avisouPronta !== a.versao_nova) {
      avisouPronta = a.versao_nova;
      avisar({ rota: `Engram ${a.versao_nova}`, texto: "baixada e conferida: instala quando você não estiver usando a janela, ou clique no selo do topo", cor: "#4ade9f", tempo: 9000 });
    }
  } else if (a.estado === "erro" && a.ativo) {
    b.hidden = false;
    b.classList.add("erro");
    b.textContent = "atualização com problema";
    b.title = `${a.erro || ""}\n\nClique para ver em Ajustes.`;
    b.onclick = () => ajustes?.abrir("geral");
  } else {
    b.hidden = true;
  }
}

// ------------------------------------------------------------------ ao vivo

function nome(id) {
  return palco.cartoes.get(id)?.info.nome || "?";
}

function atualizarProvedores(dados) {
  for (const d of dados || []) {
    const p = app.provedores.find(x => x.id === d.id);
    if (p) Object.assign(p, { instalado: d.instalado, conectado: d.conectado, modelos: d.modelos });
  }
  // pontinhos no botão Contas: um por agente instalado, aceso se tem login
  $("#contas-pontos").replaceChildren(...app.provedores.filter(p => p.instalado).map(p =>
    el("i", { class: p.conectado ? "ok" : "sem", style: { "--c": COR_AGENTE[p.id] || "#a5b4fc" }, title: `${p.nome}: ${p.conectado ? "conectado" : "sem login"}` })));
}

function tratar(m) {
  if (m.tipo === "codigo") {
    codigo?.aoVivo(m);
  } else if (m.tipo === "previa") {
    previa?.aoVivo(m);
  } else if (m.tipo === "lsp") {
    codigo?.lsp?.aoVivo(m);
  } else if (m.tipo === "fluxos") {
    fluxos?.aoVivo(m);
  } else if (m.tipo === "mcps") {
    api("/api/estado").then(e => { app.mcps = e.mcps || []; }).catch(() => {});
  } else if (m.tipo === "contas") {
    api("/api/contas").then(atualizarProvedores).catch(() => {});
    if (contas?.dlg.open) contas.mudou();
  } else if (m.tipo === "conversa") {
    const conv = palco.cartoes.get(m.sessao_id)?.conv;
    if (m.trocou) conv?.recarregar(); else conv?.atualizar();
    leitor.atualizar(m.sessao_id, !!m.trocou);
  } else if (m.tipo === "arquivos") {
    const c = palco.cartoes.get(m.sessao_id);
    c?.conv.arquivosMudaram(m.entregues);
    leitor.arquivos(m.sessao_id, m.entregues);
    for (const nomeArq of m.entregues || []) {
      avisar({ rota: `${c?.info.nome || "agente"} te devolveu`, texto: nomeArq, cor: c?.cor || "#8b7bff", tempo: 8000 });
    }
    // como no Claude: o que tem prévia (página, imagem, vídeo, PDF...) abre sozinho no painel
    const comPrevia = (m.entregues || []).filter(temPrevia);
    if (comPrevia.length) previa?.abrir({ raiz: "a", sessao: m.sessao_id, qual: "entregues", nome: comPrevia[comPrevia.length - 1] }, { sozinha: true });
  } else if (m.tipo === "atualizacao") {
    mostrarAtualizacao(m);
    ajustes?.geral.mostrarAtualizacao(m); // a área de atualização nos Ajustes acompanha ao vivo
  } else if (m.tipo === "pensamento") {
    palco.pensamento(m); // a bolha com o código sendo escrito, em cima do cartão
  } else if (m.tipo === "aviso") {
    avisar({ texto: m.texto, cor: "#38d6f5", tempo: 7000 });
  } else if (m.tipo === "evento") {
    palco.estado(m.sessao_id, m.estado, m.evento === "PreToolUse" ? m.resumo : null, m.pergunta);
    if (m.estado) leitor.estado(m.sessao_id, m.estado, m.pergunta);
    const agente = cerebro.nos.get(`sessao:${m.sessao_id}`);
    if (agente && m.estado) agente.estado = m.estado;
    for (const t of m.toques || []) {
      palco.lembranca(m.sessao_id, t.destino, t.tipo, idsNotas.has(t.destino));
      cerebro.pulso(t.destino, COR_LIGACAO[t.tipo]);
      cerebro.cometa(`sessao:${m.sessao_id}`, t.destino);
    }
    if (m.toques?.length) agendarGrafo();
  } else if (m.tipo === "sessao") {
    const s = m.sessao;
    if (!s) return;
    if (s.aberta) {
      if (palco.cartoes.has(s.id)) palco.atualizar(s);
      else {
        palco.adicionar(s);
        avisar({ rota: s.nome, texto: `entrou no palco · ${s.nome_modelo || nomeModelo(s.modelo, s.provedor)}`, cor: corModelo(s.modelo) });
      }
    } else {
      palco.marcarEncerrada(s.id);
      if (leitor.id === s.id) leitor.fechar();
    }
    if (leitor.aberto) leitor.abas();
    agendarGrafo();
    if (gaveta.aba === "time" && gaveta.aberta) gaveta.time();
  } else if (m.tipo === "conexao") {
    if (m.acao === "criada") palco.ligar(m.a, m.b, { nascendo: true });
    else if (m.acao === "revisao") palco.marcarRevisao(m.a, m.b, m.revisa);
    else palco.desligarLocal(m.a, m.b);
  } else if (m.tipo === "palco") {
    if (m.acao === "organizado") palco.reposicionar(m.posicoes);
  } else if (m.tipo === "setor") {
    if (m.acao === "salvo") palco.setores.receber(m.setor);
    else if (m.acao === "removido") palco.setores.removerLocal(m.id);
  } else if (m.tipo === "automacao") {
    if (m.acao === "removida") palco.automacoes.removerLocal(m.id);
    else if (m.acao === "focar") { trocarVista("palco"); palco.automacoes.focar(m.id); }
    else if (m.automacao) palco.automacoes.receber(m.automacao, { devolveu: m.devolveu || null });
  } else if (m.tipo === "postit") {
    if (m.acao === "removido") palco.automacoes.removerPostitLocal(m.id);
    else if (m.postit) palco.automacoes.receberPostit(m.postit);
  } else if (m.tipo === "mensagem") {
    palco.mensagem(m.de, m.para, m.fase);
    if (m.fase === "enviada") {
      const auto = String(m.de).startsWith("auto:") ? palco.automacoes.lista.get(m.de.slice(5)) : null;
      const cor = auto ? "#ffc857" : palco.cartoes.get(m.de)?.cor || "#8b7bff";
      avisar({ rota: `${auto ? `⏰ ${auto.nome}` : nome(m.de)} → ${nome(m.para)}`, texto: encurtar(m.texto || "", 110), cor });
      if (!auto) cerebro.cometa(`sessao:${m.de}`, `sessao:${m.para}`, cor);
    }
  } else if (m.tipo === "cerebro") {
    agendarGrafo();
    const id = (m.mudou || "").split("/").pop().replace(/\.md$/i, "");
    if (gaveta.notaAberta === id && gaveta.aberta) gaveta.nota(id);
  } else if (m.tipo === "sinc") {
    mostrarSinc(m);
    if (!m.rodando) agendarGrafo();
  }
}

function conectarAoVivo() {
  window.engram.aoVivo(m => { try { tratar(m); } catch (e) { console.error(e); } });
}

// ------------------------------------------------------------------ início

async function iniciar() {
  const e = await api("/api/estado");
  app.modelos = e.modelos;
  app.provedores = e.provedores || [];
  app.mcps = e.mcps || [];
  app.temas = e.temas || [];
  app.padraoAgente = e.padrao_agente;
  app.padraoModelo = e.padrao_modelo;
  aplicarTema(e.tema || "aurora");
  app.papeis = e.papeis;
  app.maxJanelas = e.max_janelas;

  gaveta = new Gaveta({ aoRetomar: retomar, aoFocarAgente: focarAgente, notaExiste: id => idsNotas.has(id) });
  gaveta.aoAbrirNota = abrirNota;
  const abrirGaveta = gaveta.abrir.bind(gaveta);
  gaveta.abrir = () => { leitor?.fechar(); abrirGaveta(); }; // um painel lateral por vez
  palco = new Palco({ aoAbrirNota: abrirNota, aoRetomar: retomar, aoLer: abrirLeitor });
  previa = new PainelPrevia();
  codigo = new VistaCodigo($("#codigo"), {
    agentes: () => [...palco.cartoes.values()].filter(c => c.viva).map(c => ({ id: c.info.id, nome: c.info.nome, estado: c.info.estado })),
  });
  fluxos = new VistaFluxos($("#fluxos"), {
    agentes: () => [...palco.cartoes.values()].filter(c => c.viva).map(c => ({ id: c.info.id, nome: c.info.nome, estado: c.info.estado })),
    corDe: id => palco.cartoes.get(id)?.cor || null,
    abrirArquivo: rel => { trocarVista("codigo"); codigo.abrirDeFora(rel); },
  });
  leitor = new Leitor({
    cartoes: () => palco.cartoes,
    aoTerminal: id => {
      leitor.fechar();
      const c = palco.cartoes.get(id);
      if (c) palco.modo(c, "terminal");
      focarAgente(id);
    },
  });
  palco.aoNovo = papel => dialogoAgente(papel);
  cerebro = new Cerebro($("#cerebro-tela"), { aoAbrir: abrirNota, aoAgente: focarAgente });

  for (const b of $$("#seg button")) b.onclick = () => trocarVista(b.dataset.vista);
  $("#btn-agente").onclick = () => dialogoAgente();
  $("#btn-time").onclick = () => gaveta.mostrar("time");
  contas = new Contas({ aoMudar: dados => { atualizarProvedores(dados); } });
  ajustes = new Ajustes({ contas, aoMudarMcps: () => api("/api/estado").then(e => { app.mcps = e.mcps || []; }).catch(() => {}) });
  $("#btn-contas").onclick = () => ajustes.abrir();
  document.addEventListener("keydown", e => { if ((e.ctrlKey || e.metaKey) && e.key === ",") { e.preventDefault(); ajustes.abrir(); } });
  atualizarProvedores(app.provedores);
  if (e.primeiro_uso) {
    const guia = new PrimeiroUso({
      ajustes,
      aoTerminar: ({ criados }) => {
        if (criados.length) setTimeout(() => { $("#enquadrar")?.click(); palco.focar(criados[0].id); }, 500);
      },
    });
    guia.aoCriar = info => { trocarVista("palco"); palco.adicionar(info); };
    setTimeout(() => guia.abrir(), 400);
  }
  $("#btn-consulta").onclick = () => gaveta.mostrar("consulta");
  $("#dlg-agente").addEventListener("close", confirmarAgente);
  $("#sinc").onclick = async () => {
    try { await api("/api/sincronizar", { method: "POST" }); } catch (err) { mostrarSinc({ erro: err.message }); }
  };
  $("#cerebro-enquadrar").onclick = () => cerebro.enquadrar();
  $("#cerebro-agitar").onclick = () => cerebro.agitar();
  instalarBusca();

  document.addEventListener("keydown", ev => {
    const foco = document.activeElement;
    const noTerminal = foco?.closest?.(".xterm");
    const noEditor = foco?.closest?.(".monaco-editor"); // o editor da vista Código tem os atalhos dele (Ctrl+K…)
    const digitando = foco?.matches?.("input, textarea, select") || noTerminal || noEditor || foco?.isContentEditable;
    if (app.vista === "codigo" && !document.querySelector("dialog[open]") && codigo.tecla(ev)) return;
    if (app.vista === "palco" && ev.key === "Escape" && !digitando && (palco.setores.escape() || palco.automacoes.escape())) { ev.preventDefault(); return; }
    if ((ev.ctrlKey && ev.key.toLowerCase() === "k" && !noTerminal && !noEditor) || (ev.key === "/" && !digitando)) {
      ev.preventDefault();
      $("#busca").focus();
      $("#busca").select();
    } else if (ev.key === "Escape" && leitor.aberto && (!digitando || foco.closest("#leitor"))) {
      leitor.fechar();
    } else if (ev.key === "Escape" && !digitando && gaveta.aberta) {
      gaveta.fechar();
    } else if (!digitando && !ev.ctrlKey && !ev.altKey && ["1", "2", "3", "4"].includes(ev.key)) {
      trocarVista({ 1: "palco", 2: "cerebro", 3: "codigo", 4: "fluxos" }[ev.key]);
    } else if (!digitando && !ev.ctrlKey && !ev.altKey && !ev.metaKey && app.vista === "palco" && ev.key.toLowerCase() === "s" && !document.querySelector("dialog[open]")) {
      palco.setores.alternarModo(); // S: desenhar um setor (de novo: sai do modo)
    } else if (!digitando && !ev.ctrlKey && !ev.altKey && !ev.metaKey && app.vista === "palco" && ["a", "n"].includes(ev.key.toLowerCase()) && !document.querySelector("dialog[open]")) {
      ev.preventDefault();
      if (ev.key.toLowerCase() === "a") palco.automacoes.nova(); // A: automação nova
      else palco.automacoes.novoPostit(); // N: post-it novo
    }
  });
  window.addEventListener("resize", moverPilula);
  // arquivo solto fora de um cartão não pode fazer o navegador sair da página para abri-lo
  window.addEventListener("dragover", ev => ev.preventDefault());
  window.addEventListener("drop", ev => ev.preventDefault());

  mostrarSinc({ rodando: e.sinc.rodando, resultado: e.sinc.ultimo, erro: e.sinc.erro });
  $(".marca").title = `Engram ${e.versao}`;
  api("/api/atualizacao").then(mostrarAtualizacao).catch(() => {});
  const [estadoPalco] = await Promise.all([api("/api/palco"), carregarGrafo()]);
  palco.carregar(estadoPalco);
  conectarAoVivo();
  requestAnimationFrame(moverPilula);

  const alvo = location.hash.match(/^#nota=(.+)$/);
  if (location.hash === "#cerebro" || alvo) trocarVista("cerebro");
  if (alvo) setTimeout(() => abrirNota(decodeURIComponent(alvo[1])), 900);
}

function registrarErro(e) {
  console.error(e);
  document.body.dataset.erro = String(e?.stack || e?.message || e).slice(0, 600);
}
window.addEventListener("error", ev => registrarErro(ev.error || ev.message));
window.addEventListener("unhandledrejection", ev => registrarErro(ev.reason));
iniciar().catch(registrarErro);
