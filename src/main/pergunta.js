// Lê, do texto da tela do terminal, a pergunta que o CLI do agente está fazendo: o que ele pergunta,
// o detalhe (o comando, o arquivo...) e as opções numeradas, com a que está marcada. É com isso que a
// vista Conversa mostra a pergunta com botões, sem a pessoa precisar ir ao terminal.
//
// Exemplo (Claude Code pedindo para rodar um comando):
//    Bash command
//      git status
//    Do you want to proceed?
//    ❯ 1. Yes
//      2. Yes, and don't ask again for git commands
//      3. No, and tell Claude what to do differently (esc)

const MOLDURA = /[─-╿]/g; // todos os traços de moldura (│ ─ ╭ ╌ ...)
const MARCA = '❯›▶▸→>●◉*';
const OPCAO = new RegExp(`^\\s*([${MARCA}])?\\s*(\\d{1,2})[.)]\\s+(\\S.*)$`);
// rodapés de diálogo: a última linha da tela quando o CLI espera uma tecla
const RODAPE = /\b(enter to (confirm|continue|submit|select|proceed)|esc to (cancel|exit|skip|go back|close)|press enter|\(y\/n\)|\[y\/n\])/i;
// quando o agente está trabalhando, o "esc to interrupt" não é pergunta
const TRABALHANDO = /esc to interrupt/i;

const limpar = l => l.replace(MOLDURA, ' ').replace(/\s+$/, '');

/**
 * { titulo, detalhe: [linhas], opcoes: [{ n, texto, atual }], rodape } ou null se não há pergunta na tela.
 * Sem opções numeradas, mas com rodapé de diálogo ("Enter to continue · Esc to cancel"), devolve opcoes: [].
 */
function lerPergunta(tela, { linhas = 30 } = {}) {
  const todas = String(tela || '').split('\n').map(limpar);
  while (todas.length && !todas[todas.length - 1].trim()) todas.pop();
  const ls = todas.slice(-linhas);
  if (!ls.length) return null;

  // o bloco de opções mais perto do fim: 1., 2., 3... em linhas seguidas (uma opção pode quebrar de linha)
  let bloco = null;
  for (let i = ls.length - 1; i >= 0 && !bloco; i--) {
    const m = OPCAO.exec(ls[i]);
    if (!m || Number(m[2]) !== 1) continue;
    const opcoes = [{ n: 1, texto: m[3].trim(), atual: !!m[1], recuo: ls[i].search(/\d/) }];
    let fim = i;
    for (let k = i + 1; k < ls.length; k++) {
      const o = OPCAO.exec(ls[k]);
      if (o && Number(o[2]) === opcoes.length + 1) { opcoes.push({ n: opcoes.length + 1, texto: o[3].trim(), atual: !!o[1], recuo: ls[k].search(/\d/) }); fim = k; continue; }
      // continuação da opção de cima: linha recuada além do número, sem número próprio
      const recuo = ls[k].search(/\S/);
      if (recuo > opcoes[opcoes.length - 1].recuo && !o && ls[k].trim() && !RODAPE.test(ls[k])) { opcoes[opcoes.length - 1].texto += ` ${ls[k].trim()}`; fim = k; continue; }
      break;
    }
    // vale como pergunta: duas opções ou mais, uma só marcada, e nada além de rodapé depois dela
    const marcadas = opcoes.filter(o => o.atual).length;
    const resto = ls.slice(fim + 1).filter(l => l.trim());
    if (opcoes.length >= 2 && marcadas === 1 && resto.length <= 3) bloco = { inicio: i, fim, opcoes: opcoes.map(({ n, texto, atual }) => ({ n, texto: texto.slice(0, 200), atual })) };
  }

  const ultima = ls[ls.length - 1];
  const rodape = RODAPE.test(ultima) && !TRABALHANDO.test(ultima) ? ultima.trim() : (bloco && ls.slice(bloco.fim + 1).map(l => l.trim()).find(l => RODAPE.test(l))) || '';
  if (!bloco && !rodape) return null;

  // o que vem antes: a pergunta (a linha logo acima das opções) e o detalhe (as de cima, até um espaço grande)
  const ate = bloco ? bloco.inicio : ls.length - 1;
  const acima = [];
  let vazias = 0;
  for (let k = ate - 1; k >= 0 && acima.length < 14; k--) {
    const l = ls[k];
    if (!l.trim()) { if (++vazias >= 2 && acima.length) break; if (acima.length) acima.unshift(''); continue; }
    vazias = 0;
    acima.unshift(l);
  }
  while (acima.length && !acima[0].trim()) acima.shift();
  while (acima.length && !acima[acima.length - 1].trim()) acima.pop();
  // tira o recuo comum
  const recuo = Math.min(...acima.filter(l => l.trim()).map(l => l.search(/\S/)), 99);
  const corpo = acima.map(l => l.slice(Math.min(recuo, l.length)));
  // a pergunta é a última linha que termina em "?" (no Claude fica logo acima das opções; no Codex, no alto);
  // sem nenhuma, vale a linha de cima das opções (ou a primeira, num diálogo sem opções)
  let titulo = '';
  let qual = -1;
  for (let k = corpo.length - 1; k >= 0; k--) if (/\?\s*$/.test(corpo[k])) { qual = k; break; }
  if (qual < 0 && corpo.length) qual = bloco ? corpo.length - 1 : 0;
  if (qual >= 0) titulo = corpo.splice(qual, 1)[0].trim();
  while (corpo.length && !corpo[0].trim()) corpo.shift();
  while (corpo.length && !corpo[corpo.length - 1].trim()) corpo.pop();
  return { titulo: titulo.slice(0, 300), detalhe: corpo.map(l => l.slice(0, 200)).slice(-12), opcoes: bloco ? bloco.opcoes : [], rodape: rodape.slice(0, 200) };
}

/** As teclas que a tela pode mandar ao terminal para responder (nada além disto passa). */
const TECLAS = { enter: '\r', esc: '\x1b', cima: '\x1b[A', baixo: '\x1b[B', esquerda: '\x1b[D', direita: '\x1b[C', tab: '\t', espaco: ' ', sim: 'y', nao: 'n' };

module.exports = { lerPergunta, TECLAS, RODAPE, TRABALHANDO };
