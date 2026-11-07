// Os fluxos do projeto, no estilo do n8n: por onde cada funcionalidade passa (tela → rota → tratamento →
// banco → volta), em blocos e ligações. Ficam em <pasta>/.engram/fluxos.json e nascem de dois jeitos: o mapa
// que uma IA monta lendo o projeto, e o que os agentes do palco desenham e marcam enquanto trabalham
// (o bloco em que alguém está mexendo acende). O modelo dos dados veio do Orbion (Lucas Lessa).

const fs = require('node:fs');
const path = require('node:path');
const { perguntar } = require('./uma-vez');

const TIPOS = ['tela', 'componente', 'rota', 'servico', 'banco', 'fila', 'ia', 'externo', 'evento', 'arquivo'];
const ESTADOS = ['trabalhando', 'feito', 'falhou'];

const BLOCO = {
  type: 'object', additionalProperties: false, required: ['id', 'tipo', 'titulo', 'detalhe', 'arquivos'],
  properties: {
    id: { type: 'string', description: 'Curto e estável, em minúsculas com hífen (ex.: tela-login, post-api-login, tabela-usuarios).' },
    tipo: {
      type: 'string', enum: TIPOS,
      description: 'tela: o que a pessoa vê; componente: pedaço de tela; rota: endpoint, API ou webhook; servico: regra, validação ou tratamento dos dados; banco: tabela, função, procedure ou consulta; fila: fila ou tarefa agendada; ia: chamada a um modelo ou agente de IA; externo: sistema de fora (pagamento, WhatsApp, e-mail, ERP); evento: gatilho (clique, horário, mensagem que chega); arquivo: configuração ou script.',
    },
    titulo: { type: 'string', description: 'Nome curto, como aparece no bloco (ex.: POST /api/login).' },
    detalhe: { type: 'string', description: 'O que o bloco faz, em uma ou duas frases.' },
    arquivos: { type: 'array', items: { type: 'string' }, description: 'Arquivos onde ele está, relativos à pasta do projeto. [] se ainda não existe.' },
  },
};
const LIGACAO = {
  type: 'object', additionalProperties: false, required: ['de', 'para', 'rotulo'],
  properties: {
    de: { type: 'string', description: 'id do bloco de onde sai' },
    para: { type: 'string', description: 'id do bloco aonde chega' },
    rotulo: { type: 'string', description: 'O que passa de um para o outro, em poucas palavras (ex.: e-mail e senha). "" se não precisar.' },
  },
};
const FLUXO = {
  type: 'object', additionalProperties: false, required: ['nome', 'blocos', 'ligacoes'],
  properties: { nome: { type: 'string', description: 'Nome da funcionalidade (ex.: Login).' }, blocos: { type: 'array', items: BLOCO }, ligacoes: { type: 'array', items: LIGACAO } },
};
const MAPA = {
  type: 'object', additionalProperties: false, required: ['resumo', 'fluxos'],
  properties: { resumo: { type: 'string', description: 'Como o projeto está organizado, em duas ou três frases.' }, fluxos: { type: 'array', items: FLUXO } },
};

/** "Login do cliente" → "login-do-cliente" (sem acento, só letras, números e hífen). */
function slug(texto) {
  const semAcento = [...String(texto || '').normalize('NFD')].filter(c => c.charCodeAt(0) < 0x300 || c.charCodeAt(0) > 0x36f).join('');
  return semAcento.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
}
const limparCaminho = c => String(c || '').split(String.fromCharCode(92)).join('/').replace(/^\.?\//, '').replace(/:\d+$/, '').trim();

/** Arruma o que veio da IA (ou de um agente): ids únicos, tipos válidos, ligações só entre blocos que existem. */
function normalizar(bruto = {}, extra = {}) {
  const blocos = [], ids = new Set();
  for (const b of bruto.blocos || []) {
    const id = slug(b.id || b.titulo);
    if (!id || ids.has(id)) continue;
    ids.add(id);
    blocos.push({
      id, tipo: TIPOS.includes(b.tipo) ? b.tipo : 'servico', titulo: String(b.titulo || id).trim().slice(0, 80),
      detalhe: String(b.detalhe || '').trim().slice(0, 600), arquivos: [...new Set((b.arquivos || []).map(limparCaminho).filter(Boolean))].slice(0, 30),
    });
  }
  const vistas = new Set(), ligacoes = [];
  for (const l of bruto.ligacoes || []) {
    const de = slug(l.de), para = slug(l.para), chave = `${de}>${para}`;
    if (!ids.has(de) || !ids.has(para) || de === para || vistas.has(chave)) continue;
    vistas.add(chave);
    ligacoes.push({ de, para, rotulo: String(l.rotulo || '').trim().slice(0, 60) });
  }
  const nome = String(bruto.nome || extra.nome || '').trim();
  return { id: extra.id || slug(bruto.id || nome) || 'fluxo', nome: nome || 'Fluxo', blocos, ligacoes, ...extra };
}

/** Junta o que é novo num fluxo que já existe: o bloco de mesmo id ganha o texto novo e soma os arquivos. */
function mesclar(base, novo) {
  if (!base) return novo;
  const blocos = base.blocos.map(b => ({ ...b, arquivos: [...b.arquivos] }));
  for (const n of novo.blocos || []) {
    const b = blocos.find(x => x.id === n.id);
    if (!b) { blocos.push({ ...n, arquivos: [...n.arquivos] }); continue; }
    if (n.titulo) b.titulo = n.titulo;
    if (n.detalhe) b.detalhe = n.detalhe;
    if (n.tipo) b.tipo = n.tipo;
    b.arquivos = [...new Set([...b.arquivos, ...n.arquivos])];
  }
  const ligacoes = [...base.ligacoes];
  for (const l of novo.ligacoes || []) {
    const existe = ligacoes.find(x => x.de === l.de && x.para === l.para);
    if (existe) { if (l.rotulo) existe.rotulo = l.rotulo; } else ligacoes.push({ ...l });
  }
  return { ...base, nome: novo.nome && novo.nome !== 'Fluxo' ? novo.nome : base.nome, blocos, ligacoes };
}

/** O fluxo em texto, para os prompts: os blocos (o escolhido marcado) e as ligações. */
function paraTexto(f, marcado = null) {
  const nome = id => f.blocos.find(b => b.id === id)?.titulo || id;
  return [
    `Fluxo "${f.nome}" (id ${f.id})`,
    'Blocos:',
    ...f.blocos.map(b => `${b.id === marcado ? '→' : ' '} ${b.id} [${b.tipo}] ${b.titulo}${b.arquivos.length ? ` (${b.arquivos.join(', ')})` : ''}`),
    f.ligacoes.length ? 'Ligações:' : '',
    ...f.ligacoes.map(l => `- ${nome(l.de)} → ${nome(l.para)}${l.rotulo ? ` (${l.rotulo})` : ''}`),
  ].filter(Boolean).join('\n');
}

class Fluxos {
  constructor({ codigo, janelas, provedores, avisar, cfg, registrar }) {
    Object.assign(this, { codigo, janelas, provedores, avisar, cfg, registrar });
    this.vivos = new Map(); // `${raiz}|${fluxo}` → Map(bloco → { estado, sessao, nome, quando })
    this.mapa = null; // { raiz, controle, passo } enquanto a IA mapeia
  }

  get raiz() { return this.codigo.raiz; }
  arquivo(raiz = this.raiz) { return path.join(raiz, '.engram', 'fluxos.json'); }

  ler(raiz = this.raiz) {
    try { return { fluxos: [], mapeadoEm: null, resumo: '', ...JSON.parse(fs.readFileSync(this.arquivo(raiz), 'utf8')) }; } catch { return { fluxos: [], mapeadoEm: null, resumo: '' }; }
  }

  gravarTudo(dados, raiz = this.raiz) {
    fs.mkdirSync(path.dirname(this.arquivo(raiz)), { recursive: true });
    fs.writeFileSync(this.arquivo(raiz), JSON.stringify(dados, null, 2));
    this.avisar({ tipo: 'fluxos', evento: 'mudou', raiz });
    return dados;
  }

  /** Guarda (ou atualiza) um fluxo pelo id, sem perder onde a pessoa arrumou os blocos. */
  gravar(fluxo, raiz = this.raiz) {
    const dados = this.ler(raiz);
    const i = dados.fluxos.findIndex(f => f.id === fluxo.id);
    const antigo = i >= 0 ? dados.fluxos[i] : null;
    const novo = { ...(antigo ? mesclar(antigo, fluxo) : fluxo), posicoes: { ...(antigo?.posicoes || {}) }, origem: antigo?.origem || fluxo.origem || 'agente', atualizadoEm: Date.now() };
    if (i >= 0) dados.fluxos[i] = novo; else dados.fluxos.unshift(novo);
    this.gravarTudo(dados, raiz);
    return novo;
  }

  estado() {
    const raiz = this.raiz, dados = this.ler(raiz);
    const vivos = {};
    for (const f of dados.fluxos) { const m = this.vivos.get(`${raiz}|${f.id}`); if (m?.size) vivos[f.id] = Object.fromEntries(m); }
    return { raiz, nome: path.basename(raiz) || raiz, ...dados, vivos, mapeando: this.mapa?.raiz === raiz ? { passo: this.mapa.passo } : null, modelo: this.cfg.fluxos_modelo || 'sonnet' };
  }

  // ---------------------------------------------------------------- o mapa feito pela IA

  async mapear(modelo) {
    if (this.mapa) throw new Error('já estou mapeando um projeto: espere terminar ou pare');
    const raiz = this.raiz;
    const controle = new AbortController();
    this.mapa = { raiz, controle, passo: 'Começando…' };
    const passo = texto => { if (this.mapa) this.mapa.passo = texto; this.avisar({ tipo: 'fluxos', evento: 'passo', raiz, texto }); };
    passo('Olhando a pasta do projeto…');
    const prompt = [
      'Desenhe os fluxos principais deste projeto, como num editor de fluxos do n8n.',
      'Para cada funcionalidade importante (login, cadastro, pedido, relatório, integração, rotina agendada, atendimento da IA, consulta ao banco...), diga por onde ela passa de ponta a ponta: tela → rota → tratamento dos dados → banco → resposta → tela, com os nomes reais (rota, tabela, função, procedure) e os arquivos onde cada bloco está.',
      'Se a pasta não for de um sistema (por exemplo, análises, scripts SQL e documentação), desenhe os processos que esses arquivos descrevem: de onde vem o dado, o que é feito com ele e aonde vai.',
      '# Regras',
      '- Gaste pouco: use Glob e Grep para achar rotas, telas, tabelas, filas e integrações, e leia só os trechos que precisar. Não leia arquivos grandes inteiros.',
      '- No máximo 10 fluxos, com até 14 blocos cada. Comece pelos que mais importam para quem usa.',
      '- Ids curtos e estáveis (ex.: tela-login, post-api-login, tabela-usuarios). Os arquivos são relativos à pasta do projeto.',
      '- Não altere nada.',
      `# Projeto\nPasta: ${raiz}`,
      '# Como responder\nEntregue no formato pedido: um resumo de como o projeto está organizado e os fluxos. Escreva em português.',
    ].join('\n\n');
    (async () => {
      try {
        const r = await perguntar(this.provedores, { prompt, cwd: raiz, esquema: MAPA, modelo: modelo ?? this.cfg.fluxos_modelo ?? 'sonnet', sinal: controle.signal, tempo: 900_000, aoPasso: passo });
        if (!r || !Array.isArray(r.fluxos)) throw new Error('a IA não devolveu os fluxos');
        const dados = this.ler(raiz);
        for (const bruto of r.fluxos) {
          const f = normalizar(bruto, { origem: 'mapa' });
          if (!f.blocos.length) continue;
          const i = dados.fluxos.findIndex(x => x.id === f.id);
          if (i >= 0) dados.fluxos[i] = { ...mesclar(dados.fluxos[i], f), atualizadoEm: Date.now() };
          else dados.fluxos.push({ ...f, posicoes: {}, atualizadoEm: Date.now() });
        }
        dados.resumo = r.resumo || dados.resumo;
        dados.mapeadoEm = Date.now();
        this.mapa = null;
        this.gravarTudo(dados, raiz);
        this.avisar({ tipo: 'fluxos', evento: 'mapa-fim', raiz, total: dados.fluxos.length });
      } catch (e) {
        this.mapa = null;
        this.registrar?.(`fluxos: o mapa de ${raiz} falhou (${e.message})`);
        this.avisar({ tipo: 'fluxos', evento: 'mapa-fim', raiz, erro: e.message === 'parado' ? null : e.message, parado: e.message === 'parado' });
      }
    })();
    return { ok: true };
  }

  parar() { this.mapa?.controle.abort(); return { ok: true }; }

  // ---------------------------------------------------------------- o que os agentes fazem (pelo MCP do time)

  /** Lista os fluxos para um agente: ids, blocos e arquivos. */
  paraAgente() {
    const d = this.ler();
    if (!d.fluxos.length) return `Ainda não há fluxos desenhados para ${this.raiz}. Se for útil, desenhe com fluxo_desenhar.`;
    return [`Fluxos do projeto ${this.raiz}${d.resumo ? `\n${d.resumo}` : ''}`, ...d.fluxos.map(f => paraTexto(f))].join('\n\n');
  }

  desenhar(sessao, bruto) {
    if (!bruto || typeof bruto !== 'object') throw new Error('mande o fluxo: { nome, blocos, ligacoes }');
    const f = normalizar(bruto, { origem: 'agente', ...(bruto.id ? { id: slug(bruto.id) } : {}) });
    if (!f.blocos.length) throw new Error('o fluxo precisa de pelo menos um bloco');
    const salvo = this.gravar(f);
    const quem = this.janelas.cerebro.sessao(sessao)?.nome || 'um agente';
    this.avisar({ tipo: 'fluxos', evento: 'desenhado', raiz: this.raiz, fluxo: salvo.id, quem });
    return `Fluxo "${salvo.nome}" (id ${salvo.id}) desenhado com ${salvo.blocos.length} blocos. Marque o bloco em que estiver trabalhando com fluxo_marcar.`;
  }

  marcar(sessao, { fluxo, bloco, estado, arquivos = [] }) {
    const raiz = this.raiz, dados = this.ler(raiz);
    const f = dados.fluxos.find(x => x.id === slug(fluxo)) || dados.fluxos.find(x => x.nome.toLowerCase() === String(fluxo || '').toLowerCase());
    if (!f) return `Não achei o fluxo "${fluxo}". Veja os ids com a ferramenta fluxos.`;
    const b = f.blocos.find(x => x.id === slug(bloco)) || f.blocos.find(x => x.titulo.toLowerCase() === String(bloco || '').toLowerCase());
    if (!b) return `O fluxo ${f.id} não tem o bloco "${bloco}". Os blocos são: ${f.blocos.map(x => x.id).join(', ')}.`;
    if (!ESTADOS.includes(estado)) return `Estado inválido: use ${ESTADOS.join(', ')}.`;
    const chave = `${raiz}|${f.id}`;
    if (!this.vivos.has(chave)) this.vivos.set(chave, new Map());
    const nome = this.janelas.cerebro.sessao(sessao)?.nome || 'agente';
    const marca = { estado, sessao, nome, quando: Date.now() };
    this.vivos.get(chave).set(b.id, marca);
    const novos = (Array.isArray(arquivos) ? arquivos : []).map(limparCaminho).filter(Boolean);
    if (novos.some(a => !b.arquivos.includes(a))) { b.arquivos = [...new Set([...b.arquivos, ...novos])]; this.gravarTudo(dados, raiz); }
    this.avisar({ tipo: 'fluxos', evento: 'bloco', raiz, fluxo: f.id, bloco: b.id, ...marca });
    return `Bloco "${b.titulo}" marcado como ${estado}.`;
  }

  /** Manda a um agente do palco um pedido sobre um bloco, com o fluxo inteiro como contexto. */
  pedir({ fluxo, bloco, sessao, texto }) {
    const f = this.ler().fluxos.find(x => x.id === fluxo);
    if (!f) throw new Error('fluxo não encontrado');
    const b = f.blocos.find(x => x.id === bloco);
    if (!b) throw new Error('bloco não encontrado');
    const pedido = [
      String(texto || '').trim() || `Revise o bloco "${b.titulo}".`,
      '',
      `É sobre o bloco "${b.titulo}" (${b.id}, ${b.tipo})${b.detalhe ? `: ${b.detalhe}` : ''}.`,
      b.arquivos.length ? `Arquivos dele: ${b.arquivos.map(a => path.join(this.raiz, a)).join(', ')}` : 'Ele ainda não tem arquivos.',
      '',
      paraTexto(f, b.id),
      '',
      `Pasta do projeto: ${this.raiz}. Enquanto trabalhar nele, marque com fluxo_marcar (fluxo "${f.id}", bloco "${b.id}") como trabalhando e, no fim, como feito.`,
    ].join('\n');
    this.janelas.digitar(sessao, pedido);
    return { ok: true };
  }

  // ---------------------------------------------------------------- rotas

  registrarRotas(rota) {
    rota('GET', '/api/fluxos', () => this.estado());
    rota('POST', '/api/fluxos/mapear', (_, b) => this.mapear(b.modelo));
    rota('POST', '/api/fluxos/parar', () => this.parar());
    rota('POST', '/api/fluxos/modelo', (_, b) => { this.cfg.fluxos_modelo = String(b.modelo || ''); require('./config').salvar({ fluxos_modelo: this.cfg.fluxos_modelo }); return { ok: true }; });
    rota('POST', '/api/fluxos/pedir', (_, b) => this.pedir(b));
    rota('POST', '/api/fluxos/limpar-marcas', () => { for (const k of [...this.vivos.keys()]) if (k.startsWith(`${this.raiz}|`)) this.vivos.delete(k); this.avisar({ tipo: 'fluxos', evento: 'mudou', raiz: this.raiz }); return { ok: true }; });
    rota('POST', '/api/fluxos/:id/posicoes', (p, b) => {
      const dados = this.ler(), f = dados.fluxos.find(x => x.id === p.id);
      if (!f) throw new Error('fluxo não encontrado');
      const pos = {};
      for (const [k, v] of Object.entries(b.posicoes || {})) if (f.blocos.some(x => x.id === k) && Number.isFinite(v?.x) && Number.isFinite(v?.y)) pos[k] = { x: Math.round(v.x), y: Math.round(v.y) };
      f.posicoes = b.trocar ? pos : { ...(f.posicoes || {}), ...pos };
      fs.writeFileSync(this.arquivo(), JSON.stringify(dados, null, 2)); // sem aviso: quem arrastou já está vendo
      return { ok: true };
    });
    rota('POST', '/api/fluxos/:id/remover', p => {
      const dados = this.ler();
      dados.fluxos = dados.fluxos.filter(x => x.id !== p.id);
      this.vivos.delete(`${this.raiz}|${p.id}`);
      this.gravarTudo(dados);
      return { ok: true };
    });
  }
}

module.exports = { Fluxos, normalizar, slug, TIPOS };
