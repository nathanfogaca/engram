// Quadro de tarefas delegadas: cada mensagem que o maestro manda pelo enviar vira uma tarefa (de quem, para
// quem, assunto, quando). Ela passa por delegada → em andamento (a mensagem chegou e o colega está nela) →
// devolvida (o colega respondeu ao maestro com o enviar) → entregue (o maestro marca pela ferramenta tarefas,
// ou a pessoa marca na tela). Guarda só o começo da devolutiva; o texto inteiro fica na tabela mensagens.

const { agora, PALCOS } = require('./banco');

const ESQUEMA = `
CREATE TABLE IF NOT EXISTS tarefas (
  n INTEGER PRIMARY KEY, de TEXT NOT NULL, para TEXT NOT NULL, assunto TEXT NOT NULL, mensagem INTEGER, setor TEXT,
  criada TEXT NOT NULL, estado TEXT NOT NULL, andamento TEXT, devolvida TEXT, entregue TEXT,
  devolutiva TEXT, devolutiva_n INTEGER, devolutiva_de TEXT, marcou TEXT, palco INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS tarefas_par ON tarefas(de, para, estado);
CREATE INDEX IF NOT EXISTS tarefas_mensagem ON tarefas(mensagem);
`;
const ESTADOS = { delegada: 'delegada', andamento: 'em andamento', devolvida: 'devolvida', entregue: 'entregue' };
const ABERTAS = "('delegada','andamento')";
const TRECHO = 600; // o começo da devolutiva que o quadro guarda

/** O texto sem o que o Engram acrescenta no fim (anexos e a nota do setor), numa linha só. */
function corpoDe(texto) {
  return String(texto || '').split(/\n\n\[Arquivos que |\n\n\((?:Mensagem para o setor |[^\n()]{1,60} quis mandar isto ao setor )/)[0];
}
function umaLinha(texto, max) {
  const t = String(texto || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}
/** Os parágrafos do começo, até `max` letras, com as quebras de linha (a tela mostra em Markdown). */
function trecho(texto, max = TRECHO) {
  const t = corpoDe(texto).trim();
  return t.length > max ? `${t.slice(0, max).replace(/\s+\S*$/, '')}…` : t;
}

class Tarefas {
  constructor({ db, janelas, avisar, diario = null }) {
    this.db = db;
    this.janelas = janelas;
    this.avisar = avisar;
    this.diario = diario;
    this.st = new Map();
    db.exec(ESQUEMA);
    // o quadro é de cada palco (o do maestro que delegou)
    if (!db.prepare("PRAGMA table_info('tarefas')").all().some(c => c.name === 'palco')) db.exec('ALTER TABLE tarefas ADD COLUMN palco INTEGER NOT NULL DEFAULT 1');
    janelas.tarefas = this; // o enviar e a entrega das mensagens avisam por aqui
  }

  q(sql) {
    let s = this.st.get(sql);
    if (!s) { s = this.db.prepare(sql); this.st.set(sql, s); }
    return s;
  }

  nome(id) { return this.janelas.cerebro.sessao(id)?.nome || 'agente que saiu'; }

  /** O que a tela e a ferramenta recebem. */
  paraTela(t) {
    if (!t) return null;
    return { ...t, nome_de: this.nome(t.de), nome_para: this.nome(t.para), nome_devolutiva_de: t.devolutiva_de ? this.nome(t.devolutiva_de) : null, rotulo: ESTADOS[t.estado] || t.estado };
  }
  pegar(n) { const r = this.q('SELECT * FROM tarefas WHERE n = ?').get(n); return r ? { ...r } : null; }

  avisarMudou(n, extra = {}) { this.avisar({ tipo: 'tarefa', tarefa: this.paraTela(this.pegar(n)), ...extra }); }

  /** Uma linha no diário do cérebro. Delegada: maestro → colega; devolvida e entregue: colega → maestro. */
  diarioLinha(t, estado, resumo = '') {
    try {
      const ida = estado === 'delegada';
      const rotulo = estado === 'entregue' ? `entregue (marcou: ${t.marcou === 'pessoa' ? 'a pessoa' : this.nome(t.marcou)})` : ESTADOS[estado];
      this.diario?.registrar({
        de: ida ? this.nome(t.de) : this.nome(estado === 'devolvida' ? t.devolutiva_de || t.para : t.para),
        para: ida ? this.nome(t.para) : this.nome(t.de),
        estado: rotulo, assunto: t.assunto, resumo, setor: t.setor,
      });
    } catch { /* o diário nunca atrapalha o time */ }
  }

  // ---------------------------------------------------------------- o que o enviar e a caixa avisam

  /** O maestro mandou uma mensagem a um colega (já na caixa dele, com o número `mensagem`). */
  delegou(de, para, texto, mensagem, setor = null) {
    if (!this.janelas.ehMaestro(de) || !this.janelas.cerebro.sessao(para)) return null;
    const assunto = umaLinha(corpoDe(texto), 160) || '(sem texto)';
    const n = Number(this.q('INSERT INTO tarefas (de, para, assunto, mensagem, setor, criada, estado, palco) VALUES (?,?,?,?,?,?,?,?)')
      .run(de, para, assunto, mensagem ?? null, setor, agora(), 'delegada', this.janelas.cerebro.palcoDe(de)).lastInsertRowid);
    this.avisarMudou(n, { acao: 'criada' });
    this.diarioLinha(this.pegar(n), 'delegada');
    return n;
  }

  /** A mensagem `mensagem` foi colada no terminal do colega: a tarefa dela está em andamento. */
  chegou(mensagem) {
    const t = this.q("SELECT * FROM tarefas WHERE mensagem = ? AND estado = 'delegada'").get(mensagem);
    if (!t) return;
    this.q("UPDATE tarefas SET estado = 'andamento', andamento = ? WHERE n = ?").run(agora(), t.n);
    this.avisarMudou(t.n, { acao: 'andamento' });
  }

  /**
   * `de` mandou uma mensagem a `para`. Se `para` tinha delegado a `de` uma tarefa ainda aberta, ela foi devolvida
   * (vale a mais antiga). O revisor que entrega ao maestro devolve a tarefa de quem ele revisa.
   */
  respondeu(de, para, texto, mensagem = null) {
    const quem = [de, ...this.janelas.cerebro.revisados(de)]; // o revisor devolve a tarefa de quem ele revisa
    const marcas = quem.map(() => '?').join(',');
    // 1) a devolutiva cita o número ("Tarefa 12:"): casa exato, com qualquer tarefa aberta desse par
    const citado = /\btarefa\s+n?[º°.]?\s*(\d+)\b/i.exec(corpoDe(texto).slice(0, 400));
    let t = citado ? this.q(`SELECT * FROM tarefas WHERE n = ? AND de = ? AND para IN (${marcas}) AND estado IN ${ABERTAS}`).get(Number(citado[1]), para, ...quem) : null;
    // 2) sem número: a mais antiga EM ANDAMENTO (a que ainda está na fila, sem ter chegado ao colega, nunca fecha)
    if (!t) t = this.q(`SELECT * FROM tarefas WHERE de = ? AND para IN (${marcas}) AND estado = 'andamento' ORDER BY (para = ?) DESC, n LIMIT 1`).get(para, ...quem, de);
    if (!t) return null;
    this.q("UPDATE tarefas SET estado = 'devolvida', devolvida = ?, andamento = COALESCE(andamento, ?), devolutiva = ?, devolutiva_n = ?, devolutiva_de = ? WHERE n = ?")
      .run(agora(), agora(), trecho(texto), mensagem, de, t.n);
    this.avisarMudou(t.n, { acao: 'devolvida' });
    const nova = this.pegar(t.n);
    this.diarioLinha(nova, 'devolvida', umaLinha(resumoDe(texto), 200));
    return t.n;
  }

  /** O maestro (pela ferramenta) ou a pessoa (na tela) marca a tarefa como entregue. */
  entregar(n, quem = 'pessoa') {
    const t = this.pegar(Number(n));
    if (!t) throw new Error(`não há tarefa ${n}`);
    if (t.estado === 'entregue') return this.paraTela(t);
    this.q("UPDATE tarefas SET estado = 'entregue', entregue = ?, marcou = ? WHERE n = ?").run(agora(), quem, t.n);
    this.avisarMudou(t.n, { acao: 'entregue' });
    this.diarioLinha(this.pegar(t.n), 'entregue');
    return this.paraTela(this.pegar(t.n));
  }

  // ---------------------------------------------------------------- leitura

  /** As abertas e devolvidas todas; as entregues dos últimos `dias`. */
  lista({ dias = 3, de = null, palco = null } = {}) {
    const desde = new Date(Date.now() - dias * 86_400_000);
    const p = x => String(x).padStart(2, '0');
    const limite = `${desde.getFullYear()}-${p(desde.getMonth() + 1)}-${p(desde.getDate())}T${p(desde.getHours())}:${p(desde.getMinutes())}:00`;
    const filtro = `${de ? 'AND de = ?' : ''} ${palco ? 'AND palco = ?' : ''}`;
    const args = [limite, ...(de ? [de] : []), ...(palco ? [palco] : [])];
    return this.q(`SELECT * FROM tarefas WHERE (estado != 'entregue' OR entregue >= ?) ${filtro} ORDER BY n DESC LIMIT 300`)
      .all(...args).map(r => this.paraTela({ ...r }));
  }

  /** O palco foi apagado: as tarefas dele saem do quadro. */
  apagarDoPalco(palco) {
    return this.q('DELETE FROM tarefas WHERE palco = ?').run(palco).changes;
  }

  /** A devolutiva inteira (a mensagem que fechou a tarefa), para o "ver tudo" da tela. */
  devolutivaInteira(n) {
    const t = this.pegar(Number(n));
    if (!t) throw new Error(`não há tarefa ${n}`);
    const m = t.devolutiva_n ? this.db.prepare('SELECT texto FROM mensagens WHERE n = ?').get(t.devolutiva_n) : null;
    const pedido = t.mensagem ? this.db.prepare('SELECT texto FROM mensagens WHERE n = ?').get(t.mensagem) : null;
    return { ...this.paraTela(t), devolutiva_inteira: m ? corpoDe(m.texto) : t.devolutiva, pedido: pedido ? corpoDe(pedido.texto) : t.assunto };
  }

  /** A ferramenta tarefas do maestro: o quadro dele, e marcar como entregues as que ele já conferiu. */
  paraMaestro(de, { entregue = [], todas = false } = {}) {
    if (!this.janelas.ehMaestro(de)) return 'Só o maestro tem quadro de tarefas.';
    const marcadas = [], erros = [];
    for (const n of (Array.isArray(entregue) ? entregue : [entregue]).filter(x => x !== undefined && x !== null && x !== '')) {
      const t = this.pegar(Number(n));
      if (!t || t.de !== de) { erros.push(String(n)); continue; }
      this.entregar(t.n, de);
      marcadas.push(t.n);
    }
    const ha = q => { const ms = Date.now() - new Date(q).getTime(); const min = Math.round(ms / 60_000); return min < 1 ? 'agora' : min < 60 ? `${min} min` : min < 1440 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${Math.floor(min / 1440)} dia(s)`; };
    const item = t => {
      const quando = t.estado === 'devolvida' ? t.devolvida : t.estado === 'andamento' ? t.andamento : t.estado === 'entregue' ? t.entregue : t.criada;
      const o = { n: t.n, para: t.nome_para, assunto: t.assunto, estado: t.rotulo, ha: ha(quando) };
      if (t.setor) o.setor = t.setor;
      if (t.devolutiva) o.devolutiva = umaLinha(t.devolutiva, 300);
      if (t.devolutiva_de && t.devolutiva_de !== t.para) o.devolvida_por = t.nome_devolutiva_de;
      if (t.estado !== 'entregue' && t.estado !== 'devolvida' && !this.janelas.ativas.has(t.para)) o.aviso = 'o colega não está mais aberto: esta tarefa não vai voltar; marque como entregue para tirar do quadro';
      return o;
    };
    const lista = this.lista({ dias: todas ? 30 : 1, de });
    const r = {
      explicacao: 'Cada mensagem que você manda pelo enviar vira uma tarefa: delegada → em andamento (chegou ao colega) → devolvida (ele respondeu a você) → entregue (você conferiu e passou adiante). Marque as devolvidas que já tratou com entregue: [n, ...]. A pessoa vê o mesmo quadro no palco.',
      devolvidas_esperando_voce: lista.filter(t => t.estado === 'devolvida').map(item),
      em_andamento: lista.filter(t => t.estado === 'andamento').map(item),
      delegadas_ainda_na_fila: lista.filter(t => t.estado === 'delegada').map(item),
      entregues: lista.filter(t => t.estado === 'entregue').slice(0, 20).map(item),
    };
    if (marcadas.length) r.marquei_como_entregues = marcadas;
    if (erros.length) r.nao_achei = `Não há tarefa sua com o número ${erros.join(', ')}.`;
    return JSON.stringify(r, null, 2);
  }

  registrarRotas(rota) {
    rota('GET', '/api/tarefas', (p, b, q) => {
      const palco = Number(q.get('palco'));
      return this.lista({ dias: Math.min(Number(q.get('dias')) || 3, 60), palco: Number.isInteger(palco) && palco >= 1 && palco <= PALCOS ? palco : this.janelas.cerebro.palcoAtual() });
    });
    rota('GET', '/api/tarefas/:n', p => this.devolutivaInteira(p.n));
    rota('POST', '/api/tarefas/:n/entregue', p => this.entregar(p.n, 'pessoa'));
  }
}

/** A primeira linha de conteúdo, sem marcação (o mesmo jeito do resumo das automações). */
function resumoDe(texto) {
  const limpa = l => l.replace(/^[\s#>*\-•|]+/, '').replace(/[*_`]/g, '').trim();
  const linhas = corpoDe(texto).split(/\r?\n/).map(l => l.trim()).filter(l => limpa(l).length > 2 && !/^[-*_=|: ]{3,}$/.test(l) && !/^\[Engram/.test(l));
  return limpa(linhas.find(l => !l.startsWith('#')) || linhas[0] || '');
}

module.exports = { Tarefas, corpoDe, trecho, resumoDe, ESTADOS };
