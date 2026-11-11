// Contas e agentes: cada CLI de agente (Claude Code, Codex, Gemini CLI, OpenCode) com o seu login.
// Entrar e instalar abrem um terminal de verdade aqui dentro; chaves de API vão para o cofre do Windows.

import { $, el, api, avisar } from "./util.js";

export const COR_AGENTE = { claude: "#ff9f6b", codex: "#7ee0c3", gemini: "#6aa8ff", opencode: "#c9a7ff" };
const LETRA = { claude: "C", codex: "X", gemini: "G", opencode: "O" };
// o ícone de cada agente (o mesmo do site); agente sem ícone fica com a letra
const LOGO = { claude: "marca/claude.png", codex: "marca/codex.png", gemini: "marca/gemini.png", opencode: "marca/opencode.svg" };

/** O ícone do agente: o logo dele, com o brilho na cor do agente; sem logo, a letra no orbe. */
export function iconeAgente(id, classe = "conta-orbe") {
  if (!LOGO[id]) return el("span", { class: classe, text: LETRA[id] || "?" });
  return el("span", { class: `${classe} logo` }, el("img", { src: LOGO[id], alt: "", draggable: "false" }));
}

export class Contas {
  constructor({ aoMudar } = {}) {
    this.dlg = $("#dlg-contas");
    this.lista = $("#contas-lista");
    this.painel = $("#contas-terminal");
    this.aoMudar = aoMudar;
    this.dados = [];
    this.chaveAberta = null; // provedor com o campo de chave aberto
    this.terminal = null;
    $("#contas-atualizar").onclick = () => this.carregar(true);
    $("#contas-term-fechar").onclick = () => this.fecharTerminal(true);
    this.dlg.addEventListener("close", () => this.fecharTerminal(true));
  }

  async abrir() {
    if (!this.dlg.open) this.dlg.showModal();
    this.desenhar();
    await this.carregar(false);
  }

  async carregar(forcar) {
    this.lista.classList.add("carregando");
    try {
      this.dados = await api(`/api/contas${forcar ? "?atualizar=1" : ""}`);
      this.desenhar();
      this.aoMudar?.(this.dados);
      const dica = $("#contas-term-dica");
      if (dica.textContent.startsWith("Terminou. Conferindo")) dica.textContent = "Terminou. Login conferido.";
    } catch (e) {
      avisar({ texto: `Não deu para conferir as contas: ${e.message}`, cor: "#ff6b7d" });
    } finally {
      this.lista.classList.remove("carregando");
    }
  }

  /** Aviso ao vivo: um login terminou ou mudou. */
  mudou() { if (this.dlg.open) this.carregar(true); else this.carregar(false); }

  desenhar() {
    if (!this.dados.length) {
      this.lista.replaceChildren(...["claude", "codex", "gemini", "opencode"].map(id =>
        el("article", { class: "conta fantasma", style: { "--cor": COR_AGENTE[id] } }, iconeAgente(id))));
      return;
    }
    this.lista.replaceChildren(...this.dados.map((p, i) => this.cartao(p, i)));
  }

  cartao(p, i) {
    const cor = COR_AGENTE[p.id] || "#a5b4fc";
    const estado = !p.instalado ? "fora" : p.conectado ? "ok" : p.conectado === null ? "duvida" : "sem";
    const textoEstado = {
      fora: "Não instalado neste computador",
      ok: `Conectado · ${[p.como, p.plano].filter(Boolean).join(" · ")}`,
      duvida: p.erro || "Não deu para conferir o login",
      sem: "Instalado, mas sem login",
    }[estado];
    const botoes = [];
    const botao = (texto, fn, classe = "btn") => el("button", { type: "button", class: classe, text: texto, onclick: fn });
    if (!p.instalado) {
      botoes.push(botao("Instalar", () => this.terminalDe(p, "instalar"), "btn-brilho pequeno"));
    } else {
      if (p.pode_entrar && !p.conectado) botoes.push(botao(p.id === "gemini" ? "Abrir para entrar" : "Entrar", () => this.terminalDe(p, "entrar"), "btn-brilho pequeno"));
      if (p.pode_sair && p.conectado && p.modo === "conta") botoes.push(botao("Sair", () => this.terminalDe(p, "sair")));
      if (p.chave) {
        if (p.tem_chave) {
          if (p.modo === "chave") botoes.push(botao("Usar a conta", () => this.modo(p, "conta")));
          else botoes.push(botao("Usar a chave", () => this.modo(p, "chave")));
          botoes.push(botao("Remover chave", () => this.removerChave(p)));
        } else {
          botoes.push(botao("Usar chave de API", () => { this.chaveAberta = this.chaveAberta === p.id ? null : p.id; this.desenhar(); }));
        }
      }
    }
    const tags = [
      p.versao ? el("span", { class: "tag", text: `v${p.versao}` }) : null,
      p.experimental ? el("span", { class: "tag experimental", text: "experimental", title: "Funciona, mas ainda não foi testado de ponta a ponta no Engram" }) : null,
    ];
    const campoChave = this.chaveAberta === p.id && p.chave ? this.formChave(p) : null;
    const instalar = !p.instalado ? el("code", { class: "conta-cmd", text: p.instalar, title: "O comando oficial que o botão Instalar roda" }) : null;
    return el("article", { class: `conta estado-${estado}`, style: { "--cor": cor, "--i": i } },
      el("div", { class: "conta-topo" },
        iconeAgente(p.id),
        el("div", { class: "conta-nome" }, el("b", { text: p.nome }), el("small", { text: p.empresa })),
        el("div", { class: "conta-tags" }, ...tags)),
      el("div", { class: "conta-estado" }, el("span", { class: "ponto" }), el("span", { text: textoEstado })),
      p.conta ? el("div", { class: "conta-detalhe", text: p.conta }) : null,
      instalar,
      campoChave,
      el("div", { class: "conta-acoes" }, ...botoes,
        el("a", { class: "conta-site", href: p.site, target: "_blank", rel: "noopener", text: "site ↗" })));
  }

  formChave(p) {
    const campo = el("input", { type: "password", placeholder: p.chave.exemplo, autocomplete: "off", spellcheck: "false" });
    const salvar = async () => {
      try {
        await api(`/api/contas/${p.id}/chave`, { json: { chave: campo.value } });
        campo.value = "";
        this.chaveAberta = null;
        avisar({ texto: `Chave do ${p.nome} guardada no cofre do Windows`, cor: "#4ade9f" });
        await this.carregar(true);
      } catch (e) { avisar({ texto: e.message, cor: "#ff6b7d" }); }
    };
    campo.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); salvar(); } });
    setTimeout(() => campo.focus(), 50);
    return el("div", { class: "conta-chave" },
      el("label", { text: p.chave.rotulo }),
      el("div", { class: "linha" }, campo, el("button", { type: "button", class: "btn-brilho pequeno", onclick: salvar }, el("span", { text: "Guardar" }))),
      el("small", {}, "Fica no Gerenciador de Credenciais do Windows e só entra nas janelas deste agente. ",
        el("a", { href: p.chave.site, target: "_blank", rel: "noopener", text: "Pegar uma chave ↗" })));
  }

  async modo(p, modo) {
    try { await api(`/api/contas/${p.id}/modo`, { json: { modo } }); await this.carregar(true); } catch (e) { avisar({ texto: e.message, cor: "#ff6b7d" }); }
  }

  async removerChave(p) {
    try {
      await api(`/api/contas/${p.id}/chave/remover`, { method: "POST" });
      avisar({ texto: `Chave do ${p.nome} apagada do cofre`, cor: "#ffc857" });
      await this.carregar(true);
    } catch (e) { avisar({ texto: e.message, cor: "#ff6b7d" }); }
  }

  // ---------------------------------------------------------------- terminal de login e instalação

  async terminalDe(p, acao) {
    let r;
    try { r = await api(`/api/contas/${p.id}/terminal`, { json: { acao } }); } catch (e) { avisar({ texto: e.message, cor: "#ff6b7d" }); return; }
    this.fecharTerminal(true);
    const titulo = { entrar: `Entrar no ${p.nome}`, sair: `Sair do ${p.nome}`, instalar: `Instalar o ${p.nome}` }[acao];
    $("#contas-term-titulo").textContent = titulo;
    $("#contas-term-dica").textContent = acao === "instalar"
      ? "Rodando o instalador oficial. Quando terminar, o Engram confere de novo."
      : acao === "entrar" ? "Siga o que o terminal pedir (o navegador pode abrir para você confirmar). Quando terminar, o Engram confere o login." : "";
    this.painel.hidden = false;
    this.painel.style.setProperty("--cor", COR_AGENTE[p.id] || "#a5b4fc");
    const alvo = $("#contas-term");
    alvo.replaceChildren();
    const term = new Terminal({
      fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, monospace', fontSize: 13, lineHeight: 1.12, cursorBlink: true, scrollback: 4000,
      theme: { background: "#070a10", foreground: "#dfe6f3", cursor: COR_AGENTE[p.id] || "#a5b4fc", selectionBackground: "rgba(139,123,255,.35)" },
    });
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(alvo);
    const canal = window.engram.terminal.abrir(r.terminal, {
      aoInicio: () => { term.reset(); requestAnimationFrame(ajustar); },
      aoDados: d => term.write(d),
      aoFim: () => { $("#contas-term-dica").textContent = "Terminou. Conferindo o login…"; },
    });
    const ajustar = () => { try { fit.fit(); canal.tamanho(term.cols, term.rows); } catch { /* ainda sem tamanho */ } };
    term.onData(d => canal.enviar(d));
    this.terminal = { id: r.terminal, term, canal };
    requestAnimationFrame(() => { ajustar(); term.focus(); this.painel.scrollIntoView({ behavior: "smooth", block: "nearest" }); });
  }

  fecharTerminal(encerrar) {
    if (!this.terminal) { this.painel.hidden = true; return; }
    const { id, term, canal } = this.terminal;
    this.terminal = null;
    try { canal.fechar(); } catch { /* já fechou */ }
    if (encerrar) api(`/api/terminais/${encodeURIComponent(id)}/fechar`, { method: "POST" }).catch(() => {});
    term.dispose();
    this.painel.hidden = true;
  }
}
