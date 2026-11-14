// Diário do palco no cérebro: cada delegação e cada devolutiva vira uma linha numa nota do dia
// (sessoes/diario-AAAA-MM-DD.md), com hora, de, para, estado, assunto e um resumo curto. Nunca o texto inteiro das
// mensagens. Assim nada se perde quando a conversa do maestro é resumida por tamanho.
// A mesma peça grava a devolutiva de uma automação como nota própria, quando a pessoa pede.
// Liga e desliga em Ajustes (diario_no_cerebro). Cérebro em pasta: grava no disco. Cérebro remoto: pela
// ferramenta arquivos_gravar do servidor, se ele tiver uma (senão avisa uma vez e para).

const fs = require('node:fs');
const path = require('node:path');
const { mascarar } = require('./janelas'); // senhas, tokens e credenciais (o mesmo do equipe)

const PASTA_DIARIO = 'sessoes';
const ESPERA = 4000; // junta as linhas de alguns segundos numa gravação só
// no servidor, cada gravação que substitui a nota deixa uma cópia de backup lá: junta as linhas por mais tempo
const ESPERA_SERVIDOR = 60_000;
const VOLTAS_CONFERIR = 3; // outra gravação no meio apagou as nossas linhas: lê de novo e regrava, até 3 vezes

const dois = n => String(n).padStart(2, '0');
const dia = d => `${d.getFullYear()}-${dois(d.getMonth() + 1)}-${dois(d.getDate())}`;
const hora = d => `${dois(d.getHours())}:${dois(d.getMinutes())}`;
const MAX_TENTATIVAS = 5; // servidor fora do ar: as linhas esperam e tentam de novo, sem gravar por cima de nada
const ESPERA_REPETIR = 60_000;

/**
 * O cérebro é compartilhado e não guarda dado pessoal nem segredo: e-mail, CPF, CNPJ, telefone e sequências com cara
 * de token saem mascarados da linha do diário (o assunto vem do texto que o maestro escreveu).
 */
function semDados(t) {
  return mascarar(t)
    .replace(/[\w.+-]+@(?:[\w-]+\.)+[\w-]{2,}/g, '•••@•••')
    .replace(/\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g, '•••')
    .replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, '•••')
    .replace(/\(?\b\d{2}\)?[\s.-]?9?\d{4}[\s.-]?\d{4}\b/g, '•••')
    .replace(/[A-Za-z0-9_-]{32,}/g, '•••');
}

/** Uma linha só, sem quebras, sem barras verticais, sem dado pessoal e sem abrir [[ligação]] por acidente. */
function limpo(texto, max) {
  let t = semDados(String(texto || '').replace(/\s+/g, ' ').replace(/\[\[/g, '[ [').trim());
  if (t.length > max) t = `${t.slice(0, max).replace(/\s+\S*$/, '')}…`;
  return t;
}

/** O nome de arquivo de uma automação: minúsculas, sem acento, só letras, números e hífen. */
function lesma(texto) {
  return String(texto || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'automacao';
}

class Diario {
  constructor({ cfg, fonte, cerebro, avisar }) {
    Object.assign(this, { cfg, fonte, cerebro, avisar });
    this.fila = []; // [{ quando: Date, linha }]
    this.timer = null;
    this.parado = null; // motivo, quando a gravação remota não funciona
    this.gravando = Promise.resolve();
  }

  ligado() { return this.cfg.diario_no_cerebro !== false && !this.parado; }

  /** Anota uma linha: { de, para, estado, assunto, resumo, setor }. */
  registrar({ de, para = null, estado, assunto = '', resumo = '', setor = null }, quando = new Date()) {
    if (!this.ligado()) return;
    const quem = para ? `**${limpo(de, 60)} → ${limpo(para, 60)}**` : `**${limpo(de, 60)}**`;
    const partes = [`${hora(quando)}`, quem, `*${estado}*`];
    if (setor) partes.push(`setor ${limpo(setor, 40)}`);
    if (assunto) partes.push(limpo(assunto, 100));
    let linha = `- ${partes.join(' · ')}`;
    if (resumo) linha += ` — ${limpo(resumo, 200)}`;
    this.fila.push({ quando, linha });
    if (this.fonte.tipo === 'pasta') { clearTimeout(this.timer); this.timer = setTimeout(() => this.descarregar(), ESPERA); }
    else if (!this.timer) this.timer = setTimeout(() => this.descarregar(), ESPERA_SERVIDOR); // no servidor: no máximo uma gravação por minuto
  }

  /** Grava agora o que está na fila (o app chama ao fechar e antes de trocar a fonte do cérebro). */
  descarregar() {
    clearTimeout(this.timer);
    this.timer = null;
    const lote = this.fila.splice(0);
    if (!lote.length) return this.gravando;
    const fonte = this.fonte; // as linhas vão para o cérebro em que nasceram, mesmo que a fonte troque no meio
    // a fila pode atravessar a meia-noite: cada linha vai para a nota do dia dela
    const porDia = new Map();
    for (const l of lote) { const d = dia(l.quando); if (!porDia.has(d)) porDia.set(d, []); porDia.get(d).push(l); }
    this.gravando = this.gravando.then(async () => {
      for (const [d, itens] of porDia) {
        try { await this.acrescentar(d, itens.map(l => l.linha), fonte); }
        catch (e) {
          // servidor que não respondeu: nada foi gravado; as linhas voltam e tentam de novo daqui a pouco
          const tentativas = (itens[0].tentativas || 0) + 1;
          if (e.transitorio && tentativas < MAX_TENTATIVAS && fonte === this.fonte) {
            this.fila.unshift(...itens.map(l => ({ ...l, tentativas })));
            clearTimeout(this.timer);
            this.timer = setTimeout(() => this.descarregar(), ESPERA_REPETIR);
          } else this.falhou(e, fonte);
        }
      }
    });
    return this.gravando;
  }

  cabecalho(d) {
    const [a, m, x] = d.split('-');
    return `---\ntipo: sessao\ntitulo: Diário do palco · ${x}/${m}/${a}\ndata: ${d}\n---\n# Diário do palco · ${x}/${m}/${a}\n\n`
      + 'Delegações e devolutivas do time, anotadas pelo Engram: só o assunto e um resumo curto (o texto inteiro fica nas conversas).\n\n';
  }

  /** Acrescenta linhas à nota do dia (cria a nota se ainda não existe). */
  async acrescentar(d, linhas, fonte = this.fonte) {
    const rel = `${PASTA_DIARIO}/diario-${d}.md`;
    const bloco = `${linhas.join('\n')}\n`;
    if (fonte.tipo === 'pasta') {
      const arq = path.join(fonte.pasta, ...rel.split('/'));
      fs.mkdirSync(path.dirname(arq), { recursive: true });
      if (!fs.existsSync(arq)) fs.writeFileSync(arq, this.cabecalho(d) + bloco, 'utf8');
      else {
        const atual = fs.readFileSync(arq, 'utf8');
        fs.appendFileSync(arq, (atual.endsWith('\n') ? '' : '\n') + bloco, 'utf8');
      }
    } else {
      // no servidor é ler, juntar e gravar a nota inteira: "não existe" só pela listagem; qualquer erro de leitura
      // (rede, servidor fora) para tudo, sem gravar por cima do diário que já está lá. Depois de gravar, lê de novo:
      // se outra gravação (outro Engram) passou por cima no meio e as nossas linhas sumiram, junta e grava outra vez
      for (let volta = 1; ; volta++) {
        let atual = '', existe = false;
        try {
          await this.conferirGravacao(fonte);
          existe = await fonte.existe(rel);
          if (existe) atual = await fonte.ler(rel);
        } catch (e) { e.transitorio = !e.definitivo; throw e; }
        const faltam = linhas.filter(l => !atual.includes(l));
        if (!faltam.length) break; // já estão lá (a volta anterior gravou e ninguém apagou)
        if (volta > VOLTAS_CONFERIR) { const e = new Error('outra gravação no mesmo diário apagou as linhas três vezes seguidas'); e.transitorio = true; throw e; }
        if (existe && !fonte.aceitaSobrescrever) { const e = new Error('o servidor não deixa substituir uma nota (arquivos_gravar sem sobrescrever): o diário só cria a nota do dia'); e.definitivo = true; throw e; }
        const blocoQueFalta = `${faltam.join('\n')}\n`;
        const novo = atual ? `${atual}${atual.endsWith('\n') ? '' : '\n'}${blocoQueFalta}` : this.cabecalho(d) + blocoQueFalta;
        // erro na gravação (rede, ou outro Engram criou a nota do dia no meio e o servidor recusou "já existe") não
        // para o diário: a volta seguinte lê de novo e regrava com sobrescrever; esgotadas as voltas, volta para a fila
        try { await this.gravarRemoto(rel, novo, fonte, existe); } catch (e) {
          if (e.definitivo || volta >= VOLTAS_CONFERIR) { e.transitorio = !e.definitivo; throw e; }
        }
      }
    }
    if (fonte === this.cerebro.fonte) await this.indexar(rel);
  }

  /**
   * Antes da primeira gravação no servidor: ele tem uma arquivos_gravar que recebe caminho e conteudo? Se não, o
   * diário para com um aviso (melhor que gravar com campos errados).
   */
  async conferirGravacao(fonte) {
    if (fonte.gravacaoConferida) return;
    const esquema = await fonte.esquema('arquivos_gravar');
    const campos = Object.keys(esquema?.properties || {});
    if (!esquema || !campos.includes('caminho') || !campos.includes('conteudo')) {
      const e = new Error(esquema ? `a ferramenta arquivos_gravar do servidor pede outros campos (${campos.join(', ') || 'nenhum'})` : 'o servidor não tem a ferramenta arquivos_gravar');
      e.definitivo = true;
      throw e;
    }
    fonte.aceitaSobrescrever = campos.includes('sobrescrever'); // sem ele, uma nota que já existe não pode ser substituída
    fonte.gravacaoConferida = true;
  }

  /** Grava uma nota inteira (a devolutiva de uma automação). Devolve o caminho relativo no cérebro. */
  async gravarNota(rel, conteudo) {
    const fonte = this.fonte;
    if (fonte.tipo === 'pasta') {
      const arq = path.resolve(fonte.pasta, ...rel.split('/'));
      if (!arq.startsWith(path.resolve(fonte.pasta) + path.sep)) throw new Error('fora do cérebro');
      fs.mkdirSync(path.dirname(arq), { recursive: true });
      fs.writeFileSync(arq, conteudo, 'utf8');
    } else {
      await this.conferirGravacao(fonte);
      if (await fonte.existe(rel)) throw new Error('já existe uma nota com esse nome no servidor');
      await this.gravarRemoto(rel, conteudo, fonte);
    }
    if (fonte === this.cerebro.fonte) await this.indexar(rel);
    return rel;
  }

  /**
   * A devolutiva de uma automação vira uma nota em automacoes/<nome>/AAAA-MM-DD-HHMMSS.md. O cérebro é compartilhado:
   * e-mail, CPF, CNPJ, telefone, senha e token saem mascarados também aqui.
   */
  async notaDeAutomacao(automacao, texto, quando = new Date()) {
    const d = dia(quando), h = hora(quando);
    const rel = `automacoes/${lesma(automacao.nome)}/${d}-${h.replace(':', '')}${dois(quando.getSeconds())}.md`;
    texto = semDados(String(texto || '')).replace(/\[\[/g, '[ [');
    const yaml = s => JSON.stringify(String(s)); // aspas e escapes válidos em YAML
    const conteudo = `---\ntipo: devolutiva\ntitulo: ${yaml(`${automacao.nome} · ${d.split('-').reverse().join('/')} ${h}`)}\nautomacao: ${yaml(automacao.nome)}\ndata: ${d}\n---\n`
      + `# ${automacao.nome} · ${d.split('-').reverse().join('/')} ${h}\n\n${String(texto || '').trim()}\n`;
    return this.gravarNota(rel, conteudo);
  }

  /** Grava no servidor. Substituir um arquivo que já existe pede sobrescrever = true (o servidor guarda um backup). */
  async gravarRemoto(rel, conteudo, fonte = this.fonte, sobrescrever = false) {
    const raiz = fonte.raiz ? `${fonte.raiz}/` : '';
    await fonte.chamar('arquivos_gravar', { caminho: `${raiz}${rel}`, conteudo, ...(sobrescrever ? { sobrescrever: true } : {}) });
  }

  async indexar(rel) {
    try {
      const erro = await this.cerebro.sincronizarArquivo(rel);
      this.avisar({ tipo: 'cerebro', mudou: rel, erro });
    } catch { /* a sincronização periódica pega depois */ }
  }

  falhou(e, fonte = this.fonte) {
    require('./config').registrar(`diário no cérebro: ${e.message}`);
    if (fonte === this.fonte && this.fonte.tipo !== 'pasta' && !this.parado) {
      this.parado = e.message;
      this.avisar({ tipo: 'aviso', texto: `O diário do palco parou: o cérebro remoto não aceitou gravar (${e.message.slice(0, 120)}). Ele volta quando o Engram reiniciar ou quando o cérebro trocar de fonte.` });
    }
  }
}

module.exports = { Diario, lesma, limpo, semDados };
