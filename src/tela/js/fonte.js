// Seletor do cérebro no topo: "Servidor <nome> | Local". Alterna na hora, sem reiniciar; as duas configurações ficam guardadas.

import { $, api, avisar } from "./util.js";

const DICA_SEM_SERVIDOR = "Configure o servidor em Ajustes > Geral > Cérebro";

export class FonteCerebro {
  constructor({ aoMudar } = {}) {
    this.aoMudar = aoMudar; // ex.: cerebro.trocouFonte(m)
    this.raiz = $("#fonte");
    this.pilula = this.raiz.querySelector(".fonte-pilula");
    this.ops = { remoto: $("#fonte-remoto"), pasta: $("#fonte-pasta") };
    this.ativa = "pasta";
    this.alvo = null; // para onde está trocando (null = parado)
    this.pedindo = false; // fui eu que pedi esta troca
    this.servidor = { configurado: false, nome: "", erro: null };
    this.local = {};
    for (const [f, b] of Object.entries(this.ops)) b.onclick = () => this.escolher(f);
    window.addEventListener("resize", () => this.mover());
    this.pintar();
  }

  async carregar() {
    try { this.aplicar(await api("/api/cerebro/fonte")); }
    catch { /* sem o seletor ainda: fica como está */ }
  }

  aplicar(d) {
    if (!d) return;
    this.ativa = d.ativa === "remoto" ? "remoto" : "pasta";
    this.local = d.local || {};
    this.servidor = d.servidor || { configurado: false };
    this.alvo = d.trocando ? this.alvo || (this.ativa === "remoto" ? "pasta" : "remoto") : null;
    this.pintar();
  }

  pintar() {
    const { remoto, pasta } = this.ops;
    const sem = !this.servidor.configurado;
    remoto.classList.toggle("apagado", sem);
    remoto.setAttribute("aria-disabled", String(sem));
    remoto.title = sem ? DICA_SEM_SERVIDOR : `Cérebro do servidor${this.servidor.nome ? ` ${this.servidor.nome}` : ""}${this.servidor.erro ? `\nÚltimo erro: ${this.servidor.erro}` : ""}`;
    $("#fonte-nome").textContent = sem ? "" : this.servidor.nome || "";
    pasta.title = `Cérebro numa pasta deste computador${this.local.pasta ? `\n${this.local.pasta}` : ""}`;
    remoto.classList.toggle("ativo", this.ativa === "remoto");
    pasta.classList.toggle("ativo", this.ativa === "pasta");
    remoto.classList.toggle("alvo", this.alvo === "remoto");
    pasta.classList.toggle("alvo", this.alvo === "pasta");
    remoto.setAttribute("aria-pressed", String(this.ativa === "remoto"));
    pasta.setAttribute("aria-pressed", String(this.ativa === "pasta"));
    this.raiz.classList.toggle("trocando", !!this.alvo);
    requestAnimationFrame(() => this.mover());
  }

  /** A pílula acesa desliza até a opção ativa (ou até a que está sendo escolhida). */
  mover() {
    const b = this.ops[this.alvo || this.ativa];
    if (!b || !b.offsetWidth) return;
    this.pilula.style.left = `${b.offsetLeft}px`;
    this.pilula.style.width = `${b.offsetWidth}px`;
    this.raiz.classList.add("pronta");
  }

  async escolher(fonte) {
    if (this.alvo || fonte === this.ativa) return;
    if (fonte === "remoto" && !this.servidor.configurado) {
      avisar({ rota: "Cérebro", texto: DICA_SEM_SERVIDOR, cor: "#ffc857", tempo: 6000 });
      this.sacudir();
      return;
    }
    this.alvo = fonte;
    this.pedindo = true;
    this.pintar();
    try {
      const r = await api("/api/cerebro/fonte", { json: { fonte } });
      this.ativa = r?.ativa === "remoto" ? "remoto" : r?.ativa === "pasta" ? "pasta" : fonte;
    } catch (e) {
      avisar({ rota: "Cérebro", texto: e.message, cor: "#ff6b7d", tempo: 9000 });
      this.sacudir();
    } finally {
      this.pedindo = false;
      this.alvo = null;
      this.pintar(); // sem trocar: a pílula volta para o ativo
      this.carregar(); // pega o estado de verdade (nome, erro) do main
    }
  }

  sacudir() {
    this.raiz.classList.remove("erro");
    void this.raiz.offsetWidth;
    this.raiz.classList.add("erro");
  }

  /** Eventos ao vivo { tipo: "cerebro_fonte", acao: "trocando" | "trocado" | "falhou" } (a troca pode vir de outro lugar, como os Ajustes). */
  aoVivo(m) {
    if (m.acao === "trocando") {
      this.alvo = m.para === "remoto" ? "remoto" : "pasta";
    } else if (m.acao === "trocado") {
      this.ativa = m.ativa === "remoto" ? "remoto" : "pasta";
      if (!this.pedindo) this.alvo = null;
      if (m.nome) this.servidor = { ...this.servidor, nome: m.nome };
    } else if (m.acao === "falhou") {
      this.ativa = m.ativa === "remoto" ? "remoto" : "pasta";
      if (!this.pedindo) {
        this.alvo = null;
        avisar({ rota: "Cérebro", texto: m.erro || "A troca do cérebro falhou", cor: "#ff6b7d", tempo: 9000 });
      }
    }
    this.pintar();
    // "config": os Ajustes do cérebro foram salvos (servidor novo ou com outro nome): relê para destravar a opção Servidor
    if (m.acao === "trocado" || m.acao === "falhou" || m.acao === "config") this.carregar();
    this.aoMudar?.(m);
  }
}
