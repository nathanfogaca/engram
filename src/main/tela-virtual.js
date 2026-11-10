// Tela virtual de um terminal (xterm sem tela): é dela que sai o texto limpo do ver_tela.

const { Terminal } = require('@xterm/headless');

class TelaVirtual {
  constructor(colunas, linhas) {
    this.t = new Terminal({ cols: colunas, rows: linhas, scrollback: 3000, allowProposedApi: true });
  }
  escrever(texto) {
    try { this.t.write(texto); } catch { /* sequência estranha: só aquele trecho se perde */ }
  }
  get colunas() { return this.t.cols; }
  get linhas() { return this.t.rows; }
  redimensionar(colunas, linhas) {
    try { this.t.resize(colunas, linhas); } catch { /* ignora */ }
  }
  texto(linhas) {
    const b = this.t.buffer.active;
    const todas = [];
    for (let i = 0; i < b.length; i++) todas.push(b.getLine(i)?.translateToString(true) ?? '');
    while (todas.length && !todas[todas.length - 1].trim()) todas.pop();
    return todas.slice(-linhas).join('\n');
  }
}

module.exports = { TelaVirtual };
