// Índice local do cérebro (SQLite) + o que o palco guarda (sessões, conexões, posições, mensagens).
// A fonte da verdade das notas são os arquivos (pasta local ou servidor remoto). Este índice é cópia.

const { Worker } = require('node:worker_threads');
const { transacao, agora, haMinutos, PALCOS } = require('./banco');
const { interpretar } = require('./notas');

const COLUNAS_NOTA = 'id, caminho, tipo, titulo, sistema, situacao, meta, corpo, erro, bytes, modificado, sincronizado';
const VERSAO_INDICE = 2; // 2: a leitura do servidor tira o cabeçalho novo ("..., linhas 1 a N de N]")
// as duas pontas de uma ligação estão no mesmo palco (ligação antiga com uma ponta retomada em outro palco não vale)
const MESMO_PALCO = 'COALESCE((SELECT palco FROM sessoes WHERE id = conexoes.a), 1) = COALESCE((SELECT palco FROM sessoes WHERE id = conexoes.b), 1)';

class Cerebro {
  constructor(cfg, db, caminhoBanco, fonte) {
    this.cfg = cfg;
    this.db = db;
    this.caminhoBanco = caminhoBanco;
    this.fonte = fonte;
    this.sincronizando = null;
  }

  q(sql) {
    this.cache ||= new Map();
    if (!this.cache.has(sql)) this.cache.set(sql, this.db.prepare(sql));
    return this.cache.get(sql);
  }

  // ---------------------------------------------------------------- sincronização

  /**
   * Lê da fonte o que mudou. Se a fonte trocar no meio (pasta <-> servidor), a leitura antiga para sem gravar
   * nada e a próxima chamada já começa outra, da fonte nova.
   */
  async sincronizar(forcar = false) {
    if (this.sincronizando && this.sincronizando.fonte === this.fonte) return this.sincronizando.p;
    const fonte = this.fonte;
    const p = this._sincronizar(forcar, fonte).finally(() => { if (this.sincronizando?.p === p) this.sincronizando = null; });
    this.sincronizando = { fonte, p };
    return p;
  }

  async _sincronizar(forcar, fonte = this.fonte) {
    const inicio = Date.now();
    const cancelada = () => ({ novas: 0, alteradas: 0, removidas: 0, total: 0, erros: [], cancelada: true, segundos: Math.round((Date.now() - inicio) / 100) / 10 });
    const remotos = await fonte.listar();
    if (this.fonte !== fonte) return cancelada();
    const locais = new Map(this.q('SELECT caminho, modificado FROM notas').all().map(r => [r.caminho, r.modificado]));
    let novas = 0, alteradas = 0;
    const erros = [];
    const removidas = [...locais.keys()].filter(rel => !remotos.has(rel));
    if (removidas.length) {
      transacao(this.db, () => {
        for (const rel of removidas) this.apagarNota(rel);
      });
    }
    // o que precisa ser lido; leitura longa (o servidor lê uma nota por chamada, com limite por minuto) avisa o
    // progresso de tempos em tempos, para a constelação ir crescendo em vez de ficar vazia até o fim
    const aLer = [...remotos.entries()].sort().filter(([rel, assinatura]) => forcar || locais.get(rel) !== assinatura);
    let lidas = 0, ultimoAviso = Date.now();
    for (const [rel, assinatura] of aLer) {
      let texto;
      try { texto = await fonte.ler(rel); } catch (e) {
        erros.push(`${rel}: ${e.message}`);
        // releitura inteira com erro nesta nota: ela perde a assinatura e a próxima sincronização relê só ela
        if (forcar && this.fonte === fonte) this.q('UPDATE notas SET modificado = NULL WHERE caminho = ?').run(rel);
        continue;
      }
      if (this.fonte !== fonte) return cancelada();
      const problema = this.gravarNota(interpretar(rel, texto), assinatura);
      if (problema) erros.push(problema);
      else if (locais.has(rel)) alteradas++;
      else novas++;
      lidas++;
      if (aLer.length >= 10 && Date.now() - ultimoAviso > 1500) {
        ultimoAviso = Date.now();
        try { this.aoProgresso?.({ lidas, total: aLer.length }); } catch { /* segue */ }
      }
    }
    if (this.fonte !== fonte) return cancelada();
    this.q("INSERT OR REPLACE INTO estado VALUES ('ultima_sincronizacao', ?)").run(agora());
    return { novas, alteradas, removidas: removidas.length, total: remotos.size, erros, forcada: !!forcar, segundos: Math.round((Date.now() - inicio) / 100) / 10 };
  }

  async sincronizarArquivo(rel) {
    const fonte = this.fonte;
    try {
      const texto = await fonte.ler(rel);
      if (this.fonte !== fonte) return null; // a fonte trocou enquanto lia: a nota era da outra
      let assinatura = null;
      if (fonte.tipo === 'pasta' && fonte.pasta) {
        try { assinatura = String(Math.floor(fs.statSync(path.join(fonte.pasta, rel)).mtimeMs)); } catch { /* segue */ }
      }
      return this.gravarNota(interpretar(rel, texto), assinatura);
    } catch (e) {
      return `${rel}: ${e.message}`;
    }
  }

  gravarNota(nota, assinatura) {
    return transacao(this.db, () => {
      const dono = this.q('SELECT caminho FROM notas WHERE id = ?').get(nota.id);
      if (dono && dono.caminho !== nota.caminho) return `${nota.caminho}: o id "${nota.id}" já é de ${dono.caminho}; renomeie um dos dois`;
      this.apagarNota(nota.caminho);
      this.q('INSERT INTO notas VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(
        nota.id, nota.caminho, nota.tipo, nota.titulo,
        nota.meta.sistema == null ? null : String(nota.meta.sistema),
        nota.meta.situacao == null ? null : String(nota.meta.situacao),
        JSON.stringify(nota.meta), nota.corpo, nota.erro, null, assinatura, agora());
      for (const [destino, tipo] of nota.ligacoes) this.q('INSERT OR IGNORE INTO ligacoes VALUES (?,?,?)').run(nota.id, destino, tipo);
      this.q('INSERT INTO notas_fts (id, titulo, corpo) VALUES (?,?,?)').run(nota.id, nota.titulo, nota.corpo);
      return null;
    });
  }

  apagarNota(caminho) {
    const linha = this.q('SELECT id FROM notas WHERE caminho = ?').get(caminho);
    if (!linha) return;
    this.q('DELETE FROM notas WHERE id = ?').run(linha.id);
    this.q('DELETE FROM ligacoes WHERE origem = ?').run(linha.id);
    this.q('DELETE FROM notas_fts WHERE id = ?').run(linha.id);
  }

  // ---------------------------------------------------------------- o índice de cada fonte
  // Trocar a fonte (pasta neste computador <-> servidor) não joga o índice fora: o da fonte que sai fica
  // guardado no banco e o da que entra volta na hora, então a constelação já aparece e a sincronização só lê o
  // que mudou desde a última vez. A chave é a da fonte (o tipo e onde ela fica).

  fonteDoIndice() { return this.q("SELECT valor FROM estado WHERE chave = 'indice_fonte'").get()?.valor || null; }

  /**
   * Índice de servidor lido por uma versão que não tirava o cabeçalho que o servidor põe na leitura ("[caminho, parte
   * 1 de 1, linhas ...]"): o corpo das notas começa por ele e o frontmatter não é lido. Esse índice é relido uma vez,
   * inteiro (em segundo plano, com o progresso na tela). A pasta local nunca teve o problema.
   */
  indiceVelho(chave) { return String(chave).startsWith('remoto:') && this.q('SELECT valor FROM estado WHERE chave = ?').get(`indice_versao:${chave}`)?.valor !== String(VERSAO_INDICE); }
  marcarIndiceNovo(chave) { this.q('INSERT OR REPLACE INTO estado VALUES (?, ?)').run(`indice_versao:${chave}`, String(VERSAO_INDICE)); }

  /** No início: o índice que está no banco é de outra fonte? Troca. Banco de versão antiga: o índice é da fonte em uso. */
  alinharIndice(chave) {
    const atual = this.fonteDoIndice();
    if (!atual) this.q("INSERT OR REPLACE INTO estado VALUES ('indice_fonte', ?)").run(chave);
    else if (atual !== chave) this.trocarIndice(atual, chave);
  }

  trocarIndice(de, para) {
    if (de === para) return;
    const estado = k => this.q('SELECT valor FROM estado WHERE chave = ?').get(k)?.valor ?? null;
    transacao(this.db, () => {
      if (de) {
        this.q('DELETE FROM notas_guardadas WHERE fonte = ?').run(de);
        this.q('DELETE FROM ligacoes_guardadas WHERE fonte = ?').run(de);
        this.q(`INSERT INTO notas_guardadas (fonte, ${COLUNAS_NOTA}) SELECT ?, ${COLUNAS_NOTA} FROM notas`).run(de);
        this.q('INSERT INTO ligacoes_guardadas (fonte, origem, destino, tipo) SELECT ?, origem, destino, tipo FROM ligacoes').run(de);
        this.q('INSERT OR REPLACE INTO estado VALUES (?, ?)').run(`ultima_sincronizacao:${de}`, estado('ultima_sincronizacao'));
      }
      this.db.exec('DELETE FROM notas; DELETE FROM ligacoes; DELETE FROM notas_fts;');
      this.q(`INSERT INTO notas (${COLUNAS_NOTA}) SELECT ${COLUNAS_NOTA} FROM notas_guardadas WHERE fonte = ?`).run(para);
      this.q('INSERT INTO ligacoes (origem, destino, tipo) SELECT origem, destino, tipo FROM ligacoes_guardadas WHERE fonte = ?').run(para);
      this.db.exec('INSERT INTO notas_fts (id, titulo, corpo) SELECT id, titulo, corpo FROM notas');
      this.q('INSERT OR REPLACE INTO estado VALUES (?, ?)').run('ultima_sincronizacao', estado(`ultima_sincronizacao:${para}`));
      this.q("INSERT OR REPLACE INTO estado VALUES ('indice_fonte', ?)").run(para);
    });
  }

  // ---------------------------------------------------------------- leitura

  grafo() {
    const nos = new Map();
    for (const n of this.q('SELECT id, tipo, titulo, sistema, situacao, erro FROM notas').all()) nos.set(n.id, { ...n });
    const arestas = [];
    const pendente = id => ({ id, tipo: 'pendente', titulo: id });
    for (const l of this.q('SELECT origem, destino, tipo FROM ligacoes').all()) {
      if (!nos.has(l.destino)) nos.set(l.destino, pendente(l.destino));
      arestas.push({ ...l });
    }
    const sessoes = this.q('SELECT id, nome, provedor, modelo, papel, estado FROM sessoes WHERE encerrada IS NULL').all();
    for (const s of sessoes) nos.set(`sessao:${s.id}`, { id: `sessao:${s.id}`, tipo: 'agente', titulo: s.nome, provedor: s.provedor, modelo: s.modelo, papel: s.papel, estado: s.estado });
    const toques = this.q('SELECT t.sessao, t.destino, t.tipo, t.vezes FROM toques t JOIN sessoes s ON s.id = t.sessao WHERE s.encerrada IS NULL').all();
    for (const t of toques) {
      if (!nos.has(t.destino)) nos.set(t.destino, pendente(t.destino));
      arestas.push({ origem: `sessao:${t.sessao}`, destino: t.destino, tipo: t.tipo, vezes: t.vezes, ao_vivo: true });
    }
    const abertas = new Set(sessoes.map(s => s.id));
    for (const c of this.conexoes()) {
      if (abertas.has(c.a) && abertas.has(c.b)) arestas.push({ origem: `sessao:${c.a}`, destino: `sessao:${c.b}`, tipo: 'time', ao_vivo: true });
    }
    return { nos: [...nos.values()], arestas };
  }

  nota(id) {
    const n = this.q('SELECT * FROM notas WHERE id = ?').get(id);
    const saidas = this.q('SELECT l.destino AS id, l.tipo, n.titulo, n.tipo AS tipo_nota FROM ligacoes l LEFT JOIN notas n ON n.id = l.destino WHERE l.origem = ? ORDER BY l.tipo, l.destino').all(id);
    const entradas = this.q('SELECT l.origem AS id, l.tipo, n.titulo, n.tipo AS tipo_nota FROM ligacoes l JOIN notas n ON n.id = l.origem WHERE l.destino = ? ORDER BY l.tipo, l.origem').all(id);
    if (!n && !entradas.length) return null;
    const base = n ? { ...n } : { id, tipo: 'pendente', titulo: id, corpo: '', meta: '{}' };
    base.meta = JSON.parse(base.meta || '{}');
    base.existe = !!n;
    base.saidas = saidas.map(r => ({ ...r }));
    base.entradas = entradas.map(r => ({ ...r }));
    return base;
  }

  buscar(consulta, limite = 30) {
    const termos = String(consulta).match(/[\p{L}\p{N}_]+/gu) || [];
    if (!termos.length) return [];
    const expressao = termos.slice(0, 12).map(t => `"${t.replace(/"/g, '')}"*`).join(' ');
    try {
      return this.q("SELECT f.id, n.tipo, n.titulo, snippet(notas_fts, -1, char(1), char(2), '…', 16) AS trecho FROM notas_fts f JOIN notas n ON n.id = f.id WHERE notas_fts MATCH ? ORDER BY bm25(notas_fts, 6.0, 3.0, 1.0) LIMIT ?")
        .all(expressao, limite).map(r => ({ ...r }));
    } catch {
      return [];
    }
  }

  /** SELECT livre no índice, numa thread à parte, só leitura e com 3 s de limite. É o "banco nosso". */
  consultar(sql, limite = 500) {
    const limpo = String(sql).replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, ' ').trim().replace(/;\s*$/, '').trim();
    if (!/^(select|with)\b/i.test(limpo)) return Promise.reject(new Error('só SELECT ou WITH'));
    const codigo = `
      const { workerData, parentPort } = require('node:worker_threads');
      const { DatabaseSync } = require('node:sqlite');
      try {
        const db = new DatabaseSync(workerData.banco, { readOnly: true });
        const st = db.prepare(workerData.sql);
        const colunas = st.columns ? st.columns().map(c => c.name) : null;
        const linhas = [];
        for (const r of st.iterate()) { linhas.push(r); if (linhas.length > workerData.limite) break; }
        parentPort.postMessage({ colunas: colunas || (linhas[0] ? Object.keys(linhas[0]) : []), linhas: linhas.map(r => Object.values(r)) });
      } catch (e) { parentPort.postMessage({ erro: String(e.message) }); }`;
    return new Promise((resolve, reject) => {
      const w = new Worker(codigo, { eval: true, workerData: { banco: this.caminhoBanco, sql: limpo, limite } });
      const prazo = setTimeout(() => { w.terminate(); reject(new Error('a consulta passou de 3 segundos')); }, 3000);
      w.once('message', m => {
        clearTimeout(prazo);
        w.terminate();
        if (m.erro) reject(new Error(m.erro));
        else resolve({ colunas: m.colunas, linhas: m.linhas.slice(0, limite), cortado: m.linhas.length > limite });
      });
      w.once('error', e => { clearTimeout(prazo); reject(e); });
    });
  }

  resumo() {
    const total = this.q('SELECT COUNT(*) AS n FROM notas').get().n;
    const porTipo = Object.fromEntries(this.q('SELECT tipo, COUNT(*) AS n FROM notas GROUP BY tipo').all().map(r => [r.tipo, r.n]));
    const ultima = this.q("SELECT valor FROM estado WHERE chave = 'ultima_sincronizacao'").get();
    return { total, por_tipo: porTipo, ultima_sincronizacao: ultima ? ultima.valor : null };
  }

  // ---------------------------------------------------------------- sessões

  sessaoCriar(id, nome, provedor, modelo, papel, pasta, palco = 1) {
    this.q(`INSERT INTO sessoes (id, nome, provedor, modelo, papel, pasta, criada, encerrada, estado, manter, palco)
            VALUES (?,?,?,?,?,?,?,NULL,'iniciando',1,?)
            ON CONFLICT(id) DO UPDATE SET encerrada = NULL, estado = 'iniciando', manter = 1, modelo = excluded.modelo, nome = excluded.nome, provedor = excluded.provedor, pasta = excluded.pasta, palco = excluded.palco`)
      .run(id, nome, provedor, modelo, papel, pasta, agora(), palco);
  }
  /** O cérebro descrito no prompt com que a conversa está rodando (a chave da fonte). */
  sessaoCerebroPrompt(id, chave) { this.q('UPDATE sessoes SET cerebro_prompt = ? WHERE id = ?').run(chave, id); }
  /** Janelas de versões antigas (sem a coluna preenchida) nasceram com a fonte que está em uso agora. */
  sessoesSemCerebroPrompt(chave) { this.q('UPDATE sessoes SET cerebro_prompt = ? WHERE cerebro_prompt IS NULL').run(chave); }
  sessaoMcps(id, lista) { this.q('UPDATE sessoes SET mcps = ? WHERE id = ?').run(lista ? JSON.stringify(lista) : null, id); }
  sessaoExterno(id, externo) { this.q('UPDATE sessoes SET externo = ? WHERE id = ? AND externo IS NOT ?').run(externo, id, externo); }
  sessaoEstado(id, estado) { this.q('UPDATE sessoes SET estado = ? WHERE id = ?').run(estado, id); }
  sessaoReabrir(id, estado) { this.q('UPDATE sessoes SET encerrada = NULL, manter = 1, estado = ? WHERE id = ?').run(estado, id); }
  sessaoRenomear(id, nome) { this.q('UPDATE sessoes SET nome = ? WHERE id = ?').run(nome, id); }
  sessaoNomePrompt(id, nome) { this.q('UPDATE sessoes SET nome_prompt = ? WHERE id = ?').run(nome, id); }
  sessaoManter(id, manter) { this.q('UPDATE sessoes SET manter = ? WHERE id = ?').run(manter ? 1 : 0, id); }
  sessaoEncerrar(id, manter = false) {
    this.q("UPDATE sessoes SET encerrada = COALESCE(encerrada, ?), estado = 'encerrada', manter = ? WHERE id = ?").run(agora(), manter ? 1 : 0, id);
  }
  sessoes(limite = 50) { return this.q('SELECT * FROM sessoes ORDER BY criada DESC LIMIT ?').all(limite).map(r => ({ ...r })); }
  sessao(id) { const r = this.q('SELECT * FROM sessoes WHERE id = ?').get(id); return r ? { ...r } : null; }
  registrarEvento(sessao, evento, ferramenta, resumo) {
    this.q('INSERT INTO eventos (sessao, quando, evento, ferramenta, resumo) VALUES (?,?,?,?,?)').run(sessao, agora(), evento, ferramenta ?? null, resumo ?? null);
  }
  registrarToque(sessao, destino, tipo) {
    this.q('INSERT INTO toques VALUES (?,?,?,1,?) ON CONFLICT(sessao, destino, tipo) DO UPDATE SET vezes = vezes + 1, ultimo = excluded.ultimo').run(sessao, destino, tipo, agora());
  }
  eventos(sessao, limite = 200) {
    return this.q('SELECT * FROM (SELECT * FROM eventos WHERE sessao = ? ORDER BY n DESC LIMIT ?) ORDER BY n').all(sessao, limite).map(r => ({ ...r }));
  }
  /** O último evento de um tipo (ex.: PreToolUse = a última ferramenta que o agente usou). */
  ultimoEvento(sessao, evento) {
    const r = this.q('SELECT quando, ferramenta, resumo FROM eventos WHERE sessao = ? AND evento = ? ORDER BY n DESC LIMIT 1').get(sessao, evento);
    return r ? { ...r } : null;
  }

  // ---------------------------------------------------------------- palco

  conectar(a, b) {
    if (this.palcoDe(a) !== this.palcoDe(b)) return false; // uma linha só liga cartões do mesmo palco
    [a, b] = [a, b].sort();
    return this.q('INSERT OR IGNORE INTO conexoes (a, b, criada) VALUES (?,?,?)').run(a, b, agora()).changes > 0;
  }
  desconectar(a, b) { [a, b] = [a, b].sort(); return this.q('DELETE FROM conexoes WHERE a = ? AND b = ?').run(a, b).changes > 0; }
  conexoes() { return this.q(`SELECT a, b, revisa FROM conexoes WHERE ${MESMO_PALCO}`).all().map(r => ({ ...r })); }
  /** Revisão na ligação a-b: "revisor" (uma das pontas) revisa as entregas da outra; null tira. Cada agente tem um revisor só. */
  revisao(a, b, revisor) {
    [a, b] = [a, b].sort();
    if (!this.q('SELECT 1 FROM conexoes WHERE a = ? AND b = ?').get(a, b)) return false;
    if (revisor) {
      const revisado = revisor === a ? b : a;
      this.q('UPDATE conexoes SET revisa = NULL WHERE (a = ? OR b = ?) AND revisa IS NOT NULL AND revisa != ?').run(revisado, revisado, revisado);
    }
    this.q('UPDATE conexoes SET revisa = ? WHERE a = ? AND b = ?').run(revisor || null, a, b);
    return true;
  }
  /** Quem revisa as entregas deste agente (ou null). */
  revisorDe(id) {
    return this.q(`SELECT revisa FROM conexoes WHERE (a = ? OR b = ?) AND revisa IS NOT NULL AND revisa != ? AND ${MESMO_PALCO}`).get(id, id, id)?.revisa || null;
  }
  /** Os agentes cujas entregas este revisa. */
  revisados(id) {
    return this.q(`SELECT a, b FROM conexoes WHERE revisa = ? AND ${MESMO_PALCO}`).all(id).map(r => (r.a === id ? r.b : r.a));
  }
  /** A última tarefa que um colega (fora os excluídos) mandou para este agente. */
  ultimaTarefa(para, excluir = []) {
    const r = this.q(`SELECT de, texto FROM mensagens WHERE para = ? AND de NOT IN (${excluir.map(() => '?').join(',') || "''"}) ORDER BY n DESC LIMIT 1`).get(para, ...excluir);
    return r ? { ...r } : null;
  }
  conectados(id) {
    return new Set(this.q(`SELECT a, b FROM conexoes WHERE (a = ? OR b = ?) AND ${MESMO_PALCO}`).all(id, id).map(r => (r.a === id ? r.b : r.a)));
  }
  posicaoSalvar(id, x, y, w, h) { this.q('INSERT OR REPLACE INTO posicoes VALUES (?,?,?,?,?)').run(id, x, y, w, h); }
  posicao(id) { const r = this.q('SELECT x, y, w, h FROM posicoes WHERE id = ?').get(id); return r ? { ...r } : null; }
  /**
   * Apaga a posição de quem saiu de vez do palco: janela que nem existe mais e janela encerrada que já saiu do
   * histórico (a gaveta mostra as últimas `historico`). Quem ainda pode ser retomado guarda o lugar.
   */
  posicoesLimpar(historico = 50) {
    return this.q(`DELETE FROM posicoes WHERE id NOT IN (SELECT id FROM sessoes)
      OR id IN (SELECT id FROM sessoes WHERE encerrada IS NOT NULL AND manter = 0
                AND id NOT IN (SELECT id FROM sessoes ORDER BY criada DESC LIMIT ?))`).run(historico).changes;
  }
  // setores do palco: áreas com nome e cor; quem tem o centro do cartão dentro faz parte
  /** Os setores de um palco (sem palco: de todos). */
  setores(palco = null) {
    const sql = 'SELECT id, nome, cor, instrucao, x, y, w, h, palco FROM setores';
    return (palco == null ? this.q(`${sql} ORDER BY criado`).all() : this.q(`${sql} WHERE palco = ? ORDER BY criado`).all(palco)).map(r => ({ ...r }));
  }
  setor(id) { const r = this.q('SELECT id, nome, cor, instrucao, x, y, w, h, palco FROM setores WHERE id = ?').get(id); return r ? { ...r } : null; }
  /** Grava o setor. O palco vale só na criação: mudar um setor não o leva para outro palco. */
  setorSalvar(s) {
    this.q('INSERT INTO setores (id, nome, cor, instrucao, x, y, w, h, criado, palco) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET nome = excluded.nome, cor = excluded.cor, instrucao = excluded.instrucao, x = excluded.x, y = excluded.y, w = excluded.w, h = excluded.h')
      .run(s.id, s.nome, s.cor, s.instrucao || '', s.x, s.y, s.w, s.h, agora(), s.palco || 1);
  }
  setorApagar(id) { return this.q('DELETE FROM setores WHERE id = ?').run(id).changes > 0; }
  /** O setor de uma janela: o menor que contém o centro do cartão dela (ou null). */
  setorDe(id, setores = null) {
    const p = this.posicao(id);
    if (!p) return null;
    const palco = this.palcoDe(id);
    const cx = p.x + p.w / 2, cy = p.y + p.h / 2;
    return (setores || this.setores(palco)).filter(s => (s.palco || 1) === palco && cx > s.x && cx < s.x + s.w && cy > s.y && cy < s.y + s.h)
      .sort((a, b) => a.w * a.h - b.w * b.h)[0] || null;
  }

  // ---------------------------------------------------------------- palcos
  // Até PALCOS palcos, cada um com os seus cartões, linhas, setores, automações e post-its. Trocar de palco na
  // tela não encerra ninguém: os agentes de todos os palcos seguem rodando e recebendo mensagens.

  palcoDe(id) { return this.q('SELECT palco FROM sessoes WHERE id = ?').get(id)?.palco || 1; }
  palcos() { return this.q('SELECT n, nome FROM palcos WHERE n BETWEEN 1 AND ? ORDER BY n').all(PALCOS).map(r => ({ ...r })); }
  palcoNome(n) { return this.q('SELECT nome FROM palcos WHERE n = ?').get(n)?.nome || `Palco ${n}`; }
  palcoRenomear(n, nome) { return this.q('UPDATE palcos SET nome = ? WHERE n = ?').run(nome, n).changes > 0; }
  /** O palco que a tela está mostrando (vale para o que é criado pela tela sem dizer o palco). */
  palcoAtual() {
    const n = Number(this.q("SELECT valor FROM estado WHERE chave = 'palco_atual'").get()?.valor);
    return Number.isInteger(n) && n >= 1 && n <= PALCOS ? n : 1;
  }
  palcoAtualDefinir(n) { this.q("INSERT OR REPLACE INTO estado VALUES ('palco_atual', ?)").run(String(n)); }
  estadoLer(chave) { return this.q('SELECT valor FROM estado WHERE chave = ?').get(chave)?.valor ?? null; }
  estadoGravar(chave, valor) { this.q('INSERT OR REPLACE INTO estado VALUES (?, ?)').run(chave, String(valor)); }
  mensagemRegistrar(de, para, texto) { return Number(this.q('INSERT INTO mensagens (de, para, quando, texto) VALUES (?,?,?,?)').run(de, para, agora(), texto).lastInsertRowid); }
  mensagemEntregue(n) { this.q('UPDATE mensagens SET entregue = ? WHERE n = ?').run(agora(), n); }
  /** A última mensagem que chegou a este agente (a tarefa em que ele está, ou a última que fez). */
  ultimaRecebida(para) {
    const r = this.q('SELECT de, texto, quando, entregue FROM mensagens WHERE para = ? AND entregue IS NOT NULL ORDER BY n DESC LIMIT 1').get(para);
    return r ? { ...r } : null;
  }
  mensagensNoPar(a, b, minutos = 10) {
    return this.q('SELECT COUNT(*) AS n FROM mensagens WHERE quando >= ? AND ((de = ? AND para = ?) OR (de = ? AND para = ?))').get(haMinutos(minutos), a, b, b, a).n;
  }
  mensagensPendentes(horas = 24) {
    return this.q('SELECT n, de, para, texto FROM mensagens WHERE entregue IS NULL AND quando >= ? ORDER BY n').all(haMinutos(horas * 60)).map(r => ({ ...r }));
  }
}

module.exports = { Cerebro };
