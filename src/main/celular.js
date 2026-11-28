// Modo dispatch: o app do Engram no celular, pela rede local (o mesmo Wi-Fi do PC).
//
// A pessoa liga em Ajustes > Celular. O Engram abre uma porta na rede e mostra um QR code com um código
// de pareamento (8 letras, vale 10 minutos, uma vez só). O celular troca o código por um token próprio,
// que o Engram guarda só como hash e que dá para revogar. Com ele, o celular conversa com o maestro (ou
// com qualquer agente aberto), vê o estado do time, responde as perguntas do terminal e aperta Parar.
//
// Desligado por padrão. A página não fala com a internet e não guarda nada além do token.
// Na rede local o tráfego é HTTP comum: vale para uma rede em que você confia.

const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const TELA = path.resolve(__dirname, '..', 'tela');
// o que o celular pode baixar (nada fora desta lista sai pela porta)
const ARQUIVOS = {
  '/': ['celular/index.html', 'text/html; charset=utf-8'],
  '/index.html': ['celular/index.html', 'text/html; charset=utf-8'],
  '/app.js': ['celular/app.js', 'text/javascript; charset=utf-8'],
  '/app.css': ['celular/app.css', 'text/css; charset=utf-8'],
  '/manifest.webmanifest': ['celular/manifest.webmanifest', 'application/manifest+json; charset=utf-8'],
  '/engram.png': ['marca/engram.png', 'image/png'],
  '/markdown-it.min.js': ['vendor/markdown-it.min.js', 'text/javascript; charset=utf-8'],
  '/avatar.js': ['celular/avatar.js', 'text/javascript; charset=utf-8'],
};
// o app só carrega o que é dele; os arquivos dos agentes (HTML, imagem, vídeo) vêm da porta de arquivos
const csp = arquivos => `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob: ${arquivos}; media-src 'self' blob: ${arquivos}; frame-src 'self' ${arquivos}; connect-src 'self' ${arquivos}; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
// os arquivos que os agentes entregam, como o celular os abre
const TEXTO = 'text/plain; charset=utf-8';
const TIPOS_ARQ = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4',
  '.pdf': 'application/pdf', '.md': 'text/markdown; charset=utf-8', '.csv': 'text/csv; charset=utf-8',
  '.txt': TEXTO, '.log': TEXTO, '.sql': TEXTO, '.py': TEXTO, '.ts': TEXTO, '.yml': TEXTO, '.yaml': TEXTO, '.xml': TEXTO, '.ini': TEXTO, '.ps1': TEXTO, '.sh': TEXTO, '.bat': TEXTO,
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
};
const VALIDADE_LINK = 30 * 60_000;
const HOST_OK = /^[A-Za-z0-9.-]{1,253}$/;
const LETRAS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sem 0/O e 1/I/L, para digitar sem erro
const VALIDADE_CODIGO = 10 * 60_000;
const MAX_APARELHOS = 10;
const MAX_AO_VIVO = 8;
const PESSOA = 'pessoa';

const sha = t => crypto.createHash('sha256').update(String(t)).digest();
const igual = (a, b) => a.length === b.length && crypto.timingSafeEqual(a, b);
const limparNome = t => String(t || '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);

/** Os IPv4 desta máquina que um celular no mesmo Wi-Fi alcança, o mais provável primeiro. */
function enderecos() {
  const lista = [];
  for (const [nome, ifs] of Object.entries(os.networkInterfaces())) {
    for (const i of ifs || []) {
      if (i.family !== 'IPv4' && i.family !== 4) continue;
      if (i.internal || /^169\.254\./.test(i.address)) continue;
      const virtual = /vEthernet|VirtualBox|VMware|Hyper-V|WSL|Docker|Loopback|Bluetooth|Npcap|TAP-|Default Switch/i.test(nome);
      const privado = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(i.address);
      const semFio = /wi-?fi|wlan|wireless|sem fio/i.test(nome);
      lista.push({ ip: i.address, nome, peso: virtual ? 3 : !privado ? 2 : semFio ? 0 : 1 });
    }
  }
  return lista.sort((a, b) => a.peso - b.peso).map(({ ip, nome }) => ({ ip, nome }));
}

class Celular {
  constructor({ cfg, dados, janelas, cerebro, versao, salvarConfig, registrar, avisar }) {
    Object.assign(this, { cfg, janelas, cerebro, versao, salvarConfig, registrar, avisar });
    this.arquivo = path.join(dados, 'celular.json');
    this.aparelhos = [];
    try { this.aparelhos = (JSON.parse(fs.readFileSync(this.arquivo, 'utf8')).aparelhos || []).filter(a => a && a.id && /^[0-9a-f]{64}$/.test(a.hash)); } catch { /* primeira vez */ }
    this.servidor = null;
    this.servidorArquivos = null; // outra porta = outra origem: o HTML do agente roda inteiro sem enxergar o token do app
    this.links = new Map(); // token do link -> { sessao, qual, expira }
    this.erro = null;
    this.convite = null; // { codigo, expira, erros }
    this.aoVivo = new Set(); // { res, aparelho }
    this.falhas = new Map(); // ip -> { n, desde }: tentativas sem token ou com código errado
    this.gravarEm = 0;
  }

  get porta() { return Number(this.cfg.celular_porta) || (Number(this.cfg.porta) || 8870) + 3; }
  get portaArquivos() { return this.porta + 1; }

  gravar() {
    try {
      fs.writeFileSync(this.arquivo, JSON.stringify({ aparelhos: this.aparelhos }, null, 1), 'utf8');
      this.gravarEm = Date.now();
    } catch (e) { this.registrar(`celular: não gravou os aparelhos (${e.message})`); }
  }

  // ------------------------------------------------------------------ o que a tela do PC mostra e faz

  estado() {
    const ips = enderecos();
    const ip = ips.find(e => e.ip === this.cfg.celular_ip)?.ip || ips[0]?.ip || null;
    const url = this.servidor && ip ? `http://${ip}:${this.porta}` : null;
    const c = this.convite && Date.now() < this.convite.expira ? this.convite : null;
    const conectados = new Map();
    for (const v of this.aoVivo) conectados.set(v.aparelho, (conectados.get(v.aparelho) || 0) + 1);
    return {
      ligado: !!this.servidor, porta: this.porta, erro: this.erro, ip, enderecos: ips, url,
      codigo: c && url ? c.codigo : null, expira: c && url ? new Date(c.expira).toISOString() : null,
      qr: c && url ? qrCaminho(`${url}/#p=${c.codigo}`) : null,
      aparelhos: this.aparelhos.map(a => ({ id: a.id, nome: a.nome, criado: a.criado, visto: a.visto, conectado: conectados.has(a.id) })),
    };
  }

  async ligar(sim, ip) {
    if (ip !== undefined) {
      const valido = !ip || enderecos().some(e => e.ip === ip);
      if (!valido) throw new Error('endereço desconhecido nesta máquina');
      this.cfg.celular_ip = ip || '';
      this.salvarConfig({ celular_ip: this.cfg.celular_ip });
    }
    if (sim !== undefined && !!sim !== this.cfg.celular_ligado) {
      this.cfg.celular_ligado = !!sim;
      this.salvarConfig({ celular_ligado: this.cfg.celular_ligado });
    }
    if (this.cfg.celular_ligado && !this.servidor) await this.abrir();
    if (!this.cfg.celular_ligado && this.servidor) this.parar();
    if (this.servidor && !(this.convite && Date.now() < this.convite.expira)) this.novoCodigo();
    return this.estado();
  }

  abrir() {
    this.erro = null;
    const servidor = http.createServer((req, res) => {
      this.tratar(req, res).catch(e => {
        this.registrar(`celular: ${e.message}`);
        if (!res.headersSent) this.json(res, 500, { erro: 'erro no Engram' }); else res.end();
      });
    });
    servidor.headersTimeout = 20_000;
    servidor.requestTimeout = 30_000;
    // ENGRAM_CELULAR_HOST: só nos testes (127.0.0.1, para não abrir a porta na rede de verdade)
    const host = process.env.ENGRAM_DADOS && process.env.ENGRAM_CELULAR_HOST ? process.env.ENGRAM_CELULAR_HOST : '0.0.0.0';
    return new Promise(resolve => {
      servidor.once('error', e => {
        this.erro = e.code === 'EADDRINUSE' ? `a porta ${this.porta} já está em uso por outro programa` : e.message;
        this.registrar(`celular: a porta ${this.porta} não abriu (${e.message})`);
        resolve(false);
      });
      servidor.listen(this.porta, host, () => {
        this.servidor = servidor;
        this.registrar(`celular: ligado na porta ${this.porta}`);
        this.abrirArquivos(host).then(() => resolve(true));
      });
    });
  }

  /** A porta dos arquivos dos agentes: só /f/<link>/<nome>. Sem ela, os arquivos saem pela porta do app, em sandbox. */
  abrirArquivos(host) {
    const servidor = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://arquivos');
      if (!url.pathname.startsWith('/f/')) { res.writeHead(404); return res.end(); }
      try { this.servirArquivo(req, res, url, true); } catch (e) { this.registrar(`celular: arquivo (${e.message})`); if (!res.headersSent) { res.writeHead(500); } res.end(); }
    });
    servidor.headersTimeout = 20_000;
    return new Promise(resolve => {
      servidor.once('error', e => { this.registrar(`celular: a porta de arquivos ${this.portaArquivos} não abriu (${e.message}); os arquivos saem pela ${this.porta}`); resolve(false); });
      servidor.listen(this.portaArquivos, host, () => { this.servidorArquivos = servidor; resolve(true); });
    });
  }

  parar() {
    for (const v of this.aoVivo) { try { v.res.end(); } catch { /* já saiu */ } }
    this.aoVivo.clear();
    this.convite = null;
    this.links.clear();
    if (this.servidorArquivos) {
      try { this.servidorArquivos.close(); this.servidorArquivos.closeAllConnections?.(); } catch { /* já fechado */ }
      this.servidorArquivos = null;
    }
    if (this.servidor) {
      try { this.servidor.close(); this.servidor.closeAllConnections?.(); } catch { /* já fechado */ }
      this.servidor = null;
      this.registrar('celular: desligado');
    }
  }

  novoCodigo() {
    let codigo = '';
    for (const b of crypto.randomBytes(8)) codigo += LETRAS[b % LETRAS.length];
    this.convite = { codigo, expira: Date.now() + VALIDADE_CODIGO, erros: 0 };
    return this.estado();
  }

  remover(id) {
    const antes = this.aparelhos.length;
    this.aparelhos = this.aparelhos.filter(a => a.id !== id);
    if (this.aparelhos.length === antes) throw new Error('aparelho não encontrado');
    this.gravar();
    for (const v of [...this.aoVivo]) if (v.aparelho === id) { try { v.res.end(); } catch { /* já saiu */ } this.aoVivo.delete(v); }
    for (const [t, l] of this.links) if (l.aparelho === id) this.links.delete(t); // os links que ele abriu morrem junto
    return this.estado();
  }

  // ------------------------------------------------------------------ avisos ao vivo (o que a tela do PC também recebe)

  aoAvisar(m) {
    if (!this.aoVivo.size || !m) return;
    let saida = null;
    if (m.tipo === 'evento') {
      saida = { tipo: 'evento', id: m.sessao_id, evento: m.evento, estado: m.estado || null };
      if ('pergunta' in m) saida.pergunta = m.pergunta || null;
      if (m.evento === 'PreToolUse' && m.resumo) saida.acao = String(m.resumo).slice(0, 200);
    } else if (m.tipo === 'conversa') saida = { tipo: 'conversa', id: m.sessao_id, trocou: !!m.trocou };
    else if (m.tipo === 'mensagem') saida = { tipo: 'mensagem', fase: m.fase, de: m.de, para: m.para, n: m.n, ...(m.de === PESSOA && m.texto ? { texto: String(m.texto).slice(0, 400) } : {}) };
    else if (m.tipo === 'arquivos' && m.entregues?.length) saida = { tipo: 'arquivos', id: m.sessao_id, entregues: m.entregues.slice(0, 20).map(n => String(n).slice(0, 160)) };
    else if (['sessao', 'palcos', 'conexao', 'setor'].includes(m.tipo) || (m.tipo === 'palco' && m.acao === 'organizado')) saida = { tipo: 'time' };
    else if (m.tipo === 'aviso') saida = { tipo: 'aviso', texto: String(m.texto || '').slice(0, 300) };
    if (!saida) return;
    const linha = `data: ${JSON.stringify(saida)}\n\n`;
    for (const v of this.aoVivo) { try { v.res.write(linha); } catch { /* caiu: o close limpa */ } }
  }

  // ------------------------------------------------------------------ o servidor da rede local

  json(res, status, corpo) {
    const texto = JSON.stringify(corpo ?? {});
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(texto), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    res.end(texto);
  }

  barrado(ip) {
    const f = this.falhas.get(ip);
    if (!f) return false;
    if (Date.now() - f.desde > 60_000) { this.falhas.delete(ip); return false; }
    return f.n >= 20;
  }

  falhou(ip) {
    const f = this.falhas.get(ip);
    if (!f || Date.now() - f.desde > 60_000) this.falhas.set(ip, { n: 1, desde: Date.now() });
    else f.n++;
    if (this.falhas.size > 500) this.falhas.clear();
  }

  autenticar(req) {
    const m = /^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(String(req.headers.authorization || ''));
    if (!m) return null;
    const h = sha(m[1]);
    let achado = null;
    for (const a of this.aparelhos) if (igual(Buffer.from(a.hash, 'hex'), h)) achado = a;
    return achado;
  }

  lerCorpo(req) {
    return new Promise((resolve, reject) => {
      let bruto = '';
      req.setEncoding('utf8');
      req.on('data', c => { bruto += c; if (bruto.length > 64_000) { reject(Object.assign(new Error('pedido grande demais'), { status: 413 })); req.destroy(); } });
      req.on('end', () => { try { resolve(bruto ? JSON.parse(bruto) : {}); } catch { reject(Object.assign(new Error('JSON inválido'), { status: 400 })); } });
      req.on('error', reject);
    });
  }

  async tratar(req, res) {
    const url = new URL(req.url, 'http://celular');
    const ip = req.socket.remoteAddress || '?';
    if (url.pathname.startsWith('/f/')) return this.servirArquivo(req, res, url, false); // sem a porta de arquivos
    if (!url.pathname.startsWith('/api/')) return this.estatico(req, res, url);
    // pedido de outra página (outro site aberto no celular): não passa
    const origem = req.headers.origin;
    if (origem && origem !== `http://${req.headers.host}`) return this.json(res, 403, { erro: 'origem não permitida' });
    if (this.barrado(ip)) return this.json(res, 429, { erro: 'tentativas demais: espere um minuto' });

    if (req.method === 'POST' && url.pathname === '/api/parear') {
      let corpo;
      try { corpo = await this.lerCorpo(req); } catch (e) { return this.json(res, e.status || 400, { erro: e.message }); }
      return this.parear(res, corpo, ip);
    }

    const aparelho = this.autenticar(req);
    if (!aparelho) { this.falhou(ip); return this.json(res, 401, { erro: 'este aparelho não está pareado' }); }
    const agora = Date.now();
    aparelho.visto = new Date(agora).toISOString();
    if (agora - this.gravarEm > 60_000) this.gravar();

    const rota = `${req.method} ${url.pathname}`;
    if (rota === 'GET /api/aovivo') return this.abrirAoVivo(req, res, aparelho);
    if (rota === 'GET /api/estado') return this.json(res, 200, this.estadoDoTime());
    if (rota === 'POST /api/sair') { this.remover(aparelho.id); return this.json(res, 200, { ok: true }); }
    if (rota === 'GET /api/arquivos') return this.json(res, 200, { itens: this.entregas() });
    if (rota === 'POST /api/link') {
      let corpo;
      try { corpo = await this.lerCorpo(req); } catch (e) { return this.json(res, e.status || 400, { erro: e.message }); }
      return this.criarLink(req, res, corpo, aparelho);
    }

    const m = /^\/api\/sessoes\/([0-9a-f-]{36})\/(conversa|prompt|interromper|responder|confiar|arquivos)$/.exec(url.pathname);
    if (!m) return this.json(res, 404, { erro: 'não existe' });
    const [, id, acao] = m;
    if (!this.cerebro.sessao(id)) return this.json(res, 404, { erro: 'agente não encontrado' });
    try {
      if (acao === 'conversa' && req.method === 'GET') {
        const desde = Math.max(0, Number(url.searchParams.get('desde')) || 0);
        const ultimos = Math.min(400, Math.max(0, Number(url.searchParams.get('ultimos')) || 0)) || null;
        return this.json(res, 200, this.janelas.lerConversa(id, desde, ultimos));
      }
      if (acao === 'arquivos' && req.method === 'GET') {
        const l = this.janelas.arquivos.listar(id);
        return this.json(res, 200, { recebidos: l.recebidos, entregues: l.entregues });
      }
      if (req.method !== 'POST') return this.json(res, 405, { erro: 'método não permitido' });
      const corpo = await this.lerCorpo(req);
      if (acao === 'prompt') return this.json(res, 200, { na_frente: this.janelas.digitar(id, String(corpo.texto || '').slice(0, 20_000)) });
      if (acao === 'interromper') { this.janelas.interromper(id); return this.json(res, 200, { ok: true }); }
      if (acao === 'responder') {
        const r = corpo.tecla !== undefined ? { tecla: String(corpo.tecla) } : { opcao: Number(corpo.opcao) };
        return this.json(res, 200, await this.janelas.responder(id, r));
      }
      if (acao === 'confiar') { this.janelas.confiarPasta(id); return this.json(res, 200, { ok: true }); }
    } catch (e) {
      return this.json(res, e.status || 400, { erro: e.message || 'não deu' });
    }
    return this.json(res, 404, { erro: 'não existe' });
  }

  parear(res, corpo, ip) {
    const c = this.convite;
    if (!c || Date.now() > c.expira) { this.falhou(ip); return this.json(res, 400, { erro: 'código vencido: gere outro no PC, em Ajustes > Celular' }); }
    const codigo = String(corpo.codigo || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!igual(sha(codigo), sha(c.codigo))) {
      this.falhou(ip);
      if (++c.erros >= 8) this.convite = null; // chutes demais: o código morre
      return this.json(res, 403, { erro: 'código errado' });
    }
    this.convite = null; // vale uma vez
    const token = crypto.randomBytes(32).toString('base64url');
    const agora = new Date().toISOString();
    const nome = limparNome(corpo.nome) || 'Celular';
    this.aparelhos.push({ id: crypto.randomUUID(), nome, hash: sha(token).toString('hex'), criado: agora, visto: agora });
    while (this.aparelhos.length > MAX_APARELHOS) this.aparelhos.shift(); // o mais antigo sai
    this.gravar();
    this.registrar(`celular: aparelho pareado (${nome})`);
    this.avisar({ tipo: 'celular', acao: 'pareado', nome });
    return this.json(res, 200, { token, pc: os.hostname() });
  }

  abrirAoVivo(req, res, aparelho) {
    if (this.aoVivo.size >= MAX_AO_VIVO) {
      // um celular que dormiu deixa conexão pendurada: a mais velha dá lugar
      const velha = this.aoVivo.values().next().value;
      try { velha.res.end(); } catch { /* já saiu */ }
      this.aoVivo.delete(velha);
    }
    req.socket.setTimeout(0);
    req.socket.setNoDelay(true);
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Connection: 'keep-alive' });
    res.write(': ligado\n\n');
    const v = { res, aparelho: aparelho.id };
    const novo = ![...this.aoVivo].some(x => x.aparelho === aparelho.id);
    this.aoVivo.add(v);
    if (novo) this.avisar({ tipo: 'celular', acao: 'conectado', nome: aparelho.nome });
    const batida = setInterval(() => { try { res.write(': .\n\n'); } catch { /* o close limpa */ } }, 20_000);
    req.on('close', () => {
      clearInterval(batida);
      this.aoVivo.delete(v);
      if (![...this.aoVivo].some(x => x.aparelho === aparelho.id)) this.avisar({ tipo: 'celular', acao: 'desconectado', nome: aparelho.nome });
    });
  }

  /** O que os agentes abertos entregaram (pasta entregues de cada um), o mais novo primeiro. */
  entregas() {
    const itens = [];
    for (const id of this.janelas.ativas.keys()) {
      const s = this.cerebro.sessao(id);
      if (!s) continue;
      let l;
      try { l = this.janelas.arquivos.listar(id); } catch { continue; }
      const nome = s.nome || this.janelas.info?.(id)?.nome || 'agente';
      for (const a of l.entregues) itens.push({ sessao: id, agente: nome, qual: 'entregues', nome: a.nome, tamanho: a.tamanho, quando: a.quando });
    }
    return itens.sort((a, b) => b.quando.localeCompare(a.quando)).slice(0, 150);
  }

  /** Link temporário para um arquivo de um agente. Vale para a pasta toda (o HTML acha o .css e as imagens do lado). */
  criarLink(req, res, corpo, aparelho) {
    const sessao = String(corpo.sessao || '');
    const qual = String(corpo.qual || 'entregues');
    const nome = String(corpo.nome || '');
    if (!/^[0-9a-f-]{36}$/.test(sessao) || !this.cerebro.sessao(sessao)) return this.json(res, 404, { erro: 'agente não encontrado' });
    try { this.janelas.arquivos.caminhoExistente(sessao, qual, nome); } catch (e) { return this.json(res, 404, { erro: e.message }); }
    const agora = Date.now();
    for (const [t, l] of this.links) if (l.expira < agora) this.links.delete(t);
    // o mesmo aparelho pedindo a mesma pasta reaproveita o link (as miniaturas não criam um por imagem)
    let token = null;
    for (const [t, l] of this.links) if (l.aparelho === aparelho.id && l.sessao === sessao && l.qual === qual && l.expira - agora > 5 * 60_000) token = t;
    if (!token) {
      token = crypto.randomBytes(18).toString('base64url');
      this.links.set(token, { sessao, qual, aparelho: aparelho.id, expira: agora + VALIDADE_LINK });
      while (this.links.size > 500) this.links.delete(this.links.keys().next().value);
    }
    const caminho = `/f/${token}/${encodeURIComponent(nome)}`;
    const host = this.hostDe(req);
    const separado = !!(this.servidorArquivos && host);
    const ext = path.extname(nome).toLowerCase();
    return this.json(res, 200, { url: separado ? `http://${host}:${this.portaArquivos}${caminho}` : caminho, separado, tipo: TIPOS_ARQ[ext] || 'application/octet-stream' });
  }

  /** O nome do PC como o celular o chamou (o IP do Wi-Fi), sem a porta; null se for estranho. */
  hostDe(req) {
    try {
      const h = new URL(`http://${req.headers.host || ''}`).hostname;
      return HOST_OK.test(h) ? h : null;
    } catch { return null; }
  }

  /**
   * GET /f/<link>/<nome>. Na porta de arquivos (separado), o arquivo tem origem própria: roda inteiro. Na porta
   * do app, vai em sandbox sem a origem do app (não lê o token). Aceita Range (o vídeo no iPhone pede assim).
   */
  servirArquivo(req, res, url, separado) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    const m = /^\/f\/([A-Za-z0-9_-]{24})\/([^/]+)$/.exec(url.pathname);
    const link = m && this.links.get(m[1]);
    if (!link || link.expira < Date.now()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('link vencido: abra de novo pelo app'); }
    let alvo;
    try { alvo = this.janelas.arquivos.caminhoExistente(link.sessao, link.qual, decodeURIComponent(m[2])); } catch { res.writeHead(404); return res.end(); }
    const st = fs.statSync(alvo);
    const ext = path.extname(alvo).toLowerCase();
    const cab = {
      'Content-Type': TIPOS_ARQ[ext] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'private, max-age=120', 'Accept-Ranges': 'bytes',
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(path.basename(alvo))}`,
    };
    if (!separado) cab['Content-Security-Policy'] = 'sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads';
    // o app (a outra porta, mesmo IP) lê os de texto (Markdown, CSV, código) para mostrar formatados
    const host = separado && this.hostDe(req);
    if (host) { cab['Access-Control-Allow-Origin'] = `http://${host}:${this.porta}`; cab.Vary = 'Origin'; }
    let ini = 0, fim = st.size - 1, status = 200;
    const r = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
    if (r && st.size && (r[1] || r[2])) {
      if (r[1] === '') ini = Math.max(0, st.size - Number(r[2]));
      else { ini = Number(r[1]); if (r[2]) fim = Math.min(Number(r[2]), st.size - 1); }
      if (ini > fim || ini >= st.size) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
      status = 206;
      cab['Content-Range'] = `bytes ${ini}-${fim}/${st.size}`;
    }
    cab['Content-Length'] = st.size ? fim - ini + 1 : 0;
    res.writeHead(status, cab);
    if (req.method === 'HEAD' || !st.size) return res.end();
    fs.createReadStream(alvo, { start: ini, end: fim }).on('error', () => res.destroy()).pipe(res);
  }

  /** O time aberto, em todos os palcos: o celular desenha a lista e escolhe com quem falar. */
  estadoDoTime() {
    const agentes = [];
    for (const [id, j] of this.janelas.ativas) {
      const s = this.janelas.info(id);
      if (!s) continue;
      let f = {};
      try { f = this.janelas.fazendo(id); } catch { /* sem detalhe */ }
      agentes.push({
        id, nome: s.nome, papel: s.papel, papel_nome: this.cfg.papeis?.[s.papel]?.nome || s.papel,
        provedor: s.provedor, agente: s.agente, modelo: s.modelo || '', nome_modelo: s.nome_modelo || '',
        estado: s.estado, pergunta: s.pergunta || null, palco: s.palco || 1, tem_conversa: !!s.tem_conversa,
        acao: f.ultima_acao?.o_que || null, acao_ha: f.ultima_acao?.ha || null,
        posicao: this.cerebro.posicao?.(id) || null, // onde o cartão está no palco (o mapa do celular)
        // o que a pessoa mandou e ainda está na fila (entra quando o agente terminar o turno)
        fila: (j.caixa || []).filter(c => c[1] === PESSOA).map(c => ({ n: c[0], texto: String(c[2] || '').slice(0, 400) })),
      });
    }
    const abertas = new Set(agentes.map(a => a.id));
    const palcosComGente = [...new Set(agentes.map(a => a.palco))];
    return {
      pc: os.hostname(), versao: this.versao, tema: this.cfg.tema || 'aurora',
      palco_atual: this.cerebro.palcoAtual(), palcos: this.cerebro.palcos(), agentes,
      conexoes: (this.cerebro.conexoes?.() || []).filter(c => abertas.has(c.a) && abertas.has(c.b)).map(c => ({ a: c.a, b: c.b, revisa: c.revisa || null })),
      setores: palcosComGente.flatMap(n => this.cerebro.setores?.(n) || []).map(s => ({ id: s.id, nome: s.nome, cor: s.cor, x: s.x, y: s.y, w: s.w, h: s.h, palco: s.palco || 1 })),
    };
  }

  estatico(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    const def = ARQUIVOS[url.pathname];
    if (!def) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('não existe'); }
    let corpo;
    try { corpo = fs.readFileSync(path.join(TELA, def[0])); } catch { res.writeHead(404); return res.end(); }
    const cab = { 'Content-Type': def[1], 'Content-Length': corpo.length, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-cache' };
    if (def[1].startsWith('text/html')) {
      const host = this.servidorArquivos && this.hostDe(req);
      cab['Content-Security-Policy'] = csp(host ? `http://${host}:${this.portaArquivos}` : '');
      cab['X-Frame-Options'] = 'DENY';
    }
    res.writeHead(200, cab);
    res.end(req.method === 'HEAD' ? undefined : corpo);
  }
}

/** O QR code como um caminho SVG (um retângulo por trecho escuro de cada linha), com o tamanho em módulos. */
function qrCaminho(texto) {
  const gerar = require('qrcode-generator');
  const q = gerar(0, 'M');
  q.addData(texto);
  q.make();
  const n = q.getModuleCount();
  let d = '';
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (!q.isDark(y, x)) continue;
      let w = 1;
      while (x + w < n && q.isDark(y, x + w)) w++;
      d += `M${x} ${y}h${w}v1h-${w}z`;
      x += w - 1;
    }
  }
  return { n, d };
}

module.exports = { Celular, enderecos, qrCaminho };
