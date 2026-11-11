// "Visualizar trabalho": ver um agente escrevendo código, numa janela à parte. O gancho dos agentes nunca
// manda conteúdo (só o alvo: o caminho do arquivo); quem lê o arquivo é o próprio Engram, no disco: antes da
// edição (no PreToolUse) e depois (no PostToolUse). A janela recebe o antes e o depois e anima a escrita.
// Agentes sem ganchos (Codex, Gemini...) são acompanhados por um vigia na pasta deles.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const EDITORES = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
// ferramentas que não gravam no disco: enquanto rodam, o que muda na pasta não é do agente
const SO_LEITURA = new Set(['Read', 'NotebookRead', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'TodoWrite', 'ToolSearch', 'Task']);
// o vigia não olha pastas de sistema nem arquivos que mudam sozinhos (logs, bancos, temporários)
const PASTAS_FORA = new Set(['node_modules', '__pycache__', 'AppData', 'venv', 'site-packages']);
const ARQUIVOS_FORA = /\.(log|tmp|temp|lock|pid|pyc|swp|etl|db|db-wal|db-shm|db-journal|sqlite|sqlite-wal|sqlite-shm)$/i;
const OCUPADO = new Set(['pensando', 'trabalhando']);
const FOLGA_MS = 3000; // depois de um comando terminar, o disco ainda pode estar gravando
const ACAO_MAX_MS = 10 * 60_000; // comando sem fim (falhou sem PostToolUse) deixa de valer
const LIMITE = 2 * 1024 * 1024;
const MAX_VISTOS = 40; // arquivos de cada sessão guardados para comparar (o "antes" da próxima edição)
const BOLHA_LINHAS = 60, BOLHA_LETRAS = 160;

/**
 * O trecho que mudou entre duas versões de um arquivo, para a bolha do palco (a tela não recebe o arquivo inteiro):
 * as linhas novas, com até 2 linhas de contexto antes, e quantas saíram.
 */
function trechoMudado(antes, depois) {
  const linhas = t => (t ? String(t).replace(/\r\n/g, '\n').split('\n') : []); // arquivo novo: nenhuma linha antes
  const a = linhas(antes), d = linhas(depois);
  let ini = 0;
  while (ini < a.length && ini < d.length && a[ini] === d[ini]) ini++;
  let fimA = a.length - 1, fimD = d.length - 1;
  while (fimA >= ini && fimD >= ini && a[fimA] === d[fimD]) { fimA--; fimD--; }
  const novas = d.slice(ini, fimD + 1), menos = fimA - ini + 1;
  if (!novas.length && menos <= 0) return null;
  const corta = l => (l.length > BOLHA_LETRAS ? `${l.slice(0, BOLHA_LETRAS)}…` : l);
  return {
    linha: ini + 1, contexto: d.slice(Math.max(0, ini - 2), ini).map(corta), novas: novas.slice(0, BOLHA_LINHAS).map(corta),
    mais: novas.length, menos: Math.max(0, menos), cortado: novas.length > BOLHA_LINHAS,
  };
}

function lerTexto(arquivo) {
  try {
    const info = fs.statSync(arquivo);
    if (!info.isFile() || info.size > LIMITE) return null;
    const buf = fs.readFileSync(arquivo);
    if (buf.subarray(0, 8000).includes(0)) return null; // binário
    return buf.toString('utf8');
  } catch { return ''; } // ainda não existe: o "antes" de um arquivo novo é vazio
}

/** O arquivo como estava no último commit (para o vigia, que não viu o antes). */
function doGit(arquivo) {
  return new Promise(resolve => {
    execFile('git', ['log', '-1', '--format=%H'], { cwd: path.dirname(arquivo), windowsHide: true }, erro => {
      if (erro) return resolve(null);
      execFile('git', ['show', `HEAD:./${path.basename(arquivo)}`], { cwd: path.dirname(arquivo), windowsHide: true, maxBuffer: LIMITE * 2, encoding: 'utf8' }, (e, saida) => resolve(e ? null : saida));
    });
  });
}

class Trabalho {
  constructor({ janelas, avisar }) {
    Object.assign(this, { janelas, avisar });
    this.assistindo = new Map(); // sessão → { janelas, antes: Map, recentes: Map, vistos: Map, vigia }
    janelas.aoEvento = (id, evento, ferramenta, entrada) => this.evento(id, evento, ferramenta, entrada);
  }

  pastaDe(sessao) { return this.janelas.cerebro.sessao(sessao)?.pasta || this.janelas.cfg.pasta_trabalho; }

  rel(sessao, arquivo) {
    const pasta = this.pastaDe(sessao);
    let real = pasta;
    try { real = fs.realpathSync.native(pasta); } catch { /* fica a gravada */ }
    for (const base of new Set([pasta, real])) {
      const r = path.relative(base, arquivo);
      if (r && !r.startsWith('..') && !path.isAbsolute(r)) return r.split(path.sep).join('/');
    }
    return arquivo;
  }

  /**
   * O que o Engram guarda de uma sessão para mostrar a escrita. Com ganchos (Claude) ele existe sempre: alimenta a
   * bolha do palco mesmo sem a janela de trabalho aberta. A janela aberta acrescenta o vigia da pasta.
   */
  estado(sessao) {
    let a = this.assistindo.get(sessao);
    if (!a) {
      const s = this.janelas.cerebro.sessao(sessao);
      a = {
        janelas: 0, antes: new Map(), recentes: new Map(), vistos: new Map(), datas: new Map(), desde: Date.now(), vigia: null, timers: new Map(),
        ganchos: (s?.provedor || 'claude') === 'claude', acoes: 0, ultimaAcao: 0, fimAcao: 0,
      };
      this.assistindo.set(sessao, a);
    }
    return a;
  }

  /** Guarda o texto visto de um arquivo (o mais recente por último; os antigos saem). */
  lembrar(a, arquivo, texto) {
    a.vistos.delete(arquivo);
    a.vistos.set(arquivo, texto);
    while (a.vistos.size > MAX_VISTOS) a.vistos.delete(a.vistos.keys().next().value);
  }

  /** A bolha do palco: o trecho que o agente acabou de escrever. */
  pensar(sessao, arquivo, antes, depois) {
    if (this.janelas.cfg.pensamento_no_palco === false) return;
    const t = trechoMudado(antes, depois);
    if (t) this.avisar({ tipo: 'pensamento', sessao, fase: 'escreveu', rel: this.rel(sessao, arquivo), ...t });
  }

  /** Começa a acompanhar uma sessão (uma janela de trabalho abriu). */
  assistir(sessao) {
    const a = this.estado(sessao);
    if (++a.janelas > 1) return this.info(sessao);
    a.desde = Date.now();
    // o nome completo da pasta: com nome curto do Windows (NATHAN~1.FOG) o fs.watch derruba o processo inteiro
    let pasta = this.pastaDe(sessao);
    try { pasta = fs.realpathSync.native(pasta); } catch { pasta = null; }
    // a pasta do usuário ou a raiz do disco têm programas gravando o tempo todo: não dá para vigiar
    const igual = p => path.resolve(p).toLowerCase() === path.resolve(pasta).toLowerCase();
    if (pasta && !igual(os.homedir()) && !igual(path.parse(pasta).root)) try {
      a.vigia = fs.watch(pasta, { recursive: true }, (_t, nome) => {
        if (!nome) return;
        const partes = String(nome).split(/[\\/]/);
        if (partes.some(p => p.startsWith('.') || PASTAS_FORA.has(p)) || ARQUIVOS_FORA.test(String(nome))) return;
        if (!this.agindo(sessao, a)) return; // agente parado: quem mexeu foi outro programa
        const arquivo = path.join(pasta, String(nome));
        clearTimeout(a.timers.get(arquivo));
        a.timers.set(arquivo, setTimeout(() => this.mudouNoDisco(sessao, arquivo), 400));
      });
      a.vigia.on('error', () => {});
    } catch { /* sem vigia: fica só com os ganchos */ }
    return this.info(sessao);
  }

  soltar(sessao) {
    const a = this.assistindo.get(sessao);
    if (!a) return;
    if (--a.janelas > 0) return;
    try { a.vigia?.close(); } catch { /* já fechado */ }
    a.vigia = null;
    for (const t of a.timers.values()) clearTimeout(t);
    a.timers.clear();
    if (!a.ganchos) this.assistindo.delete(sessao); // sem ganchos, sem a janela não há o que acompanhar
  }

  info(sessao) {
    const s = this.janelas.cerebro.sessao(sessao);
    if (!s) throw new Error('sessão não encontrada');
    const j = this.janelas.ativas.get(sessao);
    return { id: s.id, nome: s.nome, provedor: s.provedor, modelo: s.modelo, papel: s.papel, pasta: this.pastaDe(sessao), estado: j ? j.estado : 'encerrada', viva: !!j, ganchos: (s.provedor || 'claude') === 'claude' };
  }

  /** O agente está fazendo algo que pode gravar no disco? Só então o vigia conta o que mudou na pasta. */
  agindo(sessao, a) {
    const j = this.janelas.ativas.get(sessao);
    if (!j) return false;
    if (!a.ganchos) return OCUPADO.has(j.estado); // sem ganchos: vale o estado lido da tela
    // com ganchos as edições já chegam pelo gancho; o vigia só pega o que um comando (Bash, MCP...) gravar
    const agora = Date.now();
    return (a.acoes > 0 && agora - a.ultimaAcao < ACAO_MAX_MS) || agora - a.fimAcao < FOLGA_MS;
  }

  /** Os ganchos (Claude Code): antes e depois de cada edição, lidos do disco pelo Engram. */
  evento(sessao, evento, ferramenta, entrada) {
    // o Codex também manda um aviso (fim de turno) por aqui: sem ganchos, nada a guardar
    const a = this.assistindo.get(sessao) || ((this.janelas.cerebro.sessao(sessao)?.provedor || 'claude') === 'claude' ? this.estado(sessao) : null);
    if (!a?.ganchos) return;
    const comando = ferramenta && !EDITORES.has(ferramenta) && !SO_LEITURA.has(ferramenta);
    if (evento === 'PreToolUse' && comando) { a.acoes++; a.ultimaAcao = Date.now(); }
    else if (evento === 'PostToolUse' && comando && a.acoes > 0) { if (--a.acoes === 0) a.fimAcao = Date.now(); }
    else if (['Stop', 'UserPromptSubmit', 'SessionStart', 'SessionEnd'].includes(evento)) { if (a.acoes) a.fimAcao = Date.now(); a.acoes = 0; }
    if (!EDITORES.has(ferramenta) || !entrada) return;
    const arquivo = entrada.file_path || entrada.notebook_path || entrada.path;
    if (!arquivo) return;
    const abs = path.resolve(this.pastaDe(sessao), String(arquivo));
    if (evento === 'PreToolUse') {
      const antes = lerTexto(abs);
      if (antes === null) return;
      a.antes.set(abs, antes);
      a.recentes.set(abs, Date.now());
      if (a.janelas > 0) this.avisar({ tipo: 'trabalho', sessao, fase: 'vai-escrever', arquivo: abs, rel: this.rel(sessao, abs), ferramenta });
      if (this.janelas.cfg.pensamento_no_palco !== false) this.avisar({ tipo: 'pensamento', sessao, fase: 'vai', rel: this.rel(sessao, abs) });
    } else if (evento === 'PostToolUse') {
      // o arquivo leva um instante para chegar ao disco
      setTimeout(() => {
        const depois = lerTexto(abs);
        if (depois === null) return;
        const antes = a.antes.has(abs) ? a.antes.get(abs) : a.vistos.get(abs) ?? '';
        a.antes.delete(abs);
        a.recentes.set(abs, Date.now());
        this.lembrar(a, abs, depois);
        try { a.datas.set(abs, fs.statSync(abs).mtimeMs); } catch { /* saiu do disco */ }
        if (antes === depois) return;
        // o arquivo inteiro só vai quando a janela de trabalho está aberta; a bolha do palco recebe só o trecho
        if (a.janelas > 0) this.avisar({ tipo: 'trabalho', sessao, fase: 'escreveu', arquivo: abs, rel: this.rel(sessao, abs), ferramenta, antes, depois });
        this.pensar(sessao, abs, antes, depois);
      }, 120);
    }
  }

  /** O vigia da pasta (para os agentes sem ganchos, e para o que mudar por fora). */
  async mudouNoDisco(sessao, arquivo) {
    const a = this.assistindo.get(sessao);
    if (!a || !a.janelas) return;
    if (Date.now() - (a.recentes.get(arquivo) || 0) < 4000) return; // o gancho já contou essa
    let st;
    try { st = fs.statSync(arquivo); } catch { return; }
    if (st.isDirectory()) return;
    // o Windows avisa também quando o arquivo só é lido (data de acesso): sem mudar a data de gravação, não é edição
    const data = st.mtimeMs, dataVista = a.datas.get(arquivo);
    a.datas.set(arquivo, data);
    if (dataVista === data || (dataVista === undefined && data < a.desde)) {
      if (!a.vistos.has(arquivo)) { const t = lerTexto(arquivo); if (t !== null) this.lembrar(a, arquivo, t); }
      return;
    }
    const depois = lerTexto(arquivo);
    if (depois === null) return;
    let antes = a.vistos.get(arquivo);
    if (antes === undefined) antes = (await doGit(arquivo)) ?? '';
    this.lembrar(a, arquivo, depois);
    if (antes === depois) return;
    this.avisar({ tipo: 'trabalho', sessao, fase: 'escreveu', arquivo, rel: this.rel(sessao, arquivo), ferramenta: 'disco', antes, depois });
    this.pensar(sessao, arquivo, antes, depois);
  }

  registrarRotas(rota, { abrirJanela }) {
    rota('POST', '/api/trabalho/abrir', (_, b) => { this.info(String(b.sessao || '')); abrirJanela(String(b.sessao)); return { ok: true }; });
    rota('GET', '/api/trabalho/:sessao', p => this.info(p.sessao));
    rota('GET', '/api/trabalho/:sessao/ler', (p, __, q) => {
      const abs = path.resolve(this.pastaDe(p.sessao), String(q.get('arquivo') || ''));
      return { texto: lerTexto(abs) };
    });
  }
}

module.exports = { Trabalho, trechoMudado };
