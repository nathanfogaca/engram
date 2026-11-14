// Ajustes: abas Geral (pasta de trabalho, cérebro, limites, contexto, atualização) e Aparência (temas).

import { $, el, api, app, avisar } from "./util.js";

// Paleta de cada tema, só para desenhar a miniatura (o tema de verdade está no app.css)
export const PALETAS = {
  aurora: { bg: "#04060a", sup: "#0c1018", a1: "#8b7bff", a2: "#38d6f5", a3: "#e879f9", tx: "#e7ecf6", resumo: "O de sempre: violeta e ciano no escuro" },
  oceano: { bg: "#020a10", sup: "#08141e", a1: "#38bdf8", a2: "#2dd4bf", a3: "#818cf8", tx: "#e7ecf6", resumo: "Azul profundo, com brilho de água" },
  brasa: { bg: "#0b0605", sup: "#180f0d", a1: "#fb923c", a2: "#f43f5e", a3: "#facc15", tx: "#f6ebe6", resumo: "Escuro quente, cor de fogo" },
  grafite: { bg: "#0c0d0f", sup: "#17181b", a1: "#a5b4fc", a2: "#94a3b8", a3: "#cbd5e1", tx: "#e5e7eb", resumo: "Sóbrio, quase sem cor" },
  claro: { bg: "#eef1f7", sup: "#ffffff", a1: "#6d5dfc", a2: "#0891b2", a3: "#c026d3", tx: "#0f172a", resumo: "Fundo claro para o dia (terminais seguem escuros)" },
  "alto-contraste": { bg: "#000000", sup: "#000000", a1: "#ffd600", a2: "#00e5ff", a3: "#ff6eff", tx: "#ffffff", resumo: "Preto e branco, bordas fortes, sem transparência" },
};

/** Troca o tema na hora (com transição suave) e guarda para a próxima abertura. */
export function aplicarTema(tema, { salvar = false } = {}) {
  const raiz = document.documentElement;
  raiz.classList.add("trocando-tema");
  raiz.dataset.tema = tema;
  setTimeout(() => raiz.classList.remove("trocando-tema"), 600);
  try { localStorage.setItem("engram.tema", tema); } catch { /* sem armazenamento */ }
  app.tema = tema;
  if (salvar) return api("/api/tema", { json: { tema } }).catch(e => avisar({ texto: e.message, cor: "#ff6b7d" }));
  return null;
}

export function miniatura(id) {
  const p = PALETAS[id] || PALETAS.aurora;
  return el("div", { class: "tema-mini", style: { "--bg": p.bg, "--sup": p.sup, "--a1": p.a1, "--a2": p.a2, "--a3": p.a3, "--tx": p.tx } },
    el("i", { class: "m-barra" }), el("i", { class: "m-cartao um" }), el("i", { class: "m-cartao dois" }), el("i", { class: "m-fio" }), el("i", { class: "m-brilho" }));
}

export class PainelAparencia {
  constructor(raiz) { this.raiz = raiz; }

  carregar() {
    const temas = app.temas || Object.keys(PALETAS).map(id => ({ id, nome: id }));
    this.raiz.replaceChildren(
      el("div", { class: "temas" }, ...temas.map((t, i) => el("button", {
        type: "button", class: `tema-cartao${app.tema === t.id ? " ativo" : ""}`, style: { "--i": i, "--a1": PALETAS[t.id]?.a1 || "#8b7bff" },
        onclick: async () => { aplicarTema(t.id, { salvar: true }); this.carregar(); },
      }, miniatura(t.id), el("b", { text: t.nome }), el("small", { text: PALETAS[t.id]?.resumo || "" })))),
      el("p", { class: "aj-nota", text: "O tema muda na hora e fica salvo. Os terminais dos agentes continuam escuros em todos os temas, porque os CLIs foram feitos para isso." }));
  }
}

export class PainelGeral {
  constructor(raiz, { aoReiniciar }) { this.raiz = raiz; this.aoReiniciar = aoReiniciar; this.atual = null; }

  /** Versão, situação da atualização e o botão de procurar agora. */
  blocoAtualizacao() {
    this.caixaAtualizacao = el("div", { class: "aj-atualizacao" });
    api("/api/atualizacao").then(a => this.mostrarAtualizacao(a)).catch(() => {});
    return this.caixaAtualizacao;
  }

  mostrarAtualizacao(a) {
    this.atual = a;
    const caixa = this.caixaAtualizacao;
    if (!caixa || !caixa.isConnected) return;
    const hora = iso => iso ? new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : "";
    const textos = {
      parado: ["◌", "Ainda não conferiu desde que abriu."],
      verificando: ["giro", "Procurando versão nova no GitHub…"],
      "em dia": ["✓", `Você está na versão mais nova${a.conferido_em ? ` (conferido às ${hora(a.conferido_em)})` : ""}.`],
      baixando: ["giro", `Baixando a ${a.versao_nova}… ${a.progresso || 0}%`],
      pronta: ["★", `A ${a.versao_nova} está baixada e conferida. Os agentes continuam rodando durante a instalação.`],
      instalando: ["giro", `Instalando a ${a.versao_nova}…`],
      erro: ["✕", `Não deu para conferir: ${a.erro || "erro desconhecido"}.`],
    };
    const [icone, texto] = !a.ativo ? ["◌", "Em modo de desenvolvimento a atualização automática fica desligada; ela funciona no app instalado."] : textos[a.estado] || textos.parado;
    const ocupado = ["verificando", "baixando", "instalando"].includes(a.estado);
    const procurar = el("button", { type: "button", class: "btn pequeno", disabled: !a.ativo || ocupado, onclick: async () => {
      procurar.disabled = true;
      try { this.mostrarAtualizacao(await api("/api/atualizacao/verificar", { method: "POST" })); } catch (e) { avisar({ texto: e.message, cor: "#ff6b7d" }); }
    } }, "Procurar atualização agora");
    const instalar = a.estado === "pronta" ? el("button", { type: "button", class: "btn-brilho pequeno", onclick: async () => {
      try { await api("/api/atualizacao/instalar", { method: "POST" }); } catch (e) { avisar({ texto: e.message, cor: "#ff6b7d" }); }
    } }, el("span", { text: `Instalar a ${a.versao_nova} agora` })) : null;
    caixa.className = `aj-atualizacao estado-${a.ativo ? String(a.estado).replace(" ", "-") : "dev"}`;
    caixa.replaceChildren(...[
      el("div", { class: "aj-versao" }, el("b", { text: `Engram ${a.versao_atual}` }),
        el("span", { class: "aj-situacao" }, icone === "giro" ? el("span", { class: "giro" }) : el("i", { text: icone }), texto)),
      a.estado === "baixando" ? el("div", { class: "aj-barra-progresso" }, el("i", { style: { width: `${a.progresso || 0}%` } })) : null,
      el("div", { class: "aj-acoes" }, procurar, instalar),
    ].filter(Boolean)); // replaceChildren escreveria "null" no lugar do que não existe
  }

  async carregar() {
    try { this.c = await api("/api/config"); } catch (e) { avisar({ texto: e.message, cor: "#ff6b7d" }); return; }
    this.desenhar();
  }

  desenhar() {
    const c = this.c;
    const campo = (rotulo, entrada, dica) => el("label", { class: "aj-campo" }, el("span", { text: rotulo }), entrada, dica ? el("small", { class: "aj-dica", text: dica }) : null);
    const pasta = el("input", { value: c.pasta_trabalho || "", spellcheck: "false" });
    const escolher = (alvo, titulo) => el("button", { type: "button", class: "btn pequeno", onclick: async () => { const r = await api("/api/escolher-pasta", { json: { titulo } }); if (r.caminho) alvo.value = r.caminho; } }, "Escolher…");
    const ativa = c.cerebro_fonte_ativa === "remoto" ? "remoto" : "pasta";
    const servidor = c.cerebro_servidor || {};
    const cerPasta = el("input", { value: c.cerebro.pasta || "", spellcheck: "false" });
    const cerUrl = el("input", { value: c.cerebro.url || "", placeholder: "https://servidor:8765/mcp", spellcheck: "false" });
    const cerToken = el("input", { value: c.cerebro.token_env || "", placeholder: "ex.: CEREBRO_TOKEN", spellcheck: "false" });
    const cerCa = el("input", { value: c.cerebro.ca || "", placeholder: "caminho do certificado (opcional)", spellcheck: "false" });
    const cerRemota = el("input", { value: c.cerebro.pasta_remota || "cerebro", spellcheck: "false" });
    const cerServidor = el("input", { value: c.cerebro.servidor || "", placeholder: "o nome dele em MCPs (ex.: cerebro)", spellcheck: "false" });
    // as duas fontes ficam guardadas e sempre à mostra; "Em uso agora" troca na hora (o mesmo seletor do topo)
    const titulo = texto => el("small", { class: "aj-dica aj-subtitulo", text: texto, style: { display: "block", margin: "12px 0 6px", fontWeight: "600", color: "var(--texto-forte)" } });
    const blocoPasta = el("div", { class: "aj-campos" }, el("div", { class: "aj-campo largo" }, el("span", { text: "Pasta das notas" }), el("div", { class: "linha" }, cerPasta, escolher(cerPasta, "Pasta do cérebro"))));
    const blocoRemoto = el("div", { class: "aj-campos" },
      campo("Endereço do MCP", cerUrl), campo("Variável com o token", cerToken, "O token fica na variável de ambiente, não no Engram."),
      campo("Certificado (CA)", cerCa), campo("Pasta no servidor", cerRemota),
      campo("Nome do MCP nos agentes", cerServidor, "Cadastre o mesmo servidor em MCPs para os agentes lerem e gravarem as notas. Com ele cadastrado, o Engram usa o nome de lá sozinho."));
    const seg = el("div", { class: "aj-seg" });
    const desenharFonte = (trocandoPara = null) => {
      seg.replaceChildren(...[["pasta", "Local: pasta neste computador"], ["remoto", servidor.configurado ? `Servidor: ${servidor.nome || "remoto"}` : "Servidor (não configurado)"]].map(([f, r]) =>
        el("button", {
          type: "button", class: `${ativa === f ? "ativo" : ""}${trocandoPara === f ? " trocando" : ""}`,
          disabled: !!trocandoPara || (f === "remoto" && !servidor.configurado),
          title: f === "remoto" && !servidor.configurado ? "Preencha o endereço do servidor abaixo e salve" : ativa === f ? "Em uso agora" : "Trocar agora (sem reiniciar)",
          onclick: async () => {
            if (f === ativa) return;
            desenharFonte(f);
            try {
              await api("/api/cerebro/fonte", { json: { fonte: f } });
              avisar({ texto: f === "remoto" ? "Cérebro no servidor" : "Cérebro na pasta deste computador", cor: "#4ade9f" });
            } catch (e) { avisar({ texto: e.message, cor: "#ff6b7d", tempo: 9000 }); }
            await this.carregar();
          },
        }, trocandoPara === f ? "Trocando…" : r)));
    };
    desenharFonte();
    const num = (v, a, z) => el("input", { type: "number", min: a, max: z, value: v ?? "" });
    const maxJ = num(c.max_janelas, 1, 64), maxM = num(c.max_mensagens_par_10min, 5, 300), maxA = num(c.max_arquivo_mb, 1, 2000);
    const contexto = el("textarea", { rows: 6, placeholder: "Texto que entra no prompt de todas as janelas: o mapa dos sistemas da empresa, regras da casa, quem cuida do quê…" });
    contexto.value = c.contexto || "";
    let atualizar = c.atualizar_sozinho, pensamento = c.pensamento_no_palco !== false, diario = c.diario_no_cerebro !== false;
    const salvar = async () => {
      // o valor da variável do token vai para o servidor: endereço ou variável novos pedem confirmação
      const url = cerUrl.value.trim(), token = cerToken.value.trim();
      if (url && token && (url !== (c.cerebro.url || "") || token !== (c.cerebro.token_env || ""))) {
        let host = url;
        try { host = new URL(url).host; } catch { /* o main recusa o endereço inválido */ }
        if (!confirm(`O Engram vai mandar o valor da variável ${token} para ${host} sempre que ler o cérebro no servidor. Confirma?`)) return;
      }
      const corpo = {
        pasta_trabalho: pasta.value, max_janelas: maxJ.value, max_mensagens_par_10min: maxM.value, max_arquivo_mb: maxA.value,
        contexto: contexto.value, atualizar_sozinho: atualizar, pensamento_no_palco: pensamento, diario_no_cerebro: diario,
        // as duas configurações vão juntas: salvar uma não apaga a outra
        cerebro: { pasta: cerPasta.value, url: cerUrl.value, token_env: cerToken.value, ca: cerCa.value, pasta_remota: cerRemota.value, servidor: cerServidor.value },
      };
      try {
        const r = await api("/api/config", { json: corpo });
        if (r.aviso) avisar({ texto: `Salvo, mas: ${r.aviso}`, cor: "#ffc857", tempo: 9000 });
        else avisar({ texto: "Ajustes salvos", cor: "#4ade9f" });
        await this.carregar();
      } catch (e) { avisar({ texto: e.message, cor: "#ff6b7d", tempo: 7000 }); }
    };
    this.raiz.replaceChildren(
      el("section", { class: "aj-grupo" }, el("h3", { text: "Onde os agentes trabalham" }),
        el("div", { class: "aj-campo" }, el("span", { text: "Pasta de trabalho" }), el("div", { class: "linha" }, pasta, escolher(pasta, "Pasta de trabalho dos agentes")),
          el("small", { class: "aj-dica", text: "É onde cada janela nova abre. Janelas já abertas continuam onde estão." }))),
      el("section", { class: "aj-grupo" }, el("h3", { text: "Cérebro" }),
        titulo("Em uso agora (troca na hora, sem reiniciar; o mesmo seletor fica no topo, ao lado da sincronização)"), seg,
        servidor.erro ? el("small", { class: "aj-dica aj-erro", text: `Última tentativa no servidor: ${servidor.erro}`, style: { display: "block", color: "#ff8a9a", marginTop: "6px" } }) : null,
        titulo("Pasta neste computador"), blocoPasta,
        titulo("Servidor (avançado)"), blocoRemoto,
        el("small", { class: "aj-dica", text: "As duas ficam guardadas: alternar não apaga a outra. O servidor é para quem já tem as notas num servidor próprio, com as ferramentas arquivos_listar e arquivos_ler. Mudou o endereço? Salve antes de alternar. Os agentes abertos recebem um aviso na próxima mensagem dizendo onde ler e gravar." })),
      el("section", { class: "aj-grupo" }, el("h3", { text: "Limites" }),
        el("div", { class: "aj-campos tres" }, campo("Janelas abertas ao mesmo tempo", maxJ, "Vale para você e para o maestro (criar_agente)."), campo("Mensagens entre dois agentes a cada 10 min", maxM, "Trava contra dois agentes respondendo um ao outro em loop."), campo("Tamanho máximo de arquivo (MB)", maxA))),
      el("section", { class: "aj-grupo" }, el("h3", { text: "Palco" }),
        el("label", { class: "aj-opcao" }, (() => { const i = el("input", { type: "checkbox", checked: pensamento, onchange: e => { pensamento = e.target.checked; } }); return el("span", { class: "chave" }, i, el("span")); })(),
          el("span", {}, "Mostrar o código sendo escrito em cima do cartão ", el("small", { text: "(a bolha some sozinha; clicar nela abre o Visualizar trabalho)" }))),
        el("label", { class: "aj-opcao" }, (() => { const i = el("input", { type: "checkbox", checked: diario, onchange: e => { diario = e.target.checked; } }); return el("span", { class: "chave" }, i, el("span")); })(),
          el("span", {}, "Anotar delegações e devolutivas no cérebro ", el("small", { text: "(uma linha por tarefa na nota do dia, sessoes/diario-AAAA-MM-DD; só o assunto e um resumo curto, sem dado pessoal)" })))),
      el("section", { class: "aj-grupo" }, el("h3", { text: "Contexto para todos os agentes" }), el("div", { class: "aj-campo" }, contexto)),
      el("section", { class: "aj-grupo" }, el("h3", { text: "Atualização" }), this.blocoAtualizacao(),
        el("label", { class: "aj-opcao" }, (() => { const i = el("input", { type: "checkbox", checked: atualizar, onchange: e => { atualizar = e.target.checked; } }); return el("span", { class: "chave" }, i, el("span")); })(),
          el("span", {}, "Instalar atualizações sozinho ", el("small", { text: "(quando a janela não está em uso)" })))),
      el("div", { class: "aj-acoes rodape-geral" },
        el("small", { class: "aj-nota", text: `Dados do Engram: ${c.dados}` }), el("span", { class: "empurra" }),
        el("button", { type: "button", class: "btn-brilho pequeno", onclick: salvar }, el("span", { text: "Salvar" }))));
  }
}
