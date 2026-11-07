// Servidores de linguagem (LSP): o IntelliSense de verdade no editor da vista Código, do mesmo jeito que o
// VS Code faz. Cada servidor é um programa à parte que entende uma linguagem: autocompletar com tipos,
// documentação ao passar o mouse, assinatura das funções, ir para a definição e erros sublinhados.
// O Engram baixa o servidor do npm (conferindo a assinatura SHA-512 do registro), roda com o Node do motor e
// conversa com ele pelo protocolo LSP; a tela só pede e mostra.

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');

// o catálogo: servidores sem dependências (o pacote do npm já vem completo)
const CATALOGO = {
  python: {
    nome: 'Python (Pyright)', descricao: 'O núcleo de código aberto do Pylance: tipos, autocompletar, documentação e erros no Python.',
    pacote: 'pyright', entrada: 'langserver.index.js', args: ['--stdio'], linguagens: ['python'], licenca: 'MIT',
    configuracao: { python: { analysis: { typeCheckingMode: 'basic', autoSearchPaths: true, useLibraryCodeForTypes: true, diagnosticMode: 'openFilesOnly' } } },
  },
};

/** Abre um .tgz do npm (tar dentro de gzip) só com o Node: arquivos comuns, cabeçalhos PAX e caminhos longos. */
function extrairTgz(buf, destino) {
  const tar = zlib.gunzipSync(buf);
  let p = 0, nomeLongo = null;
  const base = path.resolve(destino);
  while (p + 512 <= tar.length) {
    const cab = tar.subarray(p, p + 512);
    if (cab.every(b => b === 0)) break;
    const txt = (i, n) => cab.subarray(i, i + n).toString('utf8').replace(/\0.*$/s, '');
    let nome = txt(0, 100);
    const tamanho = parseInt(txt(124, 12).trim() || '0', 8);
    const tipo = String.fromCharCode(cab[156] || 48);
    const prefixo = txt(345, 155);
    if (prefixo) nome = `${prefixo}/${nome}`;
    const dados = tar.subarray(p + 512, p + 512 + tamanho);
    p += 512 + Math.ceil(tamanho / 512) * 512;
    if (tipo === 'x' || tipo === 'g') { const m = /\d+ path=([^\n]+)\n/.exec(dados.toString('utf8')); if (m && tipo === 'x') nomeLongo = m[1]; continue; }
    if (tipo === 'L') { nomeLongo = dados.toString('utf8').replace(/\0.*$/s, ''); continue; }
    if (nomeLongo) { nome = nomeLongo; nomeLongo = null; }
    const rel = nome.replace(/^package\//, '');
    if (!rel || (tipo !== '0' && tipo !== '\0' && tipo !== '5')) continue;
    const alvo = path.resolve(base, rel);
    if (!alvo.startsWith(base + path.sep)) throw new Error('o pacote tem um caminho perigoso');
    if (tipo === '5') { fs.mkdirSync(alvo, { recursive: true }); continue; }
    fs.mkdirSync(path.dirname(alvo), { recursive: true });
    fs.writeFileSync(alvo, dados);
  }
}

/** Uma conversa LSP com um servidor (mensagens com Content-Length pela entrada e saída padrão). */
class Conexao {
  constructor({ node, script, args, raiz, configuracao, aoAviso, aoFim, registrar }) {
    Object.assign(this, { raiz, configuracao, aoAviso, aoFim, registrar });
    this.n = 0;
    this.esperando = new Map();
    this.buffer = Buffer.alloc(0);
    this.processo = spawn(node, [script, ...args], { cwd: raiz, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    this.processo.stdout.on('data', d => this.ler(d));
    this.processo.stderr.on('data', d => { this.ultimoErro = String(d).slice(-500); });
    this.processo.on('exit', codigo => {
      this.vivo = false;
      for (const { rejeitar } of this.esperando.values()) rejeitar(new Error('o servidor de linguagem fechou'));
      this.esperando.clear();
      this.aoFim?.(codigo, this.ultimoErro);
    });
    this.processo.stdin.on('error', () => {});
    this.vivo = true;
  }

  ler(d) {
    this.buffer = Buffer.concat([this.buffer, d]);
    for (;;) {
      const fim = this.buffer.indexOf('\r\n\r\n');
      if (fim < 0) return;
      const m = /Content-Length: (\d+)/i.exec(this.buffer.subarray(0, fim).toString('ascii'));
      if (!m) { this.buffer = this.buffer.subarray(fim + 4); continue; }
      const tam = Number(m[1]);
      if (this.buffer.length < fim + 4 + tam) return;
      const corpo = this.buffer.subarray(fim + 4, fim + 4 + tam).toString('utf8');
      this.buffer = this.buffer.subarray(fim + 4 + tam);
      let msg;
      try { msg = JSON.parse(corpo); } catch { continue; }
      this.tratar(msg);
    }
  }

  escrever(msg) {
    if (!this.vivo) return;
    const corpo = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...msg }), 'utf8');
    this.processo.stdin.write(`Content-Length: ${corpo.length}\r\n\r\n`);
    this.processo.stdin.write(corpo);
  }

  pedir(method, params, tempo = 15_000) {
    if (!this.vivo) return Promise.reject(new Error('o servidor de linguagem não está rodando'));
    const id = ++this.n;
    return new Promise((resolve, rejeitar) => {
      const t = setTimeout(() => { this.esperando.delete(id); rejeitar(new Error(`o servidor demorou para responder (${method})`)); }, tempo);
      this.esperando.set(id, { resolve: r => { clearTimeout(t); resolve(r); }, rejeitar: e => { clearTimeout(t); rejeitar(e); } });
      this.escrever({ id, method, params });
    });
  }

  avisar(method, params) { this.escrever({ method, params }); }

  tratar(msg) {
    if (msg.id != null && (msg.result !== undefined || msg.error) && this.esperando.has(msg.id)) {
      const e = this.esperando.get(msg.id);
      this.esperando.delete(msg.id);
      if (msg.error) e.rejeitar(new Error(msg.error.message || 'erro do servidor de linguagem')); else e.resolve(msg.result);
      return;
    }
    if (msg.id != null && msg.method) {
      // pedidos do servidor para o "editor"
      let result = null;
      if (msg.method === 'workspace/configuration') result = (msg.params?.items || []).map(it => (it.section ? it.section.split('.').reduce((o, k) => o?.[k], this.configuracao) ?? null : this.configuracao));
      else if (msg.method === 'workspace/workspaceFolders') result = [{ uri: pathToFileURL(this.raiz).href, name: path.basename(this.raiz) }];
      this.escrever({ id: msg.id, result });
      return;
    }
    if (msg.method) this.aoAviso?.(msg.method, msg.params);
  }

  async iniciar() {
    const raizUri = pathToFileURL(this.raiz).href;
    this.capacidades = (await this.pedir('initialize', {
      processId: process.pid, rootUri: raizUri, rootPath: this.raiz, workspaceFolders: [{ uri: raizUri, name: path.basename(this.raiz) }],
      clientInfo: { name: 'Engram' }, locale: 'pt-br',
      capabilities: {
        workspace: { configuration: true, workspaceFolders: true, didChangeConfiguration: { dynamicRegistration: true } },
        textDocument: {
          synchronization: { didSave: true, dynamicRegistration: false },
          completion: { completionItem: { snippetSupport: true, documentationFormat: ['markdown', 'plaintext'], resolveSupport: { properties: ['documentation', 'detail'] } }, contextSupport: true },
          hover: { contentFormat: ['markdown', 'plaintext'] },
          signatureHelp: { signatureInformation: { documentationFormat: ['markdown', 'plaintext'], parameterInformation: { labelOffsetSupport: true } } },
          definition: { linkSupport: false }, references: {}, documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          publishDiagnostics: { relatedInformation: false, tagSupport: { valueSet: [1, 2] } }, rename: { prepareSupport: false },
        },
      },
    }, 60_000))?.capabilities || {};
    this.avisar('initialized', {});
    this.avisar('workspace/didChangeConfiguration', { settings: this.configuracao });
    return this.capacidades;
  }

  parar() {
    try { this.pedir('shutdown', null, 2000).catch(() => {}).finally(() => { this.avisar('exit', null); setTimeout(() => { try { this.processo.kill(); } catch { /* já saiu */ } }, 800); }); } catch { /* já saiu */ }
  }
}

class Linguagens {
  constructor({ dados, codigo, janelas, avisar, registrar, cfg, salvarConfig }) {
    Object.assign(this, { codigo, janelas, avisar, registrar, cfg, salvarConfig });
    this.pasta = path.join(dados, 'linguagens');
    this.conexoes = new Map(); // id → { conexao, raiz, pronto }
    this.instalando = new Set();
  }

  pastaDe(id) { return path.join(this.pasta, id); }
  instalado(id) { const c = CATALOGO[id]; return !!c && fs.existsSync(path.join(this.pastaDe(id), c.entrada)); }
  versao(id) { try { return JSON.parse(fs.readFileSync(path.join(this.pastaDe(id), 'package.json'), 'utf8')).version; } catch { return null; } }
  ligado(id) { return !(this.cfg.linguagens_desligadas || []).includes(id); }

  lista() {
    return Object.entries(CATALOGO).map(([id, c]) => {
      const con = this.conexoes.get(id);
      return {
        id, nome: c.nome, descricao: c.descricao, licenca: c.licenca, linguagens: c.linguagens, instalado: this.instalado(id), versao: this.versao(id), ligado: this.ligado(id),
        instalando: this.instalando.has(id), estado: con ? (con.pronto ? 'rodando' : 'iniciando') : 'parado', capacidades: con?.capacidades || null,
      };
    });
  }

  async instalar(id) {
    const c = CATALOGO[id];
    if (!c) throw new Error('servidor desconhecido');
    if (this.instalando.has(id)) throw new Error('já está instalando');
    this.instalando.add(id);
    this.avisar({ tipo: 'lsp', evento: 'lista' });
    try {
      const meta = await (await fetch(`https://registry.npmjs.org/${c.pacote}/latest`)).json();
      const r = await fetch(meta.dist.tarball);
      if (!r.ok) throw new Error(`o download falhou (${r.status})`);
      const buf = Buffer.from(await r.arrayBuffer());
      const [algo, hash] = String(meta.dist.integrity || '').split('-');
      if (!algo || !hash) throw new Error('o registro do npm não informou a assinatura do pacote');
      if (crypto.createHash(algo).update(buf).digest('base64') !== hash) throw new Error('o pacote baixado não bate com a assinatura do npm: instalação cancelada');
      const temp = `${this.pastaDe(id)}.parcial`;
      fs.rmSync(temp, { recursive: true, force: true });
      fs.mkdirSync(temp, { recursive: true });
      extrairTgz(buf, temp);
      if (!fs.existsSync(path.join(temp, c.entrada))) throw new Error('o pacote não tem o servidor de linguagem esperado');
      this.parar(id);
      fs.rmSync(this.pastaDe(id), { recursive: true, force: true });
      fs.renameSync(temp, this.pastaDe(id));
      return { ok: true, versao: meta.version };
    } finally {
      this.instalando.delete(id);
      this.avisar({ tipo: 'lsp', evento: 'lista' });
    }
  }

  remover(id) {
    this.parar(id);
    fs.rmSync(this.pastaDe(id), { recursive: true, force: true });
    this.avisar({ tipo: 'lsp', evento: 'lista' });
    return { ok: true };
  }

  parar(id) {
    const c = this.conexoes.get(id);
    if (!c) return;
    this.conexoes.delete(id);
    c.conexao.aoFim = null;
    c.conexao.parar();
  }

  /** A conexão com o servidor, aberta (e iniciada) na pasta atual da vista Código. */
  async conexao(id) {
    const raiz = this.codigo.raiz;
    let c = this.conexoes.get(id);
    if (c && c.raiz !== raiz) { this.parar(id); c = null; }
    if (c) { await c.inicio; return c; }
    const cat = CATALOGO[id];
    if (!cat || !this.instalado(id)) throw new Error('servidor de linguagem não instalado');
    if (!this.ligado(id)) throw new Error('servidor de linguagem desligado');
    const node = this.janelas.motor?.runtime?.node && fs.existsSync(this.janelas.motor.runtime.node) ? this.janelas.motor.runtime.node : process.execPath;
    const conexao = new Conexao({
      node, script: path.join(this.pastaDe(id), cat.entrada), args: cat.args, raiz, configuracao: cat.configuracao, registrar: this.registrar,
      aoAviso: (method, params) => {
        if (method === 'textDocument/publishDiagnostics') this.avisar({ tipo: 'lsp', evento: 'diagnosticos', servidor: id, uri: params.uri, diagnosticos: params.diagnostics || [] });
      },
      aoFim: (codigo, ultimo) => {
        this.conexoes.delete(id);
        this.registrar?.(`servidor de linguagem ${id} fechou (código ${codigo})${ultimo ? `: ${ultimo.split('\n').slice(-2).join(' ')}` : ''}`);
        this.avisar({ tipo: 'lsp', evento: 'parou', servidor: id });
      },
    });
    c = { conexao, raiz, pronto: false };
    c.inicio = conexao.iniciar().then(cap => { c.pronto = true; c.capacidades = cap; this.avisar({ tipo: 'lsp', evento: 'lista' }); });
    this.conexoes.set(id, c);
    try { await c.inicio; } catch (e) { this.parar(id); throw e; }
    return c;
  }

  registrarRotas(rota) {
    rota('GET', '/api/linguagens', () => this.lista());
    rota('POST', '/api/linguagens/instalar', (_, b) => this.instalar(String(b.id || '')));
    rota('POST', '/api/linguagens/remover', (_, b) => this.remover(String(b.id || '')));
    rota('POST', '/api/linguagens/ligar', (_, b) => {
      const fora = new Set(this.cfg.linguagens_desligadas || []);
      if (b.ligado) fora.delete(b.id); else { fora.add(String(b.id)); this.parar(b.id); }
      this.cfg.linguagens_desligadas = [...fora];
      this.salvarConfig({ linguagens_desligadas: this.cfg.linguagens_desligadas });
      this.avisar({ tipo: 'lsp', evento: 'lista' });
      return { ok: true };
    });
    // a tela conversa com o servidor por aqui: pedidos (com resposta) e avisos (didOpen, didChange...)
    rota('POST', '/api/lsp/iniciar', async (_, b) => { const c = await this.conexao(String(b.servidor || '')); return { capacidades: c.capacidades, raiz: c.raiz }; });
    rota('POST', '/api/lsp/pedido', async (_, b) => { const c = await this.conexao(String(b.servidor || '')); return { resultado: await c.conexao.pedir(String(b.method), b.params) }; });
    rota('POST', '/api/lsp/aviso', async (_, b) => { const c = await this.conexao(String(b.servidor || '')); c.conexao.avisar(String(b.method), b.params); return { ok: true }; });
  }

  pararTudo() { for (const id of [...this.conexoes.keys()]) this.parar(id); }
}

module.exports = { Linguagens, CATALOGO };
