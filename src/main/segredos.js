// Segredos que a pessoa digita numa janela do Engram (ferramenta pedir_segredo): chave de API, senha, usuário,
// string de conexão. O valor vai da tela direto para o arquivo .env, sem passar pelo agente, pela conversa,
// pelo banco nem pelo log; o agente recebe só os nomes gravados. O arquivo que recebeu segredo fica protegido:
// o gancho do Claude Code barra o agente de ler ou gravar nele (bloqueio), e mudanças voltam a passar por aqui.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const ESPERA_RESPOSTA = 50_000; // a ferramenta devolve "esperando" depois disso (o MCP não espera para sempre)
const VALIDADE_PEDIDO = 10 * 60_000;
const MAX_CAMPOS = 20, MAX_VALOR = 10_000;
const NOME = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;
const ARQUIVO_ENV = /^(\.env(\.[A-Za-z0-9_-]+)*|[A-Za-z0-9_-][A-Za-z0-9_.-]*\.env)$/i;
const CHAVE_ESTADO = 'segredos_arquivos';
// ferramentas que leem ou gravam um arquivo pelo caminho, e as de terminal (Claude Code, Codex e Antigravity)
const DE_ARQUIVO = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Grep', 'read_file', 'write_file', 'edit_file', 'view_file']);
const DE_COMANDO = new Set(['Bash', 'PowerShell', 'run_command', 'shell']);

const curto = (t, n) => String(t ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
/** O caminho de verdade (o Windows aceita o mesmo arquivo como C:\Users\NOME~1 e C:\Users\nome.longo). */
function canonico(p) {
  const abs = path.resolve(String(p));
  try { return fs.realpathSync.native(abs); } catch { /* ainda não existe */ }
  try { return path.join(fs.realpathSync.native(path.dirname(abs)), path.basename(abs)); } catch { return abs; }
}
const normal = p => canonico(p).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
const dentro = (raiz, p) => { const r = path.relative(raiz, p); return r === '' || (!!r && !r.startsWith('..') && !path.isAbsolute(r)); };
const escapar = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Valor como o dotenv lê: sem aspas quando dá, senão com as aspas que ele entende. */
function comAspas(v) {
  if (/^[A-Za-z0-9_\-.:/@+,%=~]*$/.test(v)) return v;
  if (!/['\r\n]/.test(v)) return `'${v}'`;
  if (!/["\r\n]/.test(v)) return `"${v}"`;
  if (!/[`\r\n]/.test(v)) return `\`${v}\``;
  return `"${v.replace(/\r?\n/g, '\\n')}"`;
}

/** Nomes que já têm valor no arquivo (o valor nunca sai daqui). */
function nomesNoArquivo(arquivo) {
  let texto = '';
  try { texto = fs.readFileSync(arquivo, 'utf8'); } catch { return new Set(); }
  const nomes = new Set();
  for (const l of texto.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=/.exec(l);
    if (m) nomes.add(m[1]);
  }
  return nomes;
}

/** Grava os valores no .env: troca a linha da variável (todas, se repetida) ou acrescenta no fim. Vazio = mantém. */
function gravarEnv(arquivo, valores) {
  let texto = '';
  try { texto = fs.readFileSync(arquivo, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const bom = texto.startsWith('﻿');
  if (bom) texto = texto.slice(1);
  const eol = texto.includes('\r\n') ? '\r\n' : texto ? '\n' : os.EOL;
  const linhas = texto ? texto.split(/\r?\n/) : [];
  if (linhas.length && linhas[linhas.length - 1] === '') linhas.pop();
  const feito = { novos: [], trocados: [], mantidos: [], vazios: [] };
  for (const [nome, valor] of Object.entries(valores)) {
    const re = new RegExp(`^\\s*(export\\s+)?${escapar(nome)}\\s*=`);
    const onde = linhas.map((l, i) => (re.test(l) ? i : -1)).filter(i => i >= 0);
    if (valor === '') { (onde.length ? feito.mantidos : feito.vazios).push(nome); continue; }
    const linha = `${nome}=${comAspas(valor)}`;
    if (!onde.length) { linhas.push(linha); feito.novos.push(nome); continue; }
    linhas[onde[0]] = linha;
    for (const i of onde.slice(1).reverse()) linhas.splice(i, 1);
    feito.trocados.push(nome);
  }
  if (feito.novos.length || feito.trocados.length) {
    const conteudo = (bom ? '﻿' : '') + linhas.join(eol) + eol;
    const temp = `${arquivo}.engram-${process.pid}-${Date.now()}.tmp`;
    try {
      fs.writeFileSync(temp, conteudo, { encoding: 'utf8', mode: 0o600 });
      try { fs.renameSync(temp, arquivo); } catch { fs.writeFileSync(arquivo, conteudo, 'utf8'); } // aberto por outro programa
    } finally {
      try { fs.rmSync(temp, { force: true }); } catch { /* já foi renomeado */ }
    }
  }
  return feito;
}

class Segredos {
  constructor({ cfg, cerebro, janelas, avisar }) {
    Object.assign(this, { cfg, cerebro, janelas, avisar });
    this.pedido = null;
    let lista = [];
    try { lista = JSON.parse(cerebro.estadoLer(CHAVE_ESTADO) || '[]'); } catch { /* vazio */ }
    this.protegidos = new Set(Array.isArray(lista) ? lista.map(normal) : []);
  }

  proteger(arquivo) {
    this.protegidos.add(normal(arquivo));
    this.cerebro.estadoGravar(CHAVE_ESTADO, JSON.stringify([...this.protegidos]));
  }

  /** Confere o pedido do agente e devolve o arquivo e os campos (sem valor de segredo nenhum). */
  preparar(de, a) {
    const j = this.janelas.ativas.get(de);
    const base = j?.pasta || this.cfg.pasta_trabalho || os.homedir();
    const arquivo = canonico(path.resolve(base, String(a.arquivo || '.env').trim() || '.env'));
    if (!ARQUIVO_ENV.test(path.basename(arquivo))) throw new Error('o arquivo tem de ser um .env (ex.: .env, .env.local, producao.env)');
    const pasta = path.dirname(arquivo);
    if (!fs.existsSync(pasta) || !fs.statSync(pasta).isDirectory()) throw new Error(`a pasta ${pasta} não existe`);
    const raizes = [os.homedir(), this.cfg.pasta_trabalho, j?.pasta].filter(Boolean).map(canonico);
    if (!raizes.some(r => dentro(r, arquivo))) throw new Error('o arquivo tem de ficar na pasta da pessoa (perfil do Windows ou pasta de trabalho)');
    try { if (fs.lstatSync(arquivo).isSymbolicLink()) throw new Error('o arquivo é um atalho (link): aponte para o arquivo de verdade'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const lista = Array.isArray(a.campos) ? a.campos : [];
    if (!lista.length) throw new Error('mande ao menos um campo em campos');
    if (lista.length > MAX_CAMPOS) throw new Error(`no máximo ${MAX_CAMPOS} campos por pedido`);
    const existentes = nomesNoArquivo(arquivo);
    const vistos = new Set();
    const campos = lista.map((c, i) => {
      const nome = String(c?.nome || '').trim();
      if (!NOME.test(nome)) throw new Error(`campos[${i}].nome: use letras, números e _ (ex.: OPENAI_API_KEY)`);
      if (vistos.has(nome)) throw new Error(`campos: ${nome} repetido`);
      vistos.add(nome);
      const secreto = c?.secreto !== false;
      return { nome, descricao: curto(c?.descricao, 200), secreto, valor: secreto ? '' : String(c?.valor ?? '').slice(0, MAX_VALOR), existe: existentes.has(nome) };
    });
    return { arquivo, campos };
  }

  /** O agente pede: mostra a janela e espera a pessoa (até ~50 s; depois, o resultado vai como mensagem). */
  async pedir(de, a = {}) {
    let p;
    try { p = this.preparar(de, a); } catch (e) { return `Não dá para pedir isso: ${e.message}.`; }
    if (this.pedido) return `Já há um pedido de segredo esperando a pessoa na tela do Engram (de ${this.pedido.quem}). Tente de novo quando ele for respondido.`;
    let resolver;
    const resposta = new Promise(r => { resolver = r; });
    const pedido = { id: crypto.randomUUID().slice(0, 8), de, quem: this.janelas.nomeDe(de), motivo: curto(a.motivo, 400), ...p, resolver, atrasado: false };
    this.pedido = pedido;
    pedido.prazo = setTimeout(() => this.encerrar(pedido, false, 'A pessoa não respondeu em 10 minutos: o pedido de segredo foi descartado e nada foi gravado.'), VALIDADE_PEDIDO);
    this.avisar({ tipo: 'segredo_pedido', pedido: this.paraTela(pedido) });
    let espera;
    const tempo = new Promise(r => { espera = setTimeout(() => r(null), ESPERA_RESPOSTA); });
    const r = await Promise.race([resposta, tempo]);
    clearTimeout(espera);
    if (r !== null) return r;
    pedido.atrasado = true;
    return 'O pedido está na tela do Engram, esperando a pessoa preencher. Quando ela responder, o Engram te manda uma mensagem com o resultado (só os nomes, nunca os valores). Não peça o segredo na conversa enquanto isso.';
  }

  paraTela(p) { return { id: p.id, quem: p.quem, motivo: p.motivo, arquivo: p.arquivo, campos: p.campos }; }

  pendente() { return this.pedido && !this.pedido.gravando ? this.paraTela(this.pedido) : null; }

  encerrar(p, gravou, texto) {
    if (this.pedido === p) this.pedido = null;
    clearTimeout(p.prazo);
    this.avisar({ tipo: 'segredo_pedido_fim', id: p.id, gravou });
    if (p.atrasado) this.janelas.recadoDoEngram?.(p.de, `Resposta ao seu pedir_segredo: ${texto}`);
    else p.resolver(texto);
  }

  /** A pessoa respondeu na tela: grava no arquivo, protege e conta ao agente só os nomes. */
  responder(id, aceitar, valores) {
    const p = this.pedido;
    if (!p || p.id !== id || p.gravando) throw new Error('esse pedido não está mais esperando');
    if (!aceitar) { this.encerrar(p, false, 'A pessoa recusou: nada foi gravado.'); return { ok: true, resumo: 'pedido recusado: nada foi gravado' }; }
    const v = valores && typeof valores === 'object' ? valores : {};
    const limpos = {};
    for (const c of p.campos) {
      const bruto = v[c.nome];
      const valor = typeof bruto === 'string' ? bruto.replace(/^\s+|\s+$/g, '') : '';
      if (valor.length > MAX_VALOR) throw new Error(`${c.nome}: valor grande demais`);
      limpos[c.nome] = valor;
    }
    p.gravando = true;
    let feito;
    try {
      feito = gravarEnv(p.arquivo, limpos);
    } catch (e) {
      p.gravando = false;
      throw new Error(`não deu para gravar em ${p.arquivo}: ${e.code || 'erro'}`); // sem o conteúdo
    }
    this.proteger(p.arquivo);
    const partes = [];
    if (feito.novos.length) partes.push(`novas: ${feito.novos.join(', ')}`);
    if (feito.trocados.length) partes.push(`trocadas: ${feito.trocados.join(', ')}`);
    if (feito.mantidos.length) partes.push(`mantidas como estavam: ${feito.mantidos.join(', ')}`);
    if (feito.vazios.length) partes.push(`ficaram sem valor (a pessoa deixou em branco): ${feito.vazios.join(', ')}`);
    const abertos = p.campos.filter(c => !c.secreto && limpos[c.nome]).map(c => `${c.nome}=${limpos[c.nome]}`);
    const base = path.basename(p.arquivo);
    const texto = `A pessoa preencheu e o Engram gravou em ${p.arquivo} (${partes.join('; ') || 'nada mudou'}).`
      + (abertos.length ? ` Valores que não são segredo: ${abertos.join(', ')}.` : '')
      + ` Os segredos não passam por você: não leia, não mostre e não grave ${base} por conta própria (o Engram barra), e não imprima essas variáveis;`
      + ` use-as pelo nome no código (ex.: process.env.NOME, os.environ["NOME"]). Para mudar ou acrescentar variável nesse arquivo, use pedir_segredo de novo.`
      + ` Se o projeto usa git, confira se ${base} está no .gitignore.`;
    this.encerrar(p, true, texto);
    return { ok: true, resumo: `gravado em ${base}: ${partes.join('; ') || 'nada mudou'}` };
  }

  /**
   * Gancho PreToolUse: a ferramenta mexe num arquivo com segredo? Devolve o motivo para barrar, ou null.
   * Pega o caminho das ferramentas de arquivo e o nome do arquivo nos comandos de terminal (cat, type, Get-Content...).
   */
  bloqueio(ferramenta, entrada, pasta) {
    if (!this.protegidos.size || !ferramenta || !entrada) return null;
    const base = pasta || this.cfg.pasta_trabalho || os.homedir();
    const motivo = p => `O Engram barrou: ${p} guarda segredos que a pessoa preencheu pelo Engram (pedir_segredo). Não leia, não mostre e não grave esse arquivo; use as variáveis pelo nome no código. Para mudar ou acrescentar variável nele, use a ferramenta pedir_segredo.`;
    if (DE_ARQUIVO.has(ferramenta)) {
      for (const k of ['file_path', 'path', 'caminho']) {
        const v = entrada[k];
        if (typeof v === 'string' && v && this.protegidos.has(normal(path.resolve(base, v)))) return motivo(path.resolve(base, v));
      }
    }
    const cmd = typeof entrada.command === 'string' ? entrada.command : '';
    if (DE_COMANDO.has(ferramenta) && cmd) {
      const minusculo = cmd.toLowerCase().replace(/\//g, '\\');
      const onde = normal(base);
      for (const p of this.protegidos) {
        const nome = path.basename(p);
        const pertoDaPasta = dentro(onde, path.dirname(p)) || dentro(path.dirname(p), onde);
        const citado = new RegExp(`(^|[\\s"'\`\\\\=(:;|&<>,])${escapar(nome)}($|[\\s"'\`;|&)<>,])`, 'i').test(minusculo);
        if (minusculo.includes(p) || (citado && pertoDaPasta)) return motivo(p);
      }
    }
    return null;
  }
}

module.exports = { Segredos, gravarEnv, comAspas };
