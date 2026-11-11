// Engram: processo principal do app (Electron).

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, ipcMain, protocol, net, shell, Tray, Menu, nativeImage, safeStorage, dialog, Notification } = require('electron');

// Cópia de teste com dados próprios (não mexe no Engram de todo dia)
if (process.env.ENGRAM_DADOS) app.setPath('userData', path.resolve(process.env.ENGRAM_DADOS));

const config = require('./config');
const banco = require('./banco');
const { criarFonte, FontePasta } = require('./fontes');
const { Cerebro } = require('./cerebro');
const { Janelas } = require('./janelas');
const { criarServidorLocal } = require('./servidor-local');
const mcp = require('./mcp-time');
const { criarRotas } = require('./rotas');
const { Arquivos } = require('./arquivos');
const { Atualizador } = require('./atualizacao');
const { Cofre } = require('./cofre');
const { Provedores } = require('./provedores');
const { Mcps } = require('./mcps');
const { Skills } = require('./skills');
const { Codigo } = require('./codigo');
const { Fluxos } = require('./fluxos');
const { Extensoes } = require('./extensoes');
const { Previa } = require('./previa');
const { Linguagens } = require('./linguagens');
const { Trabalho } = require('./trabalho');
const { Automacoes } = require('./automacoes');

const TELA = path.resolve(__dirname, '..', 'tela');
const TIPOS = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.json': 'application/json', '.wasm': 'application/wasm', '.woff': 'font/woff', '.otf': 'font/otf' };
// pacotes que a tela usa direto da pasta node_modules (o editor da vista Código e os ícones dele)
const MODULOS = path.resolve(__dirname, '..', '..', 'node_modules');
const PACOTES = {
  'monaco/': path.join(MODULOS, 'monaco-editor', 'min'), 'codicons/': path.join(MODULOS, '@vscode', 'codicons', 'dist'),
  // o realce de sintaxe das extensões (gramáticas TextMate), o mesmo motor do VS Code
  'modulos/vscode-textmate/': path.join(MODULOS, 'vscode-textmate', 'release'), 'modulos/vscode-oniguruma/': path.join(MODULOS, 'vscode-oniguruma', 'release'),
};
const CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' engram: data: blob: http://127.0.0.1:* https://open-vsx.org https://openvsx.eclipsecontent.org; media-src 'self' blob: http://127.0.0.1:*; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-src http://127.0.0.1:*; form-action 'none'";

protocol.registerSchemesAsPrivileged([{ scheme: 'engram', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

if (!app.requestSingleInstanceLock()) app.quit();

let janela = null;
let nucleo = null;

function avisar(msg) {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('aovivo', msg);
}

// Aviso do Windows (das automações). Guardados até sumirem: sem referência, o clique pode se perder.
const notificacoes = new Set();
function notificar({ titulo, texto, automacao }) {
  try {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title: titulo, body: String(texto || '').slice(0, 240), icon: path.join(TELA, 'marca', 'engram.png') });
    notificacoes.add(n);
    const soltar = () => notificacoes.delete(n);
    n.on('click', () => { soltar(); mostrar(); setTimeout(() => avisar({ tipo: 'automacao', acao: 'focar', id: automacao }), 300); });
    n.on('close', soltar);
    n.show();
    setTimeout(soltar, 10 * 60_000);
  } catch { /* sem aviso do sistema, o cartão continua mostrando */ }
}

async function iniciarNucleo() {
  const cfg = config.carregar();
  const c = config.caminhos();
  fs.mkdirSync(c.dados, { recursive: true });
  const token = config.tokenLocal();
  const db = banco.abrir(c.banco);
  const cofre = new Cofre({ dados: c.dados, safeStorage });
  const provedores = new Provedores({ cfg, cofre, salvarConfig: config.salvar, registrar: config.registrar });
  const mcps = new Mcps({ dados: c.dados, cofre, cfg, provedores, registrar: config.registrar });
  // cérebro remoto: os agentes o enxergam pelo nome do MCP cadastrado com o mesmo endereço
  if (cfg.cerebro.fonte === 'remoto') { const m = mcps.porUrl(cfg.cerebro.url); if (m) cfg.cerebro.servidor = m.id; }
  let fonte;
  try { fonte = criarFonte(cfg); } catch (e) {
    config.registrar(`cérebro remoto não abriu (${e.message}); usando a pasta neste computador`);
    fonte = new FontePasta(cfg.cerebro.pasta);
  }
  try { fonte.preparar(); } catch (e) { config.registrar(`cérebro: ${e.message}`); }
  const cerebro = new Cerebro(cfg, db, c.banco, fonte);
  const skills = new Skills({ dados: c.dados, registrar: config.registrar });
  skills.sincronizar(); // plugin do Claude e pastas do Engram no Codex, conforme a biblioteca
  const janelas = new Janelas({ cfg, cerebro, fonte, token, caminhos: c, avisar, provedores, mcps, skills });
  const codigo = new Codigo({ cfg, salvarConfig: config.salvar, avisar, janelas, provedores, registrar: config.registrar });
  const fluxos = new Fluxos({ codigo, janelas, provedores, avisar, cfg, registrar: config.registrar });
  janelas.fluxos = fluxos; // as ferramentas fluxo_* do time (MCP) falam com ele
  const extensoes = new Extensoes({ dados: c.dados, cfg, salvarConfig: config.salvar, avisar, registrar: config.registrar });
  const previa = new Previa({ codigo, arquivos: janelas.arquivos, avisar, registrar: config.registrar });
  try { await previa.iniciar(); } catch (e) { config.registrar(`prévias: o servidor local não abriu (${e.message})`); }
  const linguagens = new Linguagens({ dados: c.dados, codigo, janelas, avisar, registrar: config.registrar, cfg, salvarConfig: config.salvar });
  app.on('before-quit', () => linguagens.pararTudo());
  const trabalho = new Trabalho({ janelas, avisar });
  const estadoSinc = { rodando: false, ultimo: null, erro: null };

  async function sincronizar(forcar = false) {
    estadoSinc.rodando = true;
    avisar({ tipo: 'sinc', rodando: true });
    let resultado;
    try {
      resultado = await cerebro.sincronizar(forcar);
      Object.assign(estadoSinc, { ultimo: resultado, erro: null });
    } catch (e) {
      estadoSinc.erro = e.message;
      resultado = { erro: e.message };
    }
    estadoSinc.rodando = false;
    avisar({ tipo: 'sinc', rodando: false, resultado });
    return resultado;
  }

  try {
    await criarServidorLocal({ cfg, token, janelas, mcp, registrar: config.registrar });
  } catch (e) {
    config.registrar(`servidor local na porta ${cfg.porta}: ${e.message}`);
  }
  try { await janelas.iniciar(); } catch (e) { config.registrar(`motor: ${e.message}`); setTimeout(() => janelas.motorCaiu(), 100); }

  sincronizar();
  setInterval(() => sincronizar(), Math.max(1, cfg.cerebro.sincronizar_min) * 60_000);
  fonte.observar(() => sincronizar());
  setInterval(() => { try { janelas.vigiar(); } catch { /* segue */ } }, 700);
  // o relógio das automações; a primeira volta espera o time voltar do motor (as atrasadas vão para ele)
  const automacoes = new Automacoes({ db, janelas, avisar, notificar });
  const vigiarAutomacoes = () => { try { automacoes.vigiar(); } catch (e) { config.registrar(`automações: ${e.message}`); } };
  setTimeout(() => { vigiarAutomacoes(); setInterval(vigiarAutomacoes, 15_000); }, 30_000);

  // Reiniciar o app não derruba os agentes (estão no motor): na volta, ele reencontra e reabre o time.
  const reiniciar = () => setTimeout(() => { saindo = true; app.relaunch(); app.exit(0); }, 600);
  const atualizador = new Atualizador({ cfg, registrar: config.registrar, avisar, janela: () => janela, aoInstalar: () => { saindo = true; } });
  atualizador.iniciar();
  provedores.todos().then(() => avisar({ tipo: 'contas' })).catch(() => {}); // já deixa o login de cada um conferido
  const escolherArquivo = async ({ titulo, filtros, pasta }) => {
    const r = await dialog.showOpenDialog(janela, { title: titulo, properties: [pasta ? 'openDirectory' : 'openFile'], filters: pasta ? undefined : filtros });
    return r.canceled ? null : r.filePaths[0];
  };
  const definirTema = tema => {
    const t = config.TEMAS[tema] || config.TEMAS.aurora;
    if (!janela || janela.isDestroyed()) return;
    janela.setBackgroundColor(t.fundo);
    try { janela.setTitleBarOverlay({ color: t.fundo, symbolColor: t.simbolos, height: 40 }); } catch { /* sem barra */ }
  };
  definirTema(cfg.tema);
  const rotas = criarRotas({ cfg, cerebro, janelas, provedores, mcps, skills, escolherArquivo, definirTema, sincronizar, estadoSinc, versao: app.getVersion(), caminhos: c, salvarConfig: config.salvar, reiniciar, atualizador, codigo, fluxos, extensoes, previa, linguagens, trabalho, automacoes, abrirTrabalho: sessao => abrirJanelaTrabalho(sessao, trabalho) });
  return { cfg, janelas, rotas, extensoes, arquivos: new Arquivos(c.arquivos) };
}

app.on('web-contents-created', (_e, wc) => {
  if (wc.getType() !== 'webview') return;
  wc.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
});

function registrarProtocolo() {
  protocol.handle('engram', async req => {
    const url = new URL(req.url);
    if (url.host === 'app') {
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
      if (rel.startsWith('ext/')) {
        // arquivos de extensões (temas, ícones, gramáticas, snippets): só dentro da pasta de cada uma
        const [, id, ...resto] = url.pathname.replace(/^\/+/, '').split('/');
        const alvo = nucleo?.extensoes?.arquivo(decodeURIComponent(id || ''), resto.join('/'));
        if (!alvo) return new Response('não existe', { status: 404 });
        const r = await net.fetch(pathToFileURL(alvo).toString());
        return new Response(r.body, { status: 200, headers: { 'Content-Type': TIPOS[path.extname(alvo).toLowerCase()] || 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' } });
      }
      const pacote = Object.keys(PACOTES).find(p => rel.startsWith(p));
      const base = pacote ? PACOTES[pacote] : TELA;
      const alvo = path.resolve(base, pacote ? rel.slice(pacote.length) : rel);
      if (!alvo.startsWith(base + path.sep) || !fs.existsSync(alvo)) return new Response('não existe', { status: 404 });
      const r = await net.fetch(pathToFileURL(alvo).toString());
      const cab = { 'Content-Type': TIPOS[path.extname(alvo).toLowerCase()] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' };
      if (alvo.endsWith('.html')) cab['Content-Security-Policy'] = CSP;
      return new Response(r.body, { status: 200, headers: cab });
    }
    if (url.host === 'arquivo' && nucleo) {
      const [id, qual, nome] = url.pathname.replace(/^\/+/, '').split('/').map(decodeURIComponent);
      try {
        const alvo = nucleo.arquivos.caminhoExistente(id, qual, nome);
        const r = await net.fetch(pathToFileURL(alvo).toString());
        return new Response(r.body, { status: 200, headers: { 'Content-Type': Arquivos.tipo(alvo), 'Content-Security-Policy': 'sandbox', 'X-Content-Type-Options': 'nosniff' } });
      } catch { return new Response('não encontrado', { status: 404 }); }
    }
    return new Response('não existe', { status: 404 });
  });
}

function registrarIpc() {
  ipcMain.handle('api', async (_e, { metodo, caminho, corpo }) => {
    if (!nucleo) return { ok: false, status: 503, erro: 'o Engram ainda está abrindo' };
    return nucleo.rotas(String(metodo || 'GET'), String(caminho || ''), corpo);
  });
  const assinaturas = new Map(); // `${webContentsId}:${id}` -> parar()
  ipcMain.on('terminal:abrir', (e, id) => {
    const chave = `${e.sender.id}:${id}`;
    assinaturas.get(chave)?.();
    const sub = nucleo?.janelas.ouvir(id, texto => {
      if (e.sender.isDestroyed()) return;
      if (texto === null) e.sender.send('terminal:fim', id);
      else e.sender.send('terminal:dados', { id, dados: texto });
    });
    if (!sub) { e.sender.send('terminal:dados', { id, dados: '\r\n\x1b[2m[esta janela não está aberta]\x1b[0m\r\n', inicio: true }); return; }
    assinaturas.set(chave, sub.parar);
    e.sender.send('terminal:dados', { id, dados: sub.historico, inicio: true, colunas: sub.colunas, linhas: sub.linhas });
    e.sender.once('destroyed', () => { sub.parar(); assinaturas.delete(chave); });
  });
  ipcMain.on('terminal:entrada', (_e, { id, dados }) => nucleo?.janelas.escrever(id, String(dados).slice(0, 65_536)));
  ipcMain.on('terminal:tamanho', (_e, { id, colunas, linhas }) => nucleo?.janelas.redimensionar(id, colunas, linhas));
  ipcMain.on('terminal:fechar', (e, id) => { const k = `${e.sender.id}:${id}`; assinaturas.get(k)?.(); assinaturas.delete(k); });
}

function temaInicial() {
  try { return config.TEMAS[config.carregar().tema] || config.TEMAS.aurora; } catch { return config.TEMAS.aurora; }
}

function criarJanela() {
  janela = new BrowserWindow({
    width: 1520, height: 940, minWidth: 960, minHeight: 620, show: false,
    backgroundColor: temaInicial().fundo, title: 'Engram',
    icon: fs.existsSync(path.join(TELA, 'marca', 'engram.png')) ? path.join(TELA, 'marca', 'engram.png') : undefined,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: temaInicial().fundo, symbolColor: temaInicial().simbolos, height: 40 },
    webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false, plugins: true, webviewTag: true }, // plugins: o leitor de PDF; webviewTag: o navegador da prévia
  });
  janela.once('ready-to-show', () => janela.show());
  janela.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('engram://arquivo/') && nucleo) {
      const [id, qual, nome] = new URL(url).pathname.replace(/^\/+/, '').split('/').map(decodeURIComponent);
      try { shell.openPath(nucleo.arquivos.caminhoExistente(id, qual, nome)); } catch { /* sumiu */ }
    } else if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });
  janela.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('engram://app/')) e.preventDefault(); });
  janela.webContents.on('will-attach-webview', (e, prefs, params) => {
    // o navegador da prévia é uma página qualquer da web: nunca recebe o preload nem acesso ao app
    delete prefs.preload;
    Object.assign(prefs, { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, plugins: true });
    params.partition = 'persist:engram-navegador';
    if (!/^https?:\/\//i.test(params.src || '')) e.preventDefault();
  });
  janela.loadURL('engram://app/index.html');
  // Fechar a janela só esconde: o Engram fica na bandeja (e os agentes, no motor).
  janela.on('close', e => {
    if (saindo || !bandeja) return;
    e.preventDefault();
    janela.hide();
    if (!avisouBandeja) {
      avisouBandeja = true;
      bandeja.displayBalloon({ title: 'O Engram continua aberto', content: 'Os agentes seguem trabalhando. Clique no ícone da bandeja para voltar.', iconType: 'info' });
    }
  });
  janela.on('closed', () => { janela = null; });
}

// janelas de "Visualizar trabalho": uma por agente, que dá para pôr em outro monitor
const janelasTrabalho = new Map();
function abrirJanelaTrabalho(sessao, trabalho) {
  const aberta = janelasTrabalho.get(sessao);
  if (aberta && !aberta.isDestroyed()) { if (aberta.isMinimized()) aberta.restore(); aberta.show(); aberta.focus(); return; }
  const t = temaInicial();
  const w = new BrowserWindow({
    width: 1280, height: 820, minWidth: 760, minHeight: 480, show: false, backgroundColor: t.fundo, title: 'Trabalho do agente',
    icon: fs.existsSync(path.join(TELA, 'marca', 'engram.png')) ? path.join(TELA, 'marca', 'engram.png') : undefined,
    titleBarStyle: 'hidden', titleBarOverlay: { color: t.fundo, symbolColor: t.simbolos, height: 40 },
    webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
  });
  janelasTrabalho.set(sessao, w);
  trabalho.assistir(sessao);
  w.once('ready-to-show', () => w.show());
  w.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  w.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('engram://app/')) e.preventDefault(); });
  w.loadURL(`engram://app/trabalho.html?sessao=${encodeURIComponent(sessao)}`);
  w.on('closed', () => { janelasTrabalho.delete(sessao); trabalho.soltar(sessao); });
}

let bandeja = null;
let saindo = false;
let avisouBandeja = false;

function mostrar() {
  if (!janela) return criarJanela();
  if (janela.isMinimized()) janela.restore();
  janela.show();
  janela.focus();
}

function criarBandeja() {
  const icone = nativeImage.createFromPath(path.join(TELA, 'marca', 'engram.png')).resize({ width: 16, height: 16 });
  bandeja = new Tray(icone);
  bandeja.setToolTip('Engram');
  const menu = () => Menu.buildFromTemplate([
    { label: 'Abrir o Engram', click: mostrar },
    { label: `Agentes rodando: ${nucleo ? nucleo.janelas.ativas.size : '…'}`, enabled: false },
    { type: 'separator' },
    { label: 'Sair (os agentes continuam rodando)', click: () => { saindo = true; app.quit(); } },
  ]);
  bandeja.setContextMenu(menu());
  bandeja.on('click', mostrar);
  bandeja.on('right-click', () => bandeja.setContextMenu(menu()));
}

app.on('second-instance', mostrar);
app.on('before-quit', () => { saindo = true; });

// sem o menu padrão do Electron: escondido, ele abria com o Alt (e roubava a tecla seguinte) e trazia atalhos
// perigosos aqui, como o Ctrl+R que recarrega a tela no meio do trabalho. Fica só o Ctrl+Shift+I (ferramentas).
app.on('web-contents-created', (_, wc) => {
  wc.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.control && input.shift && !input.alt && String(input.key).toLowerCase() === 'i') {
      e.preventDefault();
      wc.toggleDevTools();
    }
  });
});

app.whenReady().then(async () => {
  app.setAppUserModelId('app.engram.desktop');
  Menu.setApplicationMenu(null);
  registrarProtocolo();
  registrarIpc();
  try { criarBandeja(); } catch (e) { config.registrar(`bandeja: ${e.message}`); }
  criarJanela();
  nucleo = await iniciarNucleo();
});

// Sem janela e sem bandeja, o app sai. Os agentes NÃO saem: continuam no motor.
app.on('window-all-closed', () => { if (!bandeja) app.quit(); });
