// Automações do palco: um cartão com uma orientação e um horário, ligado por uma linha a um agente (de
// preferência o maestro). Na hora marcada, a orientação entra na caixa do agente como uma mensagem; ele
// trabalha (e distribui para o time, se for maestro) e devolve o resultado com o enviar para o nome da
// automação, que aparece no cartão. Os post-its do palco moram aqui também: são notas soltas, e um
// post-it pode virar automação.
// O relógio roda no app (que fica na bandeja quando a janela fecha). Com o app fechado no horário, a
// automação roda quando ele abrir ou pula a vez, conforme a escolha da pessoa.

const crypto = require('node:crypto');
const { agora } = require('./banco');

const DIAS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const ABERTAS = "('rodando','parou')";
const LIMITE_RODADA = 6 * 3600_000; // sem devolutiva depois disso, a rodada fecha sozinha
const TOLERANCIA = 3 * 60_000; // passou do horário há mais que isso: o app estava fechado

const dois = n => String(n).padStart(2, '0');
const chaveLocal = d => `${d.getFullYear()}-${dois(d.getMonth() + 1)}-${dois(d.getDate())}T${dois(d.getHours())}:${dois(d.getMinutes())}`;
const quandoCurto = d => `${DIAS[d.getDay()]} ${dois(d.getDate())}/${dois(d.getMonth() + 1)} às ${dois(d.getHours())}:${dois(d.getMinutes())}`;

/** O horário marcado mais recente que já chegou (até uma semana atrás), ou null. */
function ultimoHorario(a, ate = new Date()) {
  if (a.manual || !a.dias.length) return null;
  const [h, m] = a.hora.split(':').map(Number);
  for (let k = 0; k < 8; k++) {
    const d = new Date(ate);
    d.setDate(d.getDate() - k);
    d.setHours(h, m, 0, 0);
    if (d <= ate && a.dias.includes(d.getDay())) return d;
  }
  return null;
}

function quandoTexto(a) {
  if (a.manual) return 'só quando a pessoa aperta o botão';
  const d = [...a.dias].sort((x, y) => x - y);
  const dias = d.join() === '1,2,3,4,5' ? 'dias úteis' : d.length === 7 ? 'todo dia' : d.map(i => DIAS[i]).join(', ');
  return `${dias} às ${a.hora}`;
}

/** A primeira linha de conteúdo (título só se não houver outra), sem marcação de Markdown: o resumo no cartão e no aviso. */
function resumir(texto) {
  const limpa = l => l.replace(/^[\s#>*\-•|]+/, '').replace(/[*_`]/g, '').trim();
  const linhas = String(texto).split(/\r?\n/).map(l => l.trim()).filter(l => limpa(l).length > 2 && !/^[-*_=|: ]{3,}$/.test(l));
  const linha = limpa(linhas.find(l => !l.startsWith('#')) || linhas[0] || '');
  return linha.length > 160 ? `${linha.slice(0, 157)}…` : linha;
}

class Automacoes {
  constructor({ db, janelas, avisar, notificar }) {
    this.db = db;
    this.janelas = janelas;
    this.avisar = avisar;
    this.notificar = notificar || (() => {});
    this.st = new Map();
    janelas.automacoes = this; // o enviar e o equipe falam com ela
  }

  q(sql) {
    let s = this.st.get(sql);
    if (!s) { s = this.db.prepare(sql); this.st.set(sql, s); }
    return s;
  }

  // ---------------------------------------------------------------- automações

  linha(r) { return r ? { ...r, dias: r.dias ? r.dias.split(',').map(Number) : [], manual: !!r.manual, aviso: !!r.aviso } : null; }
  pegar(id) { return this.linha(this.q('SELECT * FROM automacoes WHERE id = ?').get(id)); }
  todas() { return this.q('SELECT * FROM automacoes ORDER BY criado').all().map(r => this.linha(r)); }
  rodadas(id, limite = 10) { return this.q('SELECT * FROM automacao_rodadas WHERE automacao = ? ORDER BY n DESC LIMIT ?').all(id, limite).map(r => ({ ...r })); }
  rodadaAberta(id) {
    const r = this.q(`SELECT * FROM automacao_rodadas WHERE automacao = ? AND estado IN ${ABERTAS} ORDER BY n DESC LIMIT 1`).get(id);
    return r ? { ...r } : null;
  }

  /** O que a tela recebe: a automação com as últimas rodadas (a primeira é a mais nova). */
  paraTela(a) {
    if (!a) return null;
    const { visto, criado, ...resto } = a;
    return { ...resto, rodadas: this.rodadas(a.id, 8) };
  }
  lista() { return this.todas().map(a => this.paraTela(a)); }

  validar(b, atual = {}) {
    const nome = String(b.nome ?? atual.nome ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!nome) throw new Error('a automação precisa de um nome');
    if (this.todas().some(x => x.id !== atual.id && x.nome.toLowerCase() === nome.toLowerCase())) throw new Error(`já existe uma automação chamada "${nome}"`);
    const alvo = b.alvo === undefined ? atual.alvo ?? null : (b.alvo || null);
    if (alvo && !this.janelas.cerebro.sessao(alvo)) throw new Error('agente não encontrado');
    let dias = b.dias ?? atual.dias ?? [1, 2, 3, 4, 5];
    dias = [...new Set((Array.isArray(dias) ? dias : String(dias).split(',')).map(Number).filter(d => Number.isInteger(d) && d >= 0 && d <= 6))].sort((x, y) => x - y);
    const hora = String(b.hora ?? atual.hora ?? '09:00');
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(hora)) throw new Error('hora inválida');
    const num = (v, padrao) => (Number.isFinite(Number(v)) ? Math.max(-1e6, Math.min(Number(v), 1e6)) : padrao);
    return {
      nome, alvo, dias, hora,
      instrucao: String(b.instrucao ?? atual.instrucao ?? '').trim().slice(0, 4000),
      manual: !!(b.manual ?? atual.manual ?? false),
      perdida: (b.perdida ?? atual.perdida) === 'pular' ? 'pular' : 'rodar',
      aviso: !!(b.aviso ?? atual.aviso ?? true),
      x: num(b.x, atual.x ?? 0), y: num(b.y, atual.y ?? 0),
    };
  }

  gravar(a) {
    this.q(`INSERT INTO automacoes (id, nome, instrucao, alvo, dias, hora, manual, perdida, aviso, x, y, visto, criado) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET nome = excluded.nome, instrucao = excluded.instrucao, alvo = excluded.alvo, dias = excluded.dias, hora = excluded.hora,
      manual = excluded.manual, perdida = excluded.perdida, aviso = excluded.aviso, x = excluded.x, y = excluded.y, visto = excluded.visto`)
      .run(a.id, a.nome, a.instrucao, a.alvo ?? null, a.dias.join(','), a.hora, a.manual ? 1 : 0, a.perdida, a.aviso ? 1 : 0, a.x, a.y, a.visto ?? null, a.criado);
  }

  /** Horário novo: só valem os próximos (o que já passou hoje não roda por causa da mudança). */
  vistoAgora(a) { const d = ultimoHorario(a); return d ? chaveLocal(d) : null; }

  criar(b) {
    const a = { id: `auto-${crypto.randomUUID().slice(0, 8)}`, ...this.validar(b), criado: agora() };
    a.visto = this.vistoAgora(a);
    this.gravar(a);
    return this.salva(a.id);
  }

  editar(id, b) {
    const atual = this.pegar(id);
    if (!atual) throw new Error('automação não encontrada');
    const a = { ...atual, ...this.validar(b, atual) };
    if (a.hora !== atual.hora || a.dias.join() !== atual.dias.join() || a.manual !== atual.manual) a.visto = this.vistoAgora(a);
    this.gravar(a);
    return this.salva(id);
  }

  salva(id) {
    const t = this.paraTela(this.pegar(id));
    this.avisar({ tipo: 'automacao', acao: 'salva', automacao: t });
    return t;
  }

  remover(id) {
    const n = this.q('DELETE FROM automacoes WHERE id = ?').run(id).changes;
    this.q('DELETE FROM automacao_rodadas WHERE automacao = ?').run(id);
    if (n) this.avisar({ tipo: 'automacao', acao: 'removida', id });
    return { ok: true };
  }

  // ---------------------------------------------------------------- rodadas

  registrar(a, { marcada = null, motivo, estado, resumo = null, devolutiva = null, fim = false }) {
    const n = Number(this.q('INSERT INTO automacao_rodadas (automacao, marcada, inicio, fim, motivo, estado, resumo, devolutiva) VALUES (?,?,?,?,?,?,?,?)')
      .run(a.id, marcada, agora(), fim ? agora() : null, motivo, estado, resumo, devolutiva).lastInsertRowid);
    return n;
  }

  fechar(n, estado, resumo) { this.q('UPDATE automacao_rodadas SET estado = ?, fim = ?, resumo = ? WHERE n = ?').run(estado, agora(), resumo, n); }

  avisarRodada(a, extra = {}) { this.avisar({ tipo: 'automacao', acao: 'rodada', automacao: this.paraTela(this.pegar(a.id)), ...extra }); }

  avisarSistema(a, titulo, texto) { if (a.aviso) this.notificar({ titulo, texto, automacao: a.id }); }

  /** Roda agora. motivo: 'botão' (a pessoa pediu), 'horário' ou 'atrasada' (o app estava fechado no horário). */
  rodar(id, motivo = 'botão', marcada = null) {
    const a = this.pegar(id);
    if (!a) throw new Error('automação não encontrada');
    const chave = marcada ? chaveLocal(marcada) : null;
    const pelaPessoa = motivo === 'botão';
    const falhou = (resumo, estado = 'falhou') => {
      if (pelaPessoa) throw new Error(resumo);
      this.registrar(a, { marcada: chave, motivo, estado, resumo, fim: true });
      this.avisarRodada(a);
      if (estado === 'falhou') this.avisarSistema(a, `${a.nome} não rodou`, resumo);
      return null;
    };
    if (!a.alvo) return falhou('ligue a automação a um agente: arraste a bolinha do cartão até ele');
    if (this.rodadaAberta(id)) return falhou('a rodada anterior ainda não terminou', pelaPessoa ? 'falhou' : 'pulou');
    const j = this.janelas.ativas.get(a.alvo);
    if (!j) return falhou(`${this.janelas.nomeDe(a.alvo)} não está aberto no palco`);
    const n = this.registrar(a, { marcada: chave, motivo, estado: 'rodando' });
    this.avisarRodada(a);
    this.janelas.enfileirar(j, `auto:${a.id}`, a.instrucao || '(sem orientação)', this.mensagem(a, motivo, marcada));
    return { n };
  }

  mensagem(a, motivo, marcada) {
    const cab = motivo === 'botão' ? 'rodada pedida agora pela pessoa' : quandoCurto(marcada);
    const setor = this.janelas.cerebro.setorDe(a.alvo);
    const doSetor = setor?.instrucao ? `\n\n(Você está no setor ${setor.nome} do palco. Instrução do setor: ${setor.instrucao})` : '';
    const atraso = motivo === 'atrasada' ? ` Era para ${quandoCurto(marcada)}, mas o Engram estava fechado nessa hora: ela roda agora.` : '';
    const instrucao = a.instrucao || '(A automação está sem orientação. Pergunte à pessoa o que fazer, devolvendo a pergunta pelo enviar.)';
    return `[Engram · automação "${a.nome}" · ${cab}]\n${instrucao}${doSetor}\n\n(Esta tarefa vem de uma automação que a pessoa deixou no palco, ligada a você.${atraso} Quando terminar, devolva o resultado com mcp__engram__enviar para="${a.nome}": é o que a pessoa lê no cartão da automação. Se distribuir o trabalho para colegas, espere as respostas deles e devolva uma vez só, com tudo junto.)`;
  }

  /** A automação ligada a este agente com esse nome (para onde o enviar leva a devolutiva). */
  daJanela(de, nome) {
    const n = String(nome || '').trim().toLowerCase();
    return n ? this.todas().find(a => a.alvo === de && a.nome.toLowerCase() === n) || null : null;
  }

  /** O agente devolveu o resultado pelo enviar: fecha a rodada aberta (ou registra uma nova). */
  devolver(a, de, texto) {
    texto = String(texto || '').trim();
    if (!texto) return 'A mensagem está vazia.';
    const resumo = resumir(texto);
    const aberta = this.rodadaAberta(a.id);
    if (aberta) this.q('UPDATE automacao_rodadas SET estado = ?, fim = ?, resumo = ?, devolutiva = ? WHERE n = ?').run('ok', agora(), resumo, texto.slice(0, 20_000), aberta.n);
    else this.registrar(a, { motivo: 'agente', estado: 'ok', resumo, devolutiva: texto.slice(0, 20_000), fim: true });
    this.avisarRodada(a, { devolveu: de });
    this.avisarSistema(a, `${a.nome} terminou`, resumo || 'O resultado está no cartão.');
    return `Entregue à automação "${a.nome}": a pessoa lê no cartão${a.aviso ? ' e recebe um aviso do Windows' : ''}.`;
  }

  /** As automações ligadas a um agente, para o equipe dele. */
  paraEquipe(id) {
    const l = this.todas().filter(a => a.alvo === id);
    if (!l.length) return null;
    return {
      explicacao: 'Automações que a pessoa ligou a você no palco. Quando uma roda, a orientação chega como [Engram · automação "nome"]. Devolva o resultado com enviar, para = o nome da automação.',
      lista: l.map(a => ({ nome: a.nome, quando: quandoTexto(a), orientacao: a.instrucao.length > 300 ? `${a.instrucao.slice(0, 300)}…` : a.instrucao })),
    };
  }

  // ---------------------------------------------------------------- o relógio

  /** Chamado a cada poucos segundos: dispara o que chegou na hora e acompanha as rodadas abertas. */
  vigiar(agoraD = new Date()) {
    for (const a of this.todas()) {
      const marcada = ultimoHorario(a, agoraD);
      if (!marcada) continue;
      const chave = chaveLocal(marcada);
      if (a.visto && chave <= a.visto) continue;
      this.q('UPDATE automacoes SET visto = ? WHERE id = ?').run(chave, a.id);
      if (!a.visto) continue; // nunca marcado: começa a valer do próximo horário
      if (agoraD - marcada <= TOLERANCIA) this.rodar(a.id, 'horário', marcada);
      else if (a.perdida === 'rodar') this.rodar(a.id, 'atrasada', marcada);
      else {
        this.registrar(a, { marcada: chave, motivo: 'atrasada', estado: 'pulou', resumo: `o Engram estava fechado ${quandoCurto(marcada)}`, fim: true });
        this.avisarRodada(a);
      }
    }
    this.acompanhar(agoraD);
  }

  acompanhar(agoraD = new Date()) {
    for (const r of this.q(`SELECT * FROM automacao_rodadas WHERE estado IN ${ABERTAS}`).all()) {
      const a = this.pegar(r.automacao);
      if (!a) { this.fechar(r.n, 'falhou', 'a automação foi removida'); continue; }
      const j = a.alvo ? this.janelas.ativas.get(a.alvo) : null;
      if (!j) {
        this.fechar(r.n, 'falhou', 'a janela do agente fechou antes de devolver');
        this.avisarRodada(a);
        continue;
      }
      const parado = j.estado === 'precisa de você';
      if (parado && r.estado === 'rodando') {
        this.q("UPDATE automacao_rodadas SET estado = 'parou' WHERE n = ?").run(r.n);
        this.avisarRodada(a);
        this.avisarSistema(a, `${a.nome} parou`, `${this.janelas.nomeDe(a.alvo)} está esperando você: pediu permissão para seguir.`);
      } else if (!parado && r.estado === 'parou') {
        this.q("UPDATE automacao_rodadas SET estado = 'rodando' WHERE n = ?").run(r.n);
        this.avisarRodada(a);
      } else if (agoraD - new Date(r.inicio) > LIMITE_RODADA) {
        this.fechar(r.n, 'sem devolutiva', `${this.janelas.nomeDe(a.alvo)} não devolveu o resultado em 6 horas`);
        this.avisarRodada(a);
      }
    }
  }

  // ---------------------------------------------------------------- post-its

  postits() { return this.q('SELECT id, texto, x, y FROM postits ORDER BY criado').all().map(r => ({ ...r })); }

  postitSalvar(b, id = null) {
    const atual = id ? this.q('SELECT id, texto, x, y FROM postits WHERE id = ?').get(id) : null;
    if (id && !atual) throw new Error('post-it não encontrado');
    const num = (v, padrao) => (Number.isFinite(Number(v)) ? Math.max(-1e6, Math.min(Number(v), 1e6)) : padrao);
    const p = {
      id: id || `postit-${crypto.randomUUID().slice(0, 8)}`,
      texto: String(b.texto ?? atual?.texto ?? '').slice(0, 2000),
      x: num(b.x, atual?.x ?? 0), y: num(b.y, atual?.y ?? 0),
    };
    this.q('INSERT INTO postits (id, texto, x, y, criado) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET texto = excluded.texto, x = excluded.x, y = excluded.y')
      .run(p.id, p.texto, p.x, p.y, agora());
    this.avisar({ tipo: 'postit', acao: 'salvo', postit: p });
    return p;
  }

  postitRemover(id) {
    if (this.q('DELETE FROM postits WHERE id = ?').run(id).changes) this.avisar({ tipo: 'postit', acao: 'removido', id });
    return { ok: true };
  }
}

module.exports = { Automacoes, ultimoHorario, quandoTexto, resumir, chaveLocal };
