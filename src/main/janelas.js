// Janelas do Engram: cada uma é um agente de verdade (CLI) num terminal que vive no MOTOR.
// Fechar ou atualizar o app não derruba o time: ao subir, o app reencontra quem está rodando e reabre
// (com --resume) quem devia estar aberto e caiu. Linhas no palco = conexões: só janelas ligadas
// trocam mensagens, que entram no terminal do colega (colar + Enter) quando ele termina o turno.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { MotorCliente, MotorErro } = require('./motor-cliente');
const { Arquivos } = require('./arquivos');
const conversa = require('./conversa');
const conversaCodex = require('./conversa-codex');
const { idDoCaminho } = require('./notas');
const { TelaVirtual } = require('./tela-virtual');
const { PALCOS } = require('./banco');

const EVENTOS_GANCHO = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SubagentStop', 'Notification', 'SessionEnd'];
const ESTADO_POR_EVENTO = { SessionStart: 'pronta', UserPromptSubmit: 'pensando', PreToolUse: 'trabalhando', PostToolUse: 'pensando', Stop: 'esperando você', Notification: 'precisa de você' };
const LIVRE = new Set(['pronta', 'esperando você']);
const { PERGUNTA_GERAL: PERGUNTA_TELA } = require('./provedores');
const { lerPergunta, TECLAS, TRABALHANDO } = require('./pergunta');
const { notasDoComando, analisarCodex, resolver, trechosDoPatch, desescapar } = require('./notas-tocadas'); // linhas do cérebro e bolha do palco
const OCUPADO_ESTADO = new Set(['pensando', 'trabalhando']);
const FERRAMENTAS_TIME = ['equipe', 'palco', 'tarefas', 'enviar', 'ver_tela', 'criar_agente', 'ligar', 'desligar', 'organizar_palco', 'renomear', 'criar_setor', 'editar_setor', 'remover_setor', 'entregar_arquivo', 'fluxos', 'fluxo_desenhar', 'fluxo_marcar', 'ajustes', 'ajustar'];
// as cores dos setores, as mesmas da tela (src/tela/js/setores.js)
const CORES_SETOR = { violeta: '#8b7bff', ciano: '#38d6f5', magenta: '#e879f9', ambar: '#ffc857', verde: '#4ade9f', coral: '#ff7a6b' };
const PESSOA = 'pessoa'; // remetente das mensagens que a pessoa digita na vista Conversa
const MAX_BUFFER = 400_000;
const TAMANHO_PADRAO = [700, 470];
// o tamanho dos outros objetos do palco (src/tela/automacoes.css); a altura deles varia, então é aproximada
const TAMANHO_AUTOMACAO = [300, 170], TAMANHO_POSTIT = [210, 160];
const ETIQUETA_SETOR = 70; // a etiqueta com o nome do setor fica em cima da área
const MAX_ANEXOS = 20;
const MONTAR_TELA = 3000; // depois do SessionStart (ou de confiar na pasta), quanto esperar antes de colar
const CONFIRMAR = 8000; // sem UserPromptSubmit nesse tempo depois de colar, a entrega é conferida na tela
const ONDE_MUDAR_LIMITE = 'Ajustes > Geral > Limites, "Janelas abertas ao mesmo tempo"';
const COLAR_INICIO = '\x1b[200~', COLAR_FIM = '\x1b[201~';
const VARIAVEIS_FORA = new Set(['CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_SSE_PORT', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE']);

class Janela {
  constructor(id, motor, provedor = 'claude') {
    this.id = id;
    this.motor = motor;
    this.provedor = provedor;
    // agentes sem ganchos: o estado sai da tela (o que mudou e quando) e do aviso de fim de turno
    this.telaAnterior = '';
    this.telaMudouEm = Date.now();
    this.ocupadoAte = 0;
    this.teveTurno = false;
    this.procurouEm = 0;
    this.saida = [];
    this.tamanho = 0;
    this.ouvintes = new Set();
    this.viva = true;
    this.estado = 'iniciando';
    this.caixa = []; // [n, de, texto formatado]
    this.entregando = false;
    this.tela = new TelaVirtual(100, 28);
    this.conversa = null;
    this.conversaTam = -1;
    this.arquivosAssinatura = '';
    this.criadaEm = Date.now();
    this.pergunta = null; // o agente está esperando uma resposta no terminal (confiar na pasta, etc.)
    this.ultimaAcao = null; // agentes sem ganchos: a última ferramenta, lida da conversa ({ o_que, quando })
  }
  // o estado guarda desde quando vale (o equipe mostra "trabalhando há 3 min")
  get estado() { return this._estado; }
  set estado(v) { if (v !== this._estado) { this._estado = v; this.estadoDesde = Date.now(); } }
  escrever(texto) { if (this.viva) this.motor.mandar('escrever', { id: this.id, dados: texto }); }
  guardar(texto) {
    this.saida.push(texto);
    this.tamanho += texto.length;
    while (this.tamanho > MAX_BUFFER && this.saida.length > 1) this.tamanho -= this.saida.shift().length;
    this.tela.escrever(texto);
  }
  historico() { return this.saida.join(''); }
}

class Janelas {
  constructor({ cfg, cerebro, fonte, token, caminhos, avisar, provedores, mcps, skills }) {
    this.cfg = cfg;
    this.cerebro = cerebro;
    this.fonte = fonte;
    this.token = token;
    this.caminhos = caminhos;
    this.avisar = avisar;
    this.ativas = new Map();
    this.auxiliares = new Map(); // terminais de apoio (login, instalação): fora do palco e do time
    this.terminais = new Map(); // terminais da vista Código (shell na pasta do projeto)
    this.arquivos = new Arquivos(caminhos.arquivos);
    fs.mkdirSync(caminhos.janelas, { recursive: true });
    this.arquivoGanchos = path.join(caminhos.dados, 'ganchos.json');
    this.motor = new MotorCliente(cfg, token, {
      aoSaida: (id, d) => this.motorSaida(id, d), aoFim: id => this.motorFim(id), aoCair: () => this.motorCaiu(), dados: caminhos.dados,
    });
    this.provedores = provedores;
    this.mcps = mcps;
    this.skills = skills;
    this.reconectando = false;
  }

  // ---------------------------------------------------------------- início

  async iniciar() {
    this.escreverGanchos();
    await this.motor.conectar();
    await this.reconciliar();
    try { this.cerebro.posicoesLimpar(); } catch { /* fica para a próxima */ }
  }

  escreverGanchos() {
    const r = this.motor.runtime;
    const comando = `"${r.node.replace(/\\/g, '/')}" "${r.gancho.replace(/\\/g, '/')}"`;
    const hooks = {};
    for (const ev of EVENTOS_GANCHO) {
      const regra = { hooks: [{ type: 'command', command: comando, timeout: 5 }] };
      if (ev === 'PreToolUse' || ev === 'PostToolUse') regra.matcher = '*';
      hooks[ev] = [regra];
    }
    // MCPs marcados como "liberar sem perguntar" entram inteiros (mcp__<nome>)
    const permitir = [...FERRAMENTAS_TIME.map(f => `mcp__engram__${f}`), ...(this.cfg.permitir || []), ...(this.mcps ? this.mcps.liberados().map(id => `mcp__${id}`) : [])];
    fs.writeFileSync(this.arquivoGanchos, JSON.stringify({ hooks, permissions: { allow: permitir } }, null, 2));
  }

  async reconciliar() {
    const lista = await this.motor.pedir('listar');
    const vivos = new Set(lista.terminais.filter(t => t.viva).map(t => t.id));
    // login ou instalação que ficou aberto quando o app fechou: ninguém mais olha para ele
    for (const t of lista.terminais) if (/^(aux|cod)-/.test(t.id)) { this.motor.mandar('fechar', { id: t.id }); this.motor.mandar('esquecer', { id: t.id }); }
    const retomar = [];
    for (const s of this.cerebro.sessoes(500)) {
      if (vivos.has(s.id)) { if (!this.ativas.has(s.id)) await this.reanexar(s); }
      else if (s.manter) retomar.push(s);
      else if (!s.encerrada) this.cerebro.sessaoEncerrar(s.id);
    }
    const ondeParou = [], doZero = [], falhas = [];
    for (const s of retomar) {
      try {
        const r = await this.abrir({ nome: s.nome, modelo: s.modelo, papel: s.papel, provedor: s.provedor || 'claude', retomar: s.id });
        (r.conversa_nova ? doZero : ondeParou).push(s.nome);
      } catch (e) {
        this.cerebro.sessaoEncerrar(s.id);
        falhas.push(`${s.nome} (${String(e.message).slice(0, 80)})`);
      }
    }
    // um aviso por grupo (com o time inteiro reaberto, um por agente empilhava em cima dos cartões)
    const juntar = nomes => (nomes.length > 4 ? `${nomes.slice(0, 4).join(', ')} e mais ${nomes.length - 4}` : nomes.join(', '));
    if (ondeParou.length) this.avisar({ tipo: 'aviso', texto: ondeParou.length === 1 ? `${ondeParou[0]} foi reaberto onde parou` : `${ondeParou.length} agentes foram reabertos onde pararam: ${juntar(ondeParou)}` });
    if (doZero.length) this.avisar({ tipo: 'aviso', texto: doZero.length === 1 ? `${doZero[0]} foi reaberto (não tinha conversa gravada, então começou uma nova)` : `${doZero.length} agentes foram reabertos com conversa nova (não tinham conversa gravada): ${juntar(doZero)}` });
    if (falhas.length) this.avisar({ tipo: 'aviso', texto: `não deu para reabrir ${juntar(falhas)}` });
    this.recolocarMensagens();
  }

  async reanexar(s) {
    const j = new Janela(s.id, this.motor, s.provedor || 'claude');
    j.arquivosAssinatura = this.arquivos.assinatura(s.id);
    j.teveTurno = !['iniciando', 'pronta'].includes(s.estado);
    const h = await this.motor.pedir('historico', { id: s.id });
    j.guardar(h.dados || '');
    // "iniciando" continua iniciando: pode estar parado numa pergunta do CLI (verificarPergunta olha a tela)
    j.estado = s.estado === 'encerrada' ? 'esperando você' : s.estado === 'precisa de você' && !j.pergunta ? 'iniciando' : s.estado;
    j.criadaEm = Date.now() - 3000;
    j.pasta = s.pasta || '';
    this.ativas.set(s.id, j);
    this.cerebro.sessaoReabrir(s.id, j.estado);
  }

  recolocarMensagens() {
    for (const m of this.cerebro.mensagensPendentes()) {
      const j = this.ativas.get(m.para);
      if (!j || j.caixa.some(([n]) => n === m.n)) continue;
      // a orientação de uma automação volta com o formato dela (e some se a automação saiu do palco)
      const daAutomacao = String(m.de).startsWith('auto:');
      const texto = daAutomacao ? this.automacoes?.refazerMensagem(m.de.slice(5))
        : this.revisorAtivo(m.de) === m.para ? this.paraRevisao(m.de, m.para, m.texto) : this.formatar(m.de, m.texto, m.para);
      if (!texto) { this.cerebro.mensagemEntregue(m.n); continue; }
      j.caixa.push([m.n, m.de, texto]);
    }
    for (const j of this.ativas.values()) this.tentarEntregar(j, 1000);
  }

  async motorCaiu() {
    if (this.reconectando) return;
    this.reconectando = true;
    for (const mapa of [this.ativas, this.auxiliares, this.terminais]) {
      for (const j of mapa.values()) {
        j.viva = false;
        for (const cb of j.ouvintes) cb(null);
      }
      mapa.clear();
    }
    this.avisar({ tipo: 'aviso', texto: 'o motor dos agentes caiu: reabrindo o time' });
    for (;;) {
      try { await this.motor.conectar(); await this.reconciliar(); break; } catch { await new Promise(r => setTimeout(r, 5000)); }
    }
    this.reconectando = false;
    for (const s of this.cerebro.sessoes(50)) this.avisar({ tipo: 'sessao', sessao: this.info(s.id) });
    this.avisarLigacoes([...this.ativas.keys()]);
  }

  // ---------------------------------------------------------------- abrir e fechar

  info(id) {
    const s = this.cerebro.sessao(id);
    if (!s) return null;
    s.posicao = this.cerebro.posicao(id);
    s.aberta = this.ativas.has(id);
    if (s.aberta) { s.estado = this.ativas.get(id).estado; s.pergunta = this.ativas.get(id).pergunta; }
    s.provedor = (s.provedor === 'gemini' ? 'antigravity' : s.provedor) || 'claude';
    s.palco = s.palco || 1;
    s.agente = this.provedores.adaptador(s.provedor)?.nome || s.provedor;
    s.nome_modelo = this.provedores.nomeModelo(s.provedor, s.modelo);
    s.tem_conversa = ['claude', 'codex'].includes(s.provedor);
    s.uso = this.uso?.resumo(id) || null; // tokens da conversa e de hoje (o chip do cartão)
    s.mcps = s.mcps ? JSON.parse(s.mcps) : null;
    return s;
  }

  async abrir({ nome, modelo = '', papel = 'livre', provedor = 'claude', retomar = null, posicao = null, ligarA = null, tarefa = null, mcps = undefined, palco = null }) {
    provedor = (provedor === 'gemini' ? 'antigravity' : provedor) || 'claude';
    nome = String(nome || '').replace(/[\x00-\x1f\x7f"]/g, '').trim().slice(0, 40) || 'agente';
    const adaptador = this.provedores.adaptador(provedor);
    if (!adaptador) throw new Error('agente desconhecido');
    modelo = String(modelo || '').trim();
    if (!this.provedores.modeloValido(provedor, modelo)) throw new Error('nome de modelo inválido');
    if (!Object.hasOwn(this.cfg.papeis, String(papel))) throw new Error('papel desconhecido');
    if (this.ativas.size >= this.cfg.max_janelas) throw new Error(`o Engram está no limite de ${this.cfg.max_janelas} janelas abertas ao mesmo tempo (abertas agora: ${this.ativas.size}). Para mudar o número: ${ONDE_MUDAR_LIMITE}`);
    if (retomar !== null) {
      if (!/^[0-9a-f-]{36}$/.test(retomar) || !this.cerebro.sessao(retomar)) throw new Error('sessão para retomar não encontrada');
      if (this.ativas.has(retomar)) throw new Error('essa sessão já está aberta');
    }
    const comando = this.provedores.comando(provedor);
    if (!comando) throw new Error(`o ${adaptador.nome} não está instalado neste computador (veja em Contas)`);
    const nomes = new Set([...this.ativas.keys()].map(i => this.cerebro.sessao(i).nome.toLowerCase()));
    for (let base = nome, n = 2; nomes.has(nome.toLowerCase()); n++) nome = `${base} ${n}`;
    const id = retomar || crypto.randomUUID();
    const pastaArquivos = this.arquivos.pasta(id);
    // Retomar volta na pasta em que a conversa começou (o Claude só acha a conversa a partir dela). Agente
    // que nunca recebeu mensagem não tem conversa gravada: aí começa uma nova, com o mesmo id e no mesmo lugar.
    let cwd = this.cfg.pasta_trabalho;
    let continuar = !!retomar;
    if (retomar) {
      const s = this.cerebro.sessao(retomar);
      const arq = provedor === 'claude' ? conversa.achar(retomar) : null;
      const onde = (arq && conversa.pastaDe(arq)) || s.pasta;
      if (onde && fs.existsSync(onde)) cwd = onde;
      if (provedor === 'claude') { if (!arq || cwd !== onde) continuar = false; }
      else if (!(['codex', 'antigravity'].includes(provedor) && s.externo)) continuar = false; // Codex e Antigravity (com o id da conversa) também retomam
    }

    let prompt = this.cfg.prompt_base.replaceAll('{nome}', nome).replaceAll('{pasta}', pastaArquivos)
      .replaceAll('{cerebro}', this.fonte.descricao()).replaceAll('{contexto}', this.cfg.contexto ? `\n${this.cfg.contexto}\n` : '');
    const extra = this.cfg.papeis[papel].prompt;
    if (extra) prompt += `\n${extra}\n`;
    const arqPrompt = path.join(this.caminhos.janelas, `${id}.prompt.md`);
    fs.writeFileSync(arqPrompt, prompt, 'utf8');
    const anterior = retomar ? this.cerebro.sessao(retomar) : null;
    // MCPs da janela: os que a pessoa escolheu ao abrir (guardados para quando ela for reaberta) ou todos os ativos
    let escolhidos = mcps === undefined ? (anterior?.mcps ? JSON.parse(anterior.mcps) : null) : Array.isArray(mcps) ? mcps.map(String) : null;
    const listaMcps = this.mcps ? await this.mcps.paraJanela(provedor, escolhidos) : [];
    const montado = adaptador.montar({
      id, nome, modelo, prompt, arqPrompt, retomar: continuar, externo: anterior?.externo || null,
      pastas: [pastaArquivos, ...this.pastasDoCerebro()],
      mcpUrl: `http://127.0.0.1:${this.cfg.porta}/mcp`, token: this.token, dirJanelas: this.caminhos.janelas,
      arquivoGanchos: this.arquivoGanchos, runtime: this.motor.runtime, chave: await this.provedores.chaveParaJanela(provedor),
      mcps: listaMcps, soEngram: !!this.mcps?.estado.so_engram,
      pluginSkills: this.skills?.pluginParaClaude() || null,
      pluginSkillsAntigravity: this.skills?.pluginParaAntigravity() || null,
    });
    const argv = [...comando, ...montado.argv];

    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !VARIAVEIS_FORA.has(k.toUpperCase())));
    const semProxy = (env.NO_PROXY || '').split(',').filter(Boolean);
    env.NO_PROXY = [...new Set([...semProxy, '127.0.0.1', 'localhost'])].join(',');
    Object.assign(env, montado.env, { ENGRAM_URL: `http://127.0.0.1:${this.cfg.porta}`, ENGRAM_TOKEN: this.token, ENGRAM_SESSAO: id });

    await this.motor.pedir('abrir', { id, argv, cwd, env, linhas: 28, colunas: 100 });
    const j = new Janela(id, this.motor, provedor);
    j.arquivosAssinatura = this.arquivos.assinatura(id);
    j.pasta = cwd;
    j.conversaNova = !continuar; // conversa que começa agora: as linhas do cérebro valem desde o início dela
    this.ativas.set(id, j);
    // o palco do cartão: o de quem o criou (o maestro), o que a tela pediu, o da janela retomada ou o que a tela mostra
    const noPalco = ligarA && this.cerebro.sessao(ligarA) ? this.cerebro.palcoDe(ligarA) : palcoValido(palco) || anterior?.palco || this.cerebro.palcoAtual();
    const mudouDePalco = !!anterior && (anterior.palco || 1) !== noPalco;
    this.cerebro.sessaoCriar(id, nome, provedor, modelo, papel, cwd, noPalco);
    this.cerebro.sessaoCerebroPrompt(id, this.fonte.chave); // o prompt que acabou de ser escrito descreve a fonte em uso
    // conversa nova: o nome dela é o deste prompt; retomada: continua o nome com que ela começou
    if (!continuar || !anterior?.nome_prompt) this.cerebro.sessaoNomePrompt(id, nome);
    if (mcps !== undefined) this.cerebro.sessaoMcps(id, escolhidos);
    const antiga = mudouDePalco ? null : this.cerebro.posicao(id); // retomada em outro palco: o lugar antigo era do outro
    if (posicao) this.cerebro.posicaoSalvar(id, ...posicaoValida(posicao));
    else if (!antiga) this.cerebro.posicaoSalvar(id, ...this.lugarLivre(ligarA, { proprio: id, palco: noPalco }));
    else if (this.sobrepoe(antiga, id)) {
      // retomada: enquanto ela estava encerrada, outro cartão ocupou o lugar dela. Vai para o lugar livre mais
      // perto; se estava num setor, para outro lugar dentro dele (continua no setor)
      const setor = this.cerebro.setorDe(id);
      const p = setor ? this.lugarNoSetor(setor, id) : null;
      if (p) this.cerebro.posicaoSalvar(id, p.x, p.y, p.w, p.h);
      else this.cerebro.posicaoSalvar(id, ...this.lugarLivre(null, { proprio: id, w: antiga.w, h: antiga.h, perto: antiga, palco: noPalco }));
    }
    if (ligarA && this.ativas.has(ligarA)) this.cerebro.conectar(ligarA, id);
    if (tarefa) {
      const infoT = {};
      this.enfileirar(j, tarefa[0], tarefa[1], null, infoT);
      try {
        if (this.ehMaestro(tarefa[0])) {
          const tn = this.tarefas?.delegou(tarefa[0], id, tarefa[1], infoT.n, null);
          const item = tn ? j.caixa.find(([n]) => n === infoT.n) : null;
          if (item) item[2] += `\n\n(No quadro do maestro esta é a tarefa ${tn}. Ao devolver o resultado, comece com "Tarefa ${tn}:".)`;
        }
      } catch { /* o quadro nunca atrapalha a entrega */ }
    }
    const info = this.info(id);
    if (retomar && !continuar) info.conversa_nova = true;
    this.avisar({ tipo: 'sessao', sessao: info });
    // as linhas só depois do cartão (a tela só desenha entre cartões que existem); vale também para a retomada
    this.avisarLigacoes([id]);
    return info;
  }

  /** Avisa a tela das ligações destas janelas com outras abertas (e da revisão de cada uma). */
  avisarLigacoes(ids) {
    const quais = new Set(ids);
    for (const c of this.cerebro.conexoes()) {
      if (!(quais.has(c.a) || quais.has(c.b)) || !this.ativas.has(c.a) || !this.ativas.has(c.b)) continue;
      this.avisar({ tipo: 'conexao', acao: 'criada', a: c.a, b: c.b });
      if (c.revisa) this.avisar({ tipo: 'conexao', acao: 'revisao', a: c.a, b: c.b, revisa: c.revisa });
    }
  }

  /**
   * O que já ocupa lugar num palco: os cartões ABERTOS dele (janela encerrada não ocupa: a posição dela fica
   * guardada só para quando for retomada), os setores com a etiqueta em cima, as automações e os post-its.
   * `ignorar`: ids de cartões ou de setores que não contam (os que estão sendo mudados de lugar).
   */
  ocupados({ ignorar = [], setores = true, extras = true, palco } = {}) {
    if (!palco) throw new Error('ocupados: diga de qual palco'); // sem padrão: o palco da tela não é o do agente
    const fora = new Set(ignorar);
    const r = [];
    for (const id of this.ativas.keys()) {
      if (fora.has(id) || this.cerebro.palcoDe(id) !== palco) continue;
      const p = this.cerebro.posicao(id);
      if (p) r.push({ x: p.x, y: p.y, w: p.w, h: p.h, tipo: 'cartao', id });
    }
    if (setores) for (const s of this.cerebro.setores(palco)) if (!fora.has(s.id)) r.push({ x: s.x, y: s.y - ETIQUETA_SETOR, w: s.w, h: s.h + ETIQUETA_SETOR, tipo: 'setor', id: s.id });
    if (extras && this.automacoes) {
      for (const a of this.automacoes.todas(palco)) r.push({ x: a.x, y: a.y, w: TAMANHO_AUTOMACAO[0], h: TAMANHO_AUTOMACAO[1], tipo: 'automacao' });
      for (const p of this.automacoes.postits(palco)) r.push({ x: p.x, y: p.y, w: TAMANHO_POSTIT[0], h: TAMANHO_POSTIT[1], tipo: 'postit' });
    }
    return r;
  }

  /** A posição guardada deste cartão bate em outro cartão aberto (ou numa automação ou post-it)? */
  sobrepoe(p, id) {
    return this.ocupados({ ignorar: [id], setores: false, palco: this.cerebro.palcoDe(id) }).some(o => toca(p, o, 0));
  }

  /**
   * Lugar livre para um cartão novo: ao lado de `pertoDe` (o maestro que o criou) ou de `perto` (a posição
   * antiga de quem foi retomado), sem encostar em cartão aberto, setor, automação ou post-it. Sem âncora,
   * perto do meio do time.
   */
  lugarLivre(pertoDe, { proprio = null, w = TAMANHO_PADRAO[0], h = TAMANHO_PADRAO[1], perto = null, palco = null } = {}) {
    palco ??= pertoDe ? this.cerebro.palcoDe(pertoDe) : proprio ? this.cerebro.palcoDe(proprio) : this.cerebro.palcoAtual();
    const ocupados = this.ocupados({ ignorar: proprio ? [proprio] : [], palco });
    const base = perto || (pertoDe ? this.cerebro.posicao(pertoDe) : null);
    const preferidos = base && !perto
      ? [[base.x + base.w + 140, base.y], [base.x + base.w + 140, base.y + h + 80], [base.x + base.w + 140, base.y - h - 80], [base.x, base.y + base.h + 120]]
      : [];
    const cartoes = ocupados.filter(o => o.tipo === 'cartao');
    const ancora = base ? centro(base) : cartoes.length ? centro(caixaDe(cartoes)) : { x: w / 2, y: h / 2 };
    return [...acharLugar(w, h, ancora, ocupados, { preferidos }), w, h];
  }

  // ---------------------------------------------------------------- palcos
  // Cada janela é de um palco. As ferramentas do maestro valem para o palco dele, e uma linha só liga cartões do
  // mesmo palco. Os nomes são únicos entre as janelas abertas de todos os palcos (assim ninguém fala com o errado).

  abertasNoPalco(palco) { return [...this.ativas.keys()].filter(id => this.cerebro.palcoDe(id) === palco); }

  /** Uma janela aberta deste palco, pelo nome ou id (null se não há ou se está em outro palco). */
  acharNoPalco(quem, palco) {
    const id = this.achar(quem);
    return id && this.cerebro.palcoDe(id) === palco ? id : null;
  }

  /** Por que o nome não serve neste palco: não existe ou está em outro palco. */
  naoAchei(quem, palco) {
    const id = this.achar(quem);
    if (id) return `${this.nomeDe(id)} está em outro palco (${this.cerebro.palcoNome(this.cerebro.palcoDe(id))}). Você só fala e mexe com quem está no seu palco (${this.cerebro.palcoNome(palco)}).`;
    return `Não há janela aberta chamada "${quem}". Veja os nomes com equipe.`;
  }

  /**
   * A pasta local do cérebro entra sempre nas pastas que o agente lê e grava (--add-dir), mesmo com o cérebro no
   * servidor: assim, se a pessoa trocar para o Local no meio da conversa, ele consegue gravar as notas lá.
   */
  pastasDoCerebro() {
    const p = this.fonte.tipo === 'pasta' ? this.fonte.pasta : this.cfg.cerebro?.pasta;
    if (!p) return [];
    try { fs.mkdirSync(p, { recursive: true }); } catch { return []; }
    return [p];
  }

  /**
   * O prompt da conversa descreve o cérebro de quando ela começou (o --append-system-prompt só vale na abertura).
   * Se a pessoa trocou a fonte depois, a próxima mensagem entregue leva o aviso, uma vez só.
   */
  avisoDeCerebro(id) {
    const s = this.cerebro.sessao(id);
    const chave = this.fonte.chave;
    if (!s || s.cerebro_prompt === chave) return '';
    this.cerebro.sessaoCerebroPrompt(id, chave);
    if (!s.cerebro_prompt) return ''; // sem registro (não deveria acontecer): só anota
    const onde = this.fonte.tipo === 'remoto' ? 'no servidor' : 'numa pasta deste computador';
    return `\n\n(Aviso do Engram: a pessoa trocou o cérebro, que agora fica ${onde}. ${this.fonte.descricao()} Vale a partir desta mensagem: esqueça o que o começo da conversa dizia sobre onde ficam as notas. Se não conseguir ler ou gravar lá, avise a pessoa.)`;
  }

  fechar(id) {
    if (!this.ativas.has(id)) throw new Error('janela não está aberta');
    this.cerebro.sessaoManter(id, false); // foi a pessoa que encerrou: não reabre sozinho
    this.motor.mandar('fechar', { id });
  }

  // ---------------------------------------------------------------- terminais de apoio

  /** Login, logout ou instalação de um CLI, num terminal que a pessoa vê e usa (fica no motor). */
  async abrirAuxiliar(argv, { aoFim = null } = {}) {
    if (this.auxiliares.size >= 3) throw new Error('já há terminais de conta abertos: feche um antes');
    const id = `aux-${crypto.randomUUID()}`;
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !VARIAVEIS_FORA.has(k.toUpperCase())));
    await this.motor.pedir('abrir', { id, argv, cwd: require('node:os').homedir(), env, linhas: 24, colunas: 100 });
    const j = new Janela(id, this.motor, 'aux');
    j.aoFim = aoFim;
    this.auxiliares.set(id, j);
    return id;
  }

  fecharAuxiliar(id) {
    if (this.auxiliares.has(id)) this.motor.mandar('fechar', { id });
  }

  janela(id) { return this.ativas.get(id) || this.auxiliares.get(id) || this.terminais.get(id); }

  /** Terminal da vista Código: um shell de verdade no motor, na pasta do projeto. */
  async abrirTerminal(argv, cwd) {
    if (this.terminais.size >= 8) throw new Error('já há 8 terminais abertos: feche um antes');
    const id = `cod-${crypto.randomUUID()}`;
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !VARIAVEIS_FORA.has(k.toUpperCase())));
    Object.assign(env, { TERM_PROGRAM: 'Engram', COLORTERM: 'truecolor' });
    await this.motor.pedir('abrir', { id, argv, cwd, env, linhas: 24, colunas: 100 });
    this.terminais.set(id, new Janela(id, this.motor, 'terminal'));
    return id;
  }

  fecharTerminal(id) { if (this.terminais.has(id)) this.motor.mandar('fechar', { id }); }

  // ---------------------------------------------------------------- terminal

  /** Um endereço local (http://localhost:5173...) apareceu na saída de um terminal: avisa a tela uma vez. */
  detectarEnderecos(id, texto) {
    this.caudas ||= new Map();
    this.enderecosVistos ||= new Map();
    // o código de controle vira espaço: o terminal posiciona o cursor em vez de quebrar a linha
    const limpo = ((this.caudas.get(id) || '') + texto).replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, ' ');
    this.caudas.set(id, limpo.slice(-300));
    const proprias = new Set([this.cfg.porta, this.cfg.motor_porta].map(String));
    for (const m of limpo.matchAll(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{2,5})(?:\/[^\s\\"'<>)\]]*)?/g)) {
      if (proprias.has(m[1])) continue;
      const url = m[0].replace('0.0.0.0', 'localhost').replace(/[.,;:]+$/, '');
      if (Date.now() - (this.enderecosVistos.get(url) || 0) < 10 * 60_000) continue;
      this.enderecosVistos.set(url, Date.now());
      this.avisar({ tipo: 'previa', evento: 'servidor', url, sessao: id });
    }
  }

  motorSaida(id, texto) {
    const j = this.janela(id);
    if (!j) return;
    if (texto.includes('://')) try { this.detectarEnderecos(id, texto); } catch { /* segue */ }
    j.guardar(texto);
    for (const cb of j.ouvintes) cb(texto);
  }

  motorFim(id) {
    const term = this.terminais.get(id);
    if (term) {
      this.terminais.delete(id);
      this.motor.mandar('esquecer', { id });
      term.viva = false;
      const texto = '\r\n\x1b[2m[terminal encerrado]\x1b[0m\r\n';
      term.guardar(texto);
      for (const cb of term.ouvintes) { cb(texto); cb(null); }
      this.avisar({ tipo: 'codigo', evento: 'terminal-fim', id });
      return;
    }
    const aux = this.auxiliares.get(id);
    if (aux) {
      this.auxiliares.delete(id);
      this.motor.mandar('esquecer', { id });
      aux.viva = false;
      const texto = '\r\n\x1b[2m[terminal encerrado]\x1b[0m\r\n';
      aux.guardar(texto);
      for (const cb of aux.ouvintes) { cb(texto); cb(null); }
      try { aux.aoFim?.(); } catch { /* segue */ }
      this.avisar({ tipo: 'auxiliar', id, fim: true });
      return;
    }
    const j = this.ativas.get(id);
    this.ativas.delete(id);
    this.motor.mandar('esquecer', { id });
    if (!j) return;
    j.viva = false;
    if (Date.now() - j.criadaEm < 60_000) {
      // fechou logo ao abrir: quase sempre é erro do CLI (opção, login, versão). Mostra o que ele disse.
      const disse = j.tela.texto(40).split('\n').map(l => l.trim()).filter(Boolean).slice(-6).join(' · ').slice(0, 400);
      const nome = this.cerebro.sessao(id)?.nome || 'a janela';
      require('./config').registrar(`${nome} (${j.provedor}) fechou logo ao abrir: ${disse}`);
      this.avisar({ tipo: 'aviso', texto: `${nome} fechou logo ao abrir${disse ? `: ${disse.slice(0, 200)}` : ''}` });
    }
    const texto = '\r\n\x1b[2m[janela encerrada]\x1b[0m\r\n';
    j.guardar(texto);
    for (const cb of j.ouvintes) { cb(texto); cb(null); }
    this.cerebro.sessaoEncerrar(id); // saiu com o app rodando (/exit, ×): conta como encerrada
    // a posição dela fica (dá para retomar pela gaveta); a de quem saiu do histórico, não
    try { this.cerebro.posicoesLimpar(); } catch { /* fica para a próxima */ }
    this.avisar({ tipo: 'sessao', sessao: this.info(id) });
  }

  escrever(id, texto) { this.janela(id)?.escrever(texto); }

  redimensionar(id, colunas, linhas) {
    const j = this.janela(id);
    if (!j || !j.viva) return;
    linhas = Math.max(5, Math.min(linhas | 0, 300));
    colunas = Math.max(20, Math.min(colunas | 0, 500));
    this.motor.mandar('tamanho', { id, linhas, colunas });
    j.tela.redimensionar(colunas, linhas);
    // quem só espelha este terminal (a janela Visualizar trabalho) precisa do mesmo tamanho, senão a tela embaralha
    this.avisar({ tipo: 'terminal', evento: 'tamanho', id, colunas, linhas });
  }

  /** Assina a saída do terminal: devolve o histórico e uma função para parar. */
  ouvir(id, cb) {
    const j = this.janela(id);
    if (!j) return null;
    j.ouvintes.add(cb);
    return { historico: j.historico(), colunas: j.tela.colunas, linhas: j.tela.linhas, parar: () => j.ouvintes.delete(cb) };
  }

  // ---------------------------------------------------------------- conversa e arquivos

  digitar(id, texto) {
    const j = this.ativas.get(id);
    if (!j) throw new Error('janela não está aberta');
    texto = String(texto || '').trim();
    if (!texto) throw new Error('mensagem vazia');
    return this.enfileirar(j, PESSOA, texto.slice(0, 20_000));
  }

  interromper(id) { this.ativas.get(id)?.escrever('\x1b'); }

  /** Antes do gancho de início, o agente pode estar parado numa pergunta do próprio CLI. */
  verificarPergunta(id, j) {
    if (j.estado !== 'iniciando' || Date.now() - j.criadaEm < 2500) return;
    const tela = j.tela.texto(40);
    let pergunta = null;
    if (/trust this folder|trust the files in this folder|Do you trust/i.test(tela)) {
      pergunta = { tipo: 'confiar_pasta', texto: 'O Claude pergunta se pode confiar na pasta de trabalho.', pasta: this.cfg.pasta_trabalho };
    } else if (Date.now() - j.criadaEm > 20_000 && /Enter to confirm|Esc to cancel|\(y\/n\)|Press Enter|Do you want to|❯\s*\d+\./i.test(tela)) {
      // só com cara de pergunta na tela: subir devagar (MCP lento, rede) não é pergunta
      pergunta = { tipo: 'terminal', texto: 'O agente está esperando uma resposta no terminal.' };
    }
    if (!pergunta) return;
    j.pergunta = pergunta;
    j.estado = 'precisa de você';
    this.cerebro.sessaoEstado(id, j.estado);
    this.avisar({ tipo: 'evento', sessao_id: id, evento: 'Pergunta', estado: j.estado, pergunta, toques: [] });
  }

  /**
   * Claude Code 2.1.330 em diante: ao abrir, cada pasta do --add-dir pede confiança ("Adding a new directory"),
   * com "No, exit" já marcado e a resposta valendo só para aquela sessão (volta em toda retomada). As pastas que
   * o Engram passa são dele: a de arquivos do agente e o cérebro local que a pessoa escolheu. Para essas, ele
   * mesmo desce até "Yes, add it", confere o marcador e só então dá Enter. Qualquer outra pasta continua sendo
   * pergunta para a pessoa. Devolve true enquanto cuida da pergunta (o resto do vigia espera).
   */
  confiarPastaDoEngram(id, j) {
    if (j.confiandoExtra && Date.now() - j.confiandoExtra < 1200) return true; // a tecla anterior ainda está chegando
    const tela = j.tela.texto(30);
    if (!/Adding a new directory:/i.test(tela) || !/worked here before/i.test(tela)) { j.confiandoExtra = 0; return false; }
    const pasta = pastaDoPedido(tela);
    if (!pasta || !this.pastaDoEngram(pasta)) return false;
    const linhas = tela.split('\n');
    const marcada = linhas.find(l => /^\s*[>❯›]\s+\S/.test(l)) || '';
    const temSim = linhas.some(l => /^\s*[>❯›]?\s*Yes, add it\b/i.test(l));
    if (!temSim) return false; // formato que não conheço: fica para a pessoa
    j.confiandoExtra = Date.now();
    if (/Yes, add it/i.test(marcada)) {
      j.escrever('\r');
      this.cerebro.registrarEvento(id, 'Pergunta', null, `pasta do Engram liberada sozinha: ${pasta}`);
    } else {
      j.escrever('\x1b[B'); // desce de "No, exit" para "Yes, add it"; na próxima volta confere o marcador e dá Enter
    }
    return true;
  }

  /** A pasta é uma das que o Engram passa ao agente no --add-dir (a de arquivos dele ou a do cérebro, como em pastasDoCerebro)? */
  pastaDoEngram(pasta) {
    const p = normalPasta(pasta);
    const donas = [this.arquivos?.base, this.fonte?.tipo === 'pasta' ? this.fonte.pasta : null, this.cfg?.cerebro?.pasta].filter(Boolean).map(normalPasta);
    return donas.some(d => p === d || p.startsWith(`${d}\\`));
  }

  /** Responde "sim, confio nesta pasta" na pergunta do Claude (só se ela ainda estiver na tela). */
  confiarPasta(id) {
    const j = this.ativas.get(id);
    if (!j || j.pergunta?.tipo !== 'confiar_pasta') throw new Error('não há pergunta de confiança aberta');
    if (!/trust this folder|trust the files in this folder|Do you trust/i.test(j.tela.texto(40))) throw new Error('a pergunta já saiu da tela');
    j.escrever('\x1b[B'); // desce para "Yes, I trust this folder"
    setTimeout(() => j.escrever('\r'), 250);
    j.pergunta = null;
    j.estado = 'iniciando';
    j.criadaEm = Date.now();
    j.prontaEm = Date.now(); // depois de confiar, o CLI ainda carrega (MCPs, plugin): a entrega espera a tela montar
    this.avisar({ tipo: 'evento', sessao_id: id, evento: 'Pergunta', estado: 'iniciando', pergunta: null, toques: [] });
  }

  /**
   * A pergunta que o CLI está fazendo agora, lida da tela (o que ele pergunta, o detalhe e as opções): é o que
   * a vista Conversa mostra com botões. Roda a cada volta do vigia, para todos os agentes.
   * Nos agentes com ganchos também acerta o estado em dois casos que os ganchos não avisam: um diálogo que
   * aparece sozinho no meio da sessão, e a pergunta que some (respondida no terminal ou recusada).
   */
  olharPergunta(id, j, a) {
    if (j.pergunta?.tipo === 'confiar_pasta') return;
    const agora = Date.now();
    const tela = j.tela.texto(40);
    const lida = lerPergunta(tela);
    const trabalhando = () => TRABALHANDO.test(tela.split('\n').slice(-8).join('\n'));
    const mudar = (estado, pergunta) => {
      j.estado = estado;
      j.pergunta = pergunta;
      j.perguntaAssinatura = pergunta ? JSON.stringify(pergunta) : null;
      this.cerebro.sessaoEstado(id, estado);
      this.avisar({ tipo: 'evento', sessao_id: id, evento: 'Pergunta', estado, pergunta, toques: [] });
      if (LIVRE.has(estado)) this.tentarEntregar(j, 600);
    };
    if (lida) {
      const p = { tipo: 'terminal', texto: lida.titulo || 'O agente está esperando uma resposta no terminal.', titulo: lida.titulo, detalhe: lida.detalhe, opcoes: lida.opcoes, rodape: lida.rodape };
      j.perguntaLida = true;
      j.semPerguntaDesde = 0;
      if (j.estado !== 'precisa de você') {
        if (!a.ganchos) return; // sem ganchos, quem decide o estado é o estadoPelaTela (que também lê a pergunta)
        // um diálogo que os ganchos não avisaram: só vale com a tela parada há um instante, e não logo depois de uma resposta
        if (tela !== j.telaPergunta) { j.telaPergunta = tela; j.telaPerguntaEm = agora; return; }
        if (agora - j.telaPerguntaEm < 1500 || agora - (j.respondeuEm || 0) < 2500) return;
        mudar('precisa de você', p);
        return;
      }
      if (JSON.stringify(p) !== j.perguntaAssinatura) mudar('precisa de você', p);
      return;
    }
    j.telaPergunta = null;
    if (!a.ganchos) return;
    if (j.estado === 'precisa de você') {
      // o gancho avisou, mas não há pergunta legível na tela. Se nunca houve e a tela é a mesma de quando ele
      // avisou, o diálogo ainda está lá (num formato que não sei ler): fica como está. Se a tela mudou, a
      // pergunta foi respondida no terminal ou recusada: o estado passa a sair da tela.
      if (!j.perguntaLida) {
        if (j.telaPrecisa === undefined) { j.telaPrecisa = tela; return; }
        if (tela === j.telaPrecisa) return;
      }
      if (!j.semPerguntaDesde) { j.semPerguntaDesde = agora; return; }
      if (agora - j.semPerguntaDesde > 2000) mudar(trabalhando() ? 'trabalhando' : 'esperando você', null);
      return;
    }
    j.semPerguntaDesde = 0;
    // depois de uma resposta dada pela Conversa: se nenhum gancho chegar e a tela mostrar o agente parado,
    // ele recusou ou cancelou (o Claude não avisa o fim do turno nesse caso)
    if (j.aposResposta && OCUPADO_ESTADO.has(j.estado)) {
      if (trabalhando()) j.aposResposta = agora;
      else if (agora - j.aposResposta > 4000) { j.aposResposta = 0; mudar('esperando você', null); }
    }
  }

  /** Responde a pergunta do CLI pela Conversa: uma opção (pelo número) ou uma tecla (enter, esc, setas...). */
  async responder(id, { opcao, tecla } = {}) {
    const j = this.ativas.get(id);
    if (!j) throw new Error('janela não está aberta');
    const espera = ms => new Promise(r => setTimeout(r, ms));
    const ler = () => lerPergunta(j.tela.texto(40));
    if (tecla !== undefined) {
      const bytes = TECLAS[String(tecla)];
      if (!bytes) throw new Error('tecla desconhecida');
      j.escrever(bytes);
      if (tecla === 'enter' || tecla === 'esc' || tecla === 'sim' || tecla === 'nao') this.respondida(id, j);
      return { ok: true };
    }
    const n = Number(opcao);
    let p = ler();
    if (!p || !p.opcoes.some(o => o.n === n)) throw new Error('essa pergunta já saiu da tela');
    // anda com as setas até a opção e confere na tela antes do Enter: nunca confirma a opção errada
    for (let passo = 0; passo < 24; passo++) {
      const atual = p.opcoes.find(o => o.atual);
      if (!atual) throw new Error('não achei a opção marcada: responda no terminal');
      if (atual.n === n) { j.escrever('\r'); this.respondida(id, j); return { ok: true }; }
      j.escrever(atual.n < n ? TECLAS.baixo : TECLAS.cima);
      let mudou = false;
      for (let k = 0; k < 12 && !mudou; k++) { // espera a tela redesenhar (até ~0,7 s)
        await espera(60);
        const q = ler();
        if (!q || !q.opcoes.some(o => o.n === n)) throw new Error('a pergunta mudou: confira no terminal');
        if (q.opcoes.find(o => o.atual)?.n !== atual.n) { p = q; mudou = true; }
      }
      if (!mudou) throw new Error('a opção não se moveu: responda no terminal');
    }
    throw new Error('não consegui marcar essa opção: responda no terminal');
  }

  respondida(id, j) {
    j.respondeuEm = Date.now();
    j.pergunta = null;
    j.perguntaAssinatura = null;
    j.perguntaLida = false;
    j.telaPrecisa = undefined;
    j.semPerguntaDesde = 0;
    const a = this.provedores.adaptador(j.provedor) || {};
    if (a.ganchos && j.estado === 'precisa de você') {
      j.estado = 'pensando';
      j.aposResposta = Date.now();
      this.cerebro.sessaoEstado(id, j.estado);
    }
    this.avisar({ tipo: 'evento', sessao_id: id, evento: 'Pergunta', estado: j.estado, pergunta: null, toques: [] });
  }

  /** Agentes sem ganchos (Codex, Gemini, OpenCode): o estado sai da tela e do aviso de fim de turno. */
  estadoPelaTela(id, j, a) {
    const agora = Date.now();
    const tela = j.tela.texto(30);
    if (tela !== j.telaAnterior) { j.telaAnterior = tela; j.telaMudouEm = agora; }
    const fim = tela.split('\n').slice(-12).join('\n');
    let novo;
    if ((a.pergunta || PERGUNTA_TELA).test(fim) || lerPergunta(tela)) novo = 'precisa de você';
    else if (a.ocupado && a.ocupado.test(fim)) novo = 'trabalhando';
    else if (agora < j.ocupadoAte || agora - j.telaMudouEm < 2500 || agora - j.criadaEm < 4000) return;
    else novo = j.teveTurno ? 'esperando você' : 'pronta';
    if (novo !== j.estado) this.mudarEstado(id, j, novo, 'Tela');
  }

  mudarEstado(id, j, novo, origem) {
    const antes = j.estado;
    j.estado = novo;
    j.pergunta = novo === 'precisa de você' ? { tipo: 'terminal', texto: 'O agente está esperando uma resposta no terminal.' } : null;
    j.perguntaAssinatura = null; // o olharPergunta completa com as opções lidas da tela
    this.cerebro.sessaoEstado(id, novo);
    this.avisar({ tipo: 'evento', sessao_id: id, evento: origem, estado: novo, pergunta: j.pergunta, toques: [] });
    if (LIVRE.has(novo)) this.tentarEntregar(j, antes === 'iniciando' ? 1500 : 600);
  }

  /** Onde o CLI grava a conversa desta janela (para a vista Conversa). */
  acharConversa(id, j) {
    if (j.provedor === 'claude') return conversa.achar(id);
    if (j.provedor !== 'codex' || Date.now() - j.procurouEm < 4000) return null;
    j.procurouEm = Date.now();
    const s = this.cerebro.sessao(id);
    let p = s?.externo ? conversaCodex.acharPorExterno(s.externo) : null;
    if (!p) { p = conversaCodex.acharPelaMarca(id, j.criadaEm); if (p) this.registrarExterno(id, conversaCodex.externoDoCaminho(p)); }
    return p;
  }

  lerConversa(id, desde, ultimos) {
    const j = this.ativas.get(id);
    const s = this.cerebro.sessao(id);
    const provedor = j?.provedor || s?.provedor || 'claude';
    let caminho = j?.conversa || null;
    if (!caminho) caminho = provedor === 'claude' ? conversa.achar(id) : provedor === 'codex' && s?.externo ? conversaCodex.acharPorExterno(s.externo) : null;
    if (!caminho) return { itens: [], ate: 0 };
    return (provedor === 'codex' ? conversaCodex : conversa).ler(caminho, desde, ultimos);
  }

  registrarExterno(id, externo) {
    if (/^[0-9a-f-]{36}$/.test(String(externo || '')) && this.cerebro.sessao(id)?.externo !== externo) this.cerebro.sessaoExterno(id, externo);
  }

  vigiar() {
    for (const [id, j] of this.ativas) {
      const a = this.provedores.adaptador(j.provedor) || {};
      let cuidando = false; // a pergunta de confiança numa pasta do próprio Engram: ele mesmo responde
      try { cuidando = j.provedor === 'claude' && this.confiarPastaDoEngram(id, j); } catch { /* segue como pergunta normal */ }
      if (!cuidando) {
        if (a.ganchos) { this.verificarPergunta(id, j); this.conferirEntrega(id, j); } else this.estadoPelaTela(id, j, a);
        try { this.olharPergunta(id, j, a); } catch { /* tela estranha: fica para a próxima volta */ }
      }
      if (!j.conversa) j.conversa = this.acharConversa(id, j);
      else if (j.conversa.endsWith('.zst')) {
        // conversa compactada pelo Codex: se ele voltar a escrever, passa a valer a aberta (.jsonl)
        const aberta = this.acharConversa(id, j);
        if (aberta && aberta !== j.conversa) { j.conversa = aberta; j.conversaTam = -1; j.conversaLida = undefined; j.conversaTrocou = true; }
      }
      if (j.conversa) {
        let tam = j.conversaTam;
        try { tam = fs.statSync(j.conversa).size; } catch { /* some e volta */ }
        if (tam !== j.conversaTam) {
          j.conversaTam = tam;
          this.medirUso(id, j);
          this.avisar({ tipo: 'conversa', sessao_id: id, tam, ...(j.conversaTrocou ? { trocou: true } : {}) });
          j.conversaTrocou = false;
          try { this.lerFerramentas(id, j); } catch { /* linha estranha: fica para a próxima */ }
        }
      }
      const assinatura = this.arquivos.assinatura(id);
      if (assinatura !== j.arquivosAssinatura) {
        const antes = new Set(j.arquivosAssinatura.split('\n').map(l => l.split('|')[0]));
        j.arquivosAssinatura = assinatura;
        const novos = assinatura.split('\n').filter(Boolean).map(l => l.split('|')[0]).filter(n => !antes.has(n));
        this.avisar({ tipo: 'arquivos', sessao_id: id, entregues: novos });
      }
    }
  }

  /**
   * O medidor de uso lê o que a conversa ganhou desde a última vez (tokens de entrada e saída, cache e custo
   * estimado) e avisa a tela. Conversa maior que uma volta de leitura continua na volta seguinte.
   */
  medirUso(id, j) {
    if (!this.uso || !j.conversa) return;
    this.uso.atualizar(id, j.provedor, j.conversa).then(mudou => {
      if (mudou) this.avisar({ tipo: 'uso', sessao_id: id, uso: this.uso.resumo(id) });
      const e = this.uso.sessoes.get(id);
      if (e && !j.conversa.endsWith('.zst') && e.lido < j.conversaTam && !e.incompleto && !e.lendo) setTimeout(() => this.medirUso(id, j), 50);
    }).catch(() => {});
  }

  // ---------------------------------------------------------------- time (usado pelo MCP)

  achar(quem) {
    quem = String(quem || '').trim();
    if (this.ativas.has(quem)) return quem;
    for (const id of this.ativas.keys()) if (this.cerebro.sessao(id)?.nome.toLowerCase() === quem.toLowerCase()) return id;
    return null;
  }

  descricao(id) {
    const s = this.cerebro.sessao(id) || {};
    const j = this.ativas.get(id);
    const d = {
      nome: s.nome,
      papel: this.cfg.papeis[s.papel]?.nome || s.papel,
      agente: this.provedores.adaptador(s.provedor || 'claude')?.nome || s.provedor,
      modelo: this.provedores.nomeModelo(s.provedor || 'claude', s.modelo),
      estado: j ? j.estado : 'encerrada',
      mensagens_na_fila: j ? j.caixa.length : 0,
    };
    const setor = this.cerebro.setorDe(id);
    if (setor) d.setor = setor.nome;
    return d;
  }

  /** Quem mandou uma mensagem, do jeito que o agente entende: o nome do colega, "a pessoa" ou a automação. */
  nomeRemetente(de) {
    if (de === PESSOA) return 'a pessoa';
    if (String(de).startsWith('auto:')) {
      const a = this.automacoes?.pegar(String(de).slice(5));
      return a ? `automação "${a.nome}"` : 'uma automação';
    }
    return this.cerebro.sessao(de)?.nome || 'um colega que já saiu';
  }

  /**
   * O que um colega está fazendo, para o equipe: a tarefa (o começo da última mensagem que chegou a ele e quem
   * mandou), há quanto tempo está nela ou parado, e a última ferramenta que usou.
   */
  fazendo(id) {
    const j = this.ativas.get(id);
    if (!j) return {};
    const agora = Date.now();
    const d = {};
    if (j.estadoDesde) d.no_estado_ha = haQuanto(agora - j.estadoDesde);
    const m = this.cerebro.ultimaRecebida(id);
    if (m) {
      // o assunto é o texto da pessoa ou do colega, sem o bloco dos anexos nem a nota do setor que o Engram põe no fim
      const corpo = String(m.texto).split(FIM_DO_ENGRAM)[0];
      const t = { de: this.nomeRemetente(m.de), assunto: assunto(corpo), ha: haQuanto(agora - new Date(m.entregue).getTime()) };
      if (OCUPADO_ESTADO.has(j.estado) || j.estado === 'precisa de você') d.tarefa = t; else d.ultima_tarefa = t;
    }
    const acao = this.ultimaAcaoDe(id, j);
    if (acao) d.ultima_acao = { o_que: acao.o_que, ha: haQuanto(agora - acao.quando) };
    return d;
  }

  /** A última ferramenta: pelo gancho (Claude) ou pela conversa (Codex). Caminhos da pasta do agente ficam curtos. */
  ultimaAcaoDe(id, j) {
    const ev = this.cerebro.ultimoEvento(id, 'PreToolUse');
    let acao = ev ? { o_que: ev.resumo || ev.ferramenta || '', quando: new Date(ev.quando).getTime() } : null;
    if (j.ultimaAcao && (!acao || j.ultimaAcao.quando > acao.quando)) acao = { ...j.ultimaAcao };
    if (!acao?.o_que) return null;
    const pasta = String(j.pasta || '');
    if (pasta.length > 3) {
      const comBarra = pasta.replace(/[\\/]+$/, '') + path.sep;
      acao.o_que = acao.o_que.split(comBarra).join('').split(comBarra.replace(/\\/g, '/')).join('');
    }
    acao.o_que = assunto(mascarar(acao.o_que), 140);
    return acao;
  }

  /** Os setores do palco com quem está em cada um (para o maestro distribuir o trabalho). */
  setoresDoPalco(palco) {
    const setores = this.cerebro.setores(palco);
    if (!setores.length) return null;
    const membros = new Map(setores.map(s => [s.id, []]));
    for (const id of this.abertasNoPalco(palco)) { const s = this.cerebro.setorDe(id, setores); if (s) membros.get(s.id).push(this.nomeDe(id)); }
    return setores.map(s => ({ nome: s.nome, ...(s.instrucao ? { instrucao: s.instrucao } : {}), agentes: membros.get(s.id).sort() }));
  }

  /** Lugar livre para um cartão novo dentro do setor; se não couber, o setor cresce para baixo. */
  lugarNoSetor(setor, proprio = null) {
    const [w, h] = TAMANHO_PADRAO, folga = 50;
    // cartões abertos, automações e post-its (encerrado não conta; `proprio` é o cartão que está procurando lugar)
    const ocupados = this.ocupados({ ignorar: proprio ? [proprio] : [], setores: false, palco: setor.palco || 1 });
    const livre = (x, y) => !ocupados.some(p => toca({ x, y, w, h }, p, 30));
    for (let y = setor.y + folga; y + h <= setor.y + setor.h - folga / 2; y += 60) {
      for (let x = setor.x + folga; x + w <= setor.x + setor.w - folga / 2; x += 60) if (livre(x, y)) return { x, y, w, h };
    }
    // não coube: abre espaço embaixo, sem cortar ninguém
    const fundo = Math.max(setor.y + setor.h, ...ocupados.filter(p => p.tipo === 'cartao' && p.x < setor.x + setor.w && p.x + p.w > setor.x && p.y < setor.y + setor.h).map(p => p.y + p.h));
    const y = fundo + 40;
    const novo = { ...setor, w: Math.max(setor.w, w + 2 * folga), h: y + h + folga - setor.y };
    this.cerebro.setorSalvar(novo);
    this.avisar({ tipo: 'setor', acao: 'salvo', setor: novo });
    return { x: setor.x + folga, y, w, h };
  }

  /** Com quem esta janela fala (ligações com janelas abertas), pelos nomes. */
  falaCom(id) {
    return [...this.cerebro.conectados(id)].filter(c => this.ativas.has(c)).map(c => this.cerebro.sessao(c)?.nome).filter(Boolean).sort();
  }

  equipe(id) {
    const comLigacoes = c => ({ ...this.descricao(c), ...this.fazendo(c), fala_com: this.falaCom(c) });
    const colegas = [...this.cerebro.conectados(id)].sort().filter(c => this.ativas.has(c)).map(comLigacoes);
    const r = { voce: this.descricao(id), colegas, sua_pasta_de_arquivos: this.arquivos.pasta(id) };
    if (this.cerebro.sessao(id)?.papel === 'maestro') {
      const palco = this.cerebro.palcoDe(id);
      const aqui = this.abertasNoPalco(palco);
      r.seu_palco = `${this.cerebro.palcoNome(palco)}, com ${aqui.length} ${aqui.length === 1 ? 'janela aberta' : 'janelas abertas'}. Suas ferramentas valem só para este palco; quem você cria nasce nele.`;
      r.janelas_abertas = `${this.ativas.size} de ${this.cfg.max_janelas}, somando todos os palcos (o limite é da pessoa, em ${ONDE_MUDAR_LIMITE})`;
      r.mapa_do_palco = 'Para ver onde está cada cartão, setor, automação e post-it (x, y, largura, altura), use a ferramenta palco.';
      // o maestro enxerga o palco inteiro, para ligar quem ainda não está no time
      const ligados = this.cerebro.conectados(id);
      const fora = aqui.filter(c => c !== id && !ligados.has(c)).sort().map(comLigacoes);
      if (fora.length) r.no_palco_sem_ligacao_com_voce = fora;
      const setores = this.setoresDoPalco(palco);
      if (setores) r.setores = { explicacao: 'Áreas que a pessoa desenhou no palco. Mande cada tarefa para quem é do setor certo; quem recebe já vê a instrução do setor dele.', lista: setores };
    }
    const meu = this.cerebro.setorDe(id);
    if (meu?.instrucao) r.instrucao_do_seu_setor = meu.instrucao;
    const automacoes = this.automacoes?.paraEquipe(id);
    if (automacoes) r.automacoes_ligadas_a_voce = automacoes;
    const revisor = this.revisorAtivo(id);
    if (revisor) r.suas_entregas_passam_por = `${this.cerebro.sessao(revisor).nome} (tudo o que você mandar vai para ele revisar antes de seguir)`;
    const revisados = this.cerebro.revisados(id).filter(x => this.ativas.has(x)).map(x => this.cerebro.sessao(x).nome);
    if (revisados.length) r.voce_revisa_as_entregas_de = revisados;
    return r;
  }

  /** O mapa do palco para o maestro: onde está cada cartão aberto, setor, automação e post-it. */
  palco(de) {
    if (!this.ehMaestro(de)) return 'Só o maestro vê o mapa do palco.';
    const r = n => Math.round(Number(n) || 0);
    const palco = this.cerebro.palcoDe(de);
    const setores = this.cerebro.setores(palco);
    const membros = new Map(setores.map(s => [s.id, []]));
    const abertas = this.abertasNoPalco(palco);
    const cartoes = abertas.map(id => {
      const p = this.cerebro.posicao(id) || { x: 0, y: 0, w: TAMANHO_PADRAO[0], h: TAMANHO_PADRAO[1] };
      const s = this.cerebro.sessao(id) || {};
      const c = { nome: s.nome, papel: this.cfg.papeis[s.papel]?.nome || s.papel, x: r(p.x), y: r(p.y), w: r(p.w), h: r(p.h) };
      if (id === de) c.voce = true;
      const st = this.cerebro.setorDe(id, setores);
      if (st) { c.setor = st.nome; membros.get(st.id).push(s.nome); }
      return c;
    }).sort((a, b) => a.y - b.y || a.x - b.x);
    const mapa = {
      explicacao: 'Coordenadas em pixels do palco: x cresce para a direita e y para baixo; x, y é o canto de cima à esquerda e w, h a largura e a altura. Um agente faz parte de um setor quando o centro do cartão está dentro do retângulo do setor; a etiqueta com o nome do setor ocupa uns 70 px acima dele. Cartão novo nasce com 700 × 470. Janelas encerradas não aparecem (não ocupam lugar), nem o que está nos outros palcos. Para mover cartões, só quando a pessoa pedir, use organizar_palco no modo lista com estes mesmos x, y. Automações e post-its têm tamanho aproximado.',
      palco: this.cerebro.palcoNome(palco),
      janelas_abertas: `${abertas.length} neste palco; ${this.ativas.size} de ${this.cfg.max_janelas} somando todos os palcos`,
      cartoes,
      setores: setores.map(s => ({ nome: s.nome, cor: Object.keys(CORES_SETOR).find(k => CORES_SETOR[k] === s.cor) || s.cor, x: r(s.x), y: r(s.y), w: r(s.w), h: r(s.h), agentes: membros.get(s.id).sort() })),
      automacoes: (this.automacoes?.todas(palco) || []).map(a => ({ nome: a.nome, x: r(a.x), y: r(a.y), w: TAMANHO_AUTOMACAO[0], h: TAMANHO_AUTOMACAO[1], ligada_a: a.alvo ? (this.ativas.has(a.alvo) ? this.nomeDe(a.alvo) : `${this.nomeDe(a.alvo)} (encerrado)`) : null })),
      postits: (this.automacoes?.postits(palco) || []).map(p => ({ texto: assunto(p.texto, 80), x: r(p.x), y: r(p.y), w: TAMANHO_POSTIT[0], h: TAMANHO_POSTIT[1] })),
    };
    const tudo = [...mapa.cartoes, ...mapa.automacoes, ...mapa.postits, ...mapa.setores.map(s => ({ ...s, y: s.y - ETIQUETA_SETOR, h: s.h + ETIQUETA_SETOR }))];
    if (tudo.length) { const c = caixaDe(tudo); mapa.area_ocupada = { x: r(c.x), y: r(c.y), w: r(c.w), h: r(c.h) }; }
    return JSON.stringify(mapa, null, 2);
  }

  /** O revisor deste agente, se a ligação de revisão existe e ele está aberto. */
  revisorAtivo(id) {
    const r = this.cerebro.revisorDe(id);
    return r && this.ativas.has(r) && this.cerebro.conectados(id).has(r) ? r : null;
  }

  /** Mensagem que leva ao revisor o que o agente entregou, junto com a tarefa que ele recebeu. */
  paraRevisao(de, revisor, texto, queria = null) {
    const r = this.descricao(de);
    const t = this.cerebro.ultimaTarefa(de, [revisor, de, PESSOA]);
    const dono = t && this.ativas.has(t.de) ? t.de : queria;
    const nomeDono = dono ? this.cerebro.sessao(dono)?.nome : null;
    const partes = [`[Engram · revisão · entrega de ${r.nome} (${r.papel}, ${r.modelo})]`];
    if (t) partes.push(`Tarefa que ${this.cerebro.sessao(t.de)?.nome || 'um colega'} passou a ${r.nome}:\n«${t.texto.length > 6000 ? `${t.texto.slice(0, 6000)}…` : t.texto}»`);
    if (queria && queria !== dono) partes.push(`(${r.nome} quis mandar isto a ${this.cerebro.sessao(queria)?.nome}.)`);
    partes.push(`O que ${r.nome} entregou:\n${texto}`);
    let dica = `Você revisa as entregas de ${r.nome}. Confira antes de passar adiante.`;
    if (nomeDono) {
      dica += ` Se estiver certo, entregue a ${nomeDono} com mcp__engram__enviar para="${nomeDono}", com o resultado e o que você conferiu.`;
      if (!this.cerebro.conectados(revisor).has(dono)) dica += ` (Você não está ligado a ${nomeDono} no palco: peça à pessoa para ligar vocês dois.)`;
    } else dica += ' Não achei de quem veio a tarefa: entregue a quem pediu.';
    dica += ` Se precisar corrigir, devolva a ${r.nome} com para="${r.nome}" dizendo o quê, uma vez só; na segunda, entregue com as ressalvas. Se for uma dúvida e não uma entrega, responda você ou leve a quem pediu.`;
    partes.push(`(${dica})`);
    return partes.join('\n\n');
  }

  /**
   * Manda uma mensagem a um colega ligado, ou ao setor inteiro (para = o nome do setor: vai para cada membro
   * ligado a quem envia). `arquivos`: caminhos que vão junto, copiados para a pasta recebidos/ de quem recebe.
   */
  enviar(de, para, texto, arquivos = []) {
    texto = String(texto || '').trim();
    const anexos = this.conferirAnexos(de, arquivos);
    if (anexos.erro) return anexos.erro;
    if (!texto && anexos.lista.length) texto = anexos.lista.length > 1 ? 'Seguem os arquivos.' : 'Segue o arquivo.';
    const palco = this.cerebro.palcoDe(de);
    const achado = this.achar(para);
    const alvo = achado && this.cerebro.palcoDe(achado) === palco ? achado : null; // quem está em outro palco não é colega
    // a devolutiva de uma automação ligada a este agente (um colega ligado com o mesmo nome tem a preferência)
    const automacao = this.automacoes?.daJanela(de, para);
    if (automacao && !(alvo && this.cerebro.conectados(de).has(alvo))) {
      const citados = anexos.lista.length ? `\n\n[Arquivos citados]\n${anexos.lista.map(a => `- ${a}`).join('\n')}` : '';
      return this.automacoes.devolver(automacao, de, texto + citados);
    }
    const setor = this.setorPorNome(para, palco);
    if (!alvo) {
      if (setor) return this.enviarAoSetor(de, setor, texto, anexos.lista);
      if (achado) return this.naoAchei(para, palco);
      return `Não há janela aberta (nem setor) chamada "${para}". Veja os nomes com equipe.`;
    }
    const r = this.entregarA(de, alvo, texto, anexos.lista).texto;
    // um agente e um setor com o mesmo nome: o agente vence, mas quem mandou fica sabendo
    return setor ? `${r} (Há também um setor chamado ${setor.nome}, mas a mensagem foi só para o agente. Para falar com o setor inteiro, peça à pessoa para mudar um dos dois nomes.)` : r;
  }

  setorPorNome(nome, palco) {
    const n = String(nome || '').trim().toLowerCase();
    return n ? this.cerebro.setores(palco).find(s => s.nome.toLowerCase() === n) || null : null;
  }

  /**
   * Confere os arquivos antes de mandar qualquer coisa: { lista: caminhos absolutos } ou { erro }.
   * O agente já lê esses arquivos com as próprias ferramentas; a trava é contra ele ser induzido (por um
   * conteúdo hostil que leu) a passar adiante o que é do Engram ou um segredo, e contra encher o disco.
   */
  conferirAnexos(de, arquivos) {
    const pedidos = (Array.isArray(arquivos) ? arquivos : arquivos ? [arquivos] : []).map(a => String(a ?? '').trim()).filter(Boolean);
    if (pedidos.length > MAX_ANEXOS) return { erro: `Não mandei nada: são ${pedidos.length} arquivos, e o máximo é ${MAX_ANEXOS} por mensagem.` };
    const base = this.ativas.get(de)?.pasta || this.cfg.pasta_trabalho || '';
    const limite = this.cfg.max_arquivo_mb * 1048576;
    const lista = [];
    let soma = 0;
    for (const a of pedidos) {
      const abs = path.resolve(base, a); // caminho relativo vale a partir da pasta em que o agente roda
      let st;
      try { st = fs.statSync(abs); } catch { return { erro: `Não mandei nada: o arquivo ${abs} não existe.` }; }
      if (!st.isFile()) return { erro: `Não mandei nada: ${abs} não é um arquivo.` };
      // confere o caminho pedido e o de verdade (um atalho ou link pode apontar para a pasta de dados ou para .ssh)
      const proibido = this.anexoProibido(abs) || this.anexoProibido(real(abs));
      if (proibido) return { erro: `Não mandei nada: ${abs} ${proibido}.` };
      if (lista.includes(abs)) continue;
      soma += st.size;
      if (soma > limite) return { erro: `Não mandei nada: os arquivos somam mais que ${this.cfg.max_arquivo_mb} MB (o limite de Ajustes vale para a mensagem inteira). Mande menos arquivos ou só o caminho deles no texto.` };
      lista.push(abs);
    }
    return { lista };
  }

  /** Por que este arquivo não pode ir como anexo (ou null): os dados do próprio Engram e arquivos de segredo. */
  anexoProibido(abs) {
    const mesmo = (p, base) => { const r = path.relative(base, p); return !r || (!r.startsWith('..') && !path.isAbsolute(r)); };
    const dados = real(this.caminhos.dados);
    // a pasta de dados do Engram (banco, token, config) fica de fora; as pastas de arquivos dos agentes e o cérebro local, não
    const liberadas = [this.caminhos.arquivos, this.caminhos.cerebro].filter(Boolean).map(real);
    if (mesmo(abs, dados) && !liberadas.some(p => mesmo(abs, p))) return 'é da pasta de dados do Engram (banco, token, configuração) e não vai como anexo';
    const nome = path.basename(abs).toLowerCase();
    const partes = abs.toLowerCase().split(/[\\/]+/);
    if (/^\.env(\..+)?$/.test(nome) || /\.(pem|key|pfx|p12|kdbx|ppk)$/.test(nome) || /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/.test(nome)
      || ['credentials', 'credentials.json', '.netrc', '.npmrc', '.pypirc', '.git-credentials'].includes(nome) || partes.includes('.ssh') || partes.includes('.aws')) {
      return 'parece um arquivo de segredo (chave, senha ou token) e não vai como anexo; se for mesmo preciso, a pessoa anexa pela tela';
    }
    return null;
  }

  /** Copia os anexos para recebidos/ de quem recebe e devolve o bloco que vai no fim da mensagem. */
  anexar(de, para, lista) {
    if (!lista.length) return '';
    const limite = this.cfg.max_arquivo_mb * 1048576;
    const copias = [];
    try {
      for (const origem of lista) copias.push(this.arquivos.copiar(para, 'recebidos', origem, null, limite));
    } catch (e) {
      // não deixa meia entrega para trás: apaga as cópias que já tinham sido feitas
      for (const c of copias) try { fs.unlinkSync(c); } catch { /* já saiu */ }
      throw e;
    }
    this.avisar({ tipo: 'arquivos', sessao_id: para, entregues: [] });
    return `\n\n[Arquivos que ${this.nomeDe(de)} anexou: estão na sua pasta recebidos/; leia antes de começar]\n${copias.map(c => `- ${c}`).join('\n')}`;
  }

  /** Uma mensagem para um colega: { ok, texto } (o texto é a resposta para quem enviou). `nota` vai antes dos anexos. */
  entregarA(de, alvo, texto, anexos = [], nota = '', setor = null) {
    if (alvo === de) return { ok: false, texto: 'Você não pode mandar mensagem para você mesmo.' };
    if (!texto) return { ok: false, texto: 'A mensagem está vazia.' };
    const corpo = texto.slice(0, 20_000) + nota;
    // revisão no caminho: tudo o que um agente revisado manda vai para o revisor dele, com a tarefa junto
    const revisor = this.revisorAtivo(de);
    if (revisor) {
      if (this.cerebro.mensagensNoPar(de, revisor) >= this.cfg.max_mensagens_par_10min) return { ok: false, texto: 'Limite de mensagens entre você e o seu revisor nos últimos 10 minutos. Pare e espere.' };
      let final;
      try { final = corpo + this.anexar(de, revisor, anexos); } catch (e) { return { ok: false, texto: `Não mandei: não deu para copiar os arquivos (${e.message}).` }; }
      const j = this.ativas.get(revisor);
      const formatado = this.paraRevisao(de, revisor, final, alvo === revisor ? null : alvo);
      const posicao = this.enfileirar(j, de, final, formatado);
      const nomeR = this.cerebro.sessao(revisor).nome;
      const desvio = alvo === revisor ? '' : ` Suas entregas passam por ${nomeR}: ele revisa antes de chegar a ${this.cerebro.sessao(alvo).nome}.`;
      return { ok: true, texto: `Mensagem entregue a ${nomeR}${posicao ? ` (entra quando ele terminar o turno, ${posicao} na frente)` : ''}.${desvio}`, nome: nomeR, posicao };
    }
    const nome = this.cerebro.sessao(alvo).nome;
    if (!this.cerebro.conectados(de).has(alvo)) return { ok: false, texto: `Você não está ligado a "${nome}" no palco. Só dá para falar com quem está ligado a você (a pessoa liga arrastando uma linha entre os cartões).` };
    if (this.cerebro.mensagensNoPar(de, alvo) >= this.cfg.max_mensagens_par_10min) return { ok: false, texto: 'Limite de mensagens entre vocês dois nos últimos 10 minutos. Pare e espere: isso costuma ser dois agentes respondendo um ao outro em loop.' };
    let final;
    try { final = corpo + this.anexar(de, alvo, anexos); } catch (e) { return { ok: false, texto: `Não mandei: não deu para copiar os arquivos (${e.message}).` }; }
    const j = this.ativas.get(alvo);
    const info = {};
    const posicao = this.enfileirar(j, de, final, null, info);
    // quadro de tarefas e diário: o maestro delegou, ou um colega devolveu ao maestro (o revisor também devolve)
    try {
      if (this.ehMaestro(de)) {
        const tn = this.tarefas?.delegou(de, alvo, final, info.n, setor);
        // o número da tarefa vai junto: quem devolve cita, e o quadro fecha a tarefa certa
        const item = tn ? j.caixa.find(([n]) => n === info.n) : null;
        if (item) item[2] += `\n\n(No quadro do maestro esta é a tarefa ${tn}. Ao devolver o resultado, comece com "Tarefa ${tn}:".)`;
      } else if (this.ehMaestro(alvo)) this.tarefas?.respondeu(de, alvo, final, info.n);
    } catch { /* o quadro nunca atrapalha a entrega */ }
    const copiados = anexos.length ? ` ${anexos.length === 1 ? 'O arquivo foi copiado' : `Os ${anexos.length} arquivos foram copiados`} para a pasta recebidos/ dele.` : '';
    if (posicao === 0) return { ok: true, texto: `Mensagem entregue a ${nome}.${copiados} A resposta chega aqui como uma mensagem do Engram.`, nome, posicao };
    return { ok: true, texto: `${nome} está ${j.estado}. A mensagem entra quando ele terminar o turno (${posicao} na frente dela).${copiados} A resposta chega aqui como uma mensagem do Engram.`, nome, posicao };
  }

  /** Para o setor inteiro: cada membro aberto e ligado a quem envia recebe a sua cópia (e os anexos na pasta dele). */
  enviarAoSetor(de, setor, texto, anexos) {
    const setores = this.cerebro.setores(setor.palco || 1);
    const membros = [...this.ativas.keys()].filter(id => id !== de && this.cerebro.setorDe(id, setores)?.id === setor.id)
      .sort((a, b) => this.nomeDe(a).localeCompare(this.nomeDe(b)));
    if (!membros.length) return `O setor ${setor.nome} não tem nenhum agente aberto${this.cerebro.setorDe(de, setores)?.id === setor.id ? ' além de você' : ''}. Não mandei nada.`;
    const conectados = this.cerebro.conectados(de);
    const ligados = membros.filter(id => conectados.has(id));
    const fora = membros.filter(id => !conectados.has(id)).map(id => this.nomeDe(id));
    const nomesFora = fora.length ? ` Ficaram de fora (sem ligação com você): ${fora.join(', ')}.` : '';
    if (!ligados.length) return `Não mandei nada: ninguém do setor ${setor.nome} está ligado a você.${nomesFora}`;
    const nomes = ligados.map(id => this.nomeDe(id));
    // quem tem revisor manda uma vez só, para ele, que revisa antes de repassar ao setor
    const revisor = this.revisorAtivo(de);
    if (revisor) {
      const notaRevisor = `\n\n(${this.nomeDe(de)} quis mandar isto ao setor ${setor.nome} inteiro: ${nomes.join(', ')}. Só você recebeu: as entregas dele passam por você. Revise antes de repassar a cada um.)`;
      return this.entregarA(de, revisor, texto, anexos, notaRevisor).texto + nomesFora;
    }
    const nota = `\n\n(Mensagem para o setor ${setor.nome} inteiro: ${nomes.join(', ')}. Cada um recebeu a sua cópia.)`;
    const foram = [], falhas = [];
    for (const id of ligados) {
      const r = this.entregarA(de, id, texto, anexos, nota, setor.nome);
      if (r.ok) foram.push(r.posicao ? `${r.nome} (na fila, ${r.posicao} na frente)` : r.nome);
      else falhas.push(`${this.nomeDe(id)} (${r.texto.replace(/\.$/, '')})`);
    }
    let r = foram.length ? `Mandei para ${foram.length === 1 ? '1 colega' : `${foram.length} colegas`} do setor ${setor.nome}: ${foram.join(', ')}.` : `Não mandei para ninguém do setor ${setor.nome}.`;
    if (foram.length && anexos.length) r += ` ${anexos.length === 1 ? 'O arquivo foi copiado' : 'Os arquivos foram copiados'} para a pasta recebidos/ de cada um.`;
    if (falhas.length) r += ` Não foi para: ${falhas.join('; ')}.`;
    r += nomesFora;
    if (foram.length) r += ' As respostas chegam aqui como mensagens do Engram.';
    return r;
  }

  verTela(de, quem, linhas) {
    const alvo = this.achar(quem);
    if (!alvo) return `Não há janela aberta chamada "${quem}".`;
    if (alvo !== de && !this.cerebro.conectados(de).has(alvo)) return `Você não está ligado a "${quem}" no palco.`;
    return this.ativas.get(alvo).tela.texto(Math.max(10, Math.min(Number(linhas) || 60, 200))) || '(tela vazia)';
  }

  async criarAgente(de, nome, papel, modelo, tarefa, provedor = null, nomeSetor = '') {
    const s = this.cerebro.sessao(de);
    if (!s || s.papel !== 'maestro') return 'Só o maestro cria agentes.';
    if (papel === 'maestro') return 'O time tem um maestro só.';
    let setor = null;
    if (nomeSetor) {
      const palco = this.cerebro.palcoDe(de);
      setor = this.cerebro.setores(palco).find(x => x.nome.toLowerCase() === String(nomeSetor).trim().toLowerCase());
      const existentes = this.setoresDoPalco(palco);
      if (!setor) return `Não há setor chamado "${nomeSetor}" no seu palco. ${existentes ? `Setores: ${existentes.map(x => x.nome).join(', ')}.` : 'A pessoa ainda não desenhou setores nele.'}`;
    }
    try {
      const info = await this.abrir({ nome, modelo, papel, provedor: provedor || s.provedor || 'claude', ligarA: de, posicao: setor ? this.lugarNoSetor(setor) : null, tarefa: tarefa && String(tarefa).trim() ? [de, String(tarefa).trim()] : null });
      const d = this.descricao(info.id);
      return `Criei ${info.nome} (${d.papel}, ${d.agente}, ${d.modelo})${setor ? ` no setor ${setor.nome}` : ''}, já ligado a você.${tarefa ? ' A tarefa entra assim que ele estiver pronto.' : ''}`;
    } catch (e) {
      return `Não deu para criar: ${e.message}.`;
    }
  }

  // ---------------------------------------------------------------- o maestro monta o palco

  ehMaestro(id) { return this.cerebro.sessao(id)?.papel === 'maestro'; }
  nomeDe(id) { return this.cerebro.sessao(id)?.nome || id; }

  /** As duas pontas pelo nome (só janelas abertas), ou a mensagem de erro. */
  pontas(qa, qb, palco) {
    const a = this.acharNoPalco(qa, palco), b = this.acharNoPalco(qb, palco);
    if (!a) return { erro: this.naoAchei(qa, palco) };
    if (!b) return { erro: this.naoAchei(qb, palco) };
    if (a === b) return { erro: 'As duas pontas são a mesma janela.' };
    return { a, b };
  }

  ligarJanelas(de, qa, qb) {
    if (!this.ehMaestro(de)) return 'Só o maestro liga agentes. Peça à pessoa (ela liga arrastando uma linha entre os cartões).';
    const p = this.pontas(qa, qb, this.cerebro.palcoDe(de));
    if (p.erro) return p.erro;
    const nomes = `${this.nomeDe(p.a)} e ${this.nomeDe(p.b)}`;
    if (!this.cerebro.conectar(p.a, p.b)) return `${nomes} já estavam ligados.`;
    this.avisar({ tipo: 'conexao', acao: 'criada', a: p.a, b: p.b });
    return `Liguei ${nomes}: agora os dois conversam pelo enviar.`;
  }

  desligarJanelas(de, qa, qb, confirmarRevisao = false) {
    if (!this.ehMaestro(de)) return 'Só o maestro desliga agentes. Peça à pessoa (ela clica na linha e escolhe remover).';
    const p = this.pontas(qa, qb, this.cerebro.palcoDe(de));
    if (p.erro) return p.erro;
    const nomes = `${this.nomeDe(p.a)} e ${this.nomeDe(p.b)}`;
    const c = this.cerebro.conexoes().find(x => (x.a === p.a && x.b === p.b) || (x.a === p.b && x.b === p.a));
    if (!c) return `${nomes} não estavam ligados.`;
    if (c.revisa && !confirmarRevisao) {
      const revisado = c.revisa === c.a ? c.b : c.a;
      return `Não desliguei: nessa ligação ${this.nomeDe(c.revisa)} revisa as entregas de ${this.nomeDe(revisado)}, e desligar apaga a revisão junto. Confirme com a pessoa; se ela quiser mesmo, chame de novo com confirmar_revisao=true.`;
    }
    this.cerebro.desconectar(p.a, p.b);
    this.avisar({ tipo: 'conexao', acao: 'removida', a: p.a, b: p.b });
    let r = `Desliguei ${nomes}.${c.revisa ? ' A revisão dessa ligação saiu junto.' : ''}`;
    // ninguém pode ficar sem caminho até o maestro sem que ele saiba
    const isolados = [p.a, p.b].filter(x => !this.ehMaestro(x) && !this.alcanca(x, de)).map(x => this.nomeDe(x));
    if (isolados.length) r += ` Atenção: ${isolados.join(' e ')} ficou sem nenhum caminho até você, nem por colegas: não consegue mais receber tarefas nem devolver resultados. Para religar, use ligar.`;
    return r;
  }

  /** Há caminho de linhas (entre janelas abertas) de "de" até "ate"? */
  alcanca(de, ate) {
    const vistos = new Set([de]), fila = [de];
    while (fila.length) {
      const x = fila.shift();
      if (x === ate) return true;
      for (const y of this.cerebro.conectados(x)) if (this.ativas.has(y) && !vistos.has(y)) { vistos.add(y); fila.push(y); }
    }
    return false;
  }

  /** Arruma os cartões: "time" (maestro no centro, colegas em volta por papel) ou "lista" (posições dadas). */
  organizarPalco(de, modo, posicoes) {
    if (!this.ehMaestro(de)) return 'Só o maestro organiza o palco.';
    const palco = this.cerebro.palcoDe(de); // só o palco do maestro
    const tamanho = id => { const p = this.cerebro.posicao(id); return p ? [p.w, p.h] : TAMANHO_PADRAO; };
    const novas = [];
    if (modo === 'lista') {
      if (!Array.isArray(posicoes) || !posicoes.length) return 'No modo "lista", mande posicoes: [{ nome, x, y }].';
      const desconhecidos = [];
      for (const item of posicoes.slice(0, 40)) {
        const id = this.acharNoPalco(item?.nome, palco);
        if (!id) { desconhecidos.push(String(item?.nome ?? '')); continue; }
        const [w, h] = tamanho(id);
        const [x, y] = posicaoValida({ x: item.x, y: item.y, w, h });
        novas.push({ id, x, y, w, h });
      }
      if (desconhecidos.length) return `Não mexi em nada: não há janela aberta chamada ${desconhecidos.map(n => `"${n}"`).join(', ')} no seu palco. Veja os nomes com equipe.`;
    } else if (modo === 'time') {
      // quem está num setor fica onde está (o setor é a arrumação da pessoa); os setores viram obstáculos
      const setores = this.cerebro.setores(palco);
      const noSetor = id => !!this.cerebro.setorDe(id, setores);
      const papelDe = id => this.cerebro.sessao(id)?.papel || 'livre';
      const colegas = this.abertasNoPalco(palco).filter(id => id !== de && !noSetor(id))
        .sort((x, y) => papelDe(x).localeCompare(papelDe(y)) || this.nomeDe(x).localeCompare(this.nomeDe(y)));
      if (!colegas.length) return 'Nada para arrumar: todos os colegas estão dentro de setores, e eles ficam onde a pessoa deixou.';
      // o maestro fica onde está e vira o centro (assim ele não cai em cima de um setor)
      const [mw, mh] = tamanho(de);
      const pm = this.cerebro.posicao(de);
      const centro = pm ? { x: pm.x + pm.w / 2, y: pm.y + pm.h / 2 } : { x: 0, y: 0 };
      const maestro = { id: de, x: Math.round(centro.x - mw / 2), y: Math.round(centro.y - mh / 2), w: mw, h: mh };
      if (!pm) novas.push(maestro);
      // os setores (com a etiqueta em cima), as automações e os post-its; os cartões dos colegas é que vão mudar
      const obstaculos = [maestro, ...this.ocupados({ ignorar: [...this.ativas.keys()], palco })];
      if (colegas.length) {
        // colegas numa elipse em volta do maestro, os do mesmo papel lado a lado; abre a elipse até ninguém encostar
        const tams = colegas.map(tamanho);
        const maiorW = Math.max(mw, ...tams.map(t => t[0])), maiorH = Math.max(mh, ...tams.map(t => t[1]));
        const encosta = (r1, r2) => r1.x < r2.x + r2.w + 60 && r2.x < r1.x + r1.w + 60 && r1.y < r2.y + r2.h + 60 && r2.y < r1.y + r1.h + 60;
        let rx = maiorW + 160, ry = maiorH + 120, lugares = null;
        for (let tentativa = 0; tentativa < 40 && !lugares; tentativa++, rx *= 1.1, ry *= 1.1) {
          const p = colegas.map((id, i) => {
            const ang = -Math.PI / 2 + (2 * Math.PI * i) / colegas.length;
            const [w, h] = tams[i];
            return { id, x: Math.round(centro.x + rx * Math.cos(ang) - w / 2), y: Math.round(centro.y + ry * Math.sin(ang) - h / 2), w, h };
          });
          const bate = p.some((r1, i) => p.some((r2, j) => j > i && encosta(r1, r2)) || obstaculos.some(o => encosta(r1, o)));
          if (!bate) lugares = p;
        }
        if (!lugares) {
          // não achou elipse livre: uma fileira embaixo de tudo
          const fundo = Math.max(...obstaculos.map(o => o.y + o.h)) + 140;
          lugares = colegas.map((id, i) => ({ id, x: Math.round(centro.x + (i - (colegas.length - 1) / 2) * (maiorW + 120) - tams[i][0] / 2), y: fundo, w: tams[i][0], h: tams[i][1] }));
        }
        novas.push(...lugares);
      }
    } else return 'Modo desconhecido: use "time" ou "lista".';
    for (const n of novas) this.cerebro.posicaoSalvar(n.id, n.x, n.y, n.w, n.h);
    this.avisar({ tipo: 'palco', acao: 'organizado', posicoes: novas, palco });
    if (modo === 'lista') return `Movi ${novas.length === 1 ? '1 cartão' : `${novas.length} cartões`} no palco.`;
    const movidos = novas.filter(n => n.id !== de).length;
    const emSetor = this.abertasNoPalco(palco).filter(id => id !== de && this.cerebro.setorDe(id)).length;
    return `Organizei o palco: ${movidos === 1 ? '1 colega' : `${movidos} colegas`} em volta de você, agrupados por papel.${emSetor ? ` ${emSetor === 1 ? 'O colega que está num setor ficou' : `Os ${emSetor} que estão em setores ficaram`} onde a pessoa deixou.` : ''}`;
  }

  /**
   * Muda o nome de uma janela (pela tela ou pelo maestro). O nome é como os agentes se chamam no enviar,
   * então tem de ser único entre as janelas abertas. A conversa continua a mesma.
   */
  renomear(id, nome) {
    const s = this.cerebro.sessao(id);
    if (!s) throw new Error('janela não encontrada');
    nome = String(nome ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/"/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!nome) throw new Error('o nome não pode ficar vazio');
    const outra = [...this.ativas.keys()].find(x => x !== id && this.cerebro.sessao(x)?.nome.toLowerCase() === nome.toLowerCase());
    if (outra) throw new Error(`já há uma janela aberta chamada ${this.nomeDe(outra)}`);
    const antes = s.nome;
    if (antes !== nome) {
      this.cerebro.sessaoRenomear(id, nome);
      this.avisar({ tipo: 'sessao', sessao: this.info(id) });
    }
    return { antes, nome };
  }

  /** O prompt da conversa tem o nome com que ela começou: se a janela foi renomeada, o agente fica sabendo. */
  avisoDeNome(id) {
    const s = this.cerebro.sessao(id);
    if (!s?.nome_prompt || s.nome === s.nome_prompt) return '';
    return `\n\n(No Engram você agora se chama ${s.nome}, não mais ${s.nome_prompt}: é por esse nome que os colegas falam com você.)`;
  }

  renomearPeloMaestro(de, quem, nome) {
    if (!this.ehMaestro(de)) return 'Só o maestro renomeia janelas. Peça à pessoa (duplo clique no nome do cartão).';
    const palco = this.cerebro.palcoDe(de);
    const id = this.acharNoPalco(quem, palco);
    if (!id) return this.naoAchei(quem, palco);
    try {
      const r = this.renomear(id, nome);
      if (r.antes === r.nome) return `${r.nome} já tem esse nome.`;
      return `Renomeei ${r.antes} para ${r.nome}. Use o nome novo no enviar; a conversa dele continua a mesma.`;
    } catch (e) {
      return `Não renomeei: ${e.message}.`;
    }
  }

  // ---------------------------------------------------------------- setores pelo maestro

  /** Os nomes viram ids de janelas abertas; devolve { ids } ou { erro }. */
  agentesPorNome(nomes, palco) {
    const lista = (Array.isArray(nomes) ? nomes : []).map(n => String(n ?? '').trim()).filter(Boolean);
    if (!lista.length) return { erro: 'Diga quais agentes ficam no setor, em agentes: ["nome", ...] (os nomes como aparecem em equipe).' };
    const ids = [], faltam = [];
    for (const n of lista) { const id = this.acharNoPalco(n, palco); if (id) { if (!ids.includes(id)) ids.push(id); } else faltam.push(`"${n}"`); }
    if (faltam.length) return { erro: `Não há janela aberta chamada ${faltam.join(', ')} no seu palco (${this.cerebro.palcoNome(palco)}). Veja os nomes com equipe.` };
    return { ids };
  }

  /**
   * A área de um setor em volta destes agentes. Se o retângulo pegaria alguém de fora ou encostaria
   * noutro setor, junta os cartões numa grade num lugar livre e envolve a grade.
   */
  areaEmVolta(ids, ignorar = null, palco = this.cerebro.palcoDe(ids[0])) {
    const FOLGA = 60, VAO = 60;
    const [pw, ph] = TAMANHO_PADRAO;
    const pos = id => this.cerebro.posicao(id) || { x: 0, y: 0, w: pw, h: ph };
    const tams = ids.map(pos);
    const caixa = caixaDe(tams);
    const r = { x: caixa.x - FOLGA, y: caixa.y - FOLGA, w: caixa.w + 2 * FOLGA, h: caixa.h + 2 * FOLGA };
    // o que não pode ficar dentro nem embaixo da área: os outros cartões abertos (encerrado não conta), os outros
    // setores com a etiqueta deles, as automações e os post-its
    const ocupados = this.ocupados({ ignorar: [...ids, ignorar].filter(Boolean), palco });
    const comEtiqueta = { x: r.x, y: r.y - ETIQUETA_SETOR, w: r.w, h: r.h + ETIQUETA_SETOR };
    // um post-it ou uma automação dentro da área não atrapalha (não entram no setor). Cartão de fora só atrapalha
    // se o centro dele cair na área ou se ele encostar nos próprios cartões do grupo: um vizinho a poucos px da
    // borda não faz o Engram mudar de lugar o que a pessoa arrumou.
    const centroDentro = o => { const c = centro(o); return c.x > r.x && c.x < r.x + r.w && c.y > r.y && c.y < r.y + r.h; };
    const atrapalha = o => (o.tipo === 'setor' ? toca(comEtiqueta, o) : o.tipo === 'cartao' && (centroDentro(o) || toca(caixa, o)));
    if (!ocupados.some(atrapalha)) return { area: r, movidos: [] };
    // junta numa grade, no lugar livre mais perto de onde o grupo está (antes ia para a direita de tudo)
    const w = Math.max(...tams.map(t => t.w)), h = Math.max(...tams.map(t => t.h));
    const cols = Math.ceil(Math.sqrt(ids.length)), linhas = Math.ceil(ids.length / cols);
    const larg = cols * w + (cols - 1) * VAO + 2 * FOLGA, alt = linhas * h + (linhas - 1) * VAO + 2 * FOLGA;
    // procura a área já com a etiqueta em cima
    const [ox, oyEtiqueta] = acharLugar(larg, alt + ETIQUETA_SETOR, centro(r), ocupados, { folga: 80, preferidos: [[r.x, r.y - ETIQUETA_SETOR]] });
    const oy = oyEtiqueta + ETIQUETA_SETOR;
    const movidos = ids.map((id, i) => ({ id, x: ox + FOLGA + (i % cols) * (w + VAO), y: oy + FOLGA + Math.floor(i / cols) * (h + VAO), w: tams[i].w, h: tams[i].h }));
    return { area: { x: ox, y: oy, w: larg, h: alt }, movidos };
  }

  criarSetor(de, { nome, cor, instrucao, agentes } = {}) {
    if (!this.ehMaestro(de)) return 'Só o maestro cria setores. Peça à pessoa (ela desenha com o botão Setor no palco).';
    nome = String(nome ?? '').trim().slice(0, 24);
    if (!nome) return 'Dê um nome ao setor.';
    const palco = this.cerebro.palcoDe(de);
    const setores = this.cerebro.setores(palco);
    const igual = setores.find(s => s.nome.toLowerCase() === nome.toLowerCase());
    if (igual) return `Já existe o setor ${igual.nome}. Para mudar, use editar_setor.`;
    const a = this.agentesPorNome(agentes, palco);
    if (a.erro) return a.erro;
    const usadas = new Set(setores.map(s => s.cor));
    const hex = CORES_SETOR[cor] || Object.values(CORES_SETOR).find(c => !usadas.has(c)) || Object.values(CORES_SETOR)[setores.length % 6];
    const { area, movidos } = this.areaEmVolta(a.ids, null, palco);
    for (const m of movidos) this.cerebro.posicaoSalvar(m.id, m.x, m.y, m.w, m.h);
    const s = { id: `setor-${crypto.randomUUID().slice(0, 8)}`, nome, cor: hex, instrucao: String(instrucao ?? '').trim().slice(0, 2000), ...area, palco };
    this.cerebro.setorSalvar(s);
    if (movidos.length) this.avisar({ tipo: 'palco', acao: 'organizado', posicoes: movidos, palco });
    this.avisar({ tipo: 'setor', acao: 'salvo', setor: s });
    const nomes = a.ids.map(id => this.nomeDe(id)).join(', ');
    return `Criei o setor ${nome} com ${nomes}.${movidos.length ? ' Juntei os cartões deles num lugar livre, porque em volta de onde estavam o setor pegaria outros agentes ou encostaria noutro setor.' : ''}${s.instrucao ? ' A instrução do setor vai junto em cada tarefa que eles receberem.' : ''}`;
  }

  editarSetor(de, { setor, nome, cor, instrucao, agentes } = {}) {
    if (!this.ehMaestro(de)) return 'Só o maestro muda setores.';
    const palco = this.cerebro.palcoDe(de);
    const setores = this.cerebro.setores(palco);
    const s = setores.find(x => x.nome.toLowerCase() === String(setor ?? '').trim().toLowerCase());
    if (!s) return `Não há setor chamado "${setor}". ${setores.length ? `Setores: ${setores.map(x => x.nome).join(', ')}.` : 'O palco ainda não tem setores.'}`;
    const novo = { ...s };
    if (nome !== undefined && String(nome).trim()) {
      novo.nome = String(nome).trim().slice(0, 24);
      if (setores.some(x => x.id !== s.id && x.nome.toLowerCase() === novo.nome.toLowerCase())) return `Já existe outro setor chamado ${novo.nome}.`;
    }
    if (cor !== undefined) { if (!CORES_SETOR[cor]) return `Cor desconhecida: use ${Object.keys(CORES_SETOR).join(', ')}.`; novo.cor = CORES_SETOR[cor]; }
    if (instrucao !== undefined) novo.instrucao = String(instrucao ?? '').trim().slice(0, 2000);
    let movidos = [];
    if (agentes !== undefined) {
      const a = this.agentesPorNome(agentes, palco);
      if (a.erro) return a.erro;
      const r = this.areaEmVolta(a.ids, s.id, palco);
      Object.assign(novo, r.area);
      movidos = r.movidos;
      for (const m of movidos) this.cerebro.posicaoSalvar(m.id, m.x, m.y, m.w, m.h);
    }
    this.cerebro.setorSalvar(novo);
    if (movidos.length) this.avisar({ tipo: 'palco', acao: 'organizado', posicoes: movidos, palco });
    this.avisar({ tipo: 'setor', acao: 'salvo', setor: novo });
    const membros = this.abertasNoPalco(palco).filter(id => this.cerebro.setorDe(id)?.id === s.id).map(id => this.nomeDe(id));
    return `Setor ${novo.nome} atualizado. Dentro dele: ${membros.length ? membros.join(', ') : 'ninguém'}.${movidos.length ? ' Juntei os cartões num lugar livre.' : ''}`;
  }

  removerSetor(de, { setor } = {}) {
    if (!this.ehMaestro(de)) return 'Só o maestro remove setores.';
    const s = this.cerebro.setores(this.cerebro.palcoDe(de)).find(x => x.nome.toLowerCase() === String(setor ?? '').trim().toLowerCase());
    if (!s) return `Não há setor chamado "${setor}".`;
    this.cerebro.setorApagar(s.id);
    this.avisar({ tipo: 'setor', acao: 'removido', id: s.id });
    return `Removi o setor ${s.nome}. Os agentes continuam no palco, só saíram do setor.`;
  }

  entregarArquivo(de, caminho, nome) {
    try {
      const base = this.ativas.get(de)?.pasta || this.cfg.pasta_trabalho || '';
      const abs = path.resolve(base, String(caminho || ''));
      const proibido = this.anexoProibido(abs) || this.anexoProibido(real(abs));
      if (proibido) return `Não deu para entregar: ${abs} ${proibido}.`;
      const destino = this.arquivos.copiar(de, 'entregues', abs, nome, this.cfg.max_arquivo_mb * 1048576);
      const j = this.ativas.get(de);
      if (j) j.arquivosAssinatura = this.arquivos.assinatura(de);
      this.avisar({ tipo: 'arquivos', sessao_id: de, entregues: [path.basename(destino)] });
      return `Entregue: ${path.basename(destino)}. A pessoa vê na área de arquivos da sua janela.`;
    } catch (e) {
      return `Não deu para entregar: ${e.message}.`;
    }
  }

  // ---------------------------------------------------------------- caixa de mensagens

  formatar(de, texto, para = null) {
    if (de === PESSOA) return texto;
    const r = this.descricao(de);
    // quem tem revisor entrega a ele, não a quem pediu
    const revisor = para ? this.revisorAtivo(para) : null;
    const dica = revisor && revisor !== de
      ? `Quando terminar, entregue o resultado com mcp__engram__enviar para="${this.cerebro.sessao(revisor).nome}": suas entregas passam por ele, que revisa antes de levar a ${r.nome}. Dúvidas sobre a tarefa também vão para ele.`
      : `Para responder, use mcp__engram__enviar com para="${r.nome}".`;
    // quem recebe está num setor com instrução: ela vai junto, sempre a atual (o setor pode mudar de nome ou de regra)
    const setor = para ? this.cerebro.setorDe(para) : null;
    const doSetor = setor?.instrucao ? `\n\n(Você está no setor ${setor.nome} do palco. Instrução do setor: ${setor.instrucao})` : '';
    return `[Engram · mensagem de ${r.nome} (${r.papel}, ${r.modelo})]\n${texto}${doSetor}\n\n(${dica})`;
  }

  /** Põe a mensagem na caixa do agente. `info` (opcional) recebe o número dela (info.n), para o quadro de tarefas. */
  enfileirar(j, de, texto, formatado = null, info = null) {
    const n = this.cerebro.mensagemRegistrar(de, j.id, texto);
    if (info) info.n = n;
    const naFrente = j.caixa.length + (j.entregando || !LIVRE.has(j.estado) ? 1 : 0);
    j.caixa.push([n, de, (formatado || this.formatar(de, texto, j.id)) + this.avisoDeNome(j.id)]);
    this.avisar({ tipo: 'mensagem', fase: 'enviada', de, para: j.id, texto: texto.slice(0, 240), n });
    this.tentarEntregar(j);
    return naFrente;
  }

  tentarEntregar(j, espera = 0) {
    if (!j.viva || j.entregando || !j.caixa.length || !LIVRE.has(j.estado)) return;
    j.entregando = true;
    // a tela do CLI ainda está montando logo depois de abrir (ou de confiar na pasta): colar antes disso perde a mensagem
    const montando = Math.max(0, (j.prontaEm || 0) + MONTAR_TELA - Date.now());
    setTimeout(() => this.colar(j), Math.max(espera, montando));
  }

  /**
   * Agente com ganchos (Claude): o UserPromptSubmit confirma que a mensagem entrou. Sem ele em CONFIRMAR ms, olha a
   * tela: trabalhando = entrou (o gancho é que não veio); texto parado na caixa = o Enter não pegou, manda de novo;
   * caixa vazia = a colagem se perdeu, volta para a frente da fila (até 2 vezes; depois avisa a pessoa).
   */
  conferirEntrega(id, j) {
    const g = j.aguardando;
    if (!g || !j.viva || Date.now() - g.em < CONFIRMAR) return;
    const tela = j.tela.texto(16);
    if (TRABALHANDO.test(tela.split('\n').slice(-8).join('\n'))) { j.aguardando = null; return; }
    // só a caixa de entrada (as últimas linhas): o histórico acima repete o que já foi enviado
    const caixa = tela.split('\n').slice(-6).join(' ').replace(/\s+/g, ' ');
    const inicio = g.texto.replace(/\s+/g, ' ').trim().slice(0, 28);
    const naCaixa = /\[Pasted text/i.test(caixa) || (inicio && caixa.includes(inicio));
    if (naCaixa && !g.enterDeNovo) { j.escrever('\r'); g.enterDeNovo = true; g.em = Date.now(); return; }
    j.aguardando = null;
    // depois do Enter de novo, caixa vazia = entrou (os ganchos é que não vieram): nunca cola outra vez, para não duplicar
    if (g.enterDeNovo && !naCaixa) { this.mudarEstado(id, j, 'esperando você', 'entrega'); return; } // não trava a caixa em "pensando"
    const nome = this.cerebro.sessao(id)?.nome || 'o agente';
    if (naCaixa || g.tentativas >= 2) {
      this.mudarEstado(id, j, 'esperando você', 'entrega');
      this.avisar({ tipo: 'aviso', texto: `A mensagem para ${nome} não entrou no terminal dele. Confira a janela e mande de novo, se precisar.` });
      return;
    }
    require('./config').registrar(`${nome}: a colagem não entrou (sem UserPromptSubmit e caixa vazia); entrego de novo (tentativa ${g.tentativas + 2})`);
    j.caixa.unshift([g.n, g.de, g.texto, g.tentativas + 1]);
    this.mudarEstado(id, j, 'esperando você', 'entrega');
    this.tentarEntregar(j, 1500);
  }

  colar(j) {
    if (!j.viva || !j.caixa.length || !LIVRE.has(j.estado)) { j.entregando = false; return; }
    const [n, de, naFila, tentativas = 0] = j.caixa.shift();
    const texto = tentativas ? naFila : naFila + this.avisoDeCerebro(j.id); // na recolocação o aviso já está no texto
    j.escrever(COLAR_INICIO + texto.replace(/\r\n/g, '\n') + COLAR_FIM);
    j.estado = 'pensando'; // até o gancho confirmar, ninguém mais cola por cima
    j.teveTurno = true;
    const a = this.provedores.adaptador(j.provedor) || {};
    // o Codex no Windows trata um Enter colado logo depois do texto como parte da colagem (vira quebra de linha)
    const espera = a.enterDepois || 400;
    j.ocupadoAte = Date.now() + espera + 5000;
    setTimeout(() => {
      if (!j.viva) { j.entregando = false; return; }
      j.escrever('\r');
      j.entregando = false;
      this.cerebro.mensagemEntregue(n);
      try { this.tarefas?.chegou(n); } catch { /* o quadro nunca atrapalha a entrega */ }
      this.cerebro.sessaoEstado(j.id, 'pensando');
      this.avisar({ tipo: 'mensagem', fase: 'entregue', de, para: j.id, n });
      if (a.ganchos) j.aguardando = { n, de, texto, em: Date.now(), tentativas };
      if (a.ocupado && !a.ganchos) {
        // se não começou a trabalhar, o Enter não pegou: manda de novo (numa caixa vazia, Enter não faz nada)
        setTimeout(() => {
          if (j.viva && !a.ocupado.test(j.tela.texto(14))) j.escrever('\r');
        }, 2500);
      }
    }, espera);
  }

  // ---------------------------------------------------------------- eventos dos ganchos

  evento(dados) {
    const id = String(dados.sessao || '');
    const j = this.ativas.get(id);
    if (!j) return;
    const evento = String(dados.evento || '');
    if (dados.externo) this.registrarExterno(id, dados.externo);
    if (evento === 'Stop') { j.teveTurno = true; j.ocupadoAte = 0; }
    else if (['UserPromptSubmit', 'PreToolUse', 'PostToolUse'].includes(evento)) j.ocupadoAte = Date.now() + 30_000;
    const ferramenta = dados.ferramenta || null;
    const entrada = dados.entrada && typeof dados.entrada === 'object' ? dados.entrada : {};
    let estado = ESTADO_POR_EVENTO[evento] || null;
    if (evento === 'Notification' && !pedePermissao(dados)) {
      // "parado há um tempo": o agente espera entrada; não trava a caixa e ainda destrava entrega
      estado = j.estado === 'precisa de você' ? null : 'esperando você';
    }
    if (estado) { j.estado = estado; this.cerebro.sessaoEstado(id, estado); }
    if (evento === 'SessionStart' || evento === 'UserPromptSubmit') j.pergunta = null;
    if (evento === 'UserPromptSubmit' || evento === 'Stop') j.aguardando = null; // a mensagem entrou
    if (evento === 'SessionStart') j.prontaEm = Date.now();
    j.aposResposta = 0; // chegou um gancho: o estado volta a vir deles
    let semPergunta; // undefined = a tela não mexe na pergunta que está mostrando
    if (estado === 'precisa de você') {
      // começa um pedido: o vigia lê a pergunta e as opções da tela (olharPergunta)
      if (!j.pergunta) { j.perguntaLida = false; j.telaPrecisa = undefined; j.semPerguntaDesde = 0; j.perguntaAssinatura = null; }
    } else if (estado && j.pergunta?.tipo === 'terminal') {
      j.pergunta = null; j.perguntaAssinatura = null; semPergunta = null; // o agente seguiu: a pergunta sai da Conversa
    }
    const resumo = resumoEvento(evento, ferramenta, entrada, String(dados.mensagem || ''));
    if (['UserPromptSubmit', 'PreToolUse', 'Stop', 'Notification', 'SessionStart'].includes(evento)) this.cerebro.registrarEvento(id, evento, ferramenta, resumo);
    const toques = evento === 'PostToolUse' ? this.registrarToques(id, this.toques(ferramenta, entrada, j.pasta)) : [];
    this.avisar({ tipo: 'evento', sessao_id: id, evento, estado, ferramenta, resumo, toques: toques.map(([d, t]) => ({ destino: d, tipo: t })), ...(semPergunta === null ? { pergunta: null } : {}) });
    try { this.aoEvento?.(id, evento, ferramenta, entrada); } catch { /* quem acompanha não atrapalha o agente */ }
    if (evento === 'SessionStart') this.tentarEntregar(j, 2000); // a tela do agente ainda está montando
    else if (evento === 'Stop' || evento === 'Notification') this.tentarEntregar(j, 600);
  }

  /**
   * O que a ferramenta tocou: notas do cérebro e servidores MCP. `base`: a pasta em que o agente roda, para os
   * caminhos relativos dos comandos de terminal.
   */
  toques(ferramenta, entrada, base = '') {
    if (!ferramenta) return [];
    const saida = [];
    if (this.fonte.tipo === 'pasta') {
      if (['Read', 'Write', 'Edit', 'MultiEdit', 'read_file', 'write_file', 'edit_file'].includes(ferramenta)) {
        const n = this.nota(entrada.file_path);
        if (n) saida.push([n[0], (ferramenta === 'Read' || ferramenta === 'read_file') ? 'leu' : 'gravou', n[1]]);
      } else if (ferramenta === 'Grep' && entrada.path) {
        const n = this.nota(entrada.path);
        if (n) saida.push([n[0], 'leu', n[1]]);
      } else if (['Bash', 'PowerShell', 'run_command'].includes(ferramenta) && entrada.command) {
        // o agente abriu ou gravou a nota por comando (Get-Content, cat, Set-Content, redirecionamento...)
        saida.push(...this.notasCitadas(notasDoComando(entrada.command, [base])));
      }
    }
    const m = /^mcp__([^_]+(?:[-_][^_]+)*?)__(.+)$/.exec(ferramenta);
    if (m && !mesmoServidor(m[1], 'engram')) {
      const [, servidor, nomeF] = m;
      if (this.fonte.tipo === 'remoto' && mesmoServidor(servidor, this.fonte.servidor) && /^arquivos_(ler|gravar|editar)$/.test(nomeF)) {
        const n = this.nota(entrada.caminho);
        if (n) saida.push([n[0], nomeF === 'arquivos_ler' ? 'leu' : 'gravou', n[1]]);
      } else if (!/^arquivos_/.test(nomeF)) {
        saida.push([servidor, 'consultou', null]);
      }
    }
    return saida;
  }

  /** [id, caminho relativo] da nota, ou null se o caminho é de fora do cérebro. */
  nota(caminho) {
    const rel = this.fonte.relativo(caminho);
    return rel ? [idDoCaminho(rel), rel] : null;
  }

  /** Dos .md citados num comando, os que são notas do cérebro: [id, 'leu' | 'gravou', rel]. */
  notasCitadas(candidatos) {
    const saida = [];
    for (const c of candidatos) {
      const abs = resolver(c, p => { try { return fs.statSync(p).isFile(); } catch { return false; } });
      const n = abs && this.nota(abs);
      if (n) saida.push([n[0], c.tipo, n[1]]);
    }
    return saida;
  }

  /** Registra os toques (sem repetir no mesmo lote), sincroniza as notas gravadas e devolve a lista. */
  registrarToques(id, toques) {
    const vistos = new Set();
    const lista = toques.filter(([d, t]) => !vistos.has(`${d}|${t}`) && vistos.add(`${d}|${t}`));
    for (const [destino, tipo, rel] of lista) {
      this.cerebro.registrarToque(id, destino, tipo);
      if (tipo === 'gravou' && rel) this.cerebro.sincronizarArquivo(rel).then(erro => this.avisar({ tipo: 'cerebro', mudou: rel, erro })).catch(() => {});
    }
    return lista;
  }

  /**
   * Agentes sem ganchos (Codex): as notas e os MCPs que as ferramentas tocaram, lidos da conversa que o CLI grava.
   * Conta quando a ferramenta termina (a nota gravada já está no disco). Conversa nova é lida desde o começo;
   * a retomada, só do ponto em que o Engram a encontrou.
   */
  lerFerramentas(id, j) {
    if (j.provedor !== 'codex' || !j.conversa || j.conversa.endsWith('.zst')) return; // a compactada não muda
    if (j.conversaLida === undefined) {
      let tam = 0;
      try { tam = fs.statSync(j.conversa).size; } catch { /* ainda não existe */ }
      j.conversaLida = j.conversaNova ? 0 : tam;
      j.chamadasAbertas = new Map();
    }
    const { itens, ate } = conversaCodex.chamadas(j.conversa, j.conversaLida);
    j.conversaLida = ate;
    const toques = [];
    for (const it of itens) {
      if (it.tipo === 'chamada') {
        j.ultimaAcao = { o_que: resumoCodex(it), quando: Date.now() }; // para o equipe ("última ação")
        try { this.pensamentoCodex(id, j, it); } catch { /* patch estranho: sem bolha */ }
        if (it.id) j.chamadasAbertas.set(it.id, it);
        else toques.push(...this.toquesCodex(it, j));
      } else if (it.tipo === 'fim' && j.chamadasAbertas.has(it.ref)) {
        toques.push(...this.toquesCodex(j.chamadasAbertas.get(it.ref), j));
        j.chamadasAbertas.delete(it.ref);
      }
    }
    if (j.chamadasAbertas.size > 100) j.chamadasAbertas = new Map([...j.chamadasAbertas].slice(-20)); // chamada que nunca terminou
    if (!toques.length) return;
    const lista = this.registrarToques(id, toques);
    this.avisar({ tipo: 'evento', sessao_id: id, evento: 'Ferramenta', estado: null, ferramenta: null, resumo: null, toques: lista.map(([d, t]) => ({ destino: d, tipo: t })) });
  }

  /** A bolha do palco no Codex: o que o apply_patch vai escrever, lido da conversa (o Codex não tem ganchos). */
  pensamentoCodex(id, j, chamada) {
    if (this.cfg.pensamento_no_palco === false || !/\*\*\* (Add|Update|Delete) File:/.test(chamada.texto)) return;
    const base = j.pasta || this.cfg.pasta_trabalho || '';
    const corta = l => (l.length > 160 ? `${l.slice(0, 160)}…` : l);
    for (const t of trechosDoPatch(chamada.escapado ? desescapar(chamada.texto) : chamada.texto)) {
      const r = path.relative(base, path.resolve(base, t.arquivo));
      const rel = r && !r.startsWith('..') && !path.isAbsolute(r) ? r.split(path.sep).join('/') : t.arquivo;
      this.avisar({ tipo: 'pensamento', sessao: id, fase: 'escreveu', rel, linha: null, contexto: [], novas: t.novas.slice(0, 60).map(corta), mais: t.novas.length, menos: t.menos, cortado: t.novas.length > 60 });
    }
  }

  toquesCodex(chamada, j) {
    const { arquivos, mcps } = analisarCodex({ nome: chamada.nome, texto: chamada.texto, escapado: chamada.escapado, base: chamada.base || j.pasta });
    const saida = this.fonte.tipo === 'pasta' ? this.notasCitadas(arquivos) : [];
    // MCP: "mcp__servidor__ferramenta" ou, no Codex novo, "servidor__ferramenta" de um servidor conhecido
    const conhecidos = ['engram', this.fonte.servidor, ...(this.mcps?.estado.servidores || []).map(s => s.id)].filter(Boolean);
    for (const m of mcps) {
      let nome = m.ferramenta;
      if (!nome.startsWith('mcp__')) {
        const servidor = nome.slice(0, nome.indexOf('__'));
        if (!conhecidos.some(s => mesmoServidor(s, servidor))) continue; // web__run, image_gen__...: do próprio Codex
        nome = `mcp__${nome}`;
      }
      saida.push(...this.toques(nome, m.entrada));
    }
    return saida;
  }
}

/** O Codex troca "-" por "_" no nome do servidor MCP: "meu-servidor" e "meu_servidor" são o mesmo. */
function mesmoServidor(a, b) {
  const n = s => String(s || '').toLowerCase().replace(/-/g, '_');
  return n(a) === n(b);
}

function pedePermissao(d) {
  const tipo = String(d.tipo_aviso || '').toLowerCase();
  if (tipo) return tipo.includes('permission');
  const t = String(d.mensagem || '').toLowerCase();
  return t.includes('permission') || t.includes('permissão') || t.includes('approve');
}

// ---------------------------------------------------------------- geometria do palco (x, y = canto de cima à esquerda)

/** Os dois retângulos se encostam (com `folga` de distância mínima)? */
function toca(a, b, folga = 0) {
  return a.x < b.x + b.w + folga && b.x < a.x + a.w + folga && a.y < b.y + b.h + folga && b.y < a.y + a.h + folga;
}
function centro(r) { return { x: r.x + r.w / 2, y: r.y + r.h / 2 }; }
function caixaDe(rs) {
  const x = Math.min(...rs.map(r => r.x)), y = Math.min(...rs.map(r => r.y));
  return { x, y, w: Math.max(...rs.map(r => r.x + r.w)) - x, h: Math.max(...rs.map(r => r.y + r.h)) - y };
}

/**
 * O lugar livre mais perto da âncora para um retângulo w × h: primeiro os `preferidos`, depois em anéis cada vez
 * maiores em volta da âncora (o centro do retângulo procurado), sem encostar em nenhum ocupado. Devolve [x, y].
 */
function acharLugar(w, h, ancora, ocupados, { folga = 60, preferidos = [], passo = 40, aneis = 150 } = {}) {
  const livre = (x, y) => !ocupados.some(o => toca({ x, y, w, h }, o, folga));
  for (const [x, y] of preferidos) if (livre(x, y)) return [Math.round(x), Math.round(y)];
  const x0 = ancora.x - w / 2, y0 = ancora.y - h / 2;
  if (livre(x0, y0)) return [Math.round(x0), Math.round(y0)];
  for (let anel = 1; anel <= aneis; anel++) {
    const pontos = [];
    for (let i = -anel; i <= anel; i++) {
      pontos.push([i, -anel], [i, anel]);
      if (Math.abs(i) < anel) pontos.push([-anel, i], [anel, i]);
    }
    // o palco é mais largo que alto: um passo para o lado custa menos que um para cima ou para baixo
    pontos.sort((a, b) => Math.hypot(a[0], a[1] * 1.5) - Math.hypot(b[0], b[1] * 1.5));
    for (const [i, k] of pontos) {
      const x = x0 + i * passo, y = y0 + k * passo;
      if (livre(x, y)) return [Math.round(x), Math.round(y)];
    }
  }
  // nada livre num raio de 6000 px: embaixo de tudo
  return [Math.round(x0), Math.round(Math.max(y0, ...ocupados.map(o => o.y + o.h)) + folga * 2)];
}

/** O caminho de verdade (segue atalhos e links, nome longo do Windows); sem acesso, o caminho resolvido. */
function real(p) {
  try { return fs.realpathSync.native(path.resolve(String(p))); } catch { return path.resolve(String(p)); }
}

// o que o Engram acrescenta no fim de uma mensagem (anexos, nota do setor): o "assunto" para antes disso
const FIM_DO_ENGRAM = /\n\n\[Arquivos que |\n\n\((?:Mensagem para o setor |[^\n()]{1,60} quis mandar isto ao setor )/;

/**
 * Esconde o que parece segredo num comando antes de mostrar a outro agente (a última ação no equipe): valor
 * depois de token=, senha=, Authorization:, Bearer, --password..., e sequências longas que parecem chave.
 */
function mascarar(texto) {
  return String(texto || '')
    // Authorization: Bearer xxx / Basic xxx (o esquema fica, o valor sai)
    .replace(/((?:proxy-)?authorization["']?\s*[:=]\s*["']?(?:bearer|basic|token|digest)?\s*)[^\s"']+/gi, '$1•••')
    .replace(/(\b(?:bearer|basic)\s+)(?!•)[^\s"']+/gi, '$1•••')
    .replace(/((?:token|access[_-]?token|api[_-]?key|apikey|secret|senha|password|passwd|pwd|chave)["']?\s*(?:[:=]|\s)\s*["']?)[^\s"'&;,]+/gi, '$1•••')
    .replace(/(--(?:password|senha|token|key|api-key)(?:=|\s+))[^\s"']+/gi, '$1•••')
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]+@/gi, '$1•••@') // https://usuario:senha@servidor
    .replace(/((?:\s-u|--user)(?:=|\s+)["']?[^\s:"']+:)[^\s"']+/gi, '$1•••') // curl -u usuario:senha
    .replace(/(\s-p)(?=[^\s-])\S+/g, '$1•••') // mysql -pSEGREDO (com espaço, como em mkdir -p, não é senha)
    .replace(/[A-Za-z0-9_-]{32,}/g, '•••'); // sequência longa sem separador: chave, token (caminhos têm barras e ficam)
}

/** "40 s", "12 min", "2 h 5 min", "3 dias". */
function haQuanto(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const min = Math.floor(s / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return d === 1 ? '1 dia' : `${d} dias`;
}

/** O começo de uma mensagem, numa linha só (o "assunto" que o equipe mostra). */
function assunto(texto, max = 160) {
  const t = String(texto || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** O caminho que a pergunta "Adding a new directory:" mostra (o terminal pode quebrá-lo em mais de uma linha). */
function pastaDoPedido(tela) {
  const m = /Adding a new directory:\s*([\s\S]*?)\s*This session hasn/i.exec(String(tela || ''));
  return m ? m[1].split('\n').map(l => l.trim()).join('') : null;
}

/** Caminho para comparar: sem espaço de quebra, com \, sem barra no fim, minúsculo e com ~ trocado pela pasta do usuário. */
function normalPasta(p) {
  let s = String(p || '').replace(/^~(?=[\\/]|$)/, require('node:os').homedir());
  s = s.replace(/\s+/g, '').replace(/\//g, '\\').replace(/\\+$/, '');
  return s.toLowerCase();
}

/** Número de palco válido (1 a PALCOS) ou null. */
function palcoValido(n) {
  const v = Number(n);
  return n != null && n !== '' && Number.isInteger(v) && v >= 1 && v <= PALCOS ? v : null;
}

function posicaoValida(p) {
  const num = (v, padrao, a, b) => (Number.isFinite(Number(v)) ? Math.max(a, Math.min(Number(v), b)) : padrao);
  return [num(p.x, 0, -1e6, 1e6), num(p.y, 0, -1e6, 1e6), num(p.w, TAMANHO_PADRAO[0], 360, 2400), num(p.h, TAMANHO_PADRAO[1], 240, 1600)];
}

/** A ferramenta que o Codex chamou, numa linha: o arquivo do apply_patch ou o comando. */
function resumoCodex(chamada) {
  const texto = String(chamada.texto || '');
  const patch = /\*\*\* (?:Add|Update|Delete) File: ([^\n\\]+)/.exec(texto);
  if (patch) return `apply_patch ${patch[1].trim()}`;
  return `${chamada.nome || 'ferramenta'} ${texto.replace(/\\n/g, ' ')}`.replace(/\s+/g, ' ').trim().slice(0, 200);
}

function resumoEvento(evento, ferramenta, e, mensagem) {
  if (evento === 'Notification') return mensagem.slice(0, 200);
  if (!ferramenta) return '';
  const nome = ferramenta.replace(/^mcp__[^_]+(?:[-_][^_]+)*?__/, '');
  const alvo = ['para', 'nome', 'caminho', 'pasta', 'sistema', 'id', 'tabela', 'file_path', 'pattern', 'description', 'command'].map(k => e[k]).find(Boolean) || '';
  return `${nome} ${alvo}`.trim().slice(0, 200);
}

module.exports = { Janelas, posicaoValida, palcoValido, acharLugar, caixaDe, mascarar, MotorErro, VARIAVEIS_FORA };
