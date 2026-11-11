// Primeiro uso guiado: tema → contas → agente e modelo padrão → MCPs e skills (opcional) → primeiro time.
// Aparece quando o Engram nunca foi usado (sem janelas, sem guia concluído, sem importação do Engram antigo).

import { el, api, app, avisar } from "./util.js";
import { COR_AGENTE, iconeAgente } from "./contas.js";
import { PALETAS, aplicarTema, miniatura } from "./geral.js";

const PASSOS = ["Boas-vindas", "Contas", "Agente", "MCPs e skills", "Primeiro time"];

export class PrimeiroUso {
  constructor({ ajustes, aoTerminar }) {
    this.ajustes = ajustes;
    this.aoTerminar = aoTerminar;
    this.passo = 0;
    this.contas = [];
    this.escolha = { agente: app.padraoAgente || null, modelo: app.padraoModelo ?? "" };
    this.marcadosMcp = new Set();
    this.marcadasSkill = new Set();
  }

  abrir() {
    this.raiz = el("div", { class: "guia", role: "dialog", "aria-modal": "true", "aria-label": "Primeiro uso do Engram" });
    document.body.append(this.raiz);
    this.mostrar(0);
  }

  fechar() {
    this.raiz.classList.add("saindo");
    setTimeout(() => this.raiz.remove(), 450);
  }

  async mostrar(n, direcao = 1) {
    this.passo = n;
    const conteudo = await [() => this.boasVindas(), () => this.passoContas(), () => this.passoAgente(), () => this.passoExtras(), () => this.passoTime()][n]();
    const progresso = el("ol", { class: "guia-passos" }, ...PASSOS.map((p, i) => el("li", { class: i < n ? "feito" : i === n ? "atual" : "" }, el("span", { text: i < n ? "✓" : String(i + 1) }), el("b", { text: p }))));
    const caixa = el("div", { class: `guia-caixa ${direcao > 0 ? "vem-direita" : "vem-esquerda"}` }, conteudo);
    this.raiz.replaceChildren(el("div", { class: "guia-fundo" }), progresso, caixa,
      el("button", { type: "button", class: "guia-pular", onclick: () => this.terminar(false) }, "Pular o guia"));
  }

  rodape(...botoes) { return el("div", { class: "guia-rodape" }, this.passo > 0 ? el("button", { type: "button", class: "btn", onclick: () => this.mostrar(this.passo - 1, -1) }, "← Voltar") : el("span"), el("span", { class: "empurra" }), ...botoes); }
  seguir(texto = "Continuar →", antes = null) {
    return el("button", { type: "button", class: "btn-brilho", onclick: async () => { if (antes && (await antes()) === false) return; this.mostrar(this.passo + 1); } }, el("span", { text: texto }));
  }

  // ---------------------------------------------------------------- 1. boas-vindas e tema
  boasVindas() {
    const temas = app.temas || [];
    const grade = el("div", { class: "guia-temas" });
    const desenhar = () => grade.replaceChildren(...temas.map(t => el("button", {
      type: "button", class: `guia-tema${app.tema === t.id ? " ativo" : ""}`, style: { "--a1": PALETAS[t.id]?.a1 || "#8b7bff" },
      onclick: () => { aplicarTema(t.id, { salvar: true }); desenhar(); },
    }, miniatura(t.id), el("b", { text: t.nome }))));
    desenhar();
    return el("div", { class: "guia-boas" },
      el("div", { class: "guia-marca" }, el("img", { src: "marca/engram.png", alt: "" }), el("i"), el("i"), el("i")),
      el("h1", { text: "Bem-vindo ao Engram" }),
      el("p", { class: "guia-lead", text: "Um palco onde agentes de IA trabalham juntos: você liga um ao outro com uma linha, eles conversam, e um maestro divide o trabalho. Tudo o que aprendem vai para um cérebro de notas que fica com você." }),
      el("h3", { text: "Escolha a cara do seu Engram" }), grade,
      this.rodape(this.seguir("Começar →")));
  }

  // ---------------------------------------------------------------- 2. contas
  async passoContas() {
    const lista = el("div", { class: "guia-contas" }, el("div", { class: "aj-carregando" }, el("span", { class: "giro" }), "Conferindo os agentes instalados…"));
    const carregar = async forcar => {
      try { this.contas = await api(`/api/contas${forcar ? "?atualizar=1" : ""}`); } catch { this.contas = []; }
      lista.replaceChildren(...this.contas.map((p, i) => {
        const estado = !p.instalado ? "fora" : p.conectado ? "ok" : "sem";
        return el("div", { class: `guia-conta estado-${estado}`, style: { "--cor": COR_AGENTE[p.id], "--i": i } },
          iconeAgente(p.id),
          el("div", { class: "aj-nome" }, el("b", { text: p.nome }), el("small", { text: { fora: "não instalado", ok: `conectado · ${p.como || ""}`, sem: "instalado, falta entrar" }[estado] })),
          estado === "ok" ? el("span", { class: "guia-ok", text: "✓" })
            : el("button", { type: "button", class: "btn pequeno", onclick: () => this.ajustes.abrir("contas") }, estado === "fora" ? "Instalar" : "Entrar"));
      }));
    };
    carregar(false);
    this.ajustes.dlg.addEventListener("close", () => carregar(true), { once: true });
    return el("div", { class: "guia-bloco" },
      el("h2", { text: "Entre com as suas contas" }),
      el("p", { class: "guia-lead", text: "Cada agente usa o login do próprio CLI (Claude Code, Codex…). Precisa de pelo menos um conectado. Chaves de API ficam no cofre do Windows." }),
      lista,
      el("button", { type: "button", class: "btn pequeno guia-conferir", onclick: () => carregar(true) }, "↻ Conferir de novo"),
      this.rodape(this.seguir("Continuar →", () => {
        if (!this.contas.some(p => p.instalado && p.conectado)) { avisar({ texto: "Entre em pelo menos um agente para continuar (ou pule o guia).", cor: "#ffc857" }); return false; }
        return true;
      })));
  }

  // ---------------------------------------------------------------- 3. agente e modelo padrão
  passoAgente() {
    const prontos = this.contas.filter(p => p.instalado && p.conectado);
    if (!prontos.some(p => p.id === this.escolha.agente)) this.escolha.agente = prontos[0]?.id || "claude";
    const agentes = el("div", { class: "opcoes-agente" });
    const modelos = el("div", { class: "opcoes-modelo" });
    const desenharModelos = () => {
      const p = prontos.find(x => x.id === this.escolha.agente) || { modelos: [] };
      if (!p.modelos.some(m => m.id === this.escolha.modelo)) this.escolha.modelo = (p.modelos.find(m => /sonnet/.test(m.id)) || p.modelos[0] || { id: "" }).id;
      modelos.replaceChildren(...p.modelos.map(m => el("label", { class: "op", style: { "--cor": COR_AGENTE[p.id] } },
        el("input", { type: "radio", name: "guia-modelo", checked: m.id === this.escolha.modelo, onchange: () => { this.escolha.modelo = m.id; } }),
        el("b", { text: m.nome }), el("small", { text: m.resumo || (m.id ? "" : "o padrão do agente") }))));
    };
    agentes.replaceChildren(...prontos.map(p => el("label", { class: "op agente", style: { "--cor": COR_AGENTE[p.id] } },
      el("input", { type: "radio", name: "guia-agente", checked: p.id === this.escolha.agente, onchange: () => { this.escolha.agente = p.id; desenharModelos(); } }),
      el("b", {}, el("span", { class: "ponto", style: { "--c": COR_AGENTE[p.id] } }), p.nome), el("small", { text: p.empresa }))));
    desenharModelos();
    return el("div", { class: "guia-bloco" },
      el("h2", { text: "Qual agente e qual modelo por padrão?" }),
      el("p", { class: "guia-lead", text: "É o que vem marcado quando você abre uma janela nova. Dá para trocar em cada janela." }),
      el("div", { class: "campo" }, el("span", { text: "Agente" }), agentes),
      el("div", { class: "campo" }, el("span", { text: "Modelo" }), modelos),
      this.rodape(this.seguir("Continuar →", async () => {
        await api("/api/config", { json: { padrao_agente: this.escolha.agente, padrao_modelo: this.escolha.modelo } }).catch(() => {});
        app.padraoAgente = this.escolha.agente; app.padraoModelo = this.escolha.modelo;
        return true;
      })));
  }

  // ---------------------------------------------------------------- 4. MCPs e skills (opcional)
  async passoExtras() {
    const caixaMcp = el("div", { class: "guia-lista" }, el("div", { class: "aj-carregando" }, el("span", { class: "giro" }), "Procurando MCPs nos seus CLIs…"));
    const caixaSkill = el("div", { class: "guia-lista" });
    const item = (marcados, id, titulo, sub, ja) => {
      if (ja) return el("div", { class: "guia-item ja" }, el("span", { class: "guia-ok", text: "✓" }), el("div", { class: "aj-nome" }, el("b", { text: titulo }), el("small", { text: `${sub} · já no Engram` })));
      const ch = el("input", { type: "checkbox", checked: marcados.has(id), onchange: e => (e.target.checked ? marcados.add(id) : marcados.delete(id)) });
      return el("label", { class: "guia-item" }, el("span", { class: "chave" }, ch, el("span")), el("div", { class: "aj-nome" }, el("b", { text: titulo }), el("small", { text: sub })));
    };
    api("/api/mcps/encontrados").then(lista => {
      for (const s of lista) if (!s.importado) this.marcadosMcp.add(s.id);
      caixaMcp.replaceChildren(...(lista.length ? lista.map(s => item(this.marcadosMcp, s.id, s.id, `${s.tipo === "http" ? "HTTP" : "stdio"} · ${s.origem}`, s.importado)) : [el("div", { class: "aj-vazio pequeno", text: "Nenhum MCP configurado nos seus CLIs. Dá para adicionar depois em Ajustes." })]));
    }).catch(() => caixaMcp.replaceChildren());
    api("/api/skills").then(d => {
      this.skillsAchadas = d.encontradas;
      caixaSkill.replaceChildren(...(d.encontradas.length ? d.encontradas.map(s => item(this.marcadasSkill, s.caminho, s.nome, s.origem, s.importada)) : [el("div", { class: "aj-vazio pequeno", text: "Nenhuma skill solta no Claude Code ou no Codex. Dá para criar ou importar depois em Ajustes." })]));
    }).catch(() => {});
    return el("div", { class: "guia-bloco" },
      el("h2", { text: "Ferramentas e receitas (opcional)" }),
      el("p", { class: "guia-lead", text: "MCPs dão ferramentas aos agentes (bancos, sistemas, APIs). Skills ensinam tarefas do seu jeito. Achamos estes nos seus CLIs: marque o que quer trazer." }),
      el("div", { class: "guia-duas" },
        el("div", {}, el("h3", { text: "MCPs" }), caixaMcp),
        el("div", {}, el("h3", { text: "Skills" }), caixaSkill)),
      this.rodape(
        el("button", { type: "button", class: "btn", onclick: () => this.mostrar(this.passo + 1) }, "Agora não"),
        this.seguir("Trazer os marcados →", async () => {
          let n = 0;
          for (const id of this.marcadosMcp) { try { await api(`/api/mcps/${encodeURIComponent(id)}/importar`, { method: "POST" }); n++; } catch (e) { avisar({ texto: `${id}: ${e.message}`, cor: "#ff6b7d" }); } }
          for (const caminho of this.marcadasSkill) { try { await api("/api/skills/importar", { json: { origem: caminho } }); n++; } catch (e) { avisar({ texto: e.message, cor: "#ff6b7d" }); } }
          if (n) avisar({ texto: `${n} ${n === 1 ? "item trazido" : "itens trazidos"} para o Engram`, cor: "#4ade9f" });
          const e = await api("/api/estado").catch(() => null);
          if (e) app.mcps = e.mcps || [];
          return true;
        })));
  }

  // ---------------------------------------------------------------- 5. primeiro time
  passoTime() {
    const MODELOS = [
      { id: "maestro", titulo: "Maestro + 2 agentes", texto: "Um maestro que divide o pedido e dois colegas ligados a ele. O jeito Engram de trabalhar.", janelas: [["maestro", "maestro"], ["analista", "livre"], ["redator", "redator"]] },
      { id: "dupla", titulo: "Dupla: agente + revisor", texto: "Um faz, o outro confere números, causa e código antes de você ver.", janelas: [["agente", "livre"], ["revisor", "revisor"]] },
      { id: "um", titulo: "Um agente só", texto: "Para começar simples. Depois é só arrastar mais agentes para o palco.", janelas: [["agente", "livre"]] },
    ];
    let escolhido = "maestro";
    const opcoes = el("div", { class: "guia-times" });
    const desenhar = () => opcoes.replaceChildren(...MODELOS.map((m, i) => el("button", {
      type: "button", class: `guia-time${escolhido === m.id ? " ativo" : ""}`, style: { "--i": i }, onclick: () => { escolhido = m.id; desenhar(); },
    }, el("div", { class: "guia-time-desenho" }, ...m.janelas.map((j, k) => el("i", { class: j[1] === "maestro" ? "maestro" : "", style: { "--k": k, "--n": m.janelas.length } }))),
      el("b", { text: m.titulo }), el("small", { text: m.texto }))));
    desenhar();
    return el("div", { class: "guia-bloco" },
      el("h2", { text: "Monte o seu primeiro time" }),
      el("p", { class: "guia-lead", text: `As janelas abrem com ${this.contas.find(p => p.id === this.escolha.agente)?.nome || "o agente padrão"}, já ligadas no palco. Escreva para o maestro (ou para o agente) e veja o time trabalhar.` }),
      opcoes,
      this.rodape(
        el("button", { type: "button", class: "btn", onclick: () => this.terminar(true) }, "Abrir o palco vazio"),
        el("button", { type: "button", class: "btn-brilho", onclick: () => this.criarTime(MODELOS.find(m => m.id === escolhido)) }, el("span", { text: "Abrir o time ✦" }))));
  }

  async criarTime(modelo) {
    const criados = [];
    const pos = modelo.janelas.length === 3 ? [[0, 0], [840, -280], [840, 280]] : modelo.janelas.length === 2 ? [[0, 0], [840, 0]] : [[0, 0]];
    try {
      for (const [k, [nome, papel]] of modelo.janelas.entries()) {
        const info = await api("/api/sessoes", { json: { nome, papel, provedor: this.escolha.agente, modelo: this.escolha.modelo, posicao: { x: pos[k][0], y: pos[k][1] } } });
        criados.push(info);
        this.aoCriar?.(info);
      }
      for (const c of criados.slice(1)) await api("/api/conexoes", { json: { a: criados[0].id, b: c.id } });
    } catch (e) { avisar({ texto: `Não abriu tudo: ${e.message}`, cor: "#ff6b7d", tempo: 8000 }); }
    this.terminar(true, criados);
  }

  async terminar(concluido, criados = []) {
    await api("/api/primeiro-uso/feito", { method: "POST" }).catch(() => {});
    this.fechar();
    this.aoTerminar?.({ concluido, criados });
  }
}
