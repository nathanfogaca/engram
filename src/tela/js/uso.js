// Medidor de uso: o chip em cada cartão (entrada e saída da conversa) e o painel com tudo por agente
// (entrada, cache lida, cache escrita, saída e custo estimado; hoje ou a conversa inteira).
// Os números vêm de info.uso em cada sessão ({ modelo, conversa, hoje }) e do evento ao vivo "uso".
// O custo é o preço de tabela da API: quem usa a assinatura não paga por token, é só referência de tamanho.

import { el, api, nomeModelo, movimentoReduzido } from "./util.js";

const ROW = 36;
const ZERO = { entrada: 0, cache_escrita: 0, cache_lida: 0, saida: 0, custo: 0, sem_preco: 0, respostas: 0 };
const SEM_MEDIDOR = /gemini|opencode/i;
export const NOTA_CUSTO = "Custo estimado pelo preço de tabela da API; quem usa assinatura (conta) não paga por token. É só para ter noção do tamanho.";

const n1 = v => v.toFixed(1).replace(".", ",");
/** 12,3 mil · 4,1 mi · 870 */
export function tokens(n) {
  n = Number(n) || 0;
  if (n >= 1e6) return `${n1(n / 1e6)} mi`;
  if (n >= 1e5) return `${Math.round(n / 1e3)} mil`;
  if (n >= 1e3) return `${n1(n / 1e3)} mil`;
  return String(Math.round(n));
}
export const dolar = v => `US$ ${Number(v || 0).toFixed(2).replace(".", ",")}`;
export const semMedidor = info => !info?.uso && SEM_MEDIDOR.test(`${info?.provedor || ""} ${info?.agente || ""}`);
const somaTok = u => (u ? u.entrada + u.cache_lida + u.cache_escrita + u.saida : 0);
const soTokens = u => !!u && u.sem_preco > 0 && !u.custo; // modelo sem preço conhecido

export class PainelUso {
  constructor({ palco, raiz }) {
    this.palco = palco;
    this.raiz = raiz;
    this.periodo = "hoje";
    this.ordem = "custo";
    this.mede = new Map(); // id → { mede }  (de GET /api/uso)
    this.explicacao = "";
    this.hojeTodos = null;
    this.montar();
  }

  montar() {
    this.corpo = el("div", { class: "uso-corpo-tab" });
    this.total = el("span", { class: "v", text: dolar(0) });
    this.estimado = el("small", { class: "estimado", text: "estimado" });
    this.totalTxt = el("small");
    this.todos = el("small", { class: "todos" });
    const filtro = (itens, atual, aoMudar) => {
      const f = el("div", { class: "q-filtro" }, ...itens.map(([v, t]) => el("button", { "data-v": v, class: v === atual ? "on" : "", text: t })));
      f.onclick = e => { const b = e.target.closest("button"); if (!b) return; for (const x of f.children) x.classList.toggle("on", x === b); aoMudar(b.dataset.v); };
      return f;
    };
    this.raiz.append(
      el("div", { class: "uso-barra" },
        filtro([["hoje", "Hoje"], ["conversa", "Conversa inteira"]], this.periodo, v => { this.periodo = v; this.desenhar(true); }),
        filtro([["custo", "Ordenar por custo"], ["palco", "Ordem do palco"]], this.ordem, v => { this.ordem = v; this.desenhar(false); }),
        el("span", { class: "uso-ao-vivo", text: "atualiza ao vivo enquanto os agentes trabalham" })),
      el("div", { class: "uso-tab" },
        el("div", { class: "uso-tab-cab" }, ...["Agente", "Entrada", "Cache lida", "Cache escrita", "Saída", "Custo estimado", ""].map(t => el("span", { text: t }))),
        this.corpo),
      el("div", { class: "uso-rodape" },
        el("div", { class: "uso-total" }, this.total, this.estimado, this.totalTxt),
        this.todos,
        el("div", { class: "uso-nota" }, NOTA_CUSTO, " ", el("b", { text: "Codex mostra só tokens (sem preço). " }), "Gemini CLI e OpenCode: sem medidor (não gravam a conversa num arquivo que o Engram lê).")));
  }

  async carregar() {
    try {
      const d = await api("/api/uso");
      this.mede = new Map(Object.entries(d?.sessoes || {}).map(([id, s]) => [id, s]));
      this.explicacao = d?.explicacao || "";
      this.hojeTodos = d?.hoje ?? null;
    } catch { /* o painel funciona só com o info.uso dos cartões */ }
    this.desenhar(true);
  }

  /** Evento ao vivo: a conversa de um agente cresceu. */
  aoVivo(m) {
    const c = this.palco.cartoes.get(m.sessao_id);
    if (!c) return;
    c.info.uso = m.uso;
    this.palco.pintarUso(c, true);
    if (this.aberto?.()) this.desenhar(false);
  }

  periodoDe(info) { return info.uso ? info.uso[this.periodo === "hoje" ? "hoje" : "conversa"] || ZERO : null; }

  linhas() {
    const lista = [...this.palco.cartoes.values()].filter(c => c.viva).map(c => ({ c, info: c.info, u: this.periodoDe(c.info) }));
    if (this.ordem === "custo") lista.sort((x, y) => ((y.u?.custo ?? -1) - (x.u?.custo ?? -1)) || (somaTok(y.u) - somaTok(x.u)));
    return lista;
  }

  desenhar(cresce = false) {
    const lista = this.linhas();
    const max = Math.max(0.0001, ...lista.map(x => x.u?.custo || 0));
    const maxTok = Math.max(1, ...lista.filter(x => soTokens(x.u)).map(x => somaTok(x.u)));
    this.corpo.style.height = `${Math.max(lista.length, 1) * ROW}px`;
    const vistos = new Set();
    lista.forEach(({ c, info, u }, i) => {
      vistos.add(c.id);
      let r = this.corpo.querySelector(`[data-r="${CSS.escape(c.id)}"]`);
      const novo = !r;
      if (novo) { r = el("div", { class: "linha-uso", "data-r": c.id }); r.style.top = `${i * ROW}px`; this.corpo.append(r); }
      r.style.setProperty("--lc", c.cor);
      const sem = semMedidor(info) || this.mede.get(c.id)?.mede === false;
      r.classList.toggle("sem", sem);
      r.classList.toggle("so-tok", !sem && soTokens(u));
      const trab = ["pensando", "trabalhando"].includes(c.estado);
      const nome = el("span", { class: "qm" }, el("i"), el("span", { class: "nm", text: info.nome }), el("small", { text: info.nome_modelo || nomeModelo(info.modelo, info.provedor) }), trab ? el("span", { class: "trab", text: "trabalhando" }) : null);
      if (sem) {
        r.replaceChildren(nome, el("span", { class: "span-sem", title: this.explicacao, text: "sem medidor: este agente ainda não grava a conversa num arquivo que o Engram lê" }));
      } else {
        const v = u || ZERO;
        const campos = [tokens(v.entrada), tokens(v.cache_lida), tokens(v.cache_escrita), tokens(v.saida), soTokens(v) ? "só tokens" : v.sem_preco ? `${dolar(v.custo)}+` : dolar(v.custo)];
        const celulas = r.querySelectorAll(".n");
        if (novo || !celulas.length || r.querySelector(".span-sem")) {
          r.replaceChildren(nome, ...campos.map((t, j) => el("span", { class: `n${j === 4 ? " custo" : ""}`, text: t, title: j === 4 ? NOTA_CUSTO : "" })), el("span", { class: "bar" }, el("i")));
        } else {
          r.querySelector(".qm").replaceWith(nome);
          celulas.forEach((e, j) => { if (e.textContent !== campos[j]) { e.textContent = campos[j]; e.classList.remove("sobe"); void e.offsetWidth; if (!movimentoReduzido) e.classList.add("sobe"); } });
        }
        const frac = soTokens(v) ? somaTok(v) / maxTok : (v.custo || 0) / max, barra = r.querySelector(".bar i");
        if (cresce && !movimentoReduzido) { barra.style.transition = "none"; barra.style.width = "0"; void barra.offsetWidth; barra.style.transition = ""; }
        requestAnimationFrame(() => { barra.style.width = `${Math.max(2, Math.min(100, frac * 100))}%`; });
      }
      r.onclick = () => this.palco.focar(c.id);
      r.style.top = `${i * ROW}px`;
    });
    for (const r of [...this.corpo.children]) if (!vistos.has(r.dataset.r)) r.remove();
    if (!lista.length) this.corpo.replaceChildren(el("div", { class: "q-vazia", text: "Nenhum agente aberto neste palco." }));
    const medidos = lista.filter(x => x.u && !(semMedidor(x.info) || this.mede.get(x.c.id)?.mede === false));
    const custo = medidos.reduce((s, x) => s + (x.u.custo || 0), 0), tok = medidos.reduce((s, x) => s + somaTok(x.u), 0);
    const antes = this.total.textContent;
    this.total.textContent = dolar(custo);
    if (antes !== this.total.textContent && antes !== dolar(0) && !movimentoReduzido) { this.total.classList.remove("sobe"); void this.total.offsetWidth; this.total.classList.add("sobe"); }
    this.totalTxt.textContent = `${this.periodo === "hoje" ? "Total do dia" : "Total da conversa inteira"} neste palco · ≈ ${tokens(tok)} tokens em ${medidos.length} agente${medidos.length === 1 ? "" : "s"} com medidor`;
    const h = this.hojeTodos;
    this.todos.textContent = h && Number.isFinite(h.custo) ? `Hoje, em todos os palcos: ${dolar(h.custo)} · ${tokens(h.entrada + h.saida + (h.cache_lida || 0) + (h.cache_escrita || 0))} tokens` : "";
  }

  /** O chip foi clicado: a linha do agente acende. */
  destacar(id) {
    const r = this.corpo.querySelector(`[data-r="${CSS.escape(id)}"]`);
    if (!r) return;
    r.classList.remove("acende");
    void r.offsetWidth;
    r.classList.add("acende");
  }
}

/** Texto do chip no cartão: só entrada e saída. */
export function textoChipUso(info) {
  const c = info?.uso?.conversa;
  return c ? `↓ ${tokens(c.entrada)} · ↑ ${tokens(c.saida)}` : "";
}
