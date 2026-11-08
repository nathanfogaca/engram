// O que a tela pede ao app, por IPC (sem porta de rede): os mesmos caminhos da versão web.

const { posicaoValida } = require('./janelas');

class ErroRota extends Error {
  constructor(status, mensagem) { super(mensagem); this.status = status; }
}

function criarRotas({ cfg, cerebro, janelas, provedores, mcps, skills, escolherArquivo, definirTema, sincronizar, estadoSinc, versao, caminhos, salvarConfig, reiniciar, atualizador, codigo, fluxos, extensoes, previa, linguagens, trabalho, abrirTrabalho }) {
  const importador = require('./importar');
  const rotas = [];
  const rota = (metodo, padrao, fn) => {
    const nomes = [];
    const re = new RegExp('^' + padrao.replace(/:(\w+)/g, (_, n) => { nomes.push(n); return '([^/]+)'; }) + '$');
    rotas.push({ metodo, re, nomes, fn });
  };
  const exigir = (cond, status, msg) => { if (!cond) throw new ErroRota(status, msg); };

  rota('GET', '/api/estado', () => ({
    versao,
    modelos: provedores.adaptador('claude').modelos(),
    provedores: provedores.resumo(),
    mcps: mcps.estado.servidores.filter(s => s.ativo).map(s => ({ id: s.id, nome: s.nome, agentes: s.agentes })),
    papeis: Object.entries(cfg.papeis).map(([id, p]) => ({ id, nome: p.nome, resumo: p.resumo || '' })),
    cerebro: { ...cerebro.resumo(), fonte: cerebro.fonte.tipo },
    sinc: estadoSinc,
    max_janelas: cfg.max_janelas,
    tema: cfg.tema,
    temas: Object.entries(require('./config').TEMAS).map(([id, t]) => ({ id, nome: t.nome })),
    padrao_agente: cfg.padrao_agente || null,
    padrao_modelo: cfg.padrao_modelo ?? null,
    // primeiro uso: ninguém passou pelo guia, não veio do Engram antigo e nunca abriu uma janela
    primeiro_uso: !cfg.primeiro_uso_feito && !cfg.importado_engram_antigo && cerebro.sessoes(1).length === 0,
  }));
  rota('GET', '/api/palco', () => {
    const abertas = new Set(janelas.ativas.keys());
    return {
      janelas: [...abertas].map(id => janelas.info(id)),
      conexoes: cerebro.conexoes().filter(c => abertas.has(c.a) && abertas.has(c.b)),
      setores: cerebro.setores(),
    };
  });
  // setores do palco: áreas com nome, cor e instrução; o centro do cartão dentro = faz parte
  const setorValido = (b, atual = {}) => {
    const nome = String(b.nome ?? atual.nome ?? '').trim().slice(0, 24);
    exigir(nome, 400, 'o setor precisa de um nome');
    const cor = String(b.cor ?? atual.cor ?? '#8b7bff');
    exigir(/^#[0-9a-f]{6}$/i.test(cor), 400, 'cor inválida');
    const num = (v, padrao, min, max) => (Number.isFinite(Number(v)) ? Math.max(min, Math.min(Number(v), max)) : padrao);
    return {
      nome, cor, instrucao: String(b.instrucao ?? atual.instrucao ?? '').trim().slice(0, 2000),
      x: num(b.x, atual.x ?? 0, -1e6, 1e6), y: num(b.y, atual.y ?? 0, -1e6, 1e6),
      w: num(b.w, atual.w ?? 900, 200, 20000), h: num(b.h, atual.h ?? 600, 140, 20000),
    };
  };
  rota('GET', '/api/setores', () => cerebro.setores());
  rota('POST', '/api/setores', (_, b) => {
    const s = { id: `setor-${require('node:crypto').randomUUID().slice(0, 8)}`, ...setorValido(b) };
    cerebro.setorSalvar(s);
    janelas.avisar({ tipo: 'setor', acao: 'salvo', setor: s });
    return s;
  });
  rota('PUT', '/api/setores/:id', (p, b) => {
    const atual = cerebro.setor(p.id);
    exigir(atual, 404, 'setor não encontrado');
    const s = { id: p.id, ...setorValido(b, atual) };
    cerebro.setorSalvar(s);
    janelas.avisar({ tipo: 'setor', acao: 'salvo', setor: s });
    return s;
  });
  rota('POST', '/api/setores/:id/remover', p => {
    if (cerebro.setorApagar(p.id)) janelas.avisar({ tipo: 'setor', acao: 'removido', id: p.id });
    return { ok: true };
  });
  rota('POST', '/api/conexoes', (_, b) => {
    exigir(b.a && b.b && b.a !== b.b && janelas.ativas.has(b.a) && janelas.ativas.has(b.b), 400, 'as duas pontas têm de ser janelas abertas e diferentes');
    if (cerebro.conectar(b.a, b.b)) janelas.avisar({ tipo: 'conexao', acao: 'criada', a: b.a, b: b.b });
    return { ok: true };
  });
  rota('POST', '/api/conexoes/revisao', (_, b) => {
    exigir(!b.revisor || b.revisor === b.a || b.revisor === b.b, 400, 'o revisor tem de ser uma das pontas da ligação');
    exigir(cerebro.revisao(b.a, b.b, b.revisor || null), 404, 'essas duas janelas não estão ligadas');
    for (const c of cerebro.conexoes()) janelas.avisar({ tipo: 'conexao', acao: 'revisao', a: c.a, b: c.b, revisa: c.revisa || null });
    return { ok: true };
  });
  rota('POST', '/api/conexoes/remover', (_, b) => {
    if (cerebro.desconectar(b.a, b.b)) janelas.avisar({ tipo: 'conexao', acao: 'removida', a: b.a, b: b.b });
    return { ok: true };
  });
  rota('PUT', '/api/posicoes/:id', (p, b) => {
    exigir(cerebro.sessao(p.id), 404, 'janela não encontrada');
    cerebro.posicaoSalvar(p.id, ...posicaoValida(b));
    return { ok: true };
  });
  rota('POST', '/api/sincronizar', async () => sincronizar(true));
  rota('GET', '/api/grafo', () => cerebro.grafo());
  rota('GET', '/api/nota/:id', p => { const n = cerebro.nota(p.id); exigir(n, 404, 'nota não encontrada'); return n; });
  rota('GET', '/api/busca', (p, b, q) => cerebro.buscar(String(q.get('q') || '').slice(0, 300)));
  rota('POST', '/api/consulta', async (_, b) => {
    try { return await cerebro.consultar(String(b.sql || '').slice(0, 20_000)); } catch (e) { throw new ErroRota(400, e.message); }
  });

  rota('GET', '/api/sessoes', () => cerebro.sessoes());
  rota('POST', '/api/sessoes', async (_, b) => {
    try {
      const anterior = b.retomar ? cerebro.sessao(b.retomar) : null;
      return await janelas.abrir({
        nome: b.nome, modelo: b.modelo || '', papel: b.papel || 'livre', provedor: anterior?.provedor || b.provedor || 'claude',
        retomar: b.retomar || null, posicao: b.posicao || null, mcps: Array.isArray(b.mcps) ? b.mcps : undefined,
      });
    } catch (e) { throw new ErroRota(400, e.message); }
  });
  rota('POST', '/api/sessoes/:id/encerrar', p => {
    try { janelas.fechar(p.id); } catch (e) { throw new ErroRota(404, e.message); }
    return { ok: true };
  });
  rota('PUT', '/api/sessoes/:id/nome', (p, b) => {
    try { return janelas.renomear(p.id, b.nome); } catch (e) { throw new ErroRota(400, e.message); }
  });
  rota('GET', '/api/sessoes/:id/eventos', p => cerebro.eventos(p.id));
  rota('GET', '/api/sessoes/:id/conversa', (p, b, q) => {
    return janelas.lerConversa(p.id, Number(q.get('desde')) || 0, Number(q.get('ultimos')) || null);
  });
  rota('POST', '/api/sessoes/:id/prompt', (p, b) => {
    try { return { na_frente: janelas.digitar(p.id, b.texto) }; } catch (e) { throw new ErroRota(400, e.message); }
  });
  rota('POST', '/api/sessoes/:id/interromper', p => { janelas.interromper(p.id); return { ok: true }; });
  rota('POST', '/api/sessoes/:id/confiar', p => {
    try { janelas.confiarPasta(p.id); } catch (e) { throw new ErroRota(400, e.message); }
    return { ok: true };
  });
  rota('GET', '/api/sessoes/:id/arquivos', p => {
    exigir(cerebro.sessao(p.id), 404, 'janela não encontrada');
    return janelas.arquivos.listar(p.id);
  });
  rota('POST', '/api/sessoes/:id/arquivos', (p, b) => {
    exigir(cerebro.sessao(p.id), 404, 'janela não encontrada');
    const limite = cfg.max_arquivo_mb * 1048576;
    try {
      const destino = b.origem
        ? janelas.arquivos.copiar(p.id, 'recebidos', String(b.origem), b.nome, limite)
        : janelas.arquivos.gravar(p.id, String(b.nome || 'arquivo'), Buffer.from(b.bytes || []), limite);
      janelas.avisar({ tipo: 'arquivos', sessao_id: p.id, entregues: [] });
      return { nome: require('node:path').basename(destino), caminho: destino };
    } catch (e) { throw new ErroRota(400, e.message); }
  });

  // ---------------------------------------------------------------- contas e provedores
  const provedorValido = id => { exigir(provedores.adaptador(id), 404, 'agente desconhecido'); return id; };
  rota('GET', '/api/contas', async (p, b, q) => provedores.todos(q.get('atualizar') === '1'));
  rota('POST', '/api/contas/:id/terminal', async (p, b) => {
    const id = provedorValido(p.id);
    const acao = String(b.acao || '');
    exigir(['entrar', 'sair', 'instalar'].includes(acao), 400, 'ação desconhecida');
    let argv;
    try { argv = provedores.comandoDe(id, acao); } catch (e) { throw new ErroRota(400, e.message); }
    try {
      const terminal = await janelas.abrirAuxiliar(argv, {
        aoFim: () => { provedores.esquecerCache(id); janelas.avisar({ tipo: 'contas', id }); },
      });
      return { terminal };
    } catch (e) { throw new ErroRota(400, e.message); }
  });
  rota('POST', '/api/terminais/:id/fechar', p => { janelas.fecharAuxiliar(p.id); return { ok: true }; });
  rota('POST', '/api/contas/:id/chave', async (p, b) => {
    const id = provedorValido(p.id);
    try { await provedores.guardarChave(id, b.chave); } catch (e) { throw new ErroRota(400, e.message); }
    return provedores.info(id, true);
  });
  rota('POST', '/api/contas/:id/chave/remover', async p => {
    const id = provedorValido(p.id);
    try { await provedores.esquecerChave(id); } catch (e) { throw new ErroRota(400, e.message); }
    return provedores.info(id, true);
  });
  rota('POST', '/api/contas/:id/modo', async (p, b) => {
    const id = provedorValido(p.id);
    exigir(['conta', 'chave'].includes(b.modo), 400, 'modo desconhecido');
    provedores.mudarModo(id, b.modo);
    return provedores.info(id, true);
  });

  // ---------------------------------------------------------------- MCPs
  const erro400 = fn => async (...a) => { try { return await fn(...a); } catch (e) { throw e instanceof ErroRota ? e : new ErroRota(400, e.message); } };
  const mudouMcps = () => { janelas.escreverGanchos(); janelas.avisar({ tipo: 'mcps' }); return mcps.listar(); };
  rota('GET', '/api/mcps', () => mcps.listar());
  rota('GET', '/api/mcps/encontrados', erro400(() => mcps.encontrados()));
  rota('POST', '/api/mcps', erro400(async (_, b) => { await mcps.salvar(b.def || {}, b.segredos || {}, b.id_antigo || null); return mudouMcps(); }));
  rota('POST', '/api/mcps/testar', erro400((_, b) => mcps.testar(b.id || b.def, b.segredos || {})));
  rota('POST', '/api/mcps/opcoes', erro400((_, b) => { mcps.opcoes(b); return mudouMcps(); }));
  rota('POST', '/api/mcps/escolher-ca', async () => ({ caminho: await escolherArquivo({ titulo: 'Certificado (CA) do servidor', filtros: [{ name: 'Certificado', extensions: ['pem', 'crt', 'cer'] }] }) }));
  rota('POST', '/api/mcps/:id/remover', erro400(async p => { await mcps.remover(p.id); return mudouMcps(); }));
  rota('POST', '/api/mcps/:id/ativo', erro400((p, b) => { mcps.alternar(p.id, b.ativo); return mudouMcps(); }));
  rota('POST', '/api/mcps/:id/importar', erro400(async p => { await mcps.importar(p.id); return mudouMcps(); }));

  // ---------------------------------------------------------------- skills
  const mudouSkills = () => { janelas.avisar({ tipo: 'skills' }); return { skills: skills.listar(), encontradas: skills.encontradas() }; };
  rota('GET', '/api/skills', () => ({ skills: skills.listar(), encontradas: skills.encontradas(), pasta: skills.dir }));
  rota('POST', '/api/skills', erro400((_, b) => { const s = skills.criar(b.nome, b.descricao); mudouSkills(); return s; }));
  rota('POST', '/api/skills/importar', erro400(async (_, b) => { const s = await skills.importar(b.origem); mudouSkills(); return s; }));
  rota('POST', '/api/skills/escolher', async (_, b) => ({
    caminho: await escolherArquivo({
      titulo: b.pasta ? 'Pasta da skill' : 'Skill (.zip, .skill ou SKILL.md)', pasta: !!b.pasta,
      filtros: [{ name: 'Skill', extensions: ['zip', 'skill', 'md'] }],
    }),
  }));
  rota('GET', '/api/skills/:nome', erro400(p => skills.ler(p.nome)));
  rota('POST', '/api/skills/:nome/salvar', erro400((p, b) => { const s = skills.salvar(p.nome, b.texto); mudouSkills(); return s; }));
  rota('POST', '/api/skills/:nome/remover', erro400(p => { skills.remover(p.nome); return mudouSkills(); }));
  rota('POST', '/api/skills/:nome/ajustar', erro400((p, b) => { skills.ajustar(p.nome, b); return mudouSkills(); }));
  rota('POST', '/api/skills/:nome/abrir-pasta', erro400(p => { require('electron').shell.openPath(skills.caminho(p.nome)); return { ok: true }; }));

  // ---------------------------------------------------------------- geral, tema e primeiro uso
  const CAMPOS_GERAIS = ['pasta_trabalho', 'max_janelas', 'max_mensagens_par_10min', 'max_arquivo_mb', 'contexto', 'atualizar_sozinho', 'padrao_agente', 'padrao_modelo'];
  // cérebro salvo que só vale depois de reiniciar (a tela mostra o salvo, não o que está em uso)
  let cerebroPendente = null;
  const chaveCerebro = x => (x.fonte === 'remoto'
    ? JSON.stringify(['remoto', x.url || '', x.token_env || '', x.ca || '', x.pasta_remota || 'cerebro', x.servidor || 'cerebro'])
    : JSON.stringify(['pasta', x.pasta || caminhos.cerebro]));
  rota('GET', '/api/config', () => ({
    ...Object.fromEntries(CAMPOS_GERAIS.map(k => [k, cfg[k] ?? null])),
    atualizar_sozinho: cfg.atualizar_sozinho !== false,
    cerebro: { ...(cerebroPendente || cfg.cerebro) }, cerebro_pendente: !!cerebroPendente,
    cerebro_fonte_ativa: cerebro.fonte.tipo, dados: caminhos.dados, versao,
  }));
  rota('POST', '/api/config', erro400(async (_, b) => {
    const fs = require('node:fs');
    const parcial = {};
    const numero = (k, a, z) => {
      if (b[k] === undefined) return;
      const n = Math.round(Number(b[k]));
      exigir(Number.isFinite(n) && n >= a && n <= z, 400, `${k.replace(/_/g, ' ')}: use um número entre ${a} e ${z}`);
      parcial[k] = n;
    };
    if (b.pasta_trabalho !== undefined) {
      const p = String(b.pasta_trabalho).trim();
      exigir(p && fs.existsSync(p) && fs.statSync(p).isDirectory(), 400, 'a pasta de trabalho não existe');
      parcial.pasta_trabalho = p;
    }
    numero('max_janelas', 1, 24);
    numero('max_mensagens_par_10min', 5, 300);
    numero('max_arquivo_mb', 1, 2000);
    if (b.contexto !== undefined) parcial.contexto = String(b.contexto).slice(0, 20_000);
    if (b.atualizar_sozinho !== undefined) parcial.atualizar_sozinho = !!b.atualizar_sozinho;
    if (b.padrao_agente !== undefined) { exigir(!b.padrao_agente || provedores.adaptador(b.padrao_agente), 400, 'agente desconhecido'); parcial.padrao_agente = b.padrao_agente || null; }
    if (b.padrao_modelo !== undefined) parcial.padrao_modelo = String(b.padrao_modelo || '');
    let reiniciar = false;
    if (b.cerebro) {
      const c = b.cerebro;
      const novo = c.fonte === 'remoto'
        ? { fonte: 'remoto', url: String(c.url || '').trim(), token_env: String(c.token_env || '').trim(), ca: String(c.ca || '').trim(), pasta_remota: String(c.pasta_remota || 'cerebro').trim(), servidor: String(c.servidor || 'cerebro').trim(), sincronizar_min: cfg.cerebro.sincronizar_min }
        : { fonte: 'pasta', pasta: String(c.pasta || '').trim(), sincronizar_min: cfg.cerebro.sincronizar_min };
      if (novo.fonte === 'remoto') {
        exigir(/^https?:\/\//.test(novo.url), 400, 'o endereço do cérebro remoto tem de começar com http:// ou https://');
        exigir(!novo.ca || fs.existsSync(novo.ca), 400, 'o arquivo do certificado (CA) não existe');
        const m = mcps.porUrl(novo.url); // o nome com que os agentes enxergam o servidor é o do cadastro em MCPs
        if (m) novo.servidor = m.id;
      }
      if (novo.fonte === 'pasta' && novo.pasta) { fs.mkdirSync(novo.pasta, { recursive: true }); }
      reiniciar = chaveCerebro(novo) !== chaveCerebro(cfg.cerebro);
      cerebroPendente = reiniciar ? novo : null;
      parcial.cerebro = novo;
    }
    salvarConfig(parcial);
    for (const [k, v] of Object.entries(parcial)) if (k !== 'cerebro') cfg[k] = v;
    return { ok: true, reiniciar, cerebro: parcial.cerebro || null };
  }));
  rota('POST', '/api/tema', erro400((_, b) => {
    exigir(require('./config').TEMAS[b.tema], 400, 'tema desconhecido');
    cfg.tema = b.tema;
    salvarConfig({ tema: b.tema });
    definirTema(b.tema);
    return { tema: b.tema };
  }));
  rota('POST', '/api/escolher-pasta', async (_, b) => ({ caminho: await escolherArquivo({ titulo: String(b.titulo || 'Escolha uma pasta'), pasta: true }) }));
  rota('POST', '/api/reiniciar', () => { reiniciar(); return { ok: true }; });
  rota('POST', '/api/primeiro-uso/feito', () => { cfg.primeiro_uso_feito = new Date().toISOString(); salvarConfig({ primeiro_uso_feito: cfg.primeiro_uso_feito }); return { ok: true }; });

  rota('GET', '/api/atualizacao', () => atualizador.estado);
  rota('POST', '/api/atualizacao/verificar', async () => atualizador.verificar());
  rota('POST', '/api/atualizacao/instalar', () => {
    try { atualizador.instalar(); } catch (e) { throw new ErroRota(400, e.message); }
    return { ok: true };
  });

  rota('GET', '/api/importar/engram-antigo', (p, b, q) => ({
    ...importador.verificar(q.get('pasta') || importador.PADRAO),
    ja_importado: cfg.importado_engram_antigo || null,
  }));
  rota('POST', '/api/importar/engram-antigo', (_, b) => {
    try {
      const r = importador.importar({
        cerebro, caminhos, dir: b.pasta || importador.PADRAO, pararAntigo: b.parar_antigo !== false, reabrir: b.reabrir !== false,
        salvarConfig: extra => salvarConfig({ ...extra, importado_engram_antigo: new Date().toISOString() }),
      });
      if (b.reiniciar !== false) reiniciar();
      return r;
    } catch (e) { throw new ErroRota(400, e.message); }
  });

  codigo?.registrarRotas(rota); // vista Código: arquivos, git e terminais da pasta aberta
  fluxos?.registrarRotas(rota); // vista Fluxos: o mapa do projeto em blocos, estilo n8n
  extensoes?.registrarRotas(rota); // extensões do VS Code (Open VSX): temas, ícones, realce e snippets
  previa?.registrarRotas(rota, { shell: require('electron').shell }); // prévias de HTML, imagens, vídeo, PDF...
  linguagens?.registrarRotas(rota); // servidores de linguagem (LSP): o IntelliSense de verdade no editor
  trabalho?.registrarRotas(rota, { abrirJanela: abrirTrabalho }); // "Visualizar trabalho": ver o agente escrevendo

  return async function tratar(metodo, caminho, corpo) {
    const url = new URL(caminho, 'engram://app');
    for (const r of rotas) {
      if (r.metodo !== metodo) continue;
      const m = r.re.exec(url.pathname);
      if (!m) continue;
      const params = Object.fromEntries(r.nomes.map((n, i) => [n, decodeURIComponent(m[i + 1])]));
      try {
        return { ok: true, dados: await r.fn(params, corpo || {}, url.searchParams) };
      } catch (e) {
        return { ok: false, status: e.status || 500, erro: e.message || 'erro no Engram' };
      }
    }
    return { ok: false, status: 404, erro: `não existe: ${metodo} ${url.pathname}` };
  };
}

module.exports = { criarRotas };
