// Índice local do cérebro (SQLite) + o que o palco guarda (sessões, conexões, posições, mensagens).
// A fonte da verdade das notas são os arquivos (pasta local ou servidor remoto). Este índice é cópia.

const { Worker } = require('node:worker_threads');
const { transacao, agora, haMinutos } = require('./banco');
const { interpretar } = require('./notas');

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

  async sincronizar(forcar = false) {
    if (this.sincronizando) return this.sincronizando;
    this.sincronizando = this._sincronizar(forcar).finally(() => { this.sincronizando = null; });
    return this.sincronizando;
  }

  async _sincronizar(forcar) {
    const inicio = Date.now();
    const remotos = await this.fonte.listar();
    const locais = new Map(this.q('SELECT caminho, modificado FROM notas').all().map(r => [r.caminho, r.modificado]));
    let novas = 0, alteradas = 0;
    const erros = [];
    for (const [rel, assinatura] of [...remotos.entries()].sort()) {
      if (!forcar && locais.get(rel) === assinatura) continue;
      let texto;
      try { texto = await this.fonte.ler(rel); } catch (e) { erros.push(`${rel}: ${e.message}`); continue; }
      const problema = this.gravarNota(interpretar(rel, texto), assinatura);
      if (problema) erros.push(problema);
      else if (locais.has(rel)) alteradas++;
      else novas++;
    }
    const removidas = [...locais.keys()].filter(rel => !remotos.has(rel));
    transacao(this.db, () => {
      for (const rel of removidas) this.apagarNota(rel);
      this.q("INSERT OR REPLACE INTO estado VALUES ('ultima_sincronizacao', ?)").run(agora());
    });
    return { novas, alteradas, removidas: removidas.length, total: remotos.size, erros, segundos: Math.round((Date.now() - inicio) / 100) / 10 };
  }

  async sincronizarArquivo(rel) {
    try {
      return this.gravarNota(interpretar(rel, await this.fonte.ler(rel)), null);
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
    const sessoes = this.q('SELECT id, nome, modelo, papel, estado FROM sessoes WHERE encerrada IS NULL').all();
    for (const s of sessoes) nos.set(`sessao:${s.id}`, { id: `sessao:${s.id}`, tipo: 'agente', titulo: s.nome, modelo: s.modelo, papel: s.papel, estado: s.estado });
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

  sessaoCriar(id, nome, provedor, modelo, papel, pasta) {
    this.q(`INSERT INTO sessoes (id, nome, provedor, modelo, papel, pasta, criada, encerrada, estado, manter)
            VALUES (?,?,?,?,?,?,?,NULL,'iniciando',1)
            ON CONFLICT(id) DO UPDATE SET encerrada = NULL, estado = 'iniciando', manter = 1, modelo = excluded.modelo, nome = excluded.nome, provedor = excluded.provedor, pasta = excluded.pasta`)
      .run(id, nome, provedor, modelo, papel, pasta, agora());
  }
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

  // ---------------------------------------------------------------- palco

  conectar(a, b) { [a, b] = [a, b].sort(); return this.q('INSERT OR IGNORE INTO conexoes (a, b, criada) VALUES (?,?,?)').run(a, b, agora()).changes > 0; }
  desconectar(a, b) { [a, b] = [a, b].sort(); return this.q('DELETE FROM conexoes WHERE a = ? AND b = ?').run(a, b).changes > 0; }
  conexoes() { return this.q('SELECT a, b, revisa FROM conexoes').all().map(r => ({ ...r })); }
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
    return this.q('SELECT revisa FROM conexoes WHERE (a = ? OR b = ?) AND revisa IS NOT NULL AND revisa != ?').get(id, id, id)?.revisa || null;
  }
  /** Os agentes cujas entregas este revisa. */
  revisados(id) {
    return this.q('SELECT a, b FROM conexoes WHERE revisa = ?').all(id).map(r => (r.a === id ? r.b : r.a));
  }
  /** A última tarefa que um colega (fora os excluídos) mandou para este agente. */
  ultimaTarefa(para, excluir = []) {
    const r = this.q(`SELECT de, texto FROM mensagens WHERE para = ? AND de NOT IN (${excluir.map(() => '?').join(',') || "''"}) ORDER BY n DESC LIMIT 1`).get(para, ...excluir);
    return r ? { ...r } : null;
  }
  conectados(id) {
    return new Set(this.q('SELECT a, b FROM conexoes WHERE a = ? OR b = ?').all(id, id).map(r => (r.a === id ? r.b : r.a)));
  }
  posicaoSalvar(id, x, y, w, h) { this.q('INSERT OR REPLACE INTO posicoes VALUES (?,?,?,?,?)').run(id, x, y, w, h); }
  posicao(id) { const r = this.q('SELECT x, y, w, h FROM posicoes WHERE id = ?').get(id); return r ? { ...r } : null; }
  // setores do palco: áreas com nome e cor; quem tem o centro do cartão dentro faz parte
  setores() { return this.q('SELECT id, nome, cor, instrucao, x, y, w, h FROM setores ORDER BY criado').all().map(r => ({ ...r })); }
  setor(id) { const r = this.q('SELECT id, nome, cor, instrucao, x, y, w, h FROM setores WHERE id = ?').get(id); return r ? { ...r } : null; }
  setorSalvar(s) {
    this.q('INSERT INTO setores (id, nome, cor, instrucao, x, y, w, h, criado) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET nome = excluded.nome, cor = excluded.cor, instrucao = excluded.instrucao, x = excluded.x, y = excluded.y, w = excluded.w, h = excluded.h')
      .run(s.id, s.nome, s.cor, s.instrucao || '', s.x, s.y, s.w, s.h, agora());
  }
  setorApagar(id) { return this.q('DELETE FROM setores WHERE id = ?').run(id).changes > 0; }
  /** O setor de uma janela: o menor que contém o centro do cartão dela (ou null). */
  setorDe(id, setores = this.setores()) {
    const p = this.posicao(id);
    if (!p) return null;
    const cx = p.x + p.w / 2, cy = p.y + p.h / 2;
    return setores.filter(s => cx > s.x && cx < s.x + s.w && cy > s.y && cy < s.y + s.h).sort((a, b) => a.w * a.h - b.w * b.h)[0] || null;
  }
  mensagemRegistrar(de, para, texto) { return Number(this.q('INSERT INTO mensagens (de, para, quando, texto) VALUES (?,?,?,?)').run(de, para, agora(), texto).lastInsertRowid); }
  mensagemEntregue(n) { this.q('UPDATE mensagens SET entregue = ? WHERE n = ?').run(agora(), n); }
  mensagensNoPar(a, b, minutos = 10) {
    return this.q('SELECT COUNT(*) AS n FROM mensagens WHERE quando >= ? AND ((de = ? AND para = ?) OR (de = ? AND para = ?))').get(haMinutos(minutos), a, b, b, a).n;
  }
  mensagensPendentes(horas = 24) {
    return this.q('SELECT n, de, para, texto FROM mensagens WHERE entregue IS NULL AND quando >= ? ORDER BY n').all(haMinutos(horas * 60)).map(r => ({ ...r }));
  }
}

module.exports = { Cerebro };
