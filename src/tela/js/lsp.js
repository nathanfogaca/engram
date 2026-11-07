// O lado do editor dos servidores de linguagem (LSP). Para cada servidor instalado e ligado: mantém o
// servidor a par dos arquivos abertos (didOpen / didChange / didClose) e liga no Monaco o autocompletar,
// a documentação ao passar o mouse, a assinatura das funções, ir para a definição (inclusive em outro
// arquivo da pasta) e os erros sublinhados. As conversas passam pelo app (rotas /api/lsp/*).

import { el, api, avisar } from "./util.js";

const ic = (nome, extra = "") => el("i", { class: `codicon codicon-${nome} ${extra}`.trim() });
const erro = e => avisar({ texto: e.message || String(e), cor: "#ff6b7d", tempo: 7000 });
const KINDS = ["", "Text", "Method", "Function", "Constructor", "Field", "Variable", "Class", "Interface", "Module", "Property", "Unit", "Value", "Enum", "Keyword", "Snippet", "Color", "File", "Reference", "Folder", "EnumMember", "Constant", "Struct", "Event", "Operator", "TypeParameter"];
const markdown = d => (!d ? undefined : typeof d === "string" ? { value: d } : d.kind === "markdown" ? { value: d.value } : { value: "```\n" + (d.value || "") + "\n```" });

export class ClienteLsp {
  constructor(vista) {
    this.vista = vista; // a VistaCodigo
    this.servidores = []; // a lista do app
    this.porLinguagem = new Map(); // linguagem → id do servidor
    this.abertos = new Map(); // uri do modelo → { servidor, versao, timer }
    this.descartaveis = [];
    this.estados = new Map(); // id → 'iniciando' | 'rodando' | 'erro'
  }

  async carregar() {
    try { this.servidores = await api("/api/linguagens"); } catch { this.servidores = []; }
    return this.servidores;
  }

  /** Liga (ou religa) os servidores instalados e ligados. */
  async ligar(monaco) {
    this.monaco = monaco;
    for (const d of this.descartaveis) try { d.dispose(); } catch { /* segue */ }
    this.descartaveis = [];
    for (const [uri, a] of this.abertos) this.fecharDocumento(uri, a);
    this.abertos.clear();
    this.porLinguagem.clear();
    await this.carregar();
    for (const s of this.servidores.filter(x => x.instalado && x.ligado)) for (const l of s.linguagens) this.porLinguagem.set(l, s.id);
    if (!this.porLinguagem.size) return;
    for (const linguagem of this.porLinguagem.keys()) this.registrarProvedores(linguagem);
    if (!this.ouvindoModelos) {
      this.ouvindoModelos = true;
      monaco.editor.onDidCreateModel(m => this.acompanhar(m));
      monaco.editor.registerEditorOpener({ openCodeEditor: (_fonte, recurso, selecao) => this.abrirDefinicao(recurso, selecao) });
    }
    for (const m of monaco.editor.getModels()) this.acompanhar(m);
  }

  servidorDe(modelo) { return this.porLinguagem.get(modelo.getLanguageId()) || null; }
  ehDoProjeto(modelo) { return modelo.uri.scheme === "file"; }

  // ---------------------------------------------------------------- os documentos abertos

  acompanhar(m) {
    if (m._engramLsp) return this.sincronizar(m);
    m._engramLsp = true;
    m.onDidChangeLanguage(() => this.sincronizar(m));
    m.onDidChangeContent(() => {
      const a = this.abertos.get(m.uri.toString());
      if (!a) return;
      clearTimeout(a.timer);
      a.timer = setTimeout(() => {
        a.versao++;
        api("/api/lsp/aviso", { json: { servidor: a.servidor, method: "textDocument/didChange", params: { textDocument: { uri: m.uri.toString(), version: a.versao }, contentChanges: [{ text: m.getValue() }] } } }).catch(() => {});
      }, 250);
    });
    m.onWillDispose(() => { const a = this.abertos.get(m.uri.toString()); if (a) this.fecharDocumento(m.uri.toString(), a); this.abertos.delete(m.uri.toString()); });
    this.sincronizar(m);
  }

  sincronizar(m) {
    const uri = m.uri.toString(), aberto = this.abertos.get(uri), servidor = this.ehDoProjeto(m) ? this.servidorDe(m) : null;
    if (aberto && aberto.servidor !== servidor) { this.fecharDocumento(uri, aberto); this.abertos.delete(uri); }
    if (!servidor || this.abertos.has(uri)) return;
    const a = { servidor, versao: 1, timer: null };
    this.abertos.set(uri, a);
    this.marcarEstado(servidor, "iniciando");
    api("/api/lsp/aviso", { json: { servidor, method: "textDocument/didOpen", params: { textDocument: { uri, languageId: m.getLanguageId(), version: 1, text: m.getValue() } } } })
      .then(() => this.marcarEstado(servidor, "rodando"))
      .catch(e => { this.marcarEstado(servidor, "erro"); erro(new Error(`servidor de linguagem: ${e.message}`)); });
  }

  fecharDocumento(uri, a) {
    clearTimeout(a.timer);
    api("/api/lsp/aviso", { json: { servidor: a.servidor, method: "textDocument/didClose", params: { textDocument: { uri } } } }).catch(() => {});
    const m = this.monaco?.editor.getModel(this.monaco.Uri.parse(uri));
    if (m) this.monaco.editor.setModelMarkers(m, "lsp", []);
  }

  marcarEstado(id, estado) {
    if (this.estados.get(id) === estado) return;
    this.estados.set(id, estado);
    this.vista.desenharStatus?.();
  }

  /** Para a barra de status: o servidor da linguagem do arquivo aberto e o estado dele. */
  estadoPara(linguagem) {
    const id = this.porLinguagem.get(linguagem);
    if (!id) return null;
    const s = this.servidores.find(x => x.id === id);
    return { id, nome: s?.nome || id, estado: this.estados.get(id) || "parado" };
  }

  // ---------------------------------------------------------------- o que o servidor oferece no editor

  pedir(servidor, method, params) {
    return api("/api/lsp/pedido", { json: { servidor, method, params } }).then(r => r.resultado);
  }

  registrarProvedores(linguagem) {
    const monaco = this.monaco, L = monaco.languages;
    const doc = m => ({ uri: m.uri.toString() });
    const pos = p => ({ line: p.lineNumber - 1, character: p.column - 1 });
    const faixa = r => new monaco.Range(r.start.line + 1, r.start.character + 1, r.end.line + 1, r.end.character + 1);
    const servidor = m => (this.ehDoProjeto(m) && this.abertos.has(m.uri.toString()) ? this.servidorDe(m) : null);

    this.descartaveis.push(L.registerCompletionItemProvider(linguagem, {
      triggerCharacters: [".", "[", "\"", "'", "(", ","],
      provideCompletionItems: async (m, p, ctx) => {
        const s = servidor(m);
        if (!s) return { suggestions: [] };
        let r;
        try { r = await this.pedir(s, "textDocument/completion", { textDocument: doc(m), position: pos(p), context: { triggerKind: ctx.triggerKind === 1 ? 2 : 1, ...(ctx.triggerCharacter ? { triggerCharacter: ctx.triggerCharacter } : {}) } }); } catch { return { suggestions: [] }; }
        const itens = Array.isArray(r) ? r : r?.items || [];
        const palavra = m.getWordUntilPosition(p);
        const padrao = new monaco.Range(p.lineNumber, palavra.startColumn, p.lineNumber, palavra.endColumn);
        return {
          incomplete: !!r?.isIncomplete,
          suggestions: itens.slice(0, 400).map(it => {
            const edit = it.textEdit;
            const range = edit ? (edit.range ? faixa(edit.range) : { insert: faixa(edit.insert), replace: faixa(edit.replace) }) : padrao;
            return {
              label: it.label, kind: L.CompletionItemKind[KINDS[it.kind] || "Text"] ?? L.CompletionItemKind.Text,
              detail: it.detail, documentation: markdown(it.documentation), sortText: it.sortText, filterText: it.filterText, preselect: it.preselect,
              insertText: edit?.newText ?? it.insertText ?? it.label, range,
              insertTextRules: it.insertTextFormat === 2 ? L.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
              additionalTextEdits: (it.additionalTextEdits || []).map(e => ({ range: faixa(e.range), text: e.newText })),
              _lsp: it, _servidor: s,
            };
          }),
        };
      },
      resolveCompletionItem: async item => {
        if (!item._lsp || item.documentation) return item;
        try {
          const r = await this.pedir(item._servidor, "completionItem/resolve", item._lsp);
          return { ...item, detail: r?.detail || item.detail, documentation: markdown(r?.documentation) };
        } catch { return item; }
      },
    }));

    this.descartaveis.push(L.registerHoverProvider(linguagem, {
      provideHover: async (m, p) => {
        const s = servidor(m);
        if (!s) return null;
        const r = await this.pedir(s, "textDocument/hover", { textDocument: doc(m), position: pos(p) }).catch(() => null);
        if (!r?.contents) return null;
        const lista = Array.isArray(r.contents) ? r.contents : [r.contents];
        return { contents: lista.map(c => (typeof c === "string" ? { value: c } : c.language ? { value: "```" + c.language + "\n" + c.value + "\n```" } : markdown(c))).filter(Boolean), range: r.range ? faixa(r.range) : undefined };
      },
    }));

    this.descartaveis.push(L.registerSignatureHelpProvider(linguagem, {
      signatureHelpTriggerCharacters: ["(", ","], signatureHelpRetriggerCharacters: [","],
      provideSignatureHelp: async (m, p) => {
        const s = servidor(m);
        if (!s) return null;
        const r = await this.pedir(s, "textDocument/signatureHelp", { textDocument: doc(m), position: pos(p) }).catch(() => null);
        if (!r?.signatures?.length) return null;
        return {
          value: {
            signatures: r.signatures.map(sg => ({ label: sg.label, documentation: markdown(sg.documentation), parameters: (sg.parameters || []).map(pa => ({ label: pa.label, documentation: markdown(pa.documentation) })) })),
            activeSignature: r.activeSignature || 0, activeParameter: r.activeParameter ?? r.signatures[r.activeSignature || 0]?.activeParameter ?? 0,
          },
          dispose() {},
        };
      },
    }));

    this.descartaveis.push(L.registerDefinitionProvider(linguagem, {
      provideDefinition: async (m, p) => {
        const s = servidor(m);
        if (!s) return null;
        const r = await this.pedir(s, "textDocument/definition", { textDocument: doc(m), position: pos(p) }).catch(() => null);
        const lista = (Array.isArray(r) ? r : r ? [r] : []).map(x => ({ uri: x.targetUri || x.uri, range: x.targetSelectionRange || x.range })).filter(x => x.uri && x.range);
        // o Monaco precisa do modelo do outro arquivo para mostrar a definição: cria com o conteúdo do disco
        for (const d of lista) await this.garantirModelo(d.uri);
        return lista.map(d => ({ uri: monaco.Uri.parse(d.uri), range: faixa(d.range) }));
      },
    }));

    this.descartaveis.push(L.registerReferenceProvider(linguagem, {
      provideReferences: async (m, p) => {
        const s = servidor(m);
        if (!s) return [];
        const r = await this.pedir(s, "textDocument/references", { textDocument: doc(m), position: pos(p), context: { includeDeclaration: true } }).catch(() => []);
        for (const d of r || []) await this.garantirModelo(d.uri);
        return (r || []).map(d => ({ uri: monaco.Uri.parse(d.uri), range: faixa(d.range) }));
      },
    }));
  }

  /** O caminho relativo à pasta aberta, se o arquivo estiver dentro dela. */
  relativo(uri) {
    const raiz = this.vista.info?.raiz;
    if (!raiz) return null;
    const caminho = this.monaco.Uri.parse(uri).fsPath.replace(/\\/g, "/");
    const base = raiz.replace(/\\/g, "/").replace(/\/$/, "");
    return caminho.toLowerCase().startsWith(`${base.toLowerCase()}/`) ? caminho.slice(base.length + 1) : null;
  }

  async garantirModelo(uri) {
    const monaco = this.monaco, u = monaco.Uri.parse(uri);
    if (monaco.editor.getModel(u)) return;
    const rel = this.relativo(uri);
    if (!rel) return;
    try {
      const r = await api(`/api/codigo/ler?rel=${encodeURIComponent(rel)}`);
      if (r.texto != null && !monaco.editor.getModel(u)) monaco.editor.createModel(r.texto, this.vista.linguagem(rel), u);
    } catch { /* sem acesso */ }
  }

  /** Ctrl+clique numa definição em outro arquivo: abre a aba dele na vista Código, na linha certa. */
  abrirDefinicao(recurso, selecao) {
    const rel = this.relativo(recurso.toString());
    if (!rel) { avisar({ texto: `A definição está fora da pasta aberta: ${recurso.fsPath}`, cor: "#ffc857" }); return true; }
    this.vista.abrirArquivo(rel).then(() => {
      const ed = this.vista.editor;
      if (!ed || !selecao) return;
      const alvo = selecao.startLineNumber ? selecao : { startLineNumber: selecao.lineNumber, startColumn: selecao.column, endLineNumber: selecao.lineNumber, endColumn: selecao.column };
      ed.setSelection(alvo);
      ed.revealRangeInCenter(alvo);
      ed.focus();
    });
    return true;
  }

  // ---------------------------------------------------------------- os erros sublinhados

  diagnosticos(m) {
    if (!this.monaco) return;
    const modelo = this.monaco.editor.getModel(this.monaco.Uri.parse(m.uri));
    if (!modelo) return;
    const S = this.monaco.MarkerSeverity, sev = [S.Error, S.Error, S.Warning, S.Info, S.Hint];
    this.monaco.editor.setModelMarkers(modelo, "lsp", (m.diagnosticos || []).map(d => ({
      severity: sev[d.severity || 1], message: d.message, source: d.source, code: typeof d.code === "object" ? String(d.code?.value ?? "") : d.code != null ? String(d.code) : undefined,
      startLineNumber: d.range.start.line + 1, startColumn: d.range.start.character + 1, endLineNumber: d.range.end.line + 1, endColumn: d.range.end.character + 1,
      tags: (d.tags || []).map(t => (t === 1 ? 1 : 2)),
    })));
    this.vista.desenharStatus?.();
  }

  aoVivo(m) {
    if (m.evento === "diagnosticos") this.diagnosticos(m);
    else if (m.evento === "parou") { this.marcarEstado(m.servidor, "parado"); for (const [uri, a] of [...this.abertos]) if (a.servidor === m.servidor) this.abertos.delete(uri); }
    else if (m.evento === "lista") this.carregar().then(() => this.vista.redesenharExtensoes?.());
  }

  // ---------------------------------------------------------------- os cartões na aba Extensões

  desenharCartoes() {
    if (!this.servidores.length) return null;
    return el("section", { class: "cod-secao lsp-secao" },
      el("header", { class: "cod-secao-topo" }, el("span", { class: "cod-secao-titulo", text: "Servidores de linguagem (IntelliSense)" })),
      el("div", { class: "cod-secao-corpo" }, this.servidores.map(s => {
        const estado = this.estados.get(s.id) || s.estado;
        return el("div", { class: `lsp-cartao${s.instalado && s.ligado ? " ligado" : ""}` },
          el("div", { class: "lsp-icone" }, ic("symbol-method")),
          el("div", { class: "ext-textos" },
            el("div", { class: "ext-linha1" }, el("b", { text: s.nome }), s.versao ? el("small", { text: s.versao }) : null,
              s.instalado ? el("span", { class: `lsp-estado ${estado}`, text: { rodando: "rodando", iniciando: "abrindo…", erro: "com erro", parado: s.ligado ? "pronto" : "desligado" }[estado] || estado }) : null),
            el("div", { class: "ext-desc", text: s.descricao }),
            el("div", { class: "ext-linha3" }, el("span", { text: `${s.licenca} · ${s.linguagens.join(", ")}` }),
              s.instalando ? el("span", { class: "ext-chip" }, el("span", { class: "giro" }), " Instalando…")
                : !s.instalado ? el("button", { class: "ext-instalar", onclick: () => this.instalar(s) }, "Instalar")
                  : el("span", { class: "lsp-acoes" },
                    el("button", { class: "cod-bt-icone", title: s.ligado ? "Desligar" : "Ligar", onclick: () => this.alternar(s) }, ic(s.ligado ? "debug-pause" : "play")),
                    el("button", { class: "cod-bt-icone", title: "Atualizar para a versão mais nova", onclick: () => this.instalar(s) }, ic("sync")),
                    el("button", { class: "cod-bt-icone", title: "Remover", onclick: () => this.remover(s) }, ic("trash"))))));
      })));
  }

  async instalar(s) {
    try {
      const r = await api("/api/linguagens/instalar", { json: { id: s.id } });
      avisar({ texto: `${s.nome} ${r.versao} instalado: abra um arquivo ${s.linguagens[0]} para usar.`, cor: "#4ade9f" });
      await this.ligar(this.monaco);
    } catch (e) { erro(e); }
    this.vista.redesenharExtensoes?.();
  }

  async alternar(s) {
    await api("/api/linguagens/ligar", { json: { id: s.id, ligado: !s.ligado } }).catch(erro);
    await this.ligar(this.monaco);
    this.vista.redesenharExtensoes?.();
  }

  async remover(s) {
    if (!confirm(`Remover ${s.nome}?`)) return;
    await api("/api/linguagens/remover", { json: { id: s.id } }).catch(erro);
    await this.ligar(this.monaco);
    this.vista.redesenharExtensoes?.();
  }
}
