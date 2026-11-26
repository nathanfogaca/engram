// Pedido de segredo de um agente (ferramenta pedir_segredo): um campo por variável do .env. O que a pessoa
// digita vai direto para o app gravar no arquivo; o agente recebe só os nomes. Esc é recusar. Os campos
// são limpos assim que a janela fecha, e nada do que é digitado fica guardado na tela.

import { el, api, avisar } from "./util.js";

let dlg = null;
let atual = null;

export function mostrarSegredo(p) {
  if (!p) return;
  if (atual?.id === p.id && dlg?.open) return;
  fecharLocal();
  atual = p;
  const entradas = new Map();
  const campos = (p.campos || []).map((c, i) => {
    const entrada = el("input", {
      class: "ps-entrada", type: c.secreto ? "password" : "text", spellcheck: "false",
      autocomplete: c.secreto ? "new-password" : "off", "data-1p-ignore": "", "data-lpignore": "true",
      placeholder: c.existe ? "já tem valor no arquivo · em branco mantém" : c.secreto ? "cole aqui" : "",
    });
    if (!c.secreto && c.valor) entrada.value = c.valor;
    entradas.set(c.nome, entrada);
    const olho = c.secreto ? el("button", { type: "button", class: "ps-olho", title: "Mostrar ou esconder", text: "👁" }) : null;
    if (olho) olho.onclick = () => { entrada.type = entrada.type === "password" ? "text" : "password"; entrada.focus(); };
    return el("label", { class: "ps-campo", style: { "--i": i } },
      el("div", { class: "ps-cab" },
        el("b", { class: "ps-nome", text: c.nome }),
        c.secreto ? el("span", { class: "ps-selo", text: "segredo" }) : el("span", { class: "ps-selo aberto", text: "o agente vê" }),
        c.existe ? el("span", { class: "ps-selo existe", text: "já existe" }) : null),
      c.descricao ? el("div", { class: "ps-desc", text: c.descricao }) : null,
      el("div", { class: "ps-linha" }, entrada, olho));
  });
  dlg = el("dialog", { class: "dlg dlg-pedido dlg-segredo" },
    el("form", { method: "dialog", autocomplete: "off" },
      el("header", {},
        el("div", { class: "ps-cadeado", text: "🔒" }),
        el("h2", { text: `${p.quem} precisa de ${p.campos.length === 1 ? "um valor" : `${p.campos.length} valores`} para o .env` }),
        p.motivo ? el("p", { class: "pa-motivo", text: p.motivo }) : null,
        el("div", { class: "ps-arquivo", title: p.arquivo }, el("span", { text: "grava em" }), el("code", { text: p.arquivo }))),
      el("div", { class: "ps-campos" }, ...campos),
      el("p", { class: "ps-nota", text: "O que você digitar vai direto para o arquivo. O agente não vê os segredos: ele recebe só os nomes que foram gravados, e o Engram barra ele de abrir esse arquivo." }),
      el("footer", {},
        el("button", { class: "btn", value: "recusar", text: "Recusar" }),
        el("button", { class: "btn-brilho", value: "gravar" }, el("span", { text: "Gravar no .env" })))));
  const id = p.id;
  const limpar = () => { for (const e of entradas.values()) e.value = ""; };
  // Enter num campo vai para o próximo; no último, grava (sem isso o Enter apertaria o primeiro botão, Recusar)
  const lista = [...entradas.values()];
  dlg.addEventListener("keydown", e => {
    if (e.key !== "Enter" || e.isComposing || !e.target.classList?.contains("ps-entrada")) return;
    e.preventDefault();
    const i = lista.indexOf(e.target);
    if (i >= 0 && i < lista.length - 1) lista[i + 1].focus();
    else dlg.close("gravar");
  });
  dlg.addEventListener("cancel", e => { e.preventDefault(); dlg.close("recusar"); }); // Esc = recusar
  dlg.addEventListener("close", () => {
    const fim = dlg?.dataset.fim === "1";
    const gravar = dlg?.returnValue === "gravar";
    const valores = gravar && !fim ? Object.fromEntries([...entradas].map(([n, e]) => [n, e.value])) : null;
    limpar();
    dlg?.remove();
    dlg = null;
    atual = null;
    if (fim) return; // já respondido ou vencido: só fecha
    api(`/api/segredos/pedido/${id}`, { json: { aceitar: gravar, valores } })
      .then(r => avisar({ rota: "Segredos", texto: r?.resumo || (gravar ? "gravado" : "pedido recusado"), cor: gravar ? "#4ade9f" : "#ffc857", tempo: gravar ? 7000 : 4000 }))
      .catch(e => avisar({ rota: "Segredos", texto: e.message, cor: "#ff6b7d" }));
  });
  document.body.append(dlg);
  dlg.showModal();
  requestAnimationFrame(() => entradas.values().next().value?.focus());
}

/** O pedido acabou sem esta janela responder (venceu, ou outra janela respondeu). */
export function fecharSegredo(id) {
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
export function conferirSegredo() {
  api("/api/segredos/pedido").then(p => { if (p) mostrarSegredo(p); }).catch(() => {});
}
