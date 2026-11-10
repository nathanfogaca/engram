// Vista "Conversa": a conversa do agente em texto legível, lida do arquivo que o Claude Code grava
// (não gasta token), com a área de arquivos dele: o que a pessoa manda e o que o agente devolve.

import { $, el, api, corModelo, nomeModelo, nomePapel, OCUPADO, ATENCAO, avisar, hora } from "./util.js";
import { temPrevia } from "./previa.js";

let _md = null;
const md = () => (_md ||= window.markdownit({ html: false, linkify: true, breaks: false }));
const MARCA_ANEXOS = "[Arquivos que a pessoa anexou";

function ferramenta(nome) {
  if (nome === "ToolSearch") return { rotulo: "carregou ferramentas", grupo: "sistema" };
  if (nome.startsWith("mcp__engram__")) return { rotulo: nome.slice(13), grupo: "time" };
  if (nome.startsWith("mcp__")) {
    const [, servidor, f] = nome.split("__");
    return { rotulo: `${servidor} · ${f}`, grupo: "mcp" };
  }
  return { rotulo: nome, grupo: "local" };
}

function markdown(texto) {
  const caixa = el("div", { class: "conv-md" });
  caixa.innerHTML = md().render(texto || ""); // HTML desligado no markdown-it
  for (const a of caixa.querySelectorAll("a")) {
    a.target = "_blank";
    a.rel = "noopener noreferrer";
  }
  return caixa;
}

const tamanhoLegivel = n => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const ehImagem = nome => /\.(png|jpe?g|gif|webp|bmp)$/i.test(nome);
const icone = nome => (ehImagem(nome) ? "🖼" : /\.(log|txt|csv|sql|json|md)$/i.test(nome) ? "📄" : /\.pdf$/i.test(nome) ? "📕" : /\.(xlsx?|ods)$/i.test(nome) ? "📊" : "📎");

export class Conversa {
  constructor(id, { cor = "#a5b4fc", grande = false, aoTerminal = null, nome = "o agente" } = {}) {
    this.id = id;
    this.cor = cor;
    this.nome = nome;
    this.ate = 0;
    this.carregado = false;
    this.ocupado = false;
    this.pendente = false;
    this.ferramentas = new Map();
    this.enviando = [];
    this.anexos = [];
    this.aoTerminal = aoTerminal;

    // área de arquivos (no alto da conversa)
    this.contArq = el("span", { class: "conv-arq-n", text: "" });
    this.btnArq = el("button", { class: "conv-arq-botao", title: "Arquivos que você mandou e que ele devolveu" },
      el("span", { text: "📁 Arquivos" }), this.contArq);
    this.gradeArq = el("div", { class: "conv-arq-grade", hidden: true });
    this.barraArq = el("div", { class: "conv-arq" }, this.btnArq, this.gradeArq);
    this.btnArq.onclick = () => this.alternarArquivos();

    this.lista = el("div", { class: "conv-lista" });
    this.vazio = el("div", { class: "conv-vazio", text: "Ainda sem conversa. Escreva abaixo ou arraste arquivos para cá." });
    this.txtDigitando = el("span", { text: "pensando" });
    this.digitando = el("div", { class: "conv-digitando", hidden: true }, el("i"), el("i"), el("i"), this.txtDigitando);
    this.avisoTexto = el("span");
    this.avisoBotoes = el("div", { class: "conv-aviso-botoes" });
    this.avisoDetalhe = el("pre", { class: "conv-aviso-detalhe", hidden: true });
    this.avisoOpcoes = el("div", { class: "conv-aviso-opcoes", hidden: true });
    this.aviso = el("div", { class: "conv-aviso", hidden: true }, this.avisoTexto, this.avisoDetalhe, this.avisoOpcoes, this.avisoBotoes);
    this.perguntaAtual = null;
    this.rolo = el("div", { class: "conv-rolo" }, this.vazio, this.lista, this.digitando, this.aviso);

    this.chipsAnexo = el("div", { class: "conv-anexos", hidden: true });
    this.entrada = el("textarea", {
      class: "conv-entrada", rows: 1, spellcheck: "false",
      placeholder: "Escreva para este agente…   Enter envia · Shift+Enter quebra linha · arraste ou cole arquivos",
    });
    this.seletor = el("input", { type: "file", multiple: true, hidden: true });
    this.btnClipe = el("button", { class: "conv-clipe", title: "Anexar arquivos (ou arraste, ou cole um print com Ctrl+V)", text: "📎" });
    this.btnParar = el("button", { class: "conv-parar", title: "Parar o que ele está fazendo", hidden: true }, el("i"));
    this.btnEnviar = el("button", { class: "conv-enviar", title: "Enviar (Enter)" }, el("i"));
    this.soltar = el("div", { class: "conv-soltar", hidden: true }, el("div", {}, el("b", { text: "Solte para mandar" }), el("span", { text: `vai para a pasta de ${nome}` })));
    this.el = el("div", { class: `conversa${grande ? " grande" : ""}`, style: { "--cor": cor } },
      this.barraArq, this.rolo,
      el("div", { class: "conv-baixo" }, this.chipsAnexo,
        el("div", { class: "conv-compositor" }, this.btnClipe, this.entrada, this.btnParar, this.btnEnviar, this.seletor)),
      this.soltar);

    this.entrada.addEventListener("keydown", e => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); this.enviar(); }
    });
    this.entrada.addEventListener("input", () => this.ajustarAltura());
    this.entrada.addEventListener("paste", e => {
      const arquivos = [...(e.clipboardData?.files || [])];
      if (arquivos.length) { e.preventDefault(); this.mandarArquivos(arquivos, true); }
    });
    this.btnEnviar.onclick = () => this.enviar();
    this.btnClipe.onclick = () => this.seletor.click();
    this.seletor.onchange = () => { this.mandarArquivos([...this.seletor.files]); this.seletor.value = ""; };
    this.btnParar.onclick = () => api(`/api/sessoes/${this.id}/interromper`, { method: "POST" }).catch(() => {});
    this.rolo.addEventListener("wheel", e => e.stopPropagation(), { passive: true });
    this.instalarSoltar(this.el);
    this.atualizarArquivos();
  }

  // ---------------------------------------------------------------- arrastar e soltar

  instalarSoltar(alvo) {
    let profundidade = 0;
    const temArquivo = e => [...(e.dataTransfer?.types || [])].includes("Files");
    alvo.addEventListener("dragenter", e => { if (temArquivo(e)) { profundidade++; this.soltar.hidden = false; } });
    alvo.addEventListener("dragleave", () => { if (--profundidade <= 0) { profundidade = 0; this.soltar.hidden = true; } });
    alvo.addEventListener("dragover", e => { if (temArquivo(e)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } });
    alvo.addEventListener("drop", e => {
      if (!temArquivo(e)) return;
      e.preventDefault();
      e.stopPropagation();
      profundidade = 0;
      this.soltar.hidden = true;
      this.mandarArquivos([...e.dataTransfer.files]);
    });
  }

  async mandarArquivos(lista, colado = false) {
    for (let arquivo of lista) {
      if (colado && /^image\//.test(arquivo.type) && (!arquivo.name || arquivo.name === "image.png")) {
        const agora = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
        arquivo = new File([arquivo], `print-${agora}.png`, { type: arquivo.type });
      }
      const chip = el("span", { class: "conv-anexo enviando", title: arquivo.name },
        el("span", { text: icone(arquivo.name) }), el("b", { text: arquivo.name }),
        el("small", { text: tamanhoLegivel(arquivo.size) }));
      const item = { nome: arquivo.name, caminho: null, chip };
      chip.append(el("button", { text: "×", title: "Tirar desta mensagem", onclick: () => this.tirarAnexo(item) }));
      this.anexos.push(item);
      this.chipsAnexo.append(chip);
      this.chipsAnexo.hidden = false;
      try {
        // arquivo do disco: o app copia direto; print colado (sem arquivo): vão os bytes
        const origem = window.engram.caminhoDoArquivo(arquivo);
        const corpo = origem ? { origem, nome: arquivo.name } : { nome: arquivo.name, bytes: new Uint8Array(await arquivo.arrayBuffer()) };
        const dados = await api(`/api/sessoes/${this.id}/arquivos`, { json: corpo });
        item.caminho = dados.caminho;
        item.nome = dados.nome;
        chip.classList.remove("enviando");
      } catch (e) {
        chip.classList.replace("enviando", "falhou");
        chip.title = `Não subiu: ${e.message}`;
      }
    }
    this.entrada.focus();
  }

  tirarAnexo(item) {
    this.anexos = this.anexos.filter(a => a !== item);
    item.chip.remove();
    this.chipsAnexo.hidden = this.anexos.length === 0;
  }

  // ---------------------------------------------------------------- área de arquivos

  alternarArquivos() {
    this.gradeArq.hidden = !this.gradeArq.hidden;
    this.btnArq.classList.toggle("aberto", !this.gradeArq.hidden);
    this.btnArq.classList.remove("novidade");
    if (!this.gradeArq.hidden) this.atualizarArquivos();
  }

  async atualizarArquivos(novos = []) {
    let r;
    try { r = await api(`/api/sessoes/${this.id}/arquivos`); } catch { return; }
    const total = r.recebidos.length + r.entregues.length;
    this.contArq.textContent = total ? String(total) : "";
    if (novos.length) this.btnArq.classList.add("novidade");
    if (this.gradeArq.hidden) return;
    const cartao = (qual, a) => {
      const url = `engram://arquivo/${this.id}/${qual}/${encodeURIComponent(a.nome)}`;
      return el("a", {
        class: `conv-arq-item${novos.includes(a.nome) ? " novo" : ""}`, href: url, target: "_blank", rel: "noopener",
        // com prévia (página, imagem, vídeo, PDF...): abre no painel; Ctrl+clique abre no programa padrão
        onclick: e => { if (temPrevia(a.nome) && !e.ctrlKey && !e.metaKey) { e.preventDefault(); window.dispatchEvent(new CustomEvent("engram:previa", { detail: { raiz: "a", sessao: this.id, qual, nome: a.nome } })); } },
        title: `${a.nome} · ${tamanhoLegivel(a.tamanho)} · ${hora(a.quando)}`,
      },
        ehImagem(a.nome) ? el("img", { src: url, alt: "", loading: "lazy" }) : el("span", { class: "conv-arq-icone", text: icone(a.nome) }),
        el("span", { class: "conv-arq-nome", text: a.nome }),
        el("small", { text: `${tamanhoLegivel(a.tamanho)} · ${hora(a.quando)}` }));
    };
    const secao = (titulo, qual, itens, vazio) => el("div", { class: "conv-arq-secao" },
      el("div", { class: "conv-arq-tit", text: `${titulo} · ${itens.length}` }),
      itens.length ? el("div", { class: "conv-arq-itens" }, itens.map(a => cartao(qual, a))) : el("div", { class: "conv-arq-vazio", text: vazio }));
    this.gradeArq.replaceChildren(
      secao("Ele devolveu", "entregues", r.entregues, "Nada ainda. Peça: “me devolve isso num arquivo”."),
      secao("Você mandou", "recebidos", r.recebidos, "Arraste arquivos para a conversa, use o 📎 ou cole um print."),
      el("div", { class: "conv-arq-pasta", text: r.pasta, title: "Pasta deste agente no seu PC" }));
  }

  arquivosMudaram(novos) {
    this.atualizarArquivos(novos || []);
  }

  // ---------------------------------------------------------------- conversa

  async carregar() {
    if (this.carregando) { this.pendente = true; return; }
    this.carregando = true;
    try {
      const r = await api(`/api/sessoes/${this.id}/conversa?ultimos=250`);
      this.lista.replaceChildren();
      this.ferramentas.clear();
      this.ate = r.ate;
      this.adicionar(r.itens, false);
      this.carregado = true;
      this.rolarFim(false);
    } catch { /* tenta de novo no próximo aviso */ }
    this.carregando = false;
    if (this.pendente) { this.pendente = false; this.atualizar(); }
  }

  async atualizar() {
    if (!this.carregado) return this.carregar();
    if (this.carregando) { this.pendente = true; return; }
    this.carregando = true;
    try {
      const r = await api(`/api/sessoes/${this.id}/conversa?desde=${this.ate}`);
      this.ate = r.ate;
      this.adicionar(r.itens, true);
    } catch { /* idem */ }
    this.carregando = false;
    if (this.pendente) { this.pendente = false; this.atualizar(); }
  }

  noFim() {
    const r = this.rolo;
    return r.scrollTop + r.clientHeight >= r.scrollHeight - 60;
  }

  rolarFim(suave) {
    requestAnimationFrame(() => this.rolo.scrollTo({ top: this.rolo.scrollHeight, behavior: suave ? "smooth" : "auto" }));
  }

  adicionar(itens, animar) {
    const estavaNoFim = this.noFim();
    for (const item of itens) {
      const no = this.montar(item);
      if (!no) continue;
      if (!animar) no.style.animation = "none";
      if (no.classList.contains("conv-ferr")) {
        let grupo = this.lista.lastElementChild;
        if (!grupo || !grupo.classList.contains("conv-ferrs")) {
          grupo = el("div", { class: "conv-ferrs" });
          if (!animar) grupo.style.animation = "none";
          this.lista.append(grupo);
        }
        grupo.append(no);
      } else {
        this.lista.append(no);
      }
    }
    this.vazio.hidden = this.lista.children.length > 0;
    if (estavaNoFim && animar) this.rolarFim(true);
  }

  montar(it) {
    if (it.tipo === "voce") {
      const i = this.enviando.findIndex(b => b.dataset.texto === it.texto.trim());
      if (i >= 0) {
        const bolha = this.enviando.splice(i, 1)[0];
        bolha.classList.remove("pendente");
        bolha.removeAttribute("data-status");
        return null;
      }
      return this.bolhaVoce(it.texto);
    }
    if (it.tipo === "colega") {
      const cor = corModelo((it.modelo || "").toLowerCase());
      const longo = it.texto.length > 1400;
      const caixa = el("div", { class: `conv-colega${longo ? " recolhido" : ""}`, style: { "--de": cor } },
        el("div", { class: "conv-de" },
          el("span", { class: "ponto", style: { "--c": cor } }),
          el("b", { text: it.de }), el("span", { class: "discreto", text: `${it.papel} · ${it.modelo}` }),
          el("span", { class: "conv-selo", text: "pela linha" })),
        markdown(it.texto));
      if (longo) caixa.append(el("button", { class: "conv-mais", text: "mostrar tudo", onclick: ev => {
        caixa.classList.remove("recolhido");
        ev.target.remove();
      } }));
      return caixa;
    }
    if (it.tipo === "agente") return el("div", { class: "conv-agente" }, markdown(it.texto));
    if (it.tipo === "ferramenta") {
      const f = ferramenta(it.nome);
      const chip = el("button", { class: `conv-ferr g-${f.grupo}`, title: it.resumo || f.rotulo },
        el("span", { class: "conv-ferr-ponto" }),
        el("b", { text: f.rotulo }),
        it.resumo && f.grupo !== "sistema" ? el("span", { class: "conv-ferr-alvo", text: it.resumo }) : null);
      chip.dados = { entrada: it.entrada, resultado: null, nome: it.nome };
      chip.onclick = () => this.detalhe(chip);
      if (it.id) this.ferramentas.set(it.id, chip);
      return chip;
    }
    if (it.tipo === "resultado") {
      const chip = this.ferramentas.get(it.ref);
      if (chip) {
        chip.classList.add(it.erro ? "erro" : "ok");
        chip.dados.resultado = it.texto;
        if (chip.detalhe) chip.detalhe.replaceWith(this.caixaDetalhe(chip));
      }
      return null;
    }
    if (it.tipo === "marco") return el("div", { class: "conv-marco" }, el("span", { text: it.texto }));
    return null;
  }

  bolhaVoce(texto, pendente = false) {
    const [corpo, anexos] = texto.split(MARCA_ANEXOS);
    const nomes = anexos ? [...anexos.matchAll(/^- (.+)$/gm)].map(m => m[1].split(/[\\/]/).pop()) : [];
    return el("div", { class: `conv-voce${pendente ? " pendente" : ""}`, "data-texto": texto.trim() },
      corpo.trim() ? el("div", { class: "conv-voce-txt", text: corpo.trim() }) : null,
      nomes.length ? el("div", { class: "conv-voce-anexos" }, nomes.map(n => el("span", { class: "conv-anexo" }, el("span", { text: icone(n) }), el("b", { text: n })))) : null);
  }

  detalhe(chip) {
    if (chip.detalhe) { chip.detalhe.remove(); chip.detalhe = null; chip.classList.remove("aberto"); return; }
    chip.detalhe = this.caixaDetalhe(chip);
    chip.classList.add("aberto");
    chip.parentElement.after(chip.detalhe);
  }

  caixaDetalhe(chip) {
    const caixa = el("div", { class: "conv-detalhe" },
      el("div", { class: "conv-detalhe-tit", text: chip.dados.nome }),
      el("pre", { text: chip.dados.entrada || "{}" }),
      el("div", { class: "conv-detalhe-tit", text: chip.dados.resultado === null ? "resultado: ainda rodando…" : "resultado" }),
      chip.dados.resultado !== null ? el("pre", { text: chip.dados.resultado }) : null);
    chip.detalhe = caixa;
    return caixa;
  }

  // ---------------------------------------------------------------- escrever

  ajustarAltura() {
    this.entrada.style.height = "auto";
    this.entrada.style.height = `${Math.min(this.entrada.scrollHeight, 180)}px`;
  }

  async enviar() {
    let texto = this.entrada.value.trim();
    const prontos = this.anexos.filter(a => a.caminho);
    if (this.anexos.some(a => !a.caminho && a.chip.classList.contains("enviando"))) {
      avisar({ texto: "Espere os arquivos terminarem de subir.", cor: "#ffc857" });
      return;
    }
    if (!texto && !prontos.length) return;
    if (prontos.length) {
      texto = `${texto || (prontos.length > 1 ? "Seguem os arquivos." : "Segue o arquivo.")}\n\n`
        + `${MARCA_ANEXOS}: estão na sua pasta; leia com a ferramenta Read]\n`
        + prontos.map(a => `- ${a.caminho}`).join("\n");
    }
    this.entrada.value = "";
    this.ajustarAltura();
    for (const a of this.anexos) a.chip.remove();
    this.anexos = [];
    this.chipsAnexo.hidden = true;
    const bolha = this.bolhaVoce(texto, true);
    this.enviando.push(bolha);
    this.lista.append(bolha);
    this.vazio.hidden = true;
    this.rolarFim(true);
    try {
      const r = await api(`/api/sessoes/${this.id}/prompt`, { json: { texto } });
      bolha.dataset.status = r.na_frente > 0 ? "na fila: entra quando ele terminar" : "enviando…";
    } catch (e) {
      bolha.classList.add("falhou");
      bolha.dataset.status = `não enviou: ${e.message}`;
    }
  }

  focar() {
    this.entrada.focus();
  }

  estado(estado) {
    const ocupado = OCUPADO.has(estado);
    this.ocupado = ocupado;
    this.digitando.hidden = !ocupado;
    this.btnParar.hidden = !ocupado;
    this.txtDigitando.textContent = estado === "trabalhando" ? "trabalhando" : estado === "iniciando" ? "iniciando" : "pensando";
    if (!this.perguntaAtual) {
      this.montarAviso("Está pedindo a sua permissão no terminal.", [["Responder no terminal", () => this.aoTerminal?.(), false]]);
      this.aviso.hidden = !ATENCAO.has(estado);
    }
    if ((ocupado || ATENCAO.has(estado)) && this.noFim()) this.rolarFim(true);
  }

  montarAviso(texto, botoes) {
    this.aviso.classList.remove("pergunta");
    this.avisoDetalhe.hidden = this.avisoOpcoes.hidden = true;
    this.avisoTexto.textContent = texto;
    this.avisoBotoes.replaceChildren(...botoes.map(([rotulo, acao, destaque]) => destaque
      ? el("button", { class: "btn-brilho pequeno", onclick: acao }, el("span", { text: rotulo }))
      : el("button", { class: "btn pequeno", text: rotulo, onclick: acao })));
  }

  /** O agente parou numa pergunta do próprio CLI antes de começar (ex.: confiar na pasta). */
  pergunta(p) {
    this.perguntaAtual = p || null;
    if (!p) { this.aviso.hidden = true; return; }
    if (p.tipo === "confiar_pasta") {
      this.montarAviso(`O Claude pergunta se pode confiar na pasta de trabalho: ${p.pasta}`, [
        ["Confiar na pasta", async () => {
          try { await api(`/api/sessoes/${this.id}/confiar`, { method: "POST" }); this.pergunta(null); }
          catch (e) { avisar({ texto: e.message, cor: "#ff6b7d" }); }
        }, true],
        ["Ver no terminal", () => this.aoTerminal?.(), false],
      ]);
    } else if (p.opcoes?.length || p.rodape) {
      this.montarPerguntaDoTerminal(p);
    } else {
      this.montarAviso(p.texto || "O agente está esperando uma resposta no terminal.", [["Abrir o terminal", () => this.aoTerminal?.(), true]]);
    }
    this.aviso.hidden = false;
    this.rolarFim(true);
  }

  /** A pergunta que o CLI do agente faz no terminal (pedir permissão, confirmar...), com as opções como botões. */
  montarPerguntaDoTerminal(p) {
    this.aviso.classList.add("pergunta");
    this.avisoTexto.textContent = p.titulo || "O agente está esperando uma resposta.";
    const detalhe = (p.detalhe || []).join("\n");
    this.avisoDetalhe.textContent = detalhe;
    this.avisoDetalhe.hidden = !detalhe.trim();
    const responder = async corpo => {
      const botoes = [...this.aviso.querySelectorAll("button")];
      for (const b of botoes) b.disabled = true;
      try { await api(`/api/sessoes/${this.id}/responder`, { json: corpo }); }
      catch (e) { avisar({ texto: e.message, cor: "#ff6b7d" }); for (const b of botoes) b.disabled = false; }
    };
    const opcoes = p.opcoes || [];
    this.avisoOpcoes.replaceChildren(...opcoes.map(o => el("button", { class: `conv-opcao${o.atual ? " atual" : ""}`, onclick: () => responder({ opcao: o.n }) },
      el("b", { text: String(o.n) }), el("span", { text: o.texto }))));
    this.avisoOpcoes.hidden = !opcoes.length;
    const tecla = (rotulo, t, dica) => el("button", { class: "btn pequeno conv-tecla", title: dica, text: rotulo, onclick: () => responder({ tecla: t }) });
    // sem opções numeradas (um formulário, um "Enter para continuar"): as teclas que o terminal espera
    const teclas = opcoes.length ? [tecla("Esc", "esc", "Cancelar (Esc)")]
      : [tecla("↑", "cima", "Seta para cima"), tecla("↓", "baixo", "Seta para baixo"), tecla("←", "esquerda", "Seta para a esquerda"), tecla("→", "direita", "Seta para a direita"), tecla("Enter", "enter", "Confirmar (Enter)"), tecla("Esc", "esc", "Cancelar (Esc)")];
    this.avisoBotoes.replaceChildren(...teclas, el("button", { class: "btn pequeno", text: "Ver no terminal", onclick: () => this.aoTerminal?.() }));
  }
}

// ------------------------------------------------------------------ leitor grande

export class Leitor {
  constructor({ cartoes, aoTerminal }) {
    this.raiz = $("#leitor");
    this.cartoes = cartoes; // função que devolve os cartões do palco
    this.aoTerminal = aoTerminal;
    this.id = null;
    this.conv = null;
    $("#leitor-fechar").onclick = () => this.fechar();
  }

  get aberto() {
    return this.raiz.classList.contains("aberto");
  }

  abrir(id) {
    const c = this.cartoes().get(id);
    if (!c) return;
    this.id = id;
    this.conv = new Conversa(id, { cor: c.cor, grande: true, nome: c.info.nome, aoTerminal: () => this.aoTerminal(id) });
    $("#leitor-corpo").replaceChildren(this.conv.el);
    this.conv.carregar();
    this.conv.estado(c.estado);
    this.abas();
    this.raiz.classList.add("aberto");
    this.raiz.setAttribute("aria-hidden", "false");
    setTimeout(() => this.conv?.focar(), 350);
  }

  fechar() {
    this.raiz.classList.remove("aberto");
    this.raiz.setAttribute("aria-hidden", "true");
    this.id = null;
    this.conv = null;
  }

  abas() {
    const abas = [...this.cartoes().values()].filter(c => c.viva).map(c => el("button", {
      class: `leitor-aba${c.id === this.id ? " ativa" : ""}${OCUPADO.has(c.estado) ? " ocupado" : ""}${ATENCAO.has(c.estado) ? " atencao" : ""}`,
      style: { "--cor": c.cor }, title: `${nomePapel(c.info.papel)} · ${nomeModelo(c.info.modelo)}`,
      onclick: () => this.abrir(c.id),
    }, el("span", { class: "orbe" }), c.info.nome));
    $("#leitor-abas").replaceChildren(...abas);
  }

  atualizar(id) {
    if (this.aberto && this.id === id) this.conv?.atualizar();
  }

  arquivos(id, novos) {
    if (this.aberto && this.id === id) this.conv?.arquivosMudaram(novos);
  }

  estado(id, estado, pergunta) {
    if (!this.aberto) return;
    if (this.id === id) {
      this.conv?.estado(estado);
      if (pergunta !== undefined) this.conv?.pergunta(pergunta);
    }
    this.abas();
  }
}
