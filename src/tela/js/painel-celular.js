// Ajustes > Celular: o modo dispatch. Liga a porta na rede local, mostra o QR code e o código de pareamento
// e a lista dos aparelhos que já podem mandar pedidos ao time.

import { el, svg, api, avisar } from "./util.js";

const dataCurta = iso => (iso ? new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "");

export class PainelCelular {
  constructor(raiz) {
    this.raiz = raiz;
    this.e = null;
    this.relogio = null;
  }

  async carregar() {
    try { this.e = await api("/api/celular"); } catch (e) { avisar({ texto: e.message, cor: "#ff6b7d" }); return; }
    // ligado e sem código válido (venceu ou já foi usado): já deixa um pronto para o próximo aparelho
    if (this.e.ligado && !this.e.codigo && this.e.url && !this.e.aparelhos.length) {
      try { this.e = await api("/api/celular/codigo", { method: "POST" }); } catch { /* fica sem código */ }
    }
    this.desenhar();
  }

  /** Aviso do app (pareou, conectou, desconectou): redesenha se a aba estiver à vista. */
  aoVivo(m) {
    if (m.acao === "pareado") avisar({ rota: "Celular", texto: `${m.nome} pareado: já pode mandar pedidos ao time`, cor: "#4ade9f", tempo: 7000 });
    if (this.raiz.isConnected && !this.raiz.hidden) this.carregar();
  }

  async mudar(corpo) {
    try { this.e = await api("/api/celular", { json: corpo }); } catch (e) { avisar({ texto: e.message, cor: "#ff6b7d", tempo: 8000 }); }
    this.desenhar();
  }

  desenhar() {
    clearInterval(this.relogio);
    const e = this.e;
    if (!e) return;
    const ligar = el("input", { type: "checkbox", checked: e.ligado, onchange: ev => this.mudar({ ligado: ev.target.checked }) });
    const topo = el("section", { class: "aj-grupo" },
      el("h3", { text: "Modo dispatch" }),
      el("label", { class: "aj-opcao" }, el("span", { class: "chave" }, ligar, el("span")),
        el("span", {}, "Receber pedidos do celular pela rede local ", el("small", { text: "(o app do Engram no celular, no mesmo Wi-Fi deste PC)" }))),
      e.erro ? el("p", { class: "cel-erro", text: `Não ligou: ${e.erro}.` }) : null,
      el("p", { class: "aj-nota", text: "Do celular você conversa com o maestro (ou com qualquer agente aberto), vê o que o time está fazendo, responde as perguntas do terminal e aperta Parar. O Engram precisa estar aberto e o PC acordado." }));

    const partes = [topo];
    if (e.ligado && e.url) partes.push(this.blocoParear(e));
    else if (e.ligado) partes.push(el("section", { class: "aj-grupo" }, el("p", { class: "cel-erro", text: "Este PC não está em nenhuma rede agora. Conecte ao Wi-Fi e abra esta aba de novo." })));
    partes.push(this.blocoAparelhos(e));
    partes.push(el("section", { class: "aj-grupo cel-dicas" }, el("h3", { text: "Bom saber" }),
      el("ul", {},
        el("li", { text: "Se o Windows perguntar sobre o firewall, permita para redes privadas. Sem isso, o celular não alcança o PC." }),
        el("li", { text: "Na rede local a conversa não é cifrada: use numa rede em que você confia." }),
        el("li", { text: "Para virar app: no iPhone, Compartilhar > Adicionar à Tela de Início; no Android, menu ⋮ > Adicionar à tela inicial. Se o app abrir pedindo código, gere outro aqui e digite lá." }),
        el("li", { text: "Celular perdido? Remova o aparelho aqui: o acesso dele acaba na hora." }))));
    this.raiz.replaceChildren(...partes);
  }

  async gerarCodigo() {
    try { this.e = await api("/api/celular/codigo", { method: "POST" }); this.desenhar(); } catch (er) { avisar({ texto: er.message, cor: "#ff6b7d" }); }
  }

  blocoParear(e) {
    if (!e.codigo) {
      // o código já foi usado (ou venceu): sem QR vazio na tela, só o caminho para parear mais um
      const ultimo = [...e.aparelhos].sort((a, b) => String(b.criado).localeCompare(String(a.criado)))[0];
      return el("section", { class: "aj-grupo" }, el("h3", { text: "Parear um celular" }),
        el("div", { class: "cel-pronto" },
          ultimo ? el("span", { class: "cel-ok", text: "✓" }) : null,
          el("p", { text: ultimo ? `${ultimo.nome} já pode mandar pedidos ao time. O endereço é ${e.url}.` : `O endereço é ${e.url}. Gere um código para parear.` }),
          el("button", { type: "button", class: "btn pequeno", onclick: () => this.gerarCodigo() }, ultimo ? "Parear outro aparelho" : "Gerar código")));
    }
    const caixaQr = el("div", { class: "cel-qr" });
    if (e.qr) {
      const m = 3; // margem branca em volta (o leitor precisa dela)
      const s = svg("svg", { viewBox: `${-m} ${-m} ${e.qr.n + 2 * m} ${e.qr.n + 2 * m}`, "shape-rendering": "crispEdges", role: "img", "aria-label": "QR code para parear o celular" });
      s.append(svg("rect", { x: -m, y: -m, width: e.qr.n + 2 * m, height: e.qr.n + 2 * m, fill: "#ffffff" }), svg("path", { d: e.qr.d, fill: "#05070c" }));
      caixaQr.append(s);
    } else caixaQr.append(el("div", { class: "cel-qr-vazio", text: "sem código" }));

    const resta = el("small", { class: "cel-resta" });
    const gerar = el("button", { type: "button", class: "btn pequeno", onclick: () => this.gerarCodigo() }, "Gerar outro código");
    const tic = () => {
      const s = Math.max(0, Math.round((new Date(e.expira) - Date.now()) / 1000));
      resta.textContent = s ? `Vale por ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}, uma vez só.` : "Venceu: gere outro.";
      if (!s) { clearInterval(this.relogio); caixaQr.classList.add("vencido"); }
    };
    tic();
    this.relogio = setInterval(() => { if (!this.raiz.isConnected) clearInterval(this.relogio); else tic(); }, 1000);

    const escolherIp = e.enderecos.length > 1
      ? el("label", { class: "cel-ip" }, el("span", { text: "Rede" }),
        el("select", { onchange: ev => this.mudar({ ip: ev.target.value }) },
          ...e.enderecos.map(x => el("option", { value: x.ip, selected: x.ip === e.ip }, `${x.ip} (${x.nome})`))))
      : null;
    const codigo = e.codigo ? `${e.codigo.slice(0, 4)}-${e.codigo.slice(4)}` : "—";
    return el("section", { class: "aj-grupo" }, el("h3", { text: "Parear um celular" }),
      el("div", { class: "cel-parear" }, caixaQr,
        el("div", { class: "cel-passos" },
          el("p", {}, el("b", { text: "1." }), " Aponte a câmera do celular para o código ao lado e abra o link."),
          el("p", {}, el("b", { text: "2." }), " Ou abra no navegador do celular ", el("code", { class: "cel-url", text: e.url }), " e digite:"),
          el("div", { class: "cel-codigo", "aria-label": "código de pareamento" }, ...[...codigo].map((ch, i) => el("span", { style: { "--i": i }, text: ch }))),
          resta, el("div", { class: "aj-acoes" }, gerar), escolherIp)));
  }

  blocoAparelhos(e) {
    const linha = a => {
      const remover = el("button", { type: "button", class: "btn pequeno", onclick: async () => {
        if (!remover.dataset.armado) {
          remover.dataset.armado = "1"; remover.textContent = "Confirmar?"; remover.classList.add("perigo");
          setTimeout(() => { delete remover.dataset.armado; remover.textContent = "Remover"; remover.classList.remove("perigo"); }, 3000);
          return;
        }
        try { this.e = await api(`/api/celular/aparelhos/${encodeURIComponent(a.id)}/remover`, { method: "POST" }); this.desenhar(); } catch (er) { avisar({ texto: er.message, cor: "#ff6b7d" }); }
      } }, "Remover");
      return el("li", { class: `cel-aparelho${a.conectado ? " on" : ""}` },
        el("i", { class: "cel-ponto" }),
        el("div", {}, el("b", { text: a.nome }),
          el("small", { text: a.conectado ? "conectado agora" : `pareado em ${dataCurta(a.criado)} · visto ${dataCurta(a.visto)}` })),
        el("span", { class: "empurra" }), remover);
    };
    return el("section", { class: "aj-grupo" }, el("h3", { text: "Aparelhos pareados" }),
      e.aparelhos.length ? el("ul", { class: "cel-aparelhos" }, ...e.aparelhos.map(linha)) : el("p", { class: "aj-nota", text: "Nenhum ainda." }));
  }
}
