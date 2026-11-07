// As prévias (como os artefatos do Claude): HTML rodando de verdade, imagens, vídeo, áudio, PDF, Markdown e
// CSV, dos arquivos da pasta do projeto (vista Código) e dos que os agentes recebem e entregam.
// Um servidor só deste computador (127.0.0.1, porta aleatória, um código aleatório no caminho) serve os
// arquivos, para o HTML achar o CSS, o JS e as imagens dele. Só serve de dentro das pastas permitidas, nunca
// ocultos (.git, .env, .engram...), e a página roda numa caixa isolada (sandbox) na tela.

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');

const TIPOS = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.map': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif',
  '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.ogv': 'video/ogg',
  '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.m4a': 'audio/mp4',
  '.flac': 'audio/flac', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.csv': 'text/plain; charset=utf-8', '.tsv': 'text/plain; charset=utf-8', '.xml': 'text/xml; charset=utf-8', '.woff': 'font/woff',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.wasm': 'application/wasm',
};

/** Que tipo de prévia cada arquivo tem (null = sem prévia: abre no editor ou no programa padrão). */
function tipoDe(nome) {
  const e = path.extname(String(nome)).toLowerCase();
  if (['.html', '.htm'].includes(e)) return 'html';
  if (e === '.svg') return 'svg';
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.ico'].includes(e)) return 'imagem';
  if (['.mp4', '.m4v', '.webm', '.ogv', '.mov'].includes(e)) return 'video';
  if (['.mp3', '.wav', '.ogg', '.oga', '.m4a', '.flac'].includes(e)) return 'audio';
  if (e === '.pdf') return 'pdf';
  if (['.md', '.markdown'].includes(e)) return 'markdown';
  if (['.csv', '.tsv'].includes(e)) return 'tabela';
  return null;
}
const TEXTUAIS = new Set(['html', 'svg', 'markdown', 'tabela']);

// a página mostrada avisa a tela dos erros do console dela (a tela confere de qual iframe veio)
const ESPIAO = `<script>(function(){var p=window.parent;function m(t,x){try{p.postMessage({engramPrevia:t,texto:String(x).slice(0,600)},'*')}catch(e){}}
window.addEventListener('error',function(e){m('erro',(e.message||'erro')+(e.filename?' ('+e.filename.split('/').pop()+':'+e.lineno+')':''))},true);
window.addEventListener('unhandledrejection',function(e){m('erro',(e.reason&&e.reason.message)||e.reason)});
var ce=console.error;console.error=function(){m('erro',[].slice.call(arguments).join(' '));return ce.apply(console,arguments)};
var cw=console.warn;console.warn=function(){m('aviso',[].slice.call(arguments).join(' '));return cw.apply(console,arguments)};
m('pronta','')})();</script>`;

class Previa {
  constructor({ codigo, arquivos, avisar, registrar }) {
    Object.assign(this, { codigo, arquivos, avisar, registrar });
    this.token = crypto.randomBytes(18).toString('hex');
    this.porta = null;
    this.vigia = null;
  }

  iniciar() {
    return new Promise((resolve, reject) => {
      this.servidor = http.createServer((req, res) => this.servir(req, res).catch(() => { try { res.writeHead(500); res.end(); } catch { /* fechou */ } }));
      this.servidor.on('error', reject);
      this.servidor.listen(0, '127.0.0.1', () => { this.porta = this.servidor.address().port; resolve(this.porta); });
    });
  }

  /** De onde vem o arquivo: { raiz: 'p', rel } (pasta do projeto) ou { raiz: 'a', sessao, qual, nome } (pasta de um agente). */
  local(o) {
    if (o.raiz === 'p') return { base: this.codigo.raiz, rel: String(o.rel || '').replace(/\\/g, '/'), url: `p/${String(o.rel || '').split('/').map(encodeURIComponent).join('/')}` };
    if (o.raiz === 'a') {
      if (!/^[0-9a-f-]{36}$/.test(o.sessao || '') || !['recebidos', 'entregues'].includes(o.qual)) throw new Error('arquivo de agente inválido');
      return { base: this.arquivos.pasta(o.sessao), rel: `${o.qual}/${o.nome}`, url: `a/${o.sessao}/${o.qual}/${encodeURIComponent(o.nome)}` };
    }
    throw new Error('origem inválida');
  }

  /** O caminho de verdade, só se estiver dentro da pasta e sem nenhum pedaço oculto. */
  seguro(base, rel) {
    const partes = String(rel || '').split('/').filter(Boolean);
    if (partes.some(p => p.startsWith('.') || p === '..')) return null;
    const alvo = path.resolve(base, ...partes);
    const r = path.relative(base, alvo);
    if (r.startsWith('..') || path.isAbsolute(r)) return null;
    return alvo;
  }

  async servir(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    const u = new URL(req.url, 'http://127.0.0.1');
    const partes = u.pathname.split('/').filter(Boolean).map(p => { try { return decodeURIComponent(p); } catch { return ''; } });
    if (partes.shift() !== this.token) { res.writeHead(404); return res.end(); }
    const raiz = partes.shift();
    let base, rel;
    if (raiz === 'p') { base = this.codigo.raiz; rel = partes.join('/'); }
    else if (raiz === 'a') {
      const sessao = partes.shift();
      if (!/^[0-9a-f-]{36}$/.test(sessao || '')) { res.writeHead(404); return res.end(); }
      base = path.join(this.arquivos.base, sessao); rel = partes.join('/');
    } else { res.writeHead(404); return res.end(); }
    let alvo = this.seguro(base, rel);
    if (!alvo || !fs.existsSync(alvo)) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('não existe'); }
    let info = fs.statSync(alvo);
    if (info.isDirectory()) {
      alvo = path.join(alvo, 'index.html');
      if (!fs.existsSync(alvo)) { res.writeHead(404); return res.end(); }
      info = fs.statSync(alvo);
    }
    const ext = path.extname(alvo).toLowerCase();
    const cab = { 'Content-Type': TIPOS[ext] || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Accept-Ranges': 'bytes' };
    if (ext === '.html' || ext === '.htm') {
      // o espião dos erros entra no começo do documento
      const texto = fs.readFileSync(alvo, 'utf8');
      const i = texto.search(/<head[^>]*>/i);
      const corpo = Buffer.from(i >= 0 ? texto.replace(/<head[^>]*>/i, m => m + ESPIAO) : ESPIAO + texto, 'utf8');
      res.writeHead(200, { ...cab, 'Content-Length': corpo.length });
      return res.end(req.method === 'HEAD' ? undefined : corpo);
    }
    // vídeo e áudio pedem pedaços (para avançar e voltar)
    const faixa = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (faixa && (faixa[1] || faixa[2])) {
      let ini = faixa[1] ? Number(faixa[1]) : Math.max(0, info.size - Number(faixa[2]));
      let fim = faixa[1] && faixa[2] ? Math.min(Number(faixa[2]), info.size - 1) : info.size - 1;
      if (ini >= info.size || ini > fim) { res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }); return res.end(); }
      res.writeHead(206, { ...cab, 'Content-Range': `bytes ${ini}-${fim}/${info.size}`, 'Content-Length': fim - ini + 1 });
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(alvo, { start: ini, end: fim }).pipe(res);
    }
    res.writeHead(200, { ...cab, 'Content-Length': info.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(alvo).pipe(res);
  }

  /** Tudo o que a tela precisa para mostrar um arquivo. */
  info(o) {
    const { base, rel, url } = this.local(o);
    const alvo = this.seguro(base, rel);
    if (!alvo || !fs.existsSync(alvo) || fs.statSync(alvo).isDirectory()) throw new Error('o arquivo não existe (ou está numa pasta oculta)');
    const info = fs.statSync(alvo);
    const tipo = tipoDe(alvo);
    const r = { nome: path.basename(alvo), caminho: alvo, tipo, tamanho: info.size, modificado: info.mtimeMs, url: `http://127.0.0.1:${this.porta}/${this.token}/${url}`, pasta: `http://127.0.0.1:${this.porta}/${this.token}/${url.split('/').slice(0, -1).join('/')}/` };
    if (TEXTUAIS.has(tipo) && info.size <= 5 * 1024 * 1024) r.texto = fs.readFileSync(alvo, 'utf8');
    return r;
  }

  /** Vigia a pasta do arquivo aberto na prévia: qualquer mudança (o próprio arquivo, o CSS dele...) avisa a tela. */
  vigiar(o) {
    try { this.vigia?.close(); } catch { /* já fechado */ }
    this.vigia = null;
    if (!o) return { ok: true };
    const { base, rel } = this.local(o);
    const alvo = this.seguro(base, rel);
    if (!alvo) return { ok: true };
    let timer = null;
    try {
      this.vigia = fs.watch(path.dirname(alvo), { recursive: true }, (_t, nome) => {
        if (!nome || String(nome).split(/[\\/]/).some(p => p.startsWith('.') || p === 'node_modules')) return;
        clearTimeout(timer);
        timer = setTimeout(() => this.avisar({ tipo: 'previa', evento: 'mudou', caminho: alvo }), 250);
      });
      this.vigia.on('error', () => {});
    } catch { /* sem vigia: recarrega só à mão */ }
    return { ok: true };
  }

  salvar(o, texto) {
    const { base, rel } = this.local(o);
    const alvo = this.seguro(base, rel);
    if (!alvo || !fs.existsSync(alvo)) throw new Error('o arquivo não existe');
    fs.writeFileSync(alvo, String(texto ?? ''));
    return { ok: true };
  }

  registrarRotas(rota, { shell }) {
    const origem = q => (q.get('raiz') === 'a' ? { raiz: 'a', sessao: q.get('sessao'), qual: q.get('qual'), nome: q.get('nome') } : { raiz: 'p', rel: q.get('rel') || '' });
    rota('GET', '/api/previa', (_, __, q) => this.info(origem(q)));
    rota('POST', '/api/previa/vigiar', (_, b) => this.vigiar(b.origem || null));
    rota('POST', '/api/previa/salvar', (_, b) => this.salvar(b.origem, b.texto));
    rota('POST', '/api/previa/externo', async (_, b) => {
      const { base, rel } = this.local(b.origem);
      const alvo = this.seguro(base, rel);
      if (!alvo) throw new Error('arquivo inválido');
      if (b.navegador) { const i = this.info(b.origem); shell.openExternal(i.url); return { ok: true }; }
      const e = await shell.openPath(alvo);
      if (e) throw new Error(e);
      return { ok: true };
    });
    rota('POST', '/api/previa/abrir-url', (_, b) => { const u = String(b.url || ''); if (!/^https?:\/\//i.test(u)) throw new Error('endereço inválido'); shell.openExternal(u); return { ok: true }; });
    rota('POST', '/api/previa/mostrar', (_, b) => { const { base, rel } = this.local(b.origem); const alvo = this.seguro(base, rel); if (alvo) shell.showItemInFolder(alvo); return { ok: true }; });
  }
}

module.exports = { Previa, tipoDe };
