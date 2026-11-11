// Gaveta lateral: a nota aberta, a consulta SQL ("o banco nosso") e o time.

import {
  $, $$, el, api, COR_TIPO, COR_LIGACAO, NOME_TIPO_UM, corModelo, nomeModelo, nomePapel, dataHora, hora, avisar,
} from "./util.js";

const EXEMPLOS = [
  ["Chamados por tabela",
    "SELECT l.destino AS tabela, COUNT(*) AS chamados\nFROM ligacoes l JOIN notas n ON n.id = l.origem\nWHERE l.tipo = 'toca' AND n.tipo = 'chamado'\nGROUP BY l.destino\nORDER BY chamados DESC;"],
  ["Chamados sem desfecho",
    "SELECT id, situacao, titulo\nFROM notas\nWHERE tipo = 'chamado' AND situacao <> 'resolvido'\nORDER BY situacao, id;"],
  ["Padrões e casos",
    "SELECT l.destino AS padrao, group_concat(l.origem, ', ') AS chamados\nFROM ligacoes l\nWHERE l.tipo = 'caso de'\nGROUP BY l.destino;"],
  ["Falta documentar",
    "SELECT l.destino AS nota_que_falta, COUNT(*) AS citada_por\nFROM ligacoes l LEFT JOIN notas n ON n.id = l.destino\nWHERE n.id IS NULL\nGROUP BY l.destino\nORDER BY citada_por DESC;"],
  ["Conversas do time",
    "SELECT m.quando, d.nome AS de, p.nome AS para, substr(m.texto, 1, 120) AS mensagem\nFROM mensagens m\nJOIN sessoes d ON d.id = m.de JOIN sessoes p ON p.id = m.para\nORDER BY m.n DESC LIMIT 50;"],
];

export class Gaveta {
  constructor({ aoRetomar, aoFocarAgente, notaExiste }) {
    this.raiz = $("#gaveta");
    this.aoRetomar = aoRetomar;
    this.aoFocarAgente = aoFocarAgente;
    this.notaExiste = notaExiste;
    this.aba = "nota";
    this.notaAberta = null;
    this.md = window.markdownit({ html: false, linkify: false, breaks: false });
    for (const b of $$("#gaveta-abas button")) b.onclick = () => this.mostrar(b.dataset.aba);
    $("#gaveta-fechar").onclick = () => this.fechar();
    $("#exemplos").replaceChildren(...EXEMPLOS.map(([nome, sql]) =>
      el("button", { class: "btn pequeno", text: nome, onclick: () => { $("#sql").value = sql; this.rodar(); } })));
    $("#sql").value = EXEMPLOS[0][1];
    $("#btn-sql").onclick = () => this.rodar();
    $("#sql").addEventListener("keydown", e => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this.rodar(); }
    });
  }

  get aberta() {
    return this.raiz.classList.contains("aberta");
  }

  abrir() {
    this.raiz.classList.add("aberta");
    this.raiz.setAttribute("aria-hidden", "false");
    requestAnimationFrame(() => this.moverSublinha());
  }

  fechar() {
    this.raiz.classList.remove("aberta");
    this.raiz.setAttribute("aria-hidden", "true");
  }

  mostrar(aba) {
    this.aba = aba;
    for (const b of $$("#gaveta-abas button")) b.classList.toggle("ativa", b.dataset.aba === aba);
    for (const a of $$(".gaveta-corpo .aba")) {
      const visivel = a.id === `aba-${aba}`;
      if (visivel && a.hidden) { a.hidden = false; a.style.animation = "none"; void a.offsetWidth; a.style.animation = ""; }
      else a.hidden = !visivel;
    }
    this.abrir();
    this.moverSublinha();
    if (aba === "time") this.time();
  }

  moverSublinha() {
    const ativa = $("#gaveta-abas button.ativa");
    const linha = $(".gaveta-sublinha");
    if (!ativa) return;
    linha.style.width = `${ativa.offsetWidth - 16}px`;
    linha.style.transform = `translateX(${ativa.offsetLeft + 8}px)`;
  }

  // ---------------------------------------------------------------- nota

  async nota(id) {
    let n;
    try {
      n = await api(`/api/nota/${encodeURIComponent(id)}`);
    } catch (e) {
      $("#aba-nota").replaceChildren(el("div", { class: "pad erro", text: e.message }));
      this.mostrar("nota");
      return null;
    }
    this.notaAberta = id;
    $("#aba-nota").replaceChildren(this.montarNota(n));
    $(".gaveta-corpo").scrollTop = 0;
    this.mostrar("nota");
    return n;
  }

  montarNota(n) {
    const sit = n.meta?.situacao;
    const partes = [
      el("div", { class: "nota-cab" },
        el("div", { class: "nota-tipo" },
          el("span", { class: "ponto", style: { "--c": COR_TIPO[n.tipo] || "#8b95aa" } }),
          NOME_TIPO_UM[n.tipo] || n.tipo,
          sit ? el("span", { class: `chip sit-${sit}`, text: sit }) : null),
        el("h2", { text: n.titulo }),
        el("div", { class: "discreto mono", text: n.caminho ? `cerebro/${n.caminho}` : n.id })),
    ];
    if (!n.existe) partes.push(el("p", { class: "pad aviso-texto", text: "Esta nota ainda não existe. Outras notas apontam para ela: é algo a documentar." }));
    if (n.erro) partes.push(el("p", { class: "pad erro", text: n.erro }));
    const meta = Object.entries(n.meta || {}).filter(([k]) => !["tipo", "titulo", "situacao"].includes(k));
    if (meta.length) {
      partes.push(el("dl", { class: "meta" }, meta.flatMap(([k, v]) => [
        el("dt", { text: k }),
        el("dd", { text: Array.isArray(v) ? v.join(", ") : typeof v === "object" ? JSON.stringify(v) : String(v) }),
      ])));
    }
    if (n.corpo) {
      const corpo = el("div", { class: "md" });
      corpo.innerHTML = this.md.render(wikilinks(n.corpo)); // markdown-it com HTML desligado
      for (const a of corpo.querySelectorAll("a")) {
        const href = a.getAttribute("href") || "";
        if (href.startsWith("#n:")) a.onclick = ev => { ev.preventDefault(); this.aoAbrirNota?.(decodeURIComponent(href.slice(3))); };
        else { a.target = "_blank"; a.rel = "noopener noreferrer"; }
      }
      partes.push(corpo);
    }
    partes.push(this.ligacoes("Aponta para", n.saidas || []), this.ligacoes("Apontam para esta nota", n.entradas || []));
    return el("div", {}, partes);
  }

  ligacoes(titulo, lista) {
    const bloco = el("div", { class: "ligacoes" }, el("h3", { text: `${titulo} · ${lista.length}` }));
    if (!lista.length) { bloco.append(el("div", { class: "discreto", text: "Nenhuma." })); return bloco; }
    const grupos = new Map();
    for (const l of lista) {
      if (!grupos.has(l.tipo)) grupos.set(l.tipo, []);
      grupos.get(l.tipo).push(l);
    }
    let i = 0;
    for (const [tipo, itens] of grupos) {
      bloco.append(el("div", { class: "grupo" },
        el("div", { class: "grupo-nome" }, el("span", { class: "ponto", style: { "--c": COR_LIGACAO[tipo] || "#5b6880" } }), tipo),
        itens.map(l => el("button", {
          class: `item${l.titulo ? "" : " falta"}`, style: { animationDelay: `${i++ * 25}ms` },
          onclick: () => this.aoAbrirNota?.(l.id),
        },
          el("span", { class: "ponto", style: { "--c": COR_TIPO[l.tipo_nota || "pendente"] } }),
          el("span", { class: "id", text: l.id }),
          el("span", { class: "tit", text: l.titulo || "ainda não documentado" })))));
    }
    return bloco;
  }

  // ---------------------------------------------------------------- consulta

  async rodar() {
    const info = $("#sql-info"), destino = $("#sql-resultado");
    info.textContent = "rodando…";
    let r;
    try {
      r = await api("/api/consulta", { json: { sql: $("#sql").value } });
    } catch (e) {
      info.textContent = "";
      destino.replaceChildren(el("p", { class: "erro", text: e.message }));
      return;
    }
    info.textContent = `${r.linhas.length} linha(s)${r.cortado ? " · cortado em 500" : ""}`;
    destino.replaceChildren(el("table", {},
      el("thead", {}, el("tr", {}, r.colunas.map(c => el("th", { text: c })))),
      el("tbody", {}, r.linhas.map(linha => el("tr", {}, linha.map(v => {
        const texto = v === null ? "" : String(v);
        const nota = this.notaExiste(texto);
        return el("td", { class: nota ? "link" : "", title: texto, text: texto, onclick: nota ? () => this.aoAbrirNota?.(texto) : null });
      }))))));
  }

  // ---------------------------------------------------------------- time

  async time() {
    const painel = $("#aba-time");
    let sessoes;
    try { sessoes = await api("/api/sessoes"); }
    catch (e) { painel.replaceChildren(el("div", { class: "pad erro", text: e.message })); return; }
    const abertas = sessoes.filter(s => !s.encerrada), antigas = sessoes.filter(s => s.encerrada);
    let i = 0;
    const membro = s => {
      const aberta = !s.encerrada;
      const card = el("div", { class: "membro", style: { "--cor": corModelo(s.modelo), animationDelay: `${i++ * 40}ms` } },
        el("div", { class: "topo-m" },
          el("span", { class: "ponto", style: { "--c": corModelo(s.modelo) } }),
          el("b", { text: s.nome }),
          el("span", { class: `tag${s.papel === "maestro" ? " maestro" : ""}`, text: s.papel === "maestro" ? "♛ Maestro" : nomePapel(s.papel) }),
          el("span", { class: "chip empurra", text: aberta ? s.estado : "encerrada" })),
        el("div", { class: "det", text: `${nomeModelo(s.modelo, s.provedor)} · aberta ${dataHora(s.criada)}` }),
        el("div", { class: "linha" },
          aberta ? el("button", { class: "btn pequeno", text: "Ver no palco", onclick: () => this.aoFocarAgente(s.id) }) : null,
          !aberta ? el("button", { class: "btn-brilho pequeno", onclick: () => this.aoRetomar(s) }, el("span", { text: "Retomar" })) : null,
          el("button", { class: "btn pequeno", text: "Atividade", onclick: ev => this.atividade(s, ev.target.closest(".membro")) })));
      return card;
    };
    let importar = null;
    try {
      const imp = await api("/api/importar/engram-antigo");
      if (imp.existe && !imp.ja_importado) {
        importar = el("div", { class: "membro importar", style: { "--cor": "#8b7bff" } },
          el("div", { class: "topo-m" }, el("b", { text: "Trazer o time do Engram antigo" })),
          el("div", { class: "det", text: `${imp.total} agente(s) no histórico${imp.abertos.length ? ` · abertos lá: ${imp.abertos.join(", ")}` : ""}` }),
          el("div", { class: "linha" }, el("button", { class: "btn-brilho pequeno", onclick: () => this.importar(imp) }, el("span", { text: "Trazer para cá" }))));
      }
    } catch { /* sem Engram antigo */ }
    painel.replaceChildren(
      ...(importar ? [importar] : []),
      el("div", { class: "secao", text: `No palco · ${abertas.length}` }),
      ...(abertas.length ? abertas.map(membro) : [el("div", { class: "pad discreto", text: "Nenhum agente aberto." })]),
      el("div", { class: "secao", text: "Anteriores" }),
      ...(antigas.length ? antigas.slice(0, 25).map(membro) : [el("div", { class: "pad discreto", text: "Nenhum." })]),
    );
  }

  async importar(imp) {
    const aviso = imp.abertos.length ? `Os agentes abertos no Engram antigo (${imp.abertos.join(", ")}) param lá e reabrem aqui, onde pararam.
` : "";
    if (!confirm(`Trazer o time do Engram antigo?

${aviso}Também vêm as posições, as linhas e os arquivos de cada agente (e os seus ajustes, se houver um importar-para-o-app.json ao lado da pasta antiga). O Engram reinicia em seguida.`)) return;
    try {
      const r = await api("/api/importar/engram-antigo", { json: {} });
      avisar({ texto: `Trouxe ${r.agentes} agente(s). Reiniciando o Engram…`, cor: "#4ade9f", tempo: 8000 });
    } catch (e) { avisar({ texto: e.message, cor: "#ff6b7d" }); }
  }

  async atividade(s, card) {
    const antes = card.querySelector(".eventos");
    if (antes) { antes.remove(); return; }
    const eventos = await api(`/api/sessoes/${s.id}/eventos`);
    const rotulo = { SessionStart: "início", UserPromptSubmit: "pedido", PreToolUse: "→", Stop: "terminou", Notification: "aviso" };
    card.append(el("ul", { class: "eventos" },
      eventos.length
        ? eventos.slice(-60).reverse().map((e, i) => el("li", {
          style: { animationDelay: `${i * 15}ms` }, title: e.resumo || "",
          text: `${hora(e.quando)}  ${rotulo[e.evento] || e.evento}  ${e.resumo || ""}`,
        }))
        : el("li", { text: "Sem atividade registrada." })));
  }
}

function wikilinks(texto) {
  // [[id]] e [[id|texto]] viram links, menos dentro de código
  return texto.split(/(^```[\s\S]*?^```[ \t]*$|^~~~[\s\S]*?^~~~[ \t]*$|`[^`\n]*`)/m)
    .map((parte, i) => (i % 2 ? parte : parte.replace(/\[\[([^\[\]|#\n]+)(?:#[^\[\]|\n]*)?(?:\|([^\[\]\n]+))?\]\]/g,
      (_, id, apelido) => `[${(apelido || id).trim().replace(/[\[\]\\]/g, "\\$&")}](#n:${encodeURIComponent(id.trim())})`)))
    .join("");
}
