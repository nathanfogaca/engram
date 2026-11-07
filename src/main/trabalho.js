// "Visualizar trabalho": ver um agente escrevendo código, numa janela à parte. O gancho dos agentes nunca
// manda conteúdo (só o alvo: o caminho do arquivo); quem lê o arquivo é o próprio Engram, no disco: antes da
// edição (no PreToolUse) e depois (no PostToolUse). A janela recebe o antes e o depois e anima a escrita.
// Agentes sem ganchos (Codex, Gemini...) são acompanhados por um vigia na pasta deles.

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const EDITORES = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const LIMITE = 2 * 1024 * 1024;

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
    const r = path.relative(this.pastaDe(sessao), arquivo);
    return r && !r.startsWith('..') && !path.isAbsolute(r) ? r.split(path.sep).join('/') : arquivo;
  }

  /** Começa a acompanhar uma sessão (uma janela de trabalho abriu). */
  assistir(sessao) {
    let a = this.assistindo.get(sessao);
    if (a) { a.janelas++; return this.info(sessao); }
    a = { janelas: 1, antes: new Map(), recentes: new Map(), vistos: new Map(), vigia: null, timers: new Map() };
    this.assistindo.set(sessao, a);
    const pasta = this.pastaDe(sessao);
    try {
      a.vigia = fs.watch(pasta, { recursive: true }, (_t, nome) => {
        if (!nome) return;
        const partes = String(nome).split(/[\\/]/);
        if (partes.some(p => p.startsWith('.') || p === 'node_modules' || p === '__pycache__')) return;
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
    for (const t of a.timers.values()) clearTimeout(t);
    this.assistindo.delete(sessao);
  }

  info(sessao) {
    const s = this.janelas.cerebro.sessao(sessao);
    if (!s) throw new Error('sessão não encontrada');
    const j = this.janelas.ativas.get(sessao);
    return { id: s.id, nome: s.nome, provedor: s.provedor, modelo: s.modelo, papel: s.papel, pasta: this.pastaDe(sessao), estado: j ? j.estado : 'encerrada', viva: !!j, ganchos: (s.provedor || 'claude') === 'claude' };
  }

  /** Os ganchos (Claude Code): antes e depois de cada edição, lidos do disco pelo Engram. */
  evento(sessao, evento, ferramenta, entrada) {
    const a = this.assistindo.get(sessao);
    if (!a || !EDITORES.has(ferramenta)) return;
    const arquivo = entrada.file_path || entrada.notebook_path || entrada.path;
    if (!arquivo) return;
    const abs = path.resolve(this.pastaDe(sessao), String(arquivo));
    if (evento === 'PreToolUse') {
      const antes = lerTexto(abs);
      if (antes === null) return;
      a.antes.set(abs, antes);
      a.recentes.set(abs, Date.now());
      this.avisar({ tipo: 'trabalho', sessao, fase: 'vai-escrever', arquivo: abs, rel: this.rel(sessao, abs), ferramenta });
    } else if (evento === 'PostToolUse') {
      // o arquivo leva um instante para chegar ao disco
      setTimeout(() => {
        const depois = lerTexto(abs);
        if (depois === null) return;
        const antes = a.antes.has(abs) ? a.antes.get(abs) : a.vistos.get(abs) ?? '';
        a.antes.delete(abs);
        a.recentes.set(abs, Date.now());
        a.vistos.set(abs, depois);
        if (antes === depois) return;
        this.avisar({ tipo: 'trabalho', sessao, fase: 'escreveu', arquivo: abs, rel: this.rel(sessao, abs), ferramenta, antes, depois });
      }, 120);
    }
  }

  /** O vigia da pasta (para os agentes sem ganchos, e para o que mudar por fora). */
  async mudouNoDisco(sessao, arquivo) {
    const a = this.assistindo.get(sessao);
    if (!a) return;
    if (Date.now() - (a.recentes.get(arquivo) || 0) < 4000) return; // o gancho já contou essa
    if (!fs.existsSync(arquivo) || fs.statSync(arquivo).isDirectory()) return;
    const depois = lerTexto(arquivo);
    if (depois === null) return;
    let antes = a.vistos.get(arquivo);
    if (antes === undefined) antes = (await doGit(arquivo)) ?? '';
    a.vistos.set(arquivo, depois);
    if (antes === depois) return;
    this.avisar({ tipo: 'trabalho', sessao, fase: 'escreveu', arquivo, rel: this.rel(sessao, arquivo), ferramenta: 'disco', antes, depois });
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

module.exports = { Trabalho };
