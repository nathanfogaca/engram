// A vista Código (o lado "VS Code" do Engram): a pasta de um projeto, os arquivos dela, o git e os terminais.
// Tudo fica preso dentro da pasta aberta: caminho que sai dela é recusado. Os terminais rodam no motor, como
// os agentes, e um vigia avisa a tela quando um arquivo muda no disco (um agente mexeu, por exemplo).
// A lógica de arquivos e do git veio do Orbion (Lucas Lessa), que passou a fazer parte do Engram.

const fs = require('node:fs');
const path = require('node:path');
const { shell } = require('electron');
const git = require('./codigo-git');
const { perguntar } = require('./uma-vez');

const OCULTOS = new Set(['.git']);
// pastas que a busca rápida (Ctrl+P) não percorre
const PESADOS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.venv', 'venv', '__pycache__', 'target', 'bin', 'obj']);
const LIMITE_EDITOR = 5 * 1024 * 1024;

function acharNoPath(nome) {
  for (const d of String(process.env.PATH || '').split(path.delimiter)) {
    const p = path.join(d, nome);
    if (d && fs.existsSync(p)) return p;
  }
  return null;
}

class Codigo {
  constructor({ cfg, salvarConfig, avisar, janelas, provedores, registrar }) {
    Object.assign(this, { cfg, salvarConfig, avisar, janelas, provedores, registrar });
    this.vigia = null;
    this.vigiando = null;
    this.ocupadoIa = null; // AbortController da pergunta à IA em andamento
  }

  /** A pasta aberta: a que a pessoa escolheu ou, sem escolha, a pasta de trabalho dos agentes. */
  get raiz() {
    const p = this.cfg.codigo_pasta;
    return p && fs.existsSync(p) ? p : this.cfg.pasta_trabalho;
  }

  info() {
    const raiz = this.raiz;
    this.vigiar();
    return { raiz, nome: path.basename(raiz) || raiz, recentes: (this.cfg.codigo_recentes || []).filter(p => p !== raiz && fs.existsSync(p)).slice(0, 8), shells: this.shells().map(({ id, nome }) => ({ id, nome })) };
  }

  abrirPasta(caminho) {
    const p = path.resolve(String(caminho || '').trim());
    if (!caminho || !fs.existsSync(p) || !fs.statSync(p).isDirectory()) throw new Error('essa pasta não existe');
    const recentes = [p, ...(this.cfg.codigo_recentes || []).filter(x => x.toLowerCase() !== p.toLowerCase())].slice(0, 10);
    this.cfg.codigo_pasta = p;
    this.cfg.codigo_recentes = recentes;
    this.salvarConfig({ codigo_pasta: p, codigo_recentes: recentes });
    this.vigiar(true);
    return this.info();
  }

  // ---------------------------------------------------------------- arquivos

  dentro(rel = '') {
    const raiz = this.raiz;
    const alvo = path.resolve(raiz, String(rel || ''));
    const r = path.relative(raiz, alvo);
    if (r.startsWith('..') || path.isAbsolute(r)) throw new Error('esse caminho está fora da pasta aberta');
    return alvo;
  }

  paraRel(abs) { return path.relative(this.raiz, abs).split(path.sep).join('/'); }

  listar(rel = '') {
    const pasta = this.dentro(rel);
    return fs.readdirSync(pasta, { withFileTypes: true })
      .filter(d => !OCULTOS.has(d.name))
      .map(d => ({ nome: d.name, rel: this.paraRel(path.join(pasta, d.name)), pasta: d.isDirectory() }))
      .sort((a, b) => (b.pasta - a.pasta) || a.nome.localeCompare(b.nome, 'pt-BR', { sensitivity: 'base' }));
  }

  ler(rel) {
    const alvo = this.dentro(rel);
    const info = fs.statSync(alvo);
    if (info.isDirectory()) throw new Error('isso é uma pasta');
    if (info.size > LIMITE_EDITOR) return { grande: true, tamanho: info.size };
    const buf = fs.readFileSync(alvo);
    if (buf.subarray(0, 8000).includes(0)) return { binario: true, tamanho: info.size };
    return { texto: buf.toString('utf8'), tamanho: info.size };
  }

  salvar(rel, texto) {
    const alvo = this.dentro(rel);
    fs.mkdirSync(path.dirname(alvo), { recursive: true });
    fs.writeFileSync(alvo, String(texto ?? ''));
    return { ok: true };
  }

  criar(rel, pasta) {
    const alvo = this.dentro(rel);
    if (!rel || fs.existsSync(alvo)) throw new Error('já existe um arquivo ou pasta com esse nome');
    if (pasta) fs.mkdirSync(alvo, { recursive: true });
    else { fs.mkdirSync(path.dirname(alvo), { recursive: true }); fs.writeFileSync(alvo, ''); }
    return { ok: true };
  }

  renomear(de, para) {
    const a = this.dentro(de), b = this.dentro(para);
    if (!de || !para) throw new Error('nome vazio');
    if (fs.existsSync(b) && a.toLowerCase() !== b.toLowerCase()) throw new Error('já existe um arquivo ou pasta com esse nome');
    fs.mkdirSync(path.dirname(b), { recursive: true });
    fs.renameSync(a, b);
    return { ok: true };
  }

  async lixeira(rel) {
    if (!rel) throw new Error('a própria pasta aberta não vai para a lixeira por aqui');
    await shell.trashItem(this.dentro(rel));
    return { ok: true };
  }

  /** Todos os arquivos, para a busca rápida (Ctrl+P), sem as pastas pesadas. */
  todos(limite = 20_000) {
    const raiz = this.raiz;
    const saida = [];
    const pilha = [''];
    while (pilha.length && saida.length < limite) {
      const rel = pilha.pop();
      let itens = [];
      try { itens = fs.readdirSync(path.join(raiz, rel), { withFileTypes: true }); } catch { continue; }
      for (const d of itens) {
        const r = rel ? `${rel}/${d.name}` : d.name;
        if (d.isDirectory()) { if (!PESADOS.has(d.name)) pilha.push(r); } else saida.push(r);
      }
    }
    return saida.sort();
  }

  /** Vigia a pasta aberta: avisa a tela dos arquivos que mudaram (e do git, quando o .git mexe). */
  vigiar(forcar = false) {
    const raiz = this.raiz;
    if (!forcar && this.vigiando === raiz && this.vigia) return;
    try { this.vigia?.close(); } catch { /* já fechado */ }
    this.vigia = null;
    this.vigiando = raiz;
    let rels = new Set(), mexeuGit = false, timer = null;
    try {
      this.vigia = fs.watch(raiz, { recursive: true }, (_tipo, nome) => {
        if (!nome) return;
        const rel = String(nome).split(path.sep).join('/');
        if (/^\.git(\/|$)/.test(rel)) { if (/^\.git\/(HEAD|index|refs\/)/.test(rel)) mexeuGit = true; else return; }
        else if (/(^|\/)node_modules(\/|$)/.test(rel)) return;
        else rels.add(rel);
        clearTimeout(timer);
        timer = setTimeout(() => {
          this.avisar({ tipo: 'codigo', evento: 'fs', raiz, rels: [...rels].slice(0, 500), git: mexeuGit || rels.size > 0 });
          rels = new Set(); mexeuGit = false;
        }, 300);
      });
      this.vigia.on('error', () => { try { this.vigia?.close(); } catch { /* segue */ } this.vigia = null; });
    } catch (e) { this.registrar?.(`vista Código: não deu para vigiar ${raiz} (${e.message})`); }
  }

  // ---------------------------------------------------------------- terminais

  shells() {
    if (process.platform !== 'win32') return [{ id: 'padrao', nome: process.env.SHELL || 'bash', cmd: process.env.SHELL || 'bash', args: ['-l'] }];
    // caminho completo: o motor não acha o programa só pelo nome (o Windows nega com "error code: 5")
    const sistema = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
    const lista = [];
    const pwsh = acharNoPath('pwsh.exe');
    if (pwsh) lista.push({ id: 'pwsh', nome: 'PowerShell 7', cmd: pwsh, args: ['-NoLogo'] });
    const ps = path.join(sistema, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    lista.push({ id: 'powershell', nome: 'PowerShell', cmd: fs.existsSync(ps) ? ps : acharNoPath('powershell.exe') || 'powershell.exe', args: ['-NoLogo'] });
    const bash = ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe'].find(p => fs.existsSync(p));
    if (bash) lista.push({ id: 'bash', nome: 'Git Bash', cmd: bash, args: ['--login', '-i'] });
    lista.push({ id: 'cmd', nome: 'Prompt de Comando', cmd: process.env.ComSpec || path.join(sistema, 'cmd.exe'), args: [] });
    return lista;
  }

  async abrirTerminal(shellId) {
    const opcoes = this.shells();
    const s = opcoes.find(x => x.id === shellId) || opcoes[0];
    const id = await this.janelas.abrirTerminal([s.cmd, ...s.args], this.raiz);
    return { id, nome: s.nome };
  }

  // ---------------------------------------------------------------- git

  async mensagemCommit() {
    const diff = await git.diffParaMensagem(this.raiz);
    if (!diff.trim()) throw new Error('não há mudanças para descrever');
    this.ocupadoIa?.abort();
    this.ocupadoIa = new AbortController();
    const prompt = [
      'Escreva a mensagem de um commit git para as mudanças abaixo.',
      '- Primeira linha: resumo curto (até 72 caracteres), no imperativo ou descrevendo o que muda.',
      '- Se precisar, uma linha em branco e depois tópicos curtos com o que importa.',
      '- No idioma das mensagens anteriores do projeto; na dúvida, em português.',
      '- Responda só com a mensagem, sem aspas e sem comentários.',
      '', 'Mudanças:', diff,
    ].join('\n');
    try {
      return await perguntar(this.provedores, { prompt, cwd: this.raiz, modelo: this.cfg.codigo_modelo_ia || '', sinal: this.ocupadoIa.signal, tempo: 120_000 });
    } finally { this.ocupadoIa = null; }
  }

  // ---------------------------------------------------------------- rotas (a tela fala por aqui)

  registrarRotas(rota) {
    const g = fn => async (_, b) => { const r = await fn(b || {}); return r === undefined ? { ok: true } : r; };
    rota('GET', '/api/codigo', () => this.info());
    rota('POST', '/api/codigo/pasta', (_, b) => this.abrirPasta(b.caminho));
    rota('GET', '/api/codigo/listar', (_, __, q) => this.listar(q.get('rel') || ''));
    rota('GET', '/api/codigo/ler', (_, __, q) => this.ler(q.get('rel') || ''));
    rota('GET', '/api/codigo/todos', () => this.todos());
    rota('POST', '/api/codigo/salvar', (_, b) => this.salvar(b.rel, b.texto));
    rota('POST', '/api/codigo/criar', (_, b) => this.criar(b.rel, !!b.pasta));
    rota('POST', '/api/codigo/renomear', (_, b) => this.renomear(b.de, b.para));
    rota('POST', '/api/codigo/lixeira', (_, b) => this.lixeira(b.rel));
    rota('POST', '/api/codigo/revelar', (_, b) => { shell.showItemInFolder(this.dentro(b.rel || '')); return { ok: true }; });
    rota('POST', '/api/codigo/externo', async (_, b) => { const e = await shell.openPath(this.dentro(b.rel || '')); if (e) throw new Error(e); return { ok: true }; });
    rota('POST', '/api/codigo/link', (_, b) => { const u = String(b.url || ''); if (!/^https:\/\//.test(u)) throw new Error('endereço inválido'); shell.openExternal(u); return { ok: true }; });
    // terminais
    rota('POST', '/api/codigo/terminais', (_, b) => this.abrirTerminal(b.shell));
    rota('POST', '/api/codigo/terminais/:id/fechar', p => { this.janelas.fecharTerminal(p.id); return { ok: true }; });
    // git
    rota('GET', '/api/codigo/git', () => git.situacao(this.raiz));
    rota('GET', '/api/codigo/git/original', (_, __, q) => git.noCommit(this.raiz, this.dentro(q.get('rel') || '')));
    rota('GET', '/api/codigo/git/indice', (_, __, q) => git.noIndice(this.raiz, String(q.get('rel') || '')));
    rota('GET', '/api/codigo/git/ramos', () => git.ramos(this.raiz));
    rota('POST', '/api/codigo/git/preparar', g(b => git.preparar(this.raiz, (b.rels || []).map(String))));
    rota('POST', '/api/codigo/git/despreparar', g(b => git.despreparar(this.raiz, (b.rels || []).map(String))));
    rota('POST', '/api/codigo/git/descartar', g(b => git.descartar(this.raiz, (b.rels || []).map(String), (b.novos || []).map(String), rel => shell.trashItem(this.dentro(rel)))));
    rota('POST', '/api/codigo/git/commit', g(async b => ({ hash: await git.commit(this.raiz, b.mensagem, { tudo: !!b.tudo }) })));
    rota('POST', '/api/codigo/git/trocar-ramo', g(b => git.trocarRamo(this.raiz, String(b.nome || ''))));
    rota('POST', '/api/codigo/git/criar-ramo', g(async b => ({ nome: await git.criarRamo(this.raiz, b.nome) })));
    rota('POST', '/api/codigo/git/puxar', g(() => git.puxar(this.raiz)));
    rota('POST', '/api/codigo/git/enviar', g(() => git.enviar(this.raiz)));
    rota('POST', '/api/codigo/git/sincronizar', g(() => git.sincronizar(this.raiz)));
    rota('POST', '/api/codigo/git/buscar', g(() => git.buscar(this.raiz)));
    rota('POST', '/api/codigo/git/iniciar', g(() => git.iniciar(this.raiz)));
    rota('POST', '/api/codigo/git/publicar', g(async b => ({ url: await git.publicarNoGitHub(this.raiz, { nome: b.nome, privado: b.privado !== false }) })));
    rota('POST', '/api/codigo/git/mensagem', g(async () => ({ mensagem: await this.mensagemCommit() })));
  }
}

module.exports = { Codigo };
