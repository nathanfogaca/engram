// Pedido de um agente para mudar os ajustes do Engram (ferramenta "ajustar"). A pessoa vê o antes e o depois
// de cada item e os avisos (para onde vai um token, o que roda sem pedir permissão), e aceita ou recusa.
// Fechar com Esc é recusar. Se o pedido vencer ou for respondido em outra janela, esta fecha sozinha.

import { el, api, avisar } from "./util.js";

let dlg = null;
let atual = null;

export function mostrarPedido(p) {
  if (!p) return;
  if (atual?.id === p.id && dlg?.open) return;
  fecharLocal();
  atual = p;
  const itens = (p.itens || []).map(i => el("li", { class: "pa-item" },
    el("div", { class: "pa-cab" }, el("span", { class: "pa-area", text: i.area }), el("b", { text: i.campo })),
    el("div", { class: "pa-antes-depois" },
      el("span", { class: "pa-antes", text: String(i.antes) }),
      el("span", { class: "pa-seta", text: "→" }),
      el("span", { class: "pa-depois", text: String(i.depois) })),
    i.texto_novo ? el("details", { class: "pa-texto" }, el("summary", { text: "ver o texto novo inteiro" }), el("pre", { text: i.texto_novo })) : null));
  dlg = el("dialog", { class: "dlg dlg-pedido" },
    el("form", { method: "dialog" },
      el("header", {},
        el("h2", { text: `${p.quem} quer mudar os ajustes do Engram` }),
        p.motivo ? el("p", { class: "pa-motivo", text: p.motivo }) : null),
      el("ul", { class: "pa-itens" }, ...itens),
      ...(p.avisos || []).map(a => el("p", { class: "pa-aviso", text: a })),
      el("p", { class: "discreto pa-nota", text: "Nada muda se você recusar. O agente fica sabendo da sua resposta." }),
      el("footer", {},
        el("button", { class: "btn", value: "recusar", text: "Recusar" }),
        el("button", { class: "btn-brilho", value: "aceitar" }, el("span", { text: "Aceitar" })))));
  const id = p.id;
  dlg.addEventListener("cancel", e => { e.preventDefault(); dlg.close("recusar"); }); // Esc = recusar
  dlg.addEventListener("close", () => {
    const fim = dlg?.dataset.fim === "1";
    const aceitar = dlg?.returnValue === "aceitar";
    dlg?.remove();
    dlg = null;
    atual = null;
    if (fim) return; // já respondido ou vencido: só fecha
    api(`/api/ajustes/pedido/${id}`, { json: { aceitar } })
      .then(r => avisar({ rota: "Ajustes", texto: aceitar ? (r?.resultado || "mudança aceita") : "pedido recusado: nada mudou", cor: aceitar ? "#4ade9f" : "#ffc857", tempo: aceitar ? 9000 : 4000 }))
      .catch(e => avisar({ rota: "Ajustes", texto: e.message, cor: "#ff6b7d" }));
  });
  document.body.append(dlg);
  dlg.showModal();
}

/** O pedido acabou sem esta janela responder (venceu, ou outra janela respondeu). */
export function fecharPedido(id) {
  if (!dlg || atual?.id !== id) return;
  dlg.dataset.fim = "1";
  dlg.close();
}

function fecharLocal() {
  if (!dlg) return;
  dlg.dataset.fim = "1";
  dlg.close();
}

/** Ao abrir a tela: um pedido que chegou com ela fechada aparece agora. */
export function conferirPedido() {
  api("/api/ajustes/pedido").then(p => { if (p) mostrarPedido(p); }).catch(() => {});
}
