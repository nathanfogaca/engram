// Utilidades e estado compartilhado do Engram.

export const $ = (s, raiz = document) => raiz.querySelector(s);
export const $$ = (s, raiz = document) => [...raiz.querySelectorAll(s)];

export function el(tag, atributos = {}, ...filhos) {
  const e = tag === "svg" || atributos.svg
    ? document.createElementNS("http://www.w3.org/2000/svg", tag)
    : document.createElement(tag);
  for (const [k, v] of Object.entries(atributos)) {
    if (v === undefined || v === null || v === false || k === "svg") continue;
    if (k === "class") e.setAttribute("class", v);
    else if (k === "text") e.textContent = v;
    else if (k === "style" && typeof v === "object") {
      // variável CSS (--cor) só entra por setProperty; Object.assign ignora
      for (const [prop, valor] of Object.entries(v)) {
        if (prop.startsWith("--")) e.style.setProperty(prop, valor);
        else e.style[prop] = valor;
      }
    }
    else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? "" : String(v));
  }
  for (const f of filhos.flat()) {
    if (f === null || f === undefined || f === false) continue;
    e.append(f instanceof Node ? f : document.createTextNode(String(f)));
  }
  return e;
}

export function svg(tag, atributos = {}) {
  const e = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(atributos)) e.setAttribute(k, String(v));
  return e;
}

// Fala com o app por IPC (a página não abre porta nenhuma). Enquanto o app termina de abrir, espera.
export async function api(caminho, opcoes = {}) {
  const metodo = opcoes.method || (opcoes.json !== undefined ? "POST" : "GET");
  for (let tentativa = 0; ; tentativa++) {
    const r = await window.engram.api(metodo, caminho, opcoes.json);
    if (r.ok) return r.dados;
    if (r.status === 503 && tentativa < 120) { await new Promise(ok => setTimeout(ok, 250)); continue; }
    throw new Error(r.erro || `erro ${r.status}`);
  }
}

export const encurtar = (t, n) => (t && t.length > n ? t.slice(0, n - 1) + "…" : t || "");
export const hora = iso => (iso ? new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : "");
export const dataHora = iso =>
  iso ? new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
export const movimentoReduzido = matchMedia("(prefers-reduced-motion: reduce)").matches;
export const limitar = (v, a, b) => Math.max(a, Math.min(b, v));

// ------------------------------------------------------------------ vocabulário visual

export const COR_MODELO = { opus: "#f5c451", sonnet: "#38d6f5", haiku: "#8ef06a", fable: "#e879f9", gpt: "#7ee0c3", codex: "#7ee0c3", gemini: "#6aa8ff" };
export function corModelo(id) {
  id = id || "";
  for (const [chave, cor] of Object.entries(COR_MODELO)) if (id.includes(chave)) return cor;
  return "#a5b4fc";
}
export const RESUMO_MODELO = {
  opus: "O mais forte. Análise difícil",
  sonnet: "Equilíbrio. O dia a dia",
  haiku: "Rápido e leve",
  fable: "Família Fable",
};

export const COR_TIPO = {
  chamado: "#6aa8ff", tabela: "#4ade9f", padrao: "#ffb36b", sistema: "#b794ff", projeto: "#ff7ab6",
  sessao: "#94a3b8", guia: "#8b95aa", pendente: "#566074", agente: "#ffffff",
};
export const NOME_TIPO = {
  chamado: "Chamados", tabela: "Tabelas", padrao: "Padrões", sistema: "Sistemas", projeto: "Projetos",
  sessao: "Sessões", guia: "Guias", pendente: "A documentar", agente: "Agentes",
};
export const NOME_TIPO_UM = {
  chamado: "Chamado", tabela: "Tabela", padrao: "Padrão", sistema: "Sistema", projeto: "Projeto",
  sessao: "Sessão", guia: "Guia", pendente: "A documentar", agente: "Agente",
};
export const COR_LIGACAO = {
  "toca": "#4ade9f", "caso de": "#ffb36b", "continua": "#6aa8ff", "parecido": "#94a3b8",
  "envolve": "#b794ff", "parte de": "#ff7ab6", "relacionado": "#7c8aa5", "cita": "#5b6880",
  "leu": "#8fb2ff", "gravou": "#ffc857", "consultou": "#38d6f5", "leu o guia": "#8fb2ff", "abriu": "#ff6b7d",
  "time": "#c9c2ff",
};
export const OCUPADO = new Set(["pensando", "trabalhando", "iniciando"]);
export const ATENCAO = new Set(["precisa de você"]);

// ------------------------------------------------------------------ estado do app

export const app = {
  modelos: [],
  provedores: [], // [{ id, nome, instalado, conectado, modelos }]
  papeis: [],
  maxJanelas: 8,
  vista: "palco",
};
export const nomeModelo = id => (app.modelos.find(m => m.id === id) || { nome: id || "Padrão" }).nome;
export const nomePapel = id => (app.papeis.find(p => p.id === id) || { nome: id }).nome;

// ------------------------------------------------------------------ avisos (toasts)

export function avisar({ rota = "", texto = "", cor = "#8b7bff", tempo = 5200 } = {}) {
  const caixa = $("#avisos");
  const aviso = el("div", { class: "aviso", style: { "--cor": cor } },
    el("span", { class: "ponto" }),
    rota ? el("span", { class: "rota", text: rota }) : null,
    texto ? el("span", { class: "texto", text: texto }) : null);
  caixa.append(aviso);
  while (caixa.children.length > 4) caixa.firstChild.remove();
  setTimeout(() => {
    aviso.classList.add("saindo");
    aviso.addEventListener("animationend", () => aviso.remove(), { once: true });
  }, tempo);
}

export function destacar(texto) {
  const frag = document.createDocumentFragment();
  for (const parte of (texto || "").split(/(\x01[^\x02]*\x02)/)) {
    if (parte.startsWith("\x01")) frag.append(el("mark", { text: parte.slice(1, -1) }));
    else if (parte) frag.append(document.createTextNode(parte));
  }
  return frag;
}
