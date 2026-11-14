// Cenas: o desenho de um time guardado para recriar com um clique (aqui, num outro palco ou no computador de outra
// pessoa, por um arquivo .json). Uma cena guarda só o desenho: os agentes (nome, papel, agente/CLI e modelo), as
// ligações e quem revisa quem, os setores, as posições e, se a pessoa quiser, as automações e os post-its.
// NUNCA entra numa cena: conversa, id de sessão, pasta, arquivo, token, chave, MCP ou qualquer coisa do cofre.
//
// Recriar: num palco que já tem gente, a cena abre num lugar livre ao lado do que está lá (ninguém é fechado). Num
// palco vazio (nenhum agente, setor, automação ou post-it), ela abre como foi salva. Se a cena tem maestro e o palco
// já tem um maestro aberto, não abre outro: as ligações do maestro da cena vão para o maestro de agora.

const crypto = require('node:crypto');
const { agora, PALCOS } = require('./banco');
const { acharLugar, caixaDe } = require('./janelas');

const ESQUEMA = 'CREATE TABLE IF NOT EXISTS cenas (id TEXT PRIMARY KEY, nome TEXT NOT NULL, criada TEXT NOT NULL, dados TEXT NOT NULL)';
const MAX_JSON = 2_000_000;
const VERSAO = 1;
const LIMITES = { cartoes: 64, ligacoes: 400, setores: 40, automacoes: 40, postits: 80 };
const ETIQUETA_SETOR = 70;
const CORES = /^#[0-9a-f]{6}$/i;
const pausa = ms => new Promise(r => setTimeout(r, ms));

const texto = (v, max) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max);
const umaLinha = (v, max) => texto(v, max).replace(/\s+/g, ' ');
const numero = (v, padrao, min = -1e6, max = 1e6) => (Number.isFinite(Number(v)) ? Math.max(min, Math.min(Number(v), max)) : padrao);

class Cenas {
  constructor({ db, cfg, janelas, automacoes, avisar }) {
    Object.assign(this, { db, cfg, janelas, automacoes, avisar });
    this.cerebro = janelas.cerebro;
    this.recriando = false;
    db.exec(ESQUEMA);
    // de onde a cena veio: 'propria' (salva aqui) ou 'importada' (um .json de outra pessoa; as instruções dela são de fora)
    if (!db.prepare("PRAGMA table_info('cenas')").all().some(c => c.name === 'origem')) db.exec("ALTER TABLE cenas ADD COLUMN origem TEXT NOT NULL DEFAULT 'propria'");
  }

  palcoValido(n) { const v = Number(n); return n != null && n !== '' && Number.isInteger(v) && v >= 1 && v <= PALCOS ? v : null; }

  // ---------------------------------------------------------------- o formato (salvo e importado passam pelo mesmo filtro)

  /**
   * Deixa a cena só com o que ela pode ter, nos tamanhos certos: o que vem de fora (um .json) pode trazer qualquer
   * coisa, e o que não está aqui é jogado fora. Lança erro se não for uma cena.
   */
  normalizar(c) {
    if (!c || typeof c !== 'object' || !Array.isArray(c.cartoes)) throw new Error('este arquivo não é uma cena do Engram');
    if (c.cartoes.length > LIMITES.cartoes) throw new Error(`a cena tem ${c.cartoes.length} agentes; o máximo é ${LIMITES.cartoes}`);
    const papeis = this.cfg.papeis || {};
    const temPapel = p => typeof p === 'string' && Object.hasOwn(papeis, p);
    const temProvedor = p => typeof p === 'string' && /^[a-z0-9-]{1,20}$/.test(p) && (!this.janelas.provedores?.adaptador || !!this.janelas.provedores.adaptador(p));
    const refs = new Set();
    const cartoes = c.cartoes.map((a, i) => {
      const ref = umaLinha(a?.ref, 12).replace(/[^a-z0-9]/gi, '') || `a${i + 1}`;
      if (refs.has(ref)) throw new Error('a cena tem dois agentes com a mesma referência');
      refs.add(ref);
      const provedor = temProvedor(a?.provedor) ? a.provedor : 'claude';
      let modelo = umaLinha(a?.modelo, 80);
      if (modelo && this.janelas.provedores?.modeloValido && !this.janelas.provedores.modeloValido(provedor, modelo)) modelo = '';
      const r = { ref, nome: umaLinha(a?.nome, 40).replace(/"/g, '') || `Agente ${i + 1}`, papel: temPapel(a?.papel) ? a.papel : 'livre', provedor, modelo };
      if (a?.x !== undefined && a?.y !== undefined) Object.assign(r, { x: numero(a.x, 0), y: numero(a.y, 0), w: numero(a.w, 700, 320, 3000), h: numero(a.h, 470, 220, 2400) });
      return r;
    });
    const ligacoes = (Array.isArray(c.ligacoes) ? c.ligacoes : []).slice(0, LIMITES.ligacoes)
      .map(l => ({ a: String(l?.a ?? ''), b: String(l?.b ?? ''), revisa: l?.revisa ? String(l.revisa) : null }))
      .filter(l => refs.has(l.a) && refs.has(l.b) && l.a !== l.b)
      .map(l => ({ ...l, revisa: l.revisa === l.a || l.revisa === l.b ? l.revisa : null }));
    const setores = (Array.isArray(c.setores) ? c.setores : []).slice(0, LIMITES.setores).map(s => ({
      nome: umaLinha(s?.nome, 24) || 'Setor', cor: CORES.test(String(s?.cor || '')) ? s.cor : '#8b7bff', instrucao: texto(s?.instrucao, 2000),
      x: numero(s?.x, 0), y: numero(s?.y, 0), w: numero(s?.w, 900, 200, 20000), h: numero(s?.h, 600, 140, 20000),
    }));
    const automacoes = (Array.isArray(c.automacoes) ? c.automacoes : []).slice(0, LIMITES.automacoes).map(a => ({
      nome: umaLinha(a?.nome, 40) || 'Automação', instrucao: texto(a?.instrucao, 4000), alvo: refs.has(String(a?.alvo)) ? String(a.alvo) : null,
      dias: (Array.isArray(a?.dias) ? a.dias : [1, 2, 3, 4, 5]).map(Number).filter(d => Number.isInteger(d) && d >= 0 && d <= 6),
      hora: /^([01]\d|2[0-3]):[0-5]\d$/.test(String(a?.hora || '')) ? a.hora : '09:00', manual: !!a?.manual,
      perdida: a?.perdida === 'pular' ? 'pular' : 'rodar', aviso: a?.aviso !== false, nota_no_cerebro: !!a?.nota_no_cerebro,
      x: numero(a?.x, 0), y: numero(a?.y, 0),
    }));
    const postits = (Array.isArray(c.postits) ? c.postits : []).slice(0, LIMITES.postits).map(p => ({ texto: texto(p?.texto, 2000), x: numero(p?.x, 0), y: numero(p?.y, 0) }));
    return { versao: VERSAO, nome: umaLinha(c.nome, 40) || 'Cena', cartoes, ligacoes, setores, automacoes, postits };
  }

  /** As instruções que viram ordem para os agentes (setores e automações): a pessoa lê antes de recriar uma cena de fora. */
  instrucoes(d) {
    return [
      ...d.setores.filter(s => s.instrucao).map(s => ({ tipo: 'setor', nome: s.nome, texto: s.instrucao })),
      ...d.automacoes.filter(a => a.instrucao).map(a => ({ tipo: 'automacao', nome: a.nome, texto: a.instrucao, quando: a.manual ? 'só no botão' : `${a.dias.join(',')} às ${a.hora}` })),
    ];
  }

  resumo(d) {
    return { agentes: d.cartoes.length, ligacoes: d.ligacoes.length, setores: d.setores.length, automacoes: d.automacoes.length, postits: d.postits.length, maestro: d.cartoes.some(c => c.papel === 'maestro'), posicoes: d.cartoes.some(c => c.x !== undefined) };
  }

  // ---------------------------------------------------------------- lista, salvar, remover, exportar, importar

  lista() {
    return this.db.prepare('SELECT id, nome, criada, dados, origem FROM cenas ORDER BY criada DESC').all().map(r => {
      const dados = JSON.parse(r.dados);
      return { id: r.id, nome: r.nome, criada: r.criada, origem: r.origem, resumo: this.resumo(dados), instrucoes: this.instrucoes(dados), dados };
    });
  }

  pegar(id) {
    const r = this.db.prepare('SELECT id, nome, criada, dados, origem FROM cenas WHERE id = ?').get(String(id));
    return r ? { id: r.id, nome: r.nome, criada: r.criada, origem: r.origem, dados: JSON.parse(r.dados) } : null;
  }

  gravar(dados, origem = 'propria') {
    const id = `cena-${crypto.randomUUID().slice(0, 8)}`;
    // nome repetido ganha um número (a lista mostra as duas)
    const nomes = new Set(this.db.prepare('SELECT nome FROM cenas').all().map(r => r.nome.toLowerCase()));
    let nome = dados.nome;
    for (let n = 2; nomes.has(nome.toLowerCase()); n++) nome = `${dados.nome.slice(0, 36)} ${n}`;
    dados = { ...dados, nome };
    this.db.prepare('INSERT INTO cenas (id, nome, criada, dados, origem) VALUES (?,?,?,?,?)').run(id, nome, agora(), JSON.stringify(dados), origem);
    const c = { id, nome, criada: agora(), origem, resumo: this.resumo(dados), instrucoes: this.instrucoes(dados), dados };
    this.avisar({ tipo: 'cena', acao: 'salva', cena: c });
    return c;
  }

  /** Salva o que está num palco agora. `incluir`: { agentes, ligacoes, setores, posicoes, automacoes, postits }. */
  salvar({ nome, palco, incluir = {} } = {}) {
    const n = this.palcoValido(palco) || this.cerebro.palcoAtual();
    const quer = k => incluir[k] !== undefined ? !!incluir[k] : !['automacoes', 'postits'].includes(k); // automações e post-its só se pedir
    const ids = quer('agentes') ? this.janelas.abertasNoPalco(n) : [];
    const ref = new Map(ids.map((id, i) => [id, `a${i + 1}`]));
    const cartoes = ids.map(id => {
      const s = this.cerebro.sessao(id) || {};
      const c = { ref: ref.get(id), nome: s.nome, papel: s.papel, provedor: s.provedor || 'claude', modelo: s.modelo || '' };
      const p = quer('posicoes') ? this.cerebro.posicao(id) : null;
      if (p) Object.assign(c, { x: p.x, y: p.y, w: p.w, h: p.h });
      return c;
    });
    const ligacoes = quer('ligacoes') ? this.cerebro.conexoes().filter(l => ref.has(l.a) && ref.has(l.b))
      .map(l => ({ a: ref.get(l.a), b: ref.get(l.b), revisa: l.revisa ? ref.get(l.revisa) || null : null })) : [];
    const setores = quer('setores') ? this.cerebro.setores(n).map(s => ({ nome: s.nome, cor: s.cor, instrucao: s.instrucao, x: s.x, y: s.y, w: s.w, h: s.h })) : [];
    const automacoes = quer('automacoes') ? this.automacoes.todas(n).map(a => ({
      nome: a.nome, instrucao: a.instrucao, alvo: a.alvo ? ref.get(a.alvo) || null : null, dias: a.dias, hora: a.hora, manual: a.manual,
      perdida: a.perdida, aviso: a.aviso, nota_no_cerebro: a.nota_no_cerebro, x: a.x, y: a.y,
    })) : [];
    const postits = quer('postits') ? this.automacoes.postits(n).map(p => ({ texto: p.texto, x: p.x, y: p.y })) : [];
    const dados = this.normalizar({ nome: nome || this.cerebro.palcoNome(n), cartoes, ligacoes, setores, automacoes, postits });
    if (!dados.cartoes.length && !dados.setores.length && !dados.automacoes.length && !dados.postits.length) throw new Error('o palco está vazio: não há o que guardar');
    return this.gravar(dados);
  }

  remover(id) {
    const n = this.db.prepare('DELETE FROM cenas WHERE id = ?').run(String(id)).changes;
    if (n) this.avisar({ tipo: 'cena', acao: 'removida', id });
    return { ok: true };
  }

  /** O .json que a pessoa passa adiante: o desenho e nada mais. */
  exportar(id) {
    const c = this.pegar(id);
    if (!c) throw new Error('cena não encontrada');
    return { formato: 'engram-cena', ...this.normalizar(c.dados), exportada: agora() };
  }

  /**
   * Uma cena de outra pessoa. Fica marcada como importada: as instruções dela (setores e automações) foram escritas
   * por fora e viram ordem para os agentes, então a pessoa lê antes de recriar, e as automações nascem só no botão.
   */
  importar(json) {
    let c = json;
    if (typeof c === 'string') {
      if (c.length > MAX_JSON) throw new Error('o arquivo é grande demais para ser uma cena');
      try { c = JSON.parse(c.replace(/^\uFEFF/, '')); } catch { throw new Error('o arquivo não é um JSON válido'); }
    } else {
      let tam = 0;
      try { tam = JSON.stringify(c ?? null).length; } catch { throw new Error('o arquivo não é um JSON válido'); }
      if (tam > MAX_JSON) throw new Error('o arquivo é grande demais para ser uma cena');
    }
    if (c?.formato && c.formato !== 'engram-cena') throw new Error('este arquivo não é uma cena do Engram');
    return this.gravar(this.normalizar(c), 'importada');
  }

  // ---------------------------------------------------------------- recriar

  /** Um palco está vazio quando não tem agente aberto, setor, automação nem post-it. */
  vazio(palco) {
    return !this.janelas.abertasNoPalco(palco).length && !this.cerebro.setores(palco).length
      && !this.automacoes.todas(palco).length && !this.automacoes.postits(palco).length;
  }

  /** Os palcos e se cada um serve para recriar "num palco vazio" (a tela mostra as opções). */
  destinos() {
    return this.cerebro.palcos().map(p => ({ n: p.n, nome: p.nome, vazio: this.vazio(p.n), agentes: this.janelas.abertasNoPalco(p.n).length }));
  }

  /**
   * Recria a cena. `modo`: 'ao_lado' (no palco dado, num lugar livre ao lado do que já está) ou 'vazio' (o palco
   * dado tem de estar vazio; a cena abre como foi salva). Os agentes abrem um por vez, para a pessoa ver cada um nascer.
   */
  async recriar(id, { palco, modo = 'ao_lado', confirmado = false } = {}) {
    const c = this.pegar(id);
    if (!c) throw new Error('cena não encontrada');
    if (this.recriando) throw new Error('já estou recriando uma cena: espere terminar');
    const deFora = c.origem === 'importada';
    if (deFora && this.instrucoes(c.dados).length && !confirmado) {
      const e = new Error('esta cena veio de outra pessoa e traz instruções de setor ou de automação escritas por ela: leia e confirme antes de recriar');
      e.status = 409;
      throw e;
    }
    const destino = this.palcoValido(palco) || this.cerebro.palcoAtual();
    if (modo === 'vazio' && !this.vazio(destino)) throw new Error(`o ${this.cerebro.palcoNome(destino)} não está vazio: escolha outro palco ou "ao lado"`);
    const d = c.dados;
    const maestroAqui = this.janelas.abertasNoPalco(destino).find(x => this.janelas.ehMaestro(x)) || null;
    const aAbrir = d.cartoes.filter(a => !(a.papel === 'maestro' && maestroAqui));
    const livres = this.cfg.max_janelas - this.janelas.ativas.size;
    if (aAbrir.length > livres) throw new Error(`a cena abre ${aAbrir.length} agentes e cabem só mais ${Math.max(0, livres)} (o limite de janelas soma todos os palcos; muda em Ajustes > Geral > Limites)`);

    // onde a cena fica: como foi salva (palco vazio) ou num lugar livre ao lado do que já está no palco
    const pecas = [
      ...d.cartoes.filter(a => a.x !== undefined).map(a => ({ x: a.x, y: a.y, w: a.w, h: a.h })),
      ...d.setores.map(s => ({ x: s.x, y: s.y - ETIQUETA_SETOR, w: s.w, h: s.h + ETIQUETA_SETOR })),
      ...d.automacoes.map(a => ({ x: a.x, y: a.y, w: 300, h: 170 })), ...d.postits.map(p => ({ x: p.x, y: p.y, w: 210, h: 160 })),
    ];
    let dx = 0, dy = 0;
    const ocupados = this.janelas.ocupados({ palco: destino });
    if (pecas.length && ocupados.length) {
      const caixa = caixaDe(pecas);
      const juntos = caixaDe(ocupados);
      const [x, y] = acharLugar(caixa.w, caixa.h, { x: juntos.x + juntos.w + caixa.w / 2 + 200, y: juntos.y + caixa.h / 2 }, ocupados, { folga: 160 });
      dx = x - caixa.x; dy = y - caixa.y;
    }

    this.recriando = true;
    const erros = [];
    const mapa = new Map();
    let falha = null;
    let abertosAgora = 0;
    try {
      this.avisar({ tipo: 'cena', acao: 'recriando', id, palco: destino, nome: c.nome, total: aAbrir.length });
      for (const s of d.setores) {
        const setor = { id: `setor-${crypto.randomUUID().slice(0, 8)}`, ...s, x: s.x + dx, y: s.y + dy, palco: destino };
        this.cerebro.setorSalvar(setor);
        this.avisar({ tipo: 'setor', acao: 'salvo', setor });
        await pausa(220);
      }
      for (const a of d.cartoes) {
        if (a.papel === 'maestro' && maestroAqui) { mapa.set(a.ref, maestroAqui); continue; }
        try {
          const posicao = a.x !== undefined ? { x: a.x + dx, y: a.y + dy, w: a.w, h: a.h } : null;
          const info = await this.janelas.abrir({ nome: a.nome, modelo: a.modelo, papel: a.papel, provedor: a.provedor, posicao, palco: destino });
          mapa.set(a.ref, info.id);
          abertosAgora++;
          this.avisar({ tipo: 'cena', acao: 'nasceu', id, sessao_id: info.id, feitos: abertosAgora, total: aAbrir.length }); // o maestro reaproveitado não conta
        } catch (e) {
          const ligacoes = d.ligacoes.filter(l => l.a === a.ref || l.b === a.ref).length;
          erros.push(`${a.nome} não abriu (${e.message})${ligacoes ? `; ${ligacoes === 1 ? 'a ligação dele ficou de fora' : `as ${ligacoes} ligações dele ficaram de fora`}` : ''}`);
        }
        await pausa(380);
      }
      for (const l of d.ligacoes) {
        const a = mapa.get(l.a), b = mapa.get(l.b);
        if (!a || !b || a === b) continue;
        if (this.cerebro.conectar(a, b)) this.avisar({ tipo: 'conexao', acao: 'criada', a, b });
        const revisor = l.revisa ? mapa.get(l.revisa) : null;
        if (revisor && this.cerebro.revisao(a, b, revisor)) this.avisar({ tipo: 'conexao', acao: 'revisao', a: [a, b].sort()[0], b: [a, b].sort()[1], revisa: revisor });
      }
      for (const a of d.automacoes) {
        try {
          let nome = a.nome;
          const existentes = new Set(this.automacoes.todas().map(x => x.nome.toLowerCase()));
          for (let n = 2; existentes.has(nome.toLowerCase()); n++) nome = `${a.nome.slice(0, 36)} ${n}`;
          // automação de cena de fora nasce só no botão, com aviso e sem gravar no cérebro: ninguém roda sem ler
          const seguro = deFora ? { manual: true, aviso: true, nota_no_cerebro: false } : {};
          this.automacoes.criar({ ...a, ...seguro, nome, alvo: a.alvo ? mapa.get(a.alvo) || null : null, x: a.x + dx, y: a.y + dy, palco: destino });
        } catch (e) { erros.push(`automação ${a.nome}: ${e.message}`); }
      }
      for (const p of d.postits) this.automacoes.postitSalvar({ ...p, x: p.x + dx, y: p.y + dy, palco: destino });
    } catch (e) {
      falha = e; // o que já nasceu fica no palco (nunca fecha agente); a tela recebe o fim e o motivo
      erros.push(`parou no meio: ${e.message}`);
    } finally {
      this.recriando = false;
    }
    const r = { palco: destino, abertos: [...mapa.values()].filter(v => v !== maestroAqui).length, maestro_reaproveitado: !!(maestroAqui && d.cartoes.some(a => a.papel === 'maestro')), erros, completa: !falha };
    if (deFora && d.automacoes.length) r.aviso = 'as automações desta cena vieram de fora: nasceram só no botão (leia a orientação de cada uma antes de rodar)';
    this.avisar({ tipo: 'cena', acao: 'recriada', id, ...r });
    return r;
  }

  registrarRotas(rota, { erro400 }) {
    rota('GET', '/api/cenas', () => ({ cenas: this.lista(), destinos: this.destinos(), atual: this.cerebro.palcoAtual() }));
    rota('POST', '/api/cenas', erro400((_, b) => this.salvar({ nome: b.nome, palco: b.palco, incluir: b.incluir || {} })));
    rota('POST', '/api/cenas/importar', erro400((_, b) => this.importar(b.json ?? b)));
    rota('GET', '/api/cenas/:id/exportar', erro400(p => this.exportar(p.id)));
    rota('POST', '/api/cenas/:id/remover', p => this.remover(p.id));
    rota('POST', '/api/cenas/:id/recriar', erro400(async (p, b) => this.recriar(p.id, { palco: b.palco, modo: b.modo === 'vazio' ? 'vazio' : 'ao_lado', confirmado: b.confirmado === true })));
  }
}

module.exports = { Cenas };
