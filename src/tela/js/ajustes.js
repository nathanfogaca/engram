// Ajustes: abas de Contas, MCPs e Skills na mesma janela.
// MCPs: cadastrar (HTTP ou stdio), testar, ligar/desligar, escolher os agentes, trazer dos CLIs.
// Skills: criar, editar (com prévia), importar, ligar/desligar e escolher Claude/Codex.

import { $, $$, el, api, avisar } from "./util.js";
import { COR_AGENTE } from "./contas.js";
import { PainelGeral, PainelAparencia } from "./geral.js";

const NOMES_AGENTE = { claude: "Claude Code", codex: "Codex", gemini: "Gemini CLI", opencode: "OpenCode" };
const md = () => window.markdownit({ html: false, linkify: true });
const botao = (texto, fn, classe = "btn pequeno", extra = {}) => el("button", { type: "button", class: classe, onclick: fn, ...extra }, texto);
const chave = (ligado, fn, titulo = "") => {
  const input = el("input", { type: "checkbox", checked: ligado, onchange: e => fn(e.target.checked) });
  return el("label", { class: "chave", title: titulo }, input, el("span"));
};
/** Botão que pede confirmação no segundo clique (sem janela do sistema). */
function confirmar(texto, fn) {
  const b = botao(texto, () => {
    if (b.dataset.armado) { fn(); return; }
    b.dataset.armado = "1"; b.textContent = "Confirmar?"; b.classList.add("perigo");
    setTimeout(() => { delete b.dataset.armado; b.textContent = texto; b.classList.remove("perigo"); }, 3000);
  });
  return b;
}

export class Ajustes {
  constructor({ contas, aoMudarMcps }) {
    this.contas = contas;
    this.aoMudarMcps = aoMudarMcps;
    this.dlg = $("#dlg-contas");
    this.aba = "geral";
    for (const b of $$("#ajustes-abas button")) b.onclick = () => this.mostrar(b.dataset.aba);
    this.mcps = new PainelMcps($("#aba-mcps"), () => this.aoMudarMcps?.());
    this.skills = new PainelSkills($("#aba-skills"));
    this.geral = new PainelGeral($("#aba-geral"), { aoReiniciar: () => api("/api/reiniciar", { method: "POST" }) });
    this.aparencia = new PainelAparencia($("#aba-aparencia"));
  }

  async abrir(aba = this.aba) {
    if (!this.dlg.open) this.dlg.showModal();
    await this.mostrar(aba);
  }

  async mostrar(aba) {
    this.aba = aba;
    for (const b of $$("#ajustes-abas button")) b.classList.toggle("ativo", b.dataset.aba === aba);
    for (const s of $$(".ajustes-aba")) s.hidden = s.id !== `aba-${aba}`;
    const titulos = {
      geral: ["Ajustes", "Onde os agentes trabalham, de onde vem o cérebro, os limites do time e o texto que todo agente recebe."],
      aparencia: ["Aparência", "Escolha o tema. Ele muda na hora e fica salvo."],
      contas: ["Contas e agentes", "Entre com as suas contas para usar cada agente no palco. Chaves de API ficam no cofre do Windows, nunca em texto no disco."],
      mcps: ["Servidores MCP", "As ferramentas que os agentes usam (bancos, sistemas, APIs). Cadastre uma vez, teste e escolha para quais agentes vale."],
      skills: ["Skills", "Receitas que ensinam o agente a fazer uma tarefa do seu jeito (formato SKILL.md). Valem para janelas novas."],
    };
    $("#ajustes-titulo").textContent = titulos[aba][0];
    $("#ajustes-sub").textContent = titulos[aba][1];
    if (aba === "contas") await this.contas.abrir();
    else if (aba === "geral") await this.geral.carregar();
    else if (aba === "aparencia") this.aparencia.carregar();
    else if (aba === "mcps") await this.mcps.carregar();
    else await this.skills.carregar();
  }
}

// ================================================================== MCPs

class PainelMcps {
  constructor(raiz, aoMudar) {
    this.raiz = raiz;
    this.aoMudar = aoMudar;
    this.dados = { servidores: [], so_engram: false };
    this.encontrados = null;
    this.editando = null; // id em edição, ou "__novo"
    this.testes = {}; // id -> resultado
  }

  async carregar() {
    try { this.dados = await api("/api/mcps"); } catch (e) { avisar({ texto: e.message, cor: "#ff6b7d" }); }
    this.desenhar();
    if (!this.encontrados) this.buscarEncontrados();
  }

  async buscarEncontrados() {
    try { this.encontrados = await api("/api/mcps/encontrados"); } catch { this.encontrados = []; }
    this.desenhar();
  }

  aplicar(dados) { this.dados = dados; this.aoMudar?.(); this.desenhar(); }

  desenhar() {
    const lista = this.dados.servidores;
    const topo = el("div", { class: "aj-barra" },
      botao(el("span", { text: "+ Adicionar MCP" }), () => { this.editando = "__novo"; this.desenhar(); }, "btn-brilho pequeno"),
      el("label", { class: "aj-opcao", title: "Nas janelas do Claude Code, ignora os MCPs configurados direto nele (global ou na pasta) e usa só os daqui" },
        chave(this.dados.so_engram, async v => { try { this.aplicar(await api("/api/mcps/opcoes", { json: { so_engram: v } })); } catch (e) { avisar({ texto: e.message, cor: "#ff6b7d" }); } }),
        el("span", { text: "Usar só os MCPs do Engram" })));
    const itens = [];
    if (this.editando === "__novo") itens.push(this.formulario(null));
    lista.forEach((s, i) => itens.push(this.editando === s.id ? this.formulario(s) : this.cartao(s, i)));
    if (!lista.length && this.editando !== "__novo") {
      itens.push(el("div", { class: "aj-vazio" }, el("b", { text: "Nenhum MCP no Engram ainda." }),
        el("span", { text: "Adicione um ou traga os que você já usa no Claude Code e no Codex (logo abaixo)." })));
    }
    this.raiz.replaceChildren(topo, el("div", { class: "aj-lista" }, ...itens), this.blocoEncontrados());
  }

  cartao(s, i) {
    const teste = this.testes[s.id];
    const alvo = s.tipo === "http" ? s.url : [s.comando, ...(s.args || [])].join(" ");
    const agentes = s.agentes.includes("todos") ? ["todos"] : s.agentes;
    return el("article", { class: `aj-cartao${s.ativo ? "" : " desligado"}`, style: { "--i": i } },
      el("div", { class: "aj-topo" },
        el("span", { class: `aj-orbe ${s.tipo}`, text: s.tipo === "http" ? "⇄" : "▸" }),
        el("div", { class: "aj-nome" }, el("b", { text: s.nome }), el("small", { text: s.id === s.nome ? (s.origem ? `trazido de ${s.origem}` : "") : `${s.id}${s.origem ? ` · trazido de ${s.origem}` : ""}` })),
        el("span", { class: "tag", text: s.tipo === "http" ? "HTTP" : "stdio" }),
        s.liberar ? el("span", { class: "tag liberado", text: "liberado", title: "Os agentes usam as ferramentas sem pedir aprovação" }) : null,
        chave(s.ativo, async v => { try { this.aplicar(await api(`/api/mcps/${encodeURIComponent(s.id)}/ativo`, { json: { ativo: v } })); } catch (e) { avisar({ texto: e.message, cor: "#ff6b7d" }); } }, s.ativo ? "Ligado" : "Desligado")),
      el("code", { class: "aj-alvo", text: alvo, title: alvo }),
      el("div", { class: "aj-agentes" }, ...agentes.map(a => el("span", { class: "aj-ag", style: { "--c": COR_AGENTE[a] || "#a5b4fc" }, text: a === "todos" ? "Todos os agentes" : NOMES_AGENTE[a] || a }))),
      teste ? this.resultado(teste) : null,
      el("div", { class: "aj-acoes" },
        botao(teste?.rodando ? "Testando…" : "Testar", () => this.testar(s.id), "btn pequeno", { disabled: !!teste?.rodando }),
        botao("Editar", () => { this.editando = s.id; this.desenhar(); }),
        confirmar("Remover", async () => { try { this.aplicar(await api(`/api/mcps/${encodeURIComponent(s.id)}/remover`, { method: "POST" })); } catch (e) { avisar({ texto: e.message, cor: "#ff6b7d" }); } })));
  }

  resultado(t) {
    if (t.rodando) return el("div", { class: "aj-teste rodando" }, el("span", { class: "giro" }), "Conectando…");
    if (!t.ok) return el("div", { class: "aj-teste erro" }, el("b", { text: "✕ " }), t.erro || "falhou");
    const nomes = t.ferramentas || [];
    return el("details", { class: "aj-teste ok" },
      el("summary", {}, el("b", { text: "✓ " }), `${t.servidor?.name || "servidor"} respondeu · ${nomes.length} ferramenta${nomes.length === 1 ? "" : "s"} · ${t.ms} ms`),
      el("div", { class: "aj-ferramentas" }, ...nomes.slice(0, 120).map(n => el("code", { text: n }))));
  }

  async testar(id, def = null, segredos = {}) {
    const chaveT = id || "__form";
    this.testes[chaveT] = { rodando: true };
    if (id) this.desenhar(); else this.mostrarTesteForm();
    try { this.testes[chaveT] = await api("/api/mcps/testar", { json: id ? { id } : { def, segredos } }); } catch (e) { this.testes[chaveT] = { ok: false, erro: e.message }; }
    if (id) this.desenhar(); else this.mostrarTesteForm();
  }

  mostrarTesteForm() {
    const alvo = $(".aj-form .aj-teste-lugar", this.raiz);
    if (alvo) alvo.replaceChildren(this.testes.__form ? this.resultado(this.testes.__form) : "");
  }

  // ---------------------------------------------------------------- formulário

  formulario(s) {
    const novo = !s;
    s = s || { id: "", nome: "", tipo: "http", url: "", headers: {}, comando: "", args: [], env: {}, agentes: ["todos"], liberar: false, ativo: true };
    let tipo = s.tipo;
    const id = el("input", { value: s.id, placeholder: "ex.: meu-servidor", maxlength: 40, spellcheck: "false" });
    const nome = el("input", { value: s.nome === s.id ? "" : s.nome, placeholder: "como aparece (opcional)", maxlength: 60 });
    const url = el("input", { value: s.url || "", placeholder: "https://servidor/mcp", spellcheck: "false" });
    const comando = el("input", { value: s.comando || "", placeholder: "ex.: npx, uvx, node, ou o caminho do programa", spellcheck: "false" });
    const args = el("textarea", { rows: 3, placeholder: "um argumento por linha", spellcheck: "false" });
    args.value = (s.args || []).join("\n");
    let ca = s.ca || "";
    const caTexto = el("span", { class: "aj-ca", text: ca || "nenhum (padrão do sistema)" });
    const linhasCab = this.pares(s.headers || {}, "Cabeçalho", "Authorization");
    const linhasEnv = this.pares(s.env || {}, "Variável", "API_KEY");
    const agentes = new Set(s.agentes);
    const chipsAgentes = el("div", { class: "aj-chips" });
    const desenharChips = () => chipsAgentes.replaceChildren(...["todos", "claude", "codex", "gemini", "opencode"].map(a => el("button", {
      type: "button", class: `aj-chip${agentes.has(a) ? " ativo" : ""}`, style: { "--c": COR_AGENTE[a] || "#a5b4fc" },
      onclick: () => {
        if (a === "todos") { agentes.clear(); agentes.add("todos"); } else { agentes.delete("todos"); agentes.has(a) ? agentes.delete(a) : agentes.add(a); if (!agentes.size) agentes.add("todos"); }
        desenharChips();
      },
    }, a === "todos" ? "Todos" : NOMES_AGENTE[a])));
    desenharChips();
    let liberar = !!s.liberar;
    const blocoHttp = el("div", { class: "aj-campos" },
      el("label", { class: "aj-campo largo" }, el("span", { text: "Endereço" }), url),
      el("div", { class: "aj-campo largo" }, el("span", { text: "Cabeçalhos" }), linhasCab.el),
      el("div", { class: "aj-campo largo" }, el("span", { text: "Certificado da empresa (CA)" }),
        el("div", { class: "linha" }, caTexto,
          botao("Escolher…", async () => { const r = await api("/api/mcps/escolher-ca", { method: "POST" }); if (r.caminho) { ca = r.caminho; caTexto.textContent = ca; } }),
          botao("Tirar", () => { ca = ""; caTexto.textContent = "nenhum (padrão do sistema)"; }))));
    const blocoStdio = el("div", { class: "aj-campos" },
      el("label", { class: "aj-campo largo" }, el("span", { text: "Comando" }), comando),
      el("label", { class: "aj-campo largo" }, el("span", { text: "Argumentos" }), args),
      el("div", { class: "aj-campo largo" }, el("span", { text: "Variáveis de ambiente" }), linhasEnv.el));
    const segTipo = el("div", { class: "aj-seg" });
    const desenharTipo = () => {
      segTipo.replaceChildren(...[["http", "HTTP (endereço)"], ["stdio", "stdio (programa local)"]].map(([t, rot]) =>
        el("button", { type: "button", class: tipo === t ? "ativo" : "", onclick: () => { tipo = t; desenharTipo(); } }, rot)));
      blocoHttp.hidden = tipo !== "http";
      blocoStdio.hidden = tipo !== "stdio";
    };
    desenharTipo();
    const montar = () => {
      const def = { id: id.value.trim(), nome: nome.value.trim() || id.value.trim(), tipo, agentes: [...agentes], liberar, ativo: s.ativo !== false, origem: s.origem };
      const segredos = {};
      const ler = (linhas, campo) => {
        const obj = {};
        for (const l of linhas.ler()) {
          if (l.segredo) { if (l.valor) segredos[`${campo}.${l.nome}`] = l.valor; obj[l.nome] = l.valor ? "" : { cofre: true }; } else obj[l.nome] = l.valor;
        }
        return obj;
      };
      if (tipo === "http") { def.url = url.value.trim(); def.headers = ler(linhasCab, "headers"); if (ca) def.ca = ca; } else {
        def.comando = comando.value.trim(); def.args = args.value.split(/\r?\n/).map(x => x.trim()).filter(Boolean); def.env = ler(linhasEnv, "env");
      }
      return { def, segredos };
    };
    const salvar = async () => {
      const { def, segredos } = montar();
      try {
        this.aplicar(await api("/api/mcps", { json: { def, segredos, id_antigo: novo ? null : s.id } }));
        this.editando = null; delete this.testes.__form;
        avisar({ texto: `${def.nome} salvo`, cor: "#4ade9f" });
        this.desenhar();
      } catch (e) { avisar({ texto: e.message, cor: "#ff6b7d", tempo: 7000 }); }
    };
    return el("article", { class: "aj-cartao aj-form" },
      el("div", { class: "aj-form-cab" }, el("b", { text: novo ? "Novo MCP" : `Editar ${s.nome}` })),
      el("div", { class: "aj-campos" },
        el("label", { class: "aj-campo" }, el("span", { text: "Nome curto" }), id),
        el("label", { class: "aj-campo" }, el("span", { text: "Nome para mostrar" }), nome)),
      segTipo, blocoHttp, blocoStdio,
      el("div", { class: "aj-campo largo" }, el("span", { text: "Para quais agentes" }), chipsAgentes),
      el("label", { class: "aj-opcao" }, chave(liberar, v => { liberar = v; }), el("span", {}, "Liberar sem perguntar ", el("small", { text: "(o agente usa as ferramentas deste MCP sem pedir aprovação)" }))),
      el("div", { class: "aj-teste-lugar" }),
      el("div", { class: "aj-acoes" },
        botao("Testar conexão", () => { const { def, segredos } = montar(); this.testar(null, novo ? def : { ...def, id: s.id }, segredos); }),
        el("span", { class: "empurra" }),
        botao("Cancelar", () => { this.editando = null; delete this.testes.__form; this.desenhar(); }),
        botao(el("span", { text: "Salvar" }), salvar, "btn-brilho pequeno")));
  }

  /** Linhas nome | valor | segredo. Valor guardado no cofre aparece como "no cofre" (vazio = mantém). */
  pares(obj, rotulo, exemplo) {
    const caixa = el("div", { class: "aj-pares" });
    const linhas = [];
    const nova = (nomeV = "", valor = "", segredo = false, noCofre = false) => {
      const n = el("input", { value: nomeV, placeholder: exemplo, spellcheck: "false" });
      const v = el("input", { value: noCofre ? "" : valor, placeholder: noCofre ? "•••••• guardado no cofre (deixe vazio para manter)" : "valor ou ${VARIAVEL}", spellcheck: "false", type: segredo ? "password" : "text" });
      const cadeado = el("button", { type: "button", class: `aj-cadeado${segredo ? " ativo" : ""}`, title: "Segredo: vai para o cofre do Windows", text: "🔒" });
      const linha = { n, v, get segredo() { return cadeado.classList.contains("ativo"); } };
      cadeado.onclick = () => { cadeado.classList.toggle("ativo"); v.type = linha.segredo ? "password" : "text"; };
      const tirar = el("button", { type: "button", class: "aj-tirar", title: "Tirar", text: "×" });
      const e = el("div", { class: "aj-par" }, n, v, cadeado, tirar);
      tirar.onclick = () => { e.remove(); linhas.splice(linhas.indexOf(linha), 1); };
      linhas.push(linha);
      caixa.insertBefore(e, mais);
    };
    const mais = botao(`+ ${rotulo}`, () => nova(), "aj-mais");
    caixa.append(mais);
    for (const [k, v] of Object.entries(obj)) nova(k, typeof v === "string" ? v : "", !!(v && v.cofre), !!(v && v.cofre));
    return { el: caixa, ler: () => linhas.map(l => ({ nome: l.n.value.trim(), valor: l.v.value, segredo: l.segredo })).filter(l => l.nome) };
  }

  blocoEncontrados() {
    const corpo = this.encontrados === null
      ? [el("div", { class: "aj-carregando" }, el("span", { class: "giro" }), "Procurando nos seus CLIs…")]
      : this.encontrados.length
        ? this.encontrados.map(s => el("div", { class: "aj-achado" },
          el("span", { class: `aj-orbe pequeno ${s.tipo}`, text: s.tipo === "http" ? "⇄" : "▸" }),
          el("div", { class: "aj-nome" }, el("b", { text: s.id }), el("small", { text: `${s.tipo === "http" ? s.url : s.comando} · ${s.origem}` })),
          s.importado ? el("span", { class: "tag", text: "já no Engram" })
            : botao("Trazer", async () => {
              try { this.aplicar(await api(`/api/mcps/${encodeURIComponent(s.id)}/importar`, { method: "POST" })); s.importado = true; avisar({ texto: `${s.id} trazido para o Engram`, cor: "#4ade9f" }); this.desenhar(); } catch (e) { avisar({ texto: e.message, cor: "#ff6b7d" }); }
            })))
        : [el("div", { class: "aj-vazio pequeno", text: "Nenhum MCP configurado direto no Claude Code ou no Codex." })];
    return el("section", { class: "aj-secao" },
      el("div", { class: "aj-secao-cab" }, el("b", { text: "Nos seus CLIs" }), el("small", { text: "MCPs já configurados no Claude Code e no Codex. Trazer copia para o Engram (tokens vão para o cofre)." }),
        botao("↻", () => { this.encontrados = null; this.desenhar(); this.buscarEncontrados(); }, "btn-icone")),
      ...corpo);
  }
}

// ================================================================== Skills

class PainelSkills {
  constructor(raiz) {
    this.raiz = raiz;
    this.dados = { skills: [], encontradas: [] };
    this.editor = null; // { nome, texto }
    this.criando = false;
  }

  async carregar() {
    try { this.dados = await api("/api/skills"); } catch (e) { avisar({ texto: e.message, cor: "#ff6b7d" }); }
    this.desenhar();
  }

  aplicar(d) { this.dados = { ...this.dados, ...d }; this.desenhar(); }

  desenhar() {
    if (this.editor) return this.raiz.replaceChildren(this.desenharEditor());
    const topo = el("div", { class: "aj-barra" },
      botao(el("span", { text: "+ Nova skill" }), () => { this.criando = !this.criando; this.desenhar(); }, "btn-brilho pequeno"),
      botao("Importar arquivo…", () => this.importar(false)),
      botao("Importar pasta…", () => this.importar(true)),
      el("small", { class: "aj-nota", text: "No Claude Code entram como engram:<nome>. No Codex ficam instaladas na pasta de skills dele." }));
    const itens = [];
    if (this.criando) itens.push(this.formNova());
    this.dados.skills.forEach((s, i) => itens.push(this.cartao(s, i)));
    if (!this.dados.skills.length && !this.criando) {
      itens.push(el("div", { class: "aj-vazio" }, el("b", { text: "Nenhuma skill ainda." }),
        el("span", { text: "Crie uma, importe um .zip/.skill ou traga as que você já tem no Claude Code e no Codex." })));
    }
    this.raiz.replaceChildren(topo, el("div", { class: "aj-lista" }, ...itens), this.blocoEncontradas());
  }

  cartao(s, i) {
    const agentes = new Set(s.agentes);
    const ajustar = async corpo => { try { this.aplicar(await api(`/api/skills/${s.nome}/ajustar`, { json: corpo })); } catch (e) { avisar({ texto: e.message, cor: "#ff6b7d" }); } };
    return el("article", { class: `aj-cartao skill${s.ativo ? "" : " desligado"}`, style: { "--i": i } },
      el("div", { class: "aj-topo" },
        el("span", { class: "aj-orbe skill", text: "✦" }),
        el("div", { class: "aj-nome" }, el("b", { text: s.nome }), el("small", { text: `${s.arquivos} arquivo${s.arquivos === 1 ? "" : "s"}` })),
        s.erro ? el("span", { class: "tag erro", text: "com erro", title: s.erro }) : null,
        chave(s.ativo, v => ajustar({ ativo: v }), s.ativo ? "Ligada" : "Desligada")),
      el("p", { class: "aj-desc", text: s.descricao || "(sem descrição)" }),
      s.erro ? el("div", { class: "aj-teste erro", text: s.erro }) : null,
      el("div", { class: "aj-chips" }, ...["claude", "codex"].map(a => el("button", {
        type: "button", class: `aj-chip${agentes.has(a) ? " ativo" : ""}`, style: { "--c": COR_AGENTE[a] },
        onclick: () => { agentes.has(a) ? agentes.delete(a) : agentes.add(a); ajustar({ agentes: [...agentes] }); },
      }, NOMES_AGENTE[a]))),
      el("div", { class: "aj-acoes" },
        botao("Editar", () => this.abrirEditor(s.nome)),
        botao("Pasta", () => api(`/api/skills/${s.nome}/abrir-pasta`, { method: "POST" })),
        confirmar("Remover", async () => { try { this.aplicar(await api(`/api/skills/${s.nome}/remover`, { method: "POST" })); } catch (e) { avisar({ texto: e.message, cor: "#ff6b7d" }); } })));
  }

  formNova() {
    const nome = el("input", { placeholder: "ex.: relatorio-de-chamado", maxlength: 64, spellcheck: "false" });
    const desc = el("textarea", { rows: 2, placeholder: "O que ela faz e quando o agente deve usar. Ex.: Monta o relatório de um chamado. Use quando pedirem resumo de chamado." });
    const criar = async () => {
      try {
        const s = await api("/api/skills", { json: { nome: nome.value, descricao: desc.value } });
        this.criando = false;
        await this.carregar();
        this.abrirEditor(s.nome);
      } catch (e) { avisar({ texto: e.message, cor: "#ff6b7d" }); }
    };
    setTimeout(() => nome.focus(), 30);
    return el("article", { class: "aj-cartao aj-form" },
      el("div", { class: "aj-campos" },
        el("label", { class: "aj-campo largo" }, el("span", { text: "Nome (minúsculo, com hífen)" }), nome),
        el("label", { class: "aj-campo largo" }, el("span", { text: "Descrição" }), desc)),
      el("div", { class: "aj-acoes" }, el("span", { class: "empurra" }),
        botao("Cancelar", () => { this.criando = false; this.desenhar(); }),
        botao(el("span", { text: "Criar e editar" }), criar, "btn-brilho pequeno")));
  }

  async importar(pasta) {
    const r = await api("/api/skills/escolher", { json: { pasta } });
    if (!r.caminho) return;
    await this.importarDe(r.caminho);
  }

  async importarDe(caminho) {
    try {
      const s = await api("/api/skills/importar", { json: { origem: caminho } });
      avisar({ texto: `Skill ${s.nome} importada`, cor: "#4ade9f" });
      await this.carregar();
    } catch (e) { avisar({ texto: e.message, cor: "#ff6b7d", tempo: 7000 }); }
  }

  blocoEncontradas() {
    const lista = this.dados.encontradas || [];
    return el("section", { class: "aj-secao" },
      el("div", { class: "aj-secao-cab" }, el("b", { text: "Nos seus CLIs" }), el("small", { text: "Skills que já estão no Claude Code (~/.claude/skills) e no Codex. Trazer copia para a biblioteca do Engram." })),
      ...(lista.length ? lista.map(s => el("div", { class: "aj-achado" },
        el("span", { class: "aj-orbe pequeno skill", text: "✦" }),
        el("div", { class: "aj-nome" }, el("b", { text: s.nome }), el("small", { text: `${s.origem} · ${s.descricao}` })),
        s.importada ? el("span", { class: "tag", text: "já no Engram" }) : botao("Trazer", () => this.importarDe(s.caminho))))
        : [el("div", { class: "aj-vazio pequeno", text: "Nenhuma skill solta no Claude Code ou no Codex." })]));
  }

  // ---------------------------------------------------------------- editor com prévia

  async abrirEditor(nome) {
    try { this.editor = await api(`/api/skills/${nome}`); } catch (e) { avisar({ texto: e.message, cor: "#ff6b7d" }); return; }
    this.desenhar();
  }

  desenharEditor() {
    const ed = this.editor;
    const area = el("textarea", { class: "aj-editor-texto", spellcheck: "false" });
    area.value = ed.texto;
    const previa = el("div", { class: "aj-previa conv-md" });
    const aviso = el("div", { class: "aj-aviso" });
    const atualizar = () => {
      const t = area.value;
      const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(t);
      const cab = m ? m[1] : "";
      const nomeOk = new RegExp(`^name:\\s*["']?${ed.nome}["']?\\s*$`, "m").test(cab);
      const descOk = /^description:\s*\S/m.test(cab);
      const problemas = [!m && "falta o cabeçalho entre --- no início", m && !nomeOk && `o name tem de ser ${ed.nome}`, m && !descOk && "falta a description"].filter(Boolean);
      aviso.className = `aj-aviso ${problemas.length ? "ruim" : "bom"}`;
      aviso.textContent = problemas.length ? problemas.join(" · ") : "Cabeçalho certo: name e description.";
      const desc = (/^description:\s*(.+)$/m.exec(cab) || [])[1] || "";
      previa.replaceChildren(
        el("div", { class: "aj-previa-cab" }, el("b", { text: `✦ ${ed.nome}` }), el("small", { text: desc.replace(/^["']|["']$/g, "") })));
      previa.insertAdjacentHTML("beforeend", md().render(m ? t.slice(m[0].length) : t));
    };
    let espera;
    area.addEventListener("input", () => { clearTimeout(espera); espera = setTimeout(atualizar, 120); });
    area.addEventListener("keydown", e => {
      if (e.key === "Tab") { e.preventDefault(); area.setRangeText("  ", area.selectionStart, area.selectionEnd, "end"); }
      if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); salvar(); }
    });
    const salvar = async () => {
      try {
        this.editor = { ...(await api(`/api/skills/${ed.nome}/salvar`, { json: { texto: area.value } })) };
        avisar({ texto: `${ed.nome} salva`, cor: "#4ade9f" });
        const d = await api("/api/skills"); this.dados = d;
      } catch (e) { avisar({ texto: e.message, cor: "#ff6b7d", tempo: 7000 }); }
    };
    atualizar();
    setTimeout(() => area.focus(), 30);
    return el("div", { class: "aj-editor" },
      el("div", { class: "aj-editor-cab" },
        botao("← Skills", () => { this.editor = null; this.carregar(); }),
        el("b", { text: `${ed.nome}/SKILL.md` }), aviso, el("span", { class: "empurra" }),
        el("small", { class: "aj-nota", text: "Ctrl+S salva" }),
        botao(el("span", { text: "Salvar" }), salvar, "btn-brilho pequeno")),
      el("div", { class: "aj-editor-corpo" }, area, previa));
  }
}
