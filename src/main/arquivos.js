// Pasta de arquivos de cada agente: o que a pessoa manda (recebidos) e o que o agente devolve (entregues).

const fs = require('node:fs');
const path = require('node:path');

const PASTAS = ['recebidos', 'entregues'];
const PROIBIDO = /[\x00-\x1f<>:"/\\|?*]/g;
const ID = /^[0-9a-f-]{36}$/;
const RESERVADOS = new Set(['CON', 'PRN', 'AUX', 'NUL', ...[1, 2, 3, 4, 5, 6, 7, 8, 9].flatMap(i => [`COM${i}`, `LPT${i}`])]);
const TIPOS = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.pdf': 'application/pdf', '.txt': 'text/plain', '.log': 'text/plain', '.csv': 'text/csv', '.md': 'text/markdown', '.json': 'application/json', '.sql': 'text/plain' };

class Arquivos {
  constructor(base) { this.base = base; }

  pasta(id) {
    if (!ID.test(id || '')) throw new Error('id inválido');
    const p = path.join(this.base, id);
    for (const q of PASTAS) fs.mkdirSync(path.join(p, q), { recursive: true });
    return p;
  }

  static nomeSeguro(nome) {
    nome = path.basename(String(nome || '').replace(/\\/g, '/')).replace(PROIBIDO, '_').replace(/^[ .]+|[ .]+$/g, '');
    if (!nome || nome === '.' || nome === '..') nome = 'arquivo';
    if (RESERVADOS.has(nome.split('.')[0].toUpperCase())) nome = `_${nome}`;
    if (nome.length > 120) {
      const ext = path.extname(nome).slice(0, 10);
      nome = nome.slice(0, 110 - ext.length) + ext;
    }
    return nome;
  }

  caminhoNovo(id, qual, nome) {
    if (!PASTAS.includes(qual)) throw new Error('pasta inválida');
    let destino = path.join(this.pasta(id), qual, Arquivos.nomeSeguro(nome));
    const ext = path.extname(destino), base = destino.slice(0, destino.length - ext.length);
    for (let n = 2; fs.existsSync(destino); n++) destino = `${base} (${n})${ext}`;
    return destino;
  }

  caminhoExistente(id, qual, nome) {
    if (!PASTAS.includes(qual) || nome !== Arquivos.nomeSeguro(nome)) throw new Error('arquivo inválido');
    const dir = path.resolve(this.pasta(id), qual);
    const alvo = path.resolve(dir, nome);
    if (path.dirname(alvo) !== dir || !fs.existsSync(alvo) || !fs.statSync(alvo).isFile()) throw new Error('arquivo não encontrado');
    return alvo;
  }

  listar(id) {
    const saida = { pasta: this.pasta(id) };
    for (const qual of PASTAS) {
      const dir = path.join(saida.pasta, qual);
      saida[qual] = fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isFile()).map(e => {
        const st = fs.statSync(path.join(dir, e.name));
        return { nome: e.name, tamanho: st.size, quando: new Date(st.mtimeMs).toISOString(), tipo: Arquivos.tipo(e.name) };
      }).sort((a, b) => b.quando.localeCompare(a.quando));
    }
    return saida;
  }

  static tipo(nome) { return TIPOS[path.extname(nome).toLowerCase()] || 'application/octet-stream'; }

  assinatura(id) {
    try {
      const dir = path.join(this.pasta(id), 'entregues');
      return fs.readdirSync(dir).map(n => { const st = fs.statSync(path.join(dir, n)); return `${n}|${st.mtimeMs}|${st.size}`; }).sort().join('\n');
    } catch { return ''; }
  }

  /** Copia um arquivo do disco (arrastado na tela ou indicado pelo agente). */
  copiar(id, qual, origem, nome, limiteBytes) {
    const st = fs.statSync(origem);
    if (!st.isFile()) throw new Error('não é um arquivo');
    if (st.size > limiteBytes) throw new Error('arquivo grande demais');
    if (qual === 'entregues' && path.dirname(path.resolve(origem)) === path.resolve(this.pasta(id), 'entregues')) return path.resolve(origem);
    const destino = this.caminhoNovo(id, qual, nome || path.basename(origem));
    fs.copyFileSync(origem, destino);
    return destino;
  }

  /** Grava bytes (um print colado, que não tem arquivo no disco). */
  gravar(id, nome, bytes, limiteBytes) {
    if (bytes.length > limiteBytes) throw new Error('arquivo grande demais');
    const destino = this.caminhoNovo(id, 'recebidos', nome);
    fs.writeFileSync(destino, bytes);
    return destino;
  }
}

module.exports = { Arquivos };
