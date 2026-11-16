// Palcos: até 3, cada um com os seus cartões, linhas, setores, post-its e automações. Trocar de palco não
// encerra ninguém: os agentes do outro palco seguem rodando e recebendo mensagem; muda só o que aparece na tela.
// Aqui ficam o item "Palcos" do menu Ferramentas, os selos (agente esperando você em outro palco), o mapa de
// todas as janelas abertas (id → palco, nome, estado) e a troca com movimento e brilho.

import { $, el, api, avisar, movimentoReduzido, OCUPADO, ATENCAO } from "./util.js";

const pausa = ms => new Promise(r => setTimeout(r, ms));
const rotuloAgentes = n => (n === 0 ? "sem agentes" : n === 1 ? "1 agente" : `${n} agentes`);

export class Palcos {
  constructor({ palco, aoAntes, aoDepois, aoRepetir }) {
    this.palco = palco;
    this.aoAntes = aoAntes; // antes de a tela trocar (ex.: fechar o leitor)
    this.aoDepois = aoDepois; // depois de a tela trocar (ex.: redesenhar o cérebro, a gaveta Time)
    this.aoRepetir = aoRepetir; // reaplica um evento ao vivo que chegou no meio da troca
    this.atual = 1;
    this.max = 3;
    this.lista = [{ n: 1, nome: "Palco 1" }, { n: 2, nome: "Palco 2" }, { n: 3, nome: "Palco 3" }];
    this.mapa = new Map(); // id da janela aberta → { palco, nome, estado }
    this.selos = new Map(); // n → "atencao" | "terminou" (só de palco que não é o atual)
    this.cameras = new Map(); // n → vista (pan e zoom) de quando saímos dele
    this.emTroca = false;
    this.fila = [];
    this.editando = false;
    this.chave = "";
    this.montar();
  }

  // ---------------------------------------------------------------- dados

  async carregar() {
    this.aplicar(await api("/api/palcos"));
    return this.atual;
  }

  aplicar(d) {
    if (!d || !Array.isArray(d.lista)) return;
    this.max = d.max || this.max;
    this.atual = d.atual || this.atual;
    this.palco.n = this.atual;
    this.lista = d.lista.map(p => ({ n: p.n, nome: p.nome || `Palco ${p.n}` }));
    this.mapa.clear();
    for (const p of d.lista) for (const a of p.agentes || []) this.mapa.set(a.id, { palco: p.n, nome: a.nome, estado: a.estado });
    this.selos.delete(this.atual);
    this.desenhar();
  }

  nomeDe(n) { return this.lista.find(p => p.n === n)?.nome || `Palco ${n}`; }
  agentesDe(n) { return [...this.mapa.entries()].filter(([, a]) => a.palco === n).map(([id, a]) => ({ id, ...a })); }
  /** Esta janela é do palco que está na tela? (sem informação, trata como sim) */
  noAtual(id) { return (this.mapa.get(id)?.palco ?? this.atual) === this.atual; }
  nomeAgente(id) { return this.mapa.get(id)?.nome || null; }

  // ---------------------------------------------------------------- eventos ao vivo

  /** Todo evento passa por aqui antes: mantém o mapa, as contagens e os selos, mesmo os de outro palco. */
  observar(m) {
    if (m.tipo === "sessao" && m.sessao) {
      const s = m.sessao;
      if (s.aberta) {
        const n = Number.isInteger(s.palco) ? s.palco : this.mapa.get(s.id)?.palco ?? this.atual;
        this.mapa.set(s.id, { palco: n, nome: s.nome, estado: s.estado });
        if (n !== this.atual && ATENCAO.has(s.estado)) this.selar(n, "atencao");
      } else this.mapa.delete(s.id);
    } else if (m.tipo === "evento" && m.estado) {
      const a = this.mapa.get(m.sessao_id);
      if (!a) return;
      const antes = a.estado;
      a.estado = m.estado;
      if (a.palco !== this.atual) {
        if (ATENCAO.has(m.estado)) this.selar(a.palco, "atencao");
        else if (m.estado === "esperando você" && OCUPADO.has(antes)) this.selar(a.palco, "terminou"); // acabou o que estava fazendo enquanto você olhava outro palco
      }
    } else if (m.tipo === "palcos" && m.acao === "nome") {
      const p = this.lista.find(x => x.n === m.n);
      if (p) p.nome = m.nome;
      if (m.n === this.atual) this.pintarAtual();
    } else if (m.tipo === "palcos" && m.acao === "apagado") {
      for (const id of m.agentes || []) this.mapa.delete(id);
      this.selos.delete(m.n);
      this.cameras.delete(m.n);
      if (m.n === this.atual) this.esvaziarTela();
    } else return;
    this.desenhar();
  }

  selar(n, tipo) {
    if (this.selos.get(n) === "atencao") return; // "precisa de você" pesa mais que "terminou"
    this.selos.set(n, tipo);
    this.novoSelo = true;
  }

  /** O evento desenha alguma coisa no palco da tela? (os de outro palco só contam e selam) */
  vale(m) {
    const aqui = n => (Number.isInteger(n) ? n : this.atual) === this.atual;
    switch (m.tipo) {
      case "sessao": return aqui(m.sessao?.palco);
      case "setor": return aqui(m.setor?.palco);
      case "automacao": return aqui(m.automacao?.palco);
      case "postit": return aqui(m.postit?.palco);
      case "conexao": return this.noAtual(m.a) && this.noAtual(m.b);
      case "palco": return aqui(m.palco);
      default: return true;
    }
  }

  // ---------------------------------------------------------------- menu

  montar() {
    this.botao = $("#btn-palcos");
    this.caixa = $("#palcos-lista");
    this.botao.onclick = () => this.expandir(this.caixa.hidden);
    document.addEventListener("pointerdown", e => { if (!e.target.closest("#ferramentas")) this.expandir(false); });
    this.pintarAtual();
  }

  expandir(abrir) {
    if (this.caixa.hidden === !abrir) return;
    this.caixa.hidden = !abrir;
    this.botao.setAttribute("aria-expanded", String(abrir));
    if (abrir) {
      this.caixa.classList.remove("abre");
      void this.caixa.offsetWidth;
      if (!movimentoReduzido) this.caixa.classList.add("abre");
      this.chave = ""; // refaz as linhas
      this.desenhar();
    }
  }

  pintarAtual() {
    const chip = $("#ferr-palco");
    if (chip.textContent !== this.nomeDe(this.atual)) {
      chip.textContent = this.nomeDe(this.atual);
      chip.classList.remove("pisca");
      void chip.offsetWidth;
      if (!movimentoReduzido) chip.classList.add("pisca");
    }
    $("#palcos-resumo").textContent = `${this.nomeDe(this.atual)} · ${rotuloAgentes(this.agentesDe(this.atual).length)}`;
  }

  desenhar() {
    this.pintarAtual();
    // selo no botão Ferramentas e no item Palcos: algum outro palco pede atenção?
    const outros = [...this.selos.entries()].filter(([n]) => n !== this.atual);
    const tipo = outros.some(([, t]) => t === "atencao") ? "atencao" : outros.length ? "terminou" : null;
    for (const s of [$("#selo-ferr"), $("#selo-palcos")]) {
      const tinha = !s.hidden;
      s.hidden = !tipo;
      s.className = `selo${tipo === "terminou" ? " terminou" : ""}${outros.length > 1 ? " com-n" : ""}`;
      s.textContent = outros.length > 1 ? String(outros.length) : "";
      s.title = outros.map(([n, t]) => `${this.nomeDe(n)}: ${t === "atencao" ? "um agente precisa de você" : "um agente terminou"}`).join("\n");
      if (tipo && (!tinha || this.novoSelo) && !movimentoReduzido) s.classList.add("nasce");
    }
    this.novoSelo = false;
    if (this.caixa.hidden || this.editando) return;
    const chave = JSON.stringify([this.atual, this.lista, [...this.selos], this.lista.map(p => this.agentesDe(p.n).map(a => a.estado))]);
    if (chave === this.chave) return;
    this.chave = chave;
    this.caixa.replaceChildren(...this.lista.map(p => this.linha(p)));
  }

  linha(p) {
    const ags = this.agentesDe(p.n);
    const selo = this.selos.get(p.n);
    const nome = el("b", { text: p.nome, title: "Duplo clique para renomear" });
    const lapis = el("button", { class: "palco-lapis", title: "Renomear o palco", "aria-label": "Renomear o palco" }, el("i", { class: "codicon codicon-edit" }));
    const lixo = el("button", { class: "palco-lixo", title: "Apagar o palco (encerra os agentes dele)", "aria-label": "Apagar o palco" }, el("i", { class: "codicon codicon-trash" }));
    const linha = el("div", { class: `palco-linha${p.n === this.atual ? " atual" : ""}`, role: "menuitemradio", "aria-checked": String(p.n === this.atual), "data-n": p.n, tabindex: "0",
      title: p.n === this.atual ? "O palco que está na tela" : `Ir para ${p.nome}` },
      el("span", { class: "palco-num", text: p.n }),
      el("span", { class: "palco-nome" }, nome, el("small", { text: rotuloAgentes(ags.length) })),
      el("span", { class: "palco-ag" }, ...ags.slice(0, 8).map(a => el("i", { class: OCUPADO.has(a.estado) ? "ocupado" : ATENCAO.has(a.estado) ? "atencao" : "livre", title: `${a.nome}: ${a.estado || ""}` }))),
      selo ? el("span", { class: `selo${selo === "terminou" ? " terminou" : ""}`, title: selo === "atencao" ? "Um agente deste palco precisa de você" : "Um agente deste palco terminou" }) : null,
      lapis, lixo);
    linha.addEventListener("click", e => { if (!e.target.closest(".palco-lapis, .palco-lixo, input")) this.trocar(p.n); });
    lixo.onclick = e => { e.stopPropagation(); this.apagar(p); };
    linha.addEventListener("keydown", e => { if (e.key === "Enter" && e.target === linha) this.trocar(p.n); });
    nome.addEventListener("dblclick", e => { e.stopPropagation(); this.renomear(p, nome); });
    lapis.onclick = e => { e.stopPropagation(); this.renomear(p, nome); };
    return linha;
  }

  /** Edita o nome na própria linha: Enter (ou clicar fora) salva, Esc desiste. */
  renomear(p, elNome) {
    if (this.editando) return;
    this.editando = true;
    const campo = el("input", { value: p.nome, maxlength: "24", spellcheck: "false", autocomplete: "off", "aria-label": "Nome do palco" });
    elNome.replaceWith(campo);
    campo.focus();
    campo.select();
    let feito = false;
    const fim = async salvar => {
      if (feito) return;
      feito = true;
      const nome = campo.value.trim();
      this.editando = false;
      if (salvar && nome && nome !== p.nome) {
        try {
          const r = await api(`/api/palcos/${p.n}`, { method: "PUT", json: { nome } });
          p.nome = r?.nome || nome;
        } catch (e) { avisar({ texto: `Não renomeou: ${e.message}`, cor: "#ff6b7d" }); }
      }
      this.chave = "";
      this.desenhar();
    };
    campo.addEventListener("keydown", e => {
      e.stopPropagation();
      if (e.key === "Enter") { e.preventDefault(); fim(true); }
      else if (e.key === "Escape") { e.preventDefault(); fim(false); }
    });
    campo.addEventListener("blur", () => fim(true));
    campo.addEventListener("click", e => e.stopPropagation());
  }

  /**
   * Apaga o palco: o lugar continua na lista, vazio e com o nome de fábrica. Antes, a pessoa vê o que sai: os
   * agentes são encerrados (a conversa fica salva) e os setores, automações, post-its e tarefas dele somem.
   */
  async apagar(p) {
    let d;
    try { d = await api(`/api/palco?palco=${p.n}`); } catch (e) { avisar({ texto: `Não deu para ler o palco: ${e.message}`, cor: "#ff6b7d" }); return; }
    const conta = (n, um, varios) => (n ? (n === 1 ? um : `${n} ${varios}`) : null);
    const ags = d.janelas?.length || 0;
    const sai = [
      conta(d.setores?.length, "1 setor", "setores"),
      conta(d.automacoes?.length, "1 automação", "automações"),
      conta(d.postits?.length, "1 post-it", "post-its"),
    ].filter(Boolean);
    if (!ags && !sai.length && p.nome === `Palco ${p.n}`) { avisar({ texto: `O ${p.nome} já está vazio`, cor: "#ffc857", tempo: 3500 }); return; }
    const linhas = [`Apagar o ${p.nome}?`, ""];
    if (ags) linhas.push(`${ags === 1 ? "1 agente é encerrado" : `${ags} agentes são encerrados`}. A conversa de cada um fica salva e dá para retomar pela aba Time.`);
    linhas.push(`Saem também ${sai.length ? `${sai.join(", ")} e ` : ""}as tarefas do quadro deste palco.`);
    linhas.push("", `O lugar continua na lista, vazio, com o nome "Palco ${p.n}".`);
    if (!confirm(linhas.join("\n"))) return;
    try {
      const r = await api(`/api/palcos/${p.n}/apagar`, { method: "POST" });
      avisar({ rota: `${p.nome} apagado`, texto: r.agentes ? `${r.agentes === 1 ? "1 agente encerrado" : `${r.agentes} agentes encerrados`}; as conversas ficam salvas` : "o palco ficou vazio", cor: "#4ade9f" });
    } catch (e) { avisar({ texto: `Não apagou: ${e.message}`, cor: "#ff6b7d" }); }
  }

  /** O palco apagado é o da tela: os cartões saem (as linhas, setores, automações e post-its saem pelos avisos). */
  esvaziarTela() {
    this.aoAntes?.();
    for (const id of [...this.palco.cartoes.keys()]) this.palco.remover(id);
    this.aoDepois?.(this.atual);
  }

  // ---------------------------------------------------------------- a troca

  /** Põe outro palco na tela: o de agora sai deslizando e esmaecendo, o novo entra com um varrido de luz. */
  async trocar(n) {
    if (this.emTroca) { avisar({ texto: "Trocando de palco: tente de novo em um instante", cor: "#ffc857", tempo: 3500 }); return false; }
    if (n === this.atual || !this.lista.some(p => p.n === n)) return false;
    this.emTroca = true;
    this.fila = [];
    const de = this.atual;
    const dir = n > de ? 1 : -1;
    const raiz = $("#palco"), varrido = $("#palco-varrido");
    raiz.style.setProperty("--dir", String(dir));
    this.cameras.set(de, { ...this.palco.v });
    let dados;
    try {
      // 1) buscar e avisar o main: aqui a tela ainda é a do palco antigo e nada foi tirado dela
      this.aoAntes?.();
      if (!movimentoReduzido) raiz.classList.add("palco-troca-saindo");
      [dados] = await Promise.all([api(`/api/palco?palco=${n}`), pausa(movimentoReduzido ? 0 : 250)]);
      await api("/api/palcos/atual", { json: { n } });
    } catch (e) {
      raiz.classList.remove("palco-troca-saindo");
      avisar({ texto: `Não trocou de palco: ${e.message}`, cor: "#ff6b7d", tempo: 6000 });
      this.emTroca = false;
      for (const m of this.fila.splice(0)) this.aoRepetir?.(m); // o que chegou durante a espera: o palco que continua na tela fica em dia
      return false;
    }
    try {
      // 2) trocar a tela
      this.palco.limpar();
      this.atual = n;
      this.palco.n = n;
      this.selos.delete(n);
      this.palco.carregar(dados);
      const cam = this.cameras.get(n);
      if (cam) { this.palco.v = { ...cam }; this.palco.aplicar(false); }
      else if (!dados.janelas?.length) { this.palco.v = { x: innerWidth / 2 - 350, y: innerHeight / 2 - 205, z: 1 }; this.palco.aplicar(false); }
      this.palco.setores.posicionarAgrupar();

      if (!movimentoReduzido) {
        raiz.classList.remove("palco-troca-saindo");
        raiz.classList.add("palco-troca-entrando");
        $("#palco-varrido-nome").textContent = this.nomeDe(n);
        varrido.dataset.dir = String(dir);
        varrido.classList.add("on");
        setTimeout(() => { raiz.classList.remove("palco-troca-entrando"); varrido.classList.remove("on"); }, 1000);
      }
      this.chave = "";
      this.desenhar();
      this.carregar().catch(() => {}); // ressincroniza o mapa com o main
      this.aoDepois?.(n);
      for (const m of this.fila.splice(0)) this.aoRepetir?.(m); // o que chegou durante a troca
      return true;
    } catch (e) {
      // falhou depois de a tela ser esvaziada: recarrega o palco atual inteiro para ela nunca ficar vazia
      raiz.classList.remove("palco-troca-saindo", "palco-troca-entrando");
      varrido.classList.remove("on");
      try {
        this.palco.limpar();
        this.palco.carregar(await api(`/api/palco?palco=${this.atual}`));
        this.desenhar();
        this.aoDepois?.(this.atual);
        for (const m of this.fila.splice(0)) this.aoRepetir?.(m);
        avisar({ texto: `A troca de palco deu erro (${e.message}); o palco foi recarregado.`, cor: "#ffc857", tempo: 7000 });
        return true;
      } catch (e2) {
        avisar({ texto: `Não deu para mostrar o palco: ${e2.message}. Clique em outro palco para tentar de novo.`, cor: "#ff6b7d", tempo: 9000 });
        return false;
      }
    } finally {
      this.emTroca = false;
    }
  }
}
