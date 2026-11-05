// De onde vêm as notas do cérebro.
// - FontePasta (padrão): uma pasta local de arquivos .md. Os agentes leem e gravam com as próprias
//   ferramentas de arquivo.
// - FonteRemota (opcional): um servidor MCP com as ferramentas arquivos_listar/arquivos_ler. Quem não
//   tem um servidor assim usa a pasta.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const https = require('node:https');
const http = require('node:http');
const { opcoesDeConexao } = require('./tls-proprio');

const LEIAME = `---
tipo: guia
titulo: Como o cérebro funciona
---
# Cérebro do Engram

O cérebro é a memória de longo prazo compartilhada pelos agentes: notas Markdown ligadas entre si.

- O **id** de uma nota é o nome do arquivo sem \`.md\`, e é o que vai dentro de \`[[...]]\`.
- Pastas sugeridas: \`assuntos/\`, \`padroes/\` (problemas que se repetem), \`sistemas/\`, \`projetos/\`.
- Frontmatter simples no topo (\`tipo\`, \`titulo\`, \`atualizado\`) e campos que viram ligação:
  \`relacionados: [outra-nota]\`, \`sistemas: [...]\`, \`projetos: [...]\`.
- Uma nota, um assunto. Antes de criar, procure: duplicata é pior que nota incompleta.
- Nada de dado pessoal ou segredo.
`;

class FontePasta {
  constructor(pasta) {
    this.pasta = path.resolve(pasta);
    this.tipo = 'pasta';
  }

  preparar() {
    fs.mkdirSync(this.pasta, { recursive: true });
    const leiame = path.join(this.pasta, 'LEIAME.md');
    if (!fs.existsSync(leiame)) fs.writeFileSync(leiame, LEIAME, 'utf8');
  }

  descricao() {
    return `As notas ficam na pasta ${this.pasta} (convenções em LEIAME.md); leia e grave com as suas ferramentas de arquivo.`;
  }

  /** caminho relativo à pasta, com "/", ou null se for de fora do cérebro */
  relativo(caminho) {
    const abs = path.resolve(String(caminho || ''));
    const rel = path.relative(this.pasta, abs);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || !rel.toLowerCase().endsWith('.md')) return null;
    return rel.split(path.sep).join('/');
  }

  async listar() {
    const saida = new Map();
    const andar = async (dir) => {
      let itens;
      try { itens = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const it of itens) {
        if (it.name.startsWith('.')) continue;
        const p = path.join(dir, it.name);
        if (it.isDirectory()) await andar(p);
        else if (it.isFile() && it.name.toLowerCase().endsWith('.md')) {
          const st = await fsp.stat(p);
          saida.set(path.relative(this.pasta, p).split(path.sep).join('/'), `${st.size}:${Math.floor(st.mtimeMs)}`);
        }
      }
    };
    await andar(this.pasta);
    return saida;
  }

  async ler(rel) {
    const alvo = path.resolve(this.pasta, rel);
    if (!alvo.startsWith(this.pasta + path.sep)) throw new Error('fora do cérebro');
    return fsp.readFile(alvo, 'utf8');
  }

  observar(aoMudar) {
    let timer = null;
    try {
      this.vigia = fs.watch(this.pasta, { recursive: true }, () => {
        clearTimeout(timer);
        timer = setTimeout(aoMudar, 800);
      });
    } catch { /* sem vigia: a sincronização periódica cobre */ }
  }
}

// ------------------------------------------------------------------ servidor remoto (MCP com arquivos_*)

const LINHA_ARQUIVO = /^(.+?)\s{2}\(([\d.,]+) bytes, (\d{2}\/\d{2}\/\d{4} \d{2}:\d{2})\)$/;
const CABECALHO_LEITURA = /^\[(.+), parte (\d+) de (\d+)\]\r?\n\r?\n?/;

class FonteRemota {
  constructor({ url, token_env = '', ca = '', pasta_remota = 'cerebro', servidor = 'cerebro' }) {
    this.tipo = 'remoto';
    this.servidor = servidor; // nome do MCP com que os agentes enxergam esse servidor
    this.url = new URL(url);
    this.tokenEnv = token_env;
    this.ca = ca ? fs.readFileSync(ca) : undefined;
    this.raiz = pasta_remota.replace(/^\/+|\/+$/g, '');
    this.prefixo = `mcp__${servidor}__`;
    this.marcas = [];
    this.n = 0;
  }

  preparar() {}

  descricao() {
    return `As notas ficam em ${this.raiz}/ no servidor; leia e grave pelas ferramentas ${this.prefixo}arquivos_*.`;
  }

  relativo(caminho) {
    const c = String(caminho || '').replace(/\\/g, '/');
    if (!c.startsWith(this.raiz + '/') || !c.toLowerCase().endsWith('.md')) return null;
    return c.slice(this.raiz.length + 1);
  }

  async esperarVez() {
    // no máximo 40 chamadas por minuto: o servidor é compartilhado com os agentes
    for (;;) {
      const t = Date.now();
      this.marcas = this.marcas.filter(m => t - m < 60_000);
      if (this.marcas.length < 40) { this.marcas.push(t); return; }
      await new Promise(r => setTimeout(r, 60_000 - (t - this.marcas[0]) + 50));
    }
  }

  async chamar(ferramenta, argumentos) {
    const token = process.env[this.tokenEnv];
    if (!token) throw new Error(`a variável de ambiente ${this.tokenEnv} não está definida`);
    await this.esperarVez();
    const corpo = JSON.stringify({ jsonrpc: '2.0', id: ++this.n, method: 'tools/call', params: { name: ferramenta, arguments: argumentos } });
    const mod = this.url.protocol === 'https:' ? https : http;
    const conexao = await opcoesDeConexao(this.url, this.ca); // certificado conferido antes de o token sair
    const resposta = await new Promise((resolve, reject) => {
      const req = mod.request(this.url, {
        ...conexao, method: 'POST', timeout: 60_000,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Content-Length': Buffer.byteLength(corpo) },
      }, res => {
        let dados = '';
        res.setEncoding('utf8');
        res.on('data', c => { dados += c; });
        res.on('end', () => resolve({ status: res.statusCode, tipo: res.headers['content-type'] || '', dados }));
      });
      req.on('timeout', () => req.destroy(new Error('o servidor não respondeu')));
      req.on('error', e => reject(new Error(`sem conexão com o servidor (${e.code || e.message})`)));
      req.end(corpo);
    });
    if (resposta.status !== 200) throw new Error(`o servidor respondeu HTTP ${resposta.status}`);
    let json;
    if (resposta.tipo.startsWith('text/event-stream')) {
      const linha = resposta.dados.split(/\r?\n/).find(l => l.startsWith('data:'));
      json = JSON.parse(linha.slice(5));
    } else json = JSON.parse(resposta.dados);
    if (json.error) throw new Error(`erro do servidor: ${json.error.message}`);
    const texto = (json.result?.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
    if (json.result?.isError) throw new Error(texto.slice(0, 300) || 'a ferramenta devolveu erro');
    return texto;
  }

  async listar() {
    const saida = new Map();
    const fila = [this.raiz];
    while (fila.length) {
      const pasta = fila.pop();
      const texto = await this.chamar('arquivos_listar', { pasta });
      for (const linha of texto.split(/\r?\n/).slice(1)) {
        const l = linha.trimEnd();
        if (!l) continue;
        if (l.endsWith('/')) { fila.push(`${pasta}/${l.slice(0, -1)}`); continue; }
        const m = LINHA_ARQUIVO.exec(l);
        if (m && m[1].toLowerCase().endsWith('.md')) saida.set(`${pasta}/${m[1]}`.slice(this.raiz.length + 1), `${m[2]}:${m[3]}`);
      }
    }
    return saida;
  }

  async ler(rel) {
    const partes = [];
    let parte = 1, total = 1;
    while (parte <= total) {
      let texto = await this.chamar('arquivos_ler', { caminho: `${this.raiz}/${rel}`, parte });
      const m = CABECALHO_LEITURA.exec(texto);
      if (m) { total = Number(m[3]); texto = texto.slice(m[0].length); }
      partes.push(texto);
      parte++;
    }
    return partes.join('');
  }

  observar() {}
}

function criarFonte(cfg) {
  const c = cfg.cerebro || {};
  if (c.fonte === 'remoto' && c.url) return new FonteRemota(c);
  return new FontePasta(c.pasta);
}

module.exports = { FontePasta, FonteRemota, criarFonte };
