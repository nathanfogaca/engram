// Skills do Engram (formato SKILL.md do Claude Code, que o Codex também usa).
// A biblioteca fica em <dados>/skills/<nome>/. Cada skill liga e desliga e diz para quais agentes vale:
// - Claude Code: entram como um plugin só da janela (--plugin-dir), com o nome "engram:<skill>";
//   a pasta ~/.claude/skills da pessoa não é tocada.
// - Codex: não aceita pasta extra, então a skill é instalada em ~/.codex/skills/engram-<nome>, com a marca
//   .engram. O Engram só mexe nas pastas que ele mesmo instalou.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const YAML = require('yaml');

const NOME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const AGENTES_SKILL = ['claude', 'codex'];
const MARCA = '.engram';

function frontmatter(texto) {
  const m = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(texto);
  if (!m) return { erro: 'falta o cabeçalho entre --- no início (name e description)' };
  try {
    const d = YAML.parse(m[1]) || {};
    return { dados: d, corpo: texto.slice(m[0].length) };
  } catch (e) { return { erro: `cabeçalho inválido: ${e.message.split('\n')[0]}` }; }
}

function validar(texto, nomeEsperado = null) {
  const f = frontmatter(texto);
  if (f.erro) return f.erro;
  const nome = String(f.dados.name || '').trim();
  const desc = String(f.dados.description || '').trim();
  if (!NOME.test(nome)) return 'o "name" tem de ser minúsculo, com letras, números e hífen (até 64)';
  if (nomeEsperado && nome !== nomeEsperado) return `o "name" (${nome}) tem de ser igual ao nome da skill (${nomeEsperado})`;
  if (!desc) return 'falta a "description": é por ela que o agente sabe quando usar a skill';
  if (desc.length > 1024) return 'a "description" passa de 1024 caracteres';
  return null;
}

class Skills {
  constructor({ dados, registrar }) {
    this.dir = path.join(dados, 'skills');
    this.arqEstado = path.join(dados, 'skills.json');
    this.plugin = path.join(dados, 'plugin-claude');
    this.codex = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'skills');
    this.registrar = registrar || (() => {});
    fs.mkdirSync(this.dir, { recursive: true });
    try { this.estado = JSON.parse(fs.readFileSync(this.arqEstado, 'utf8')); } catch { this.estado = {}; }
  }

  gravarEstado() { fs.writeFileSync(this.arqEstado, JSON.stringify(this.estado, null, 2), 'utf8'); }
  config(nome) { return { ativo: true, agentes: [...AGENTES_SKILL], ...(this.estado[nome] || {}) }; }

  listar() {
    const saida = [];
    for (const nome of fs.readdirSync(this.dir).sort()) {
      const pasta = path.join(this.dir, nome);
      const arq = path.join(pasta, 'SKILL.md');
      if (!fs.existsSync(arq)) continue;
      const texto = fs.readFileSync(arq, 'utf8');
      const f = frontmatter(texto);
      saida.push({
        nome, descricao: f.dados ? String(f.dados.description || '') : '', erro: validar(texto, nome),
        arquivos: contarArquivos(pasta), ...this.config(nome),
      });
    }
    return saida;
  }

  caminho(nome) {
    if (!NOME.test(String(nome || ''))) throw new Error('nome de skill inválido');
    return path.join(this.dir, nome);
  }

  ler(nome) {
    const arq = path.join(this.caminho(nome), 'SKILL.md');
    if (!fs.existsSync(arq)) throw new Error('skill não encontrada');
    return { nome, texto: fs.readFileSync(arq, 'utf8'), pasta: this.caminho(nome), ...this.config(nome) };
  }

  criar(nome, descricao) {
    nome = String(nome || '').trim().toLowerCase().replace(/\s+/g, '-');
    const pasta = this.caminho(nome);
    if (fs.existsSync(pasta)) throw new Error(`já existe uma skill chamada ${nome}`);
    const desc = String(descricao || '').replace(/\r?\n/g, ' ').trim() || 'Diga aqui o que a skill faz e quando o agente deve usá-la.';
    const texto = `---\nname: ${nome}\ndescription: ${JSON.stringify(desc)}\n---\n\n# ${nome}\n\nEscreva aqui as instruções da skill: o passo a passo, exemplos e o que evitar.\n`;
    fs.mkdirSync(pasta, { recursive: true });
    fs.writeFileSync(path.join(pasta, 'SKILL.md'), texto, 'utf8');
    this.estado[nome] = this.config(nome);
    this.gravarEstado();
    this.sincronizar();
    return this.ler(nome);
  }

  salvar(nome, texto) {
    const pasta = this.caminho(nome);
    if (!fs.existsSync(pasta)) throw new Error('skill não encontrada');
    const erro = validar(String(texto || ''), nome);
    if (erro) throw new Error(erro);
    fs.writeFileSync(path.join(pasta, 'SKILL.md'), String(texto), 'utf8');
    this.sincronizar();
    return this.ler(nome);
  }

  remover(nome) {
    fs.rmSync(this.caminho(nome), { recursive: true, force: true });
    delete this.estado[nome];
    this.gravarEstado();
    this.sincronizar();
  }

  ajustar(nome, { ativo, agentes }) {
    this.caminho(nome);
    const c = this.config(nome);
    if (ativo !== undefined) c.ativo = !!ativo;
    if (Array.isArray(agentes)) c.agentes = agentes.filter(a => AGENTES_SKILL.includes(a));
    this.estado[nome] = c;
    this.gravarEstado();
    this.sincronizar();
    return c;
  }

  /** Importa de uma pasta, de um SKILL.md ou de um .zip/.skill (o pacote do skill-creator). */
  async importar(origem) {
    origem = String(origem || '');
    if (!fs.existsSync(origem)) throw new Error('não achei esse arquivo ou pasta');
    let pasta = origem;
    let temporaria = null;
    if (fs.statSync(origem).isFile()) {
      if (/SKILL\.md$/i.test(origem)) pasta = path.dirname(origem);
      else if (/\.(zip|skill)$/i.test(origem)) { temporaria = await extrair(origem); pasta = temporaria; } else throw new Error('escolha uma pasta, um SKILL.md ou um .zip/.skill');
    }
    try {
      const raiz = acharRaizSkill(pasta);
      if (!raiz) throw new Error('não há um SKILL.md nessa pasta (nem uma pasta abaixo)');
      const texto = fs.readFileSync(path.join(raiz, 'SKILL.md'), 'utf8');
      const erro = validar(texto);
      if (erro) throw new Error(erro);
      const nome = String(frontmatter(texto).dados.name).trim();
      const destino = this.caminho(nome);
      if (fs.existsSync(destino)) throw new Error(`já existe uma skill chamada ${nome}`);
      fs.cpSync(raiz, destino, { recursive: true, filter: f => !/[\\/](\.git|node_modules|__pycache__)([\\/]|$)/.test(f) && path.basename(f) !== MARCA });
      this.estado[nome] = this.config(nome);
      this.gravarEstado();
      this.sincronizar();
      return this.ler(nome);
    } finally {
      if (temporaria) fs.rmSync(path.dirname(temporaria), { recursive: true, force: true });
    }
  }

  /** Skills que já existem no Claude Code e no Codex da pessoa (fora do Engram), para trazer. */
  encontradas() {
    const saida = [];
    const ja = new Set(fs.readdirSync(this.dir));
    const olhar = (base, origem) => {
      let nomes = [];
      try { nomes = fs.readdirSync(base); } catch { return; }
      for (const n of nomes) {
        const pasta = path.join(base, n);
        const arq = path.join(pasta, 'SKILL.md');
        if (!fs.existsSync(arq) || fs.existsSync(path.join(pasta, MARCA))) continue;
        const f = frontmatter(fs.readFileSync(arq, 'utf8'));
        const nome = f.dados ? String(f.dados.name || n) : n;
        saida.push({ origem, nome, descricao: f.dados ? String(f.dados.description || '').slice(0, 300) : '', caminho: pasta, importada: ja.has(nome) });
      }
    };
    olhar(path.join(os.homedir(), '.claude', 'skills'), 'Claude Code');
    olhar(this.codex, 'Codex');
    return saida;
  }

  /** Pasta do plugin do Engram para o Claude (null se nenhuma skill ativa vale para o Claude). */
  pluginParaClaude() {
    return fs.existsSync(path.join(this.plugin, 'skills')) && fs.readdirSync(path.join(this.plugin, 'skills')).length ? this.plugin : null;
  }

  /** Remonta o plugin do Claude e as skills do Engram dentro do Codex. Vale para janelas novas. */
  sincronizar() {
    const ativas = this.listar().filter(s => s.ativo && !s.erro);
    try {
      fs.rmSync(path.join(this.plugin, 'skills'), { recursive: true, force: true });
      fs.mkdirSync(path.join(this.plugin, '.claude-plugin'), { recursive: true });
      fs.writeFileSync(path.join(this.plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'engram', description: 'Skills da biblioteca do Engram', version: '1.0.0' }, null, 2));
      for (const s of ativas.filter(x => x.agentes.includes('claude'))) fs.cpSync(path.join(this.dir, s.nome), path.join(this.plugin, 'skills', s.nome), { recursive: true });
    } catch (e) { this.registrar(`skills (Claude): ${e.message}`); }
    try {
      const querem = new Set(ativas.filter(x => x.agentes.includes('codex')).map(x => `engram-${x.nome}`));
      let existentes = [];
      try { existentes = fs.readdirSync(this.codex); } catch { /* sem pasta */ }
      for (const n of existentes) {
        // só o que o Engram instalou (pasta com a marca) sai
        if (n.startsWith('engram-') && fs.existsSync(path.join(this.codex, n, MARCA)) && !querem.has(n)) fs.rmSync(path.join(this.codex, n), { recursive: true, force: true });
      }
      if (querem.size) fs.mkdirSync(this.codex, { recursive: true });
      for (const s of ativas.filter(x => x.agentes.includes('codex'))) {
        const destino = path.join(this.codex, `engram-${s.nome}`);
        if (fs.existsSync(destino) && !fs.existsSync(path.join(destino, MARCA))) continue; // pasta da pessoa com esse nome: não mexe
        fs.rmSync(destino, { recursive: true, force: true });
        fs.cpSync(path.join(this.dir, s.nome), destino, { recursive: true });
        fs.writeFileSync(path.join(destino, MARCA), 'Instalada pelo Engram. Para tirar, desative a skill no Engram.\n');
      }
    } catch (e) { this.registrar(`skills (Codex): ${e.message}`); }
  }
}

function contarArquivos(pasta) {
  let n = 0;
  const andar = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) andar(path.join(d, e.name)); else n++; } };
  try { andar(pasta); } catch { /* sumiu */ }
  return n;
}

function acharRaizSkill(pasta) {
  if (fs.existsSync(path.join(pasta, 'SKILL.md'))) return pasta;
  const filhas = fs.readdirSync(pasta, { withFileTypes: true }).filter(e => e.isDirectory() && fs.existsSync(path.join(pasta, e.name, 'SKILL.md')));
  return filhas.length === 1 ? path.join(pasta, filhas[0].name) : null;
}

function extrair(arquivo) {
  const destino = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-skill-'));
  const zip = path.join(destino, 'pacote.zip');
  fs.copyFileSync(arquivo, zip);
  const saida = path.join(destino, 'conteudo');
  const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolve, reject) => {
    execFile(ps, ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath $env:ENGRAM_ZIP -DestinationPath $env:ENGRAM_DESTINO -Force'],
      { windowsHide: true, timeout: 60_000, env: { ...process.env, ENGRAM_ZIP: zip, ENGRAM_DESTINO: saida } }, erro => {
        if (erro) { fs.rmSync(destino, { recursive: true, force: true }); return reject(new Error('não deu para abrir o pacote (.zip/.skill)')); }
        resolve(saida);
      });
  });
}

module.exports = { Skills, AGENTES_SKILL, validar };
