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

const EVENTOS_GANCHO = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SubagentStop', 'Notification', 'SessionEnd'];
const ESTADO_POR_EVENTO = { SessionStart: 'pronta', UserPromptSubmit: 'pensando', PreToolUse: 'trabalhando', PostToolUse: 'pensando', Stop: 'esperando você', Notification: 'precisa de você' };
const LIVRE = new Set(['pronta', 'esperando você']);
const { PERGUNTA_GERAL: PERGUNTA_TELA } = require('./provedores');
const { lerPergunta, TECLAS, TRABALHANDO } = require('./pergunta');
const OCUPADO_ESTADO = new Set(['pensando', 'trabalhando']);
const FERRAMENTAS_TIME = ['equipe', 'enviar', 'ver_tela', 'criar_agente', 'ligar', 'desligar', 'organizar_palco', 'renomear', 'criar_setor', 'editar_setor', 'remover_setor', 'entregar_arquivo', 'fluxos', 'fluxo_desenhar', 'fluxo_marcar'];
// as cores dos setores, as mesmas da tela (src/tela/js/setores.js)
const CORES_SETOR = { violeta: '#8b7bff', ciano: '#38d6f5', magenta: '#e879f9', ambar: '#ffc857', verde: '#4ade9f', coral: '#ff7a6b' };
const PESSOA = 'pessoa'; // remetente das mensagens que a pessoa digita na vista Conversa
const MAX_BUFFER = 400_000;
const TAMANHO_PADRAO = [700, 470];
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
  }
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
    for (const s of retomar) {
      try {
        const r = await this.abrir({ nome: s.nome, modelo: s.modelo, papel: s.papel, provedor: s.provedor || 'claude', retomar: s.id });
        this.avisar({ tipo: 'aviso', texto: r.conversa_nova ? `${s.nome} foi reaberto (não tinha conversa gravada, então começou uma nova)` : `${s.nome} foi reaberto onde parou` });
      } catch (e) {
        this.cerebro.sessaoEncerrar(s.id);
        this.avisar({ tipo: 'aviso', texto: `não deu para reabrir ${s.nome}: ${e.message}` });
      }
    }
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
    this.ativas.set(s.id, j);
    this.cerebro.sessaoReabrir(s.id, j.estado);
  }

  recolocarMensagens() {
    for (const m of this.cerebro.mensagensPendentes()) {
      const j = this.ativas.get(m.para);
      if (j && !j.caixa.some(([n]) => n === m.n)) j.caixa.push([m.n, m.de, this.revisorAtivo(m.de) === m.para ? this.paraRevisao(m.de, m.para, m.texto) : this.formatar(m.de, m.texto, m.para)]);
    }
    for (const j of this.ativas.values()) this.tentarEntregar(j, 1000);
  }

  async motorCaiu() {
    if (this.reconectando) return;
    this.reconectando = true;
    for (const j of this.ativas.values()) {
      j.viva = false;
      for (const cb of j.ouvintes) cb(null);
    }
    this.ativas.clear();
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
    s.provedor = s.provedor || 'claude';
    s.agente = this.provedores.adaptador(s.provedor)?.nome || s.provedor;
    s.nome_modelo = this.provedores.nomeModelo(s.provedor, s.modelo);
    s.tem_conversa = ['claude', 'codex'].includes(s.provedor);
    s.mcps = s.mcps ? JSON.parse(s.mcps) : null;
    return s;
  }

  async abrir({ nome, modelo = '', papel = 'livre', provedor = 'claude', retomar = null, posicao = null, ligarA = null, tarefa = null, mcps = undefined }) {
    nome = String(nome || '').replace(/[\x00-\x1f\x7f"]/g, '').trim().slice(0, 40) || 'agente';
    const adaptador = this.provedores.adaptador(provedor);
    if (!adaptador) throw new Error('agente desconhecido');
    modelo = String(modelo || '').trim();
    if (!this.provedores.modeloValido(provedor, modelo)) throw new Error('nome de modelo inválido');
    if (!this.cfg.papeis[papel]) throw new Error('papel desconhecido');
    if (this.ativas.size >= this.cfg.max_janelas) throw new Error(`já há ${this.ativas.size} janelas abertas (máximo ${this.cfg.max_janelas})`);
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
      else if (!(provedor === 'codex' && s.externo)) continuar = false; // só o Codex (com o id dele) também retoma
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
      pastas: [pastaArquivos, ...(this.fonte.tipo === 'pasta' ? [this.fonte.pasta] : [])],
      mcpUrl: `http://127.0.0.1:${this.cfg.porta}/mcp`, token: this.token, dirJanelas: this.caminhos.janelas,
      arquivoGanchos: this.arquivoGanchos, runtime: this.motor.runtime, chave: await this.provedores.chaveParaJanela(provedor),
      mcps: listaMcps, soEngram: !!this.mcps?.estado.so_engram, pluginSkills: this.skills?.pluginParaClaude() || null,
    });
    const argv = [...comando, ...montado.argv];

    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !VARIAVEIS_FORA.has(k.toUpperCase())));
    const semProxy = (env.NO_PROXY || '').split(',').filter(Boolean);
    env.NO_PROXY = [...new Set([...semProxy, '127.0.0.1', 'localhost'])].join(',');
    Object.assign(env, montado.env, { ENGRAM_URL: `http://127.0.0.1:${this.cfg.porta}`, ENGRAM_TOKEN: this.token, ENGRAM_SESSAO: id });

    await this.motor.pedir('abrir', { id, argv, cwd, env, linhas: 28, colunas: 100 });
    const j = new Janela(id, this.motor, provedor);
    j.arquivosAssinatura = this.arquivos.assinatura(id);
    this.ativas.set(id, j);
    this.cerebro.sessaoCriar(id, nome, provedor, modelo, papel, cwd);
    // conversa nova: o nome dela é o deste prompt; retomada: continua o nome com que ela começou
    if (!continuar || !anterior?.nome_prompt) this.cerebro.sessaoNomePrompt(id, nome);
    if (mcps !== undefined) this.cerebro.sessaoMcps(id, escolhidos);
    if (posicao) this.cerebro.posicaoSalvar(id, ...posicaoValida(posicao));
    else if (!this.cerebro.posicao(id)) this.cerebro.posicaoSalvar(id, ...this.lugarLivre(ligarA));
    if (ligarA && this.ativas.has(ligarA)) this.cerebro.conectar(ligarA, id);
    if (tarefa) this.enfileirar(j, tarefa[0], tarefa[1]);
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

  lugarLivre(pertoDe) {
    const [w, h] = TAMANHO_PADRAO;
    const ocupados = [...this.ativas.keys()].map(i => this.cerebro.posicao(i)).filter(Boolean);
    const base = pertoDe ? this.cerebro.posicao(pertoDe) : null;
    const candidatos = base
      ? [[base.x + base.w + 140, base.y], [base.x + base.w + 140, base.y + h + 80], [base.x + base.w + 140, base.y - h - 80], [base.x, base.y + base.h + 120]]
      : [0, 1, 2, 3].flatMap(l => [0, 1, 2, 3].map(c => [c * (w + 140), l * (h + 120)]));
    for (const [x, y] of candidatos) if (!ocupados.some(p => Math.abs(x - p.x) < w && Math.abs(y - p.y) < h)) return [x, y, w, h];
    const [x, y] = candidatos[candidatos.length - 1];
    return [x + 60, y + 60, w, h];
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
  }

  /** Assina a saída do terminal: devolve o histórico e uma função para parar. */
  ouvir(id, cb) {
    const j = this.janela(id);
    if (!j) return null;
    j.ouvintes.add(cb);
    return { historico: j.historico(), parar: () => j.ouvintes.delete(cb) };
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
      if (a.ganchos) this.verificarPergunta(id, j); else this.estadoPelaTela(id, j, a);
      try { this.olharPergunta(id, j, a); } catch { /* tela estranha: fica para a próxima volta */ }
      if (!j.conversa) j.conversa = this.acharConversa(id, j);
      if (j.conversa) {
        let tam = j.conversaTam;
        try { tam = fs.statSync(j.conversa).size; } catch { /* some e volta */ }
        if (tam !== j.conversaTam) { j.conversaTam = tam; this.avisar({ tipo: 'conversa', sessao_id: id, tam }); }
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

  /** Os setores do palco com quem está em cada um (para o maestro distribuir o trabalho). */
  setoresDoPalco() {
    const setores = this.cerebro.setores();
    if (!setores.length) return null;
    const membros = new Map(setores.map(s => [s.id, []]));
    for (const id of this.ativas.keys()) { const s = this.cerebro.setorDe(id, setores); if (s) membros.get(s.id).push(this.nomeDe(id)); }
    return setores.map(s => ({ nome: s.nome, ...(s.instrucao ? { instrucao: s.instrucao } : {}), agentes: membros.get(s.id).sort() }));
  }

  /** Lugar livre para um cartão novo dentro do setor; se não couber, o setor cresce para baixo. */
  lugarNoSetor(setor) {
    const [w, h] = TAMANHO_PADRAO, folga = 50;
    const ocupados = [...this.ativas.keys()].map(i => this.cerebro.posicao(i)).filter(Boolean);
    const livre = (x, y) => !ocupados.some(p => x < p.x + p.w + 30 && p.x < x + w + 30 && y < p.y + p.h + 30 && p.y < y + h + 30);
    for (let y = setor.y + folga; y + h <= setor.y + setor.h - folga / 2; y += 60) {
      for (let x = setor.x + folga; x + w <= setor.x + setor.w - folga / 2; x += 60) if (livre(x, y)) return { x, y, w, h };
    }
    // não coube: abre espaço embaixo, sem cortar ninguém
    const fundo = Math.max(setor.y + setor.h, ...ocupados.filter(p => p.x < setor.x + setor.w && p.x + p.w > setor.x && p.y < setor.y + setor.h).map(p => p.y + p.h));
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
    const comLigacoes = c => ({ ...this.descricao(c), fala_com: this.falaCom(c) });
    const colegas = [...this.cerebro.conectados(id)].sort().filter(c => this.ativas.has(c)).map(comLigacoes);
    const r = { voce: this.descricao(id), colegas, sua_pasta_de_arquivos: this.arquivos.pasta(id) };
    if (this.cerebro.sessao(id)?.papel === 'maestro') {
      // o maestro enxerga o palco inteiro, para ligar quem ainda não está no time
      const fora = [...this.ativas.keys()].filter(c => c !== id && !this.cerebro.conectados(id).has(c)).sort().map(comLigacoes);
      if (fora.length) r.no_palco_sem_ligacao_com_voce = fora;
      const setores = this.setoresDoPalco();
      if (setores) r.setores = { explicacao: 'Áreas que a pessoa desenhou no palco. Mande cada tarefa para quem é do setor certo; quem recebe já vê a instrução do setor dele.', lista: setores };
    }
    const meu = this.cerebro.setorDe(id);
    if (meu?.instrucao) r.instrucao_do_seu_setor = meu.instrucao;
    const revisor = this.revisorAtivo(id);
    if (revisor) r.suas_entregas_passam_por = `${this.cerebro.sessao(revisor).nome} (tudo o que você mandar vai para ele revisar antes de seguir)`;
    const revisados = this.cerebro.revisados(id).filter(x => this.ativas.has(x)).map(x => this.cerebro.sessao(x).nome);
    if (revisados.length) r.voce_revisa_as_entregas_de = revisados;
    return r;
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

  enviar(de, para, texto) {
    const alvo = this.achar(para);
    if (!alvo) return `Não há janela aberta chamada "${para}". Veja os nomes com equipe.`;
    if (alvo === de) return 'Você não pode mandar mensagem para você mesmo.';
    // revisão no caminho: tudo o que um agente revisado manda vai para o revisor dele, com a tarefa junto
    const revisor = this.revisorAtivo(de);
    if (revisor) {
      texto = String(texto || '').trim();
      if (!texto) return 'A mensagem está vazia.';
      if (this.cerebro.mensagensNoPar(de, revisor) >= this.cfg.max_mensagens_par_10min) return 'Limite de mensagens entre você e o seu revisor nos últimos 10 minutos. Pare e espere.';
      const j = this.ativas.get(revisor);
      const formatado = this.paraRevisao(de, revisor, texto.slice(0, 20_000), alvo === revisor ? null : alvo);
      const posicao = this.enfileirar(j, de, texto.slice(0, 20_000), formatado);
      const nomeR = this.cerebro.sessao(revisor).nome;
      const desvio = alvo === revisor ? '' : ` Suas entregas passam por ${nomeR}: ele revisa antes de chegar a ${this.cerebro.sessao(alvo).nome}.`;
      return `Mensagem entregue a ${nomeR}${posicao ? ` (entra quando ele terminar o turno, ${posicao} na frente)` : ''}.${desvio}`;
    }
    if (!this.cerebro.conectados(de).has(alvo)) return `Você não está ligado a "${para}" no palco. Só dá para falar com quem está ligado a você (a pessoa liga arrastando uma linha entre os cartões).`;
    if (this.cerebro.mensagensNoPar(de, alvo) >= this.cfg.max_mensagens_par_10min) return 'Limite de mensagens entre vocês dois nos últimos 10 minutos. Pare e espere: isso costuma ser dois agentes respondendo um ao outro em loop.';
    texto = String(texto || '').trim();
    if (!texto) return 'A mensagem está vazia.';
    const j = this.ativas.get(alvo);
    const posicao = this.enfileirar(j, de, texto.slice(0, 20_000));
    const nome = this.cerebro.sessao(alvo).nome;
    if (posicao === 0) return `Mensagem entregue a ${nome}. A resposta chega aqui como uma mensagem do Engram.`;
    return `${nome} está ${j.estado}. A mensagem entra quando ele terminar o turno (${posicao} na frente dela). A resposta chega aqui como uma mensagem do Engram.`;
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
      setor = this.cerebro.setores().find(x => x.nome.toLowerCase() === String(nomeSetor).trim().toLowerCase());
      if (!setor) return `Não há setor chamado "${nomeSetor}" no palco. ${this.setoresDoPalco() ? `Setores: ${this.setoresDoPalco().map(x => x.nome).join(', ')}.` : 'A pessoa ainda não desenhou setores.'}`;
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
  pontas(qa, qb) {
    const a = this.achar(qa), b = this.achar(qb);
    if (!a) return { erro: `Não há janela aberta chamada "${qa}". Veja os nomes com equipe.` };
    if (!b) return { erro: `Não há janela aberta chamada "${qb}". Veja os nomes com equipe.` };
    if (a === b) return { erro: 'As duas pontas são a mesma janela.' };
    return { a, b };
  }

  ligarJanelas(de, qa, qb) {
    if (!this.ehMaestro(de)) return 'Só o maestro liga agentes. Peça à pessoa (ela liga arrastando uma linha entre os cartões).';
    const p = this.pontas(qa, qb);
    if (p.erro) return p.erro;
    const nomes = `${this.nomeDe(p.a)} e ${this.nomeDe(p.b)}`;
    if (!this.cerebro.conectar(p.a, p.b)) return `${nomes} já estavam ligados.`;
    this.avisar({ tipo: 'conexao', acao: 'criada', a: p.a, b: p.b });
    return `Liguei ${nomes}: agora os dois conversam pelo enviar.`;
  }

  desligarJanelas(de, qa, qb, confirmarRevisao = false) {
    if (!this.ehMaestro(de)) return 'Só o maestro desliga agentes. Peça à pessoa (ela clica na linha e escolhe remover).';
    const p = this.pontas(qa, qb);
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
    const tamanho = id => { const p = this.cerebro.posicao(id); return p ? [p.w, p.h] : TAMANHO_PADRAO; };
    const novas = [];
    if (modo === 'lista') {
      if (!Array.isArray(posicoes) || !posicoes.length) return 'No modo "lista", mande posicoes: [{ nome, x, y }].';
      const desconhecidos = [];
      for (const item of posicoes.slice(0, 40)) {
        const id = this.achar(item?.nome);
        if (!id) { desconhecidos.push(String(item?.nome ?? '')); continue; }
        const [w, h] = tamanho(id);
        const [x, y] = posicaoValida({ x: item.x, y: item.y, w, h });
        novas.push({ id, x, y, w, h });
      }
      if (desconhecidos.length) return `Não mexi em nada: não há janela aberta chamada ${desconhecidos.map(n => `"${n}"`).join(', ')}. Veja os nomes com equipe.`;
    } else if (modo === 'time') {
      // quem está num setor fica onde está (o setor é a arrumação da pessoa); os setores viram obstáculos
      const setores = this.cerebro.setores();
      const noSetor = id => !!this.cerebro.setorDe(id, setores);
      const papelDe = id => this.cerebro.sessao(id)?.papel || 'livre';
      const colegas = [...this.ativas.keys()].filter(id => id !== de && !noSetor(id))
        .sort((x, y) => papelDe(x).localeCompare(papelDe(y)) || this.nomeDe(x).localeCompare(this.nomeDe(y)));
      if (!colegas.length) return 'Nada para arrumar: todos os colegas estão dentro de setores, e eles ficam onde a pessoa deixou.';
      // o maestro fica onde está e vira o centro (assim ele não cai em cima de um setor)
      const [mw, mh] = tamanho(de);
      const pm = this.cerebro.posicao(de);
      const centro = pm ? { x: pm.x + pm.w / 2, y: pm.y + pm.h / 2 } : { x: 0, y: 0 };
      const maestro = { id: de, x: Math.round(centro.x - mw / 2), y: Math.round(centro.y - mh / 2), w: mw, h: mh };
      if (!pm) novas.push(maestro);
      const obstaculos = [maestro, ...setores.map(s => ({ x: s.x, y: s.y - 60, w: s.w, h: s.h + 60 }))]; // 60: a etiqueta em cima
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
    this.avisar({ tipo: 'palco', acao: 'organizado', posicoes: novas });
    if (modo === 'lista') return `Movi ${novas.length === 1 ? '1 cartão' : `${novas.length} cartões`} no palco.`;
    const movidos = novas.filter(n => n.id !== de).length;
    const emSetor = [...this.ativas.keys()].filter(id => id !== de && this.cerebro.setorDe(id)).length;
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
    const id = this.achar(quem);
    if (!id) return `Não há janela aberta chamada "${quem}". Veja os nomes com equipe.`;
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
  agentesPorNome(nomes) {
    const lista = (Array.isArray(nomes) ? nomes : []).map(n => String(n ?? '').trim()).filter(Boolean);
    if (!lista.length) return { erro: 'Diga quais agentes ficam no setor, em agentes: ["nome", ...] (os nomes como aparecem em equipe).' };
    const ids = [], faltam = [];
    for (const n of lista) { const id = this.achar(n); if (id) { if (!ids.includes(id)) ids.push(id); } else faltam.push(`"${n}"`); }
    if (faltam.length) return { erro: `Não há janela aberta chamada ${faltam.join(', ')}. Veja os nomes com equipe.` };
    return { ids };
  }

  /**
   * A área de um setor em volta destes agentes. Se o retângulo pegaria alguém de fora ou encostaria
   * noutro setor, junta os cartões numa grade num lugar livre e envolve a grade.
   */
  areaEmVolta(ids, ignorar = null) {
    const FOLGA = 60, VAO = 60, ETIQUETA = 70;
    const [pw, ph] = TAMANHO_PADRAO;
    const pos = id => this.cerebro.posicao(id) || { x: 0, y: 0, w: pw, h: ph };
    const caixa = ps => {
      const x = Math.min(...ps.map(p => p.x)) - FOLGA, y = Math.min(...ps.map(p => p.y)) - FOLGA;
      return { x, y, w: Math.max(...ps.map(p => p.x + p.w)) + FOLGA - x, h: Math.max(...ps.map(p => p.y + p.h)) + FOLGA - y };
    };
    const encosta = (a, b, m = 0) => a.x < b.x + b.w + m && b.x < a.x + a.w + m && a.y < b.y + b.h + m && b.y < a.y + a.h + m;
    const setores = this.cerebro.setores().filter(s => s.id !== ignorar).map(s => ({ x: s.x, y: s.y - ETIQUETA, w: s.w, h: s.h + ETIQUETA }));
    const outros = [...this.ativas.keys()].filter(id => !ids.includes(id)).map(pos);
    const centroDentro = (p, r) => p.x + p.w / 2 > r.x && p.x + p.w / 2 < r.x + r.w && p.y + p.h / 2 > r.y && p.y + p.h / 2 < r.y + r.h;
    const r = caixa(ids.map(pos));
    const comEtiqueta = { x: r.x, y: r.y - ETIQUETA, w: r.w, h: r.h + ETIQUETA };
    if (!outros.some(p => centroDentro(p, r)) && !setores.some(s => encosta(comEtiqueta, s))) return { area: r, movidos: [] };
    // junta numa grade: primeiro onde o grupo já está, senão à direita ou embaixo de tudo
    const tams = ids.map(pos), w = Math.max(...tams.map(t => t.w)), h = Math.max(...tams.map(t => t.h));
    const cols = Math.ceil(Math.sqrt(ids.length)), linhas = Math.ceil(ids.length / cols);
    const larg = cols * w + (cols - 1) * VAO + 2 * FOLGA, alt = linhas * h + (linhas - 1) * VAO + 2 * FOLGA;
    const ocupados = [...outros, ...setores];
    const livre = (x, y) => !ocupados.some(o => encosta({ x, y: y - ETIQUETA, w: larg, h: alt + ETIQUETA }, o, 80));
    const tudo = ocupados.length ? caixa([...ocupados, ...tams]) : r;
    const candidatos = [[r.x, r.y], [tudo.x + tudo.w + 200, r.y], [r.x, tudo.y + tudo.h + 200 + ETIQUETA]];
    let [ox, oy] = candidatos.find(([x, y]) => livre(x, y)) || [tudo.x + tudo.w + 200, tudo.y];
    ox = Math.round(ox); oy = Math.round(oy);
    const movidos = ids.map((id, i) => ({ id, x: ox + FOLGA + (i % cols) * (w + VAO), y: oy + FOLGA + Math.floor(i / cols) * (h + VAO), w: tams[i].w, h: tams[i].h }));
    return { area: { x: ox, y: oy, w: larg, h: alt }, movidos };
  }

  criarSetor(de, { nome, cor, instrucao, agentes } = {}) {
    if (!this.ehMaestro(de)) return 'Só o maestro cria setores. Peça à pessoa (ela desenha com o botão Setor no palco).';
    nome = String(nome ?? '').trim().slice(0, 24);
    if (!nome) return 'Dê um nome ao setor.';
    const setores = this.cerebro.setores();
    const igual = setores.find(s => s.nome.toLowerCase() === nome.toLowerCase());
    if (igual) return `Já existe o setor ${igual.nome}. Para mudar, use editar_setor.`;
    const a = this.agentesPorNome(agentes);
    if (a.erro) return a.erro;
    const usadas = new Set(setores.map(s => s.cor));
    const hex = CORES_SETOR[cor] || Object.values(CORES_SETOR).find(c => !usadas.has(c)) || Object.values(CORES_SETOR)[setores.length % 6];
    const { area, movidos } = this.areaEmVolta(a.ids);
    for (const m of movidos) this.cerebro.posicaoSalvar(m.id, m.x, m.y, m.w, m.h);
    const s = { id: `setor-${crypto.randomUUID().slice(0, 8)}`, nome, cor: hex, instrucao: String(instrucao ?? '').trim().slice(0, 2000), ...area };
    this.cerebro.setorSalvar(s);
    if (movidos.length) this.avisar({ tipo: 'palco', acao: 'organizado', posicoes: movidos });
    this.avisar({ tipo: 'setor', acao: 'salvo', setor: s });
    const nomes = a.ids.map(id => this.nomeDe(id)).join(', ');
    return `Criei o setor ${nome} com ${nomes}.${movidos.length ? ' Juntei os cartões deles num lugar livre, porque em volta de onde estavam o setor pegaria outros agentes ou encostaria noutro setor.' : ''}${s.instrucao ? ' A instrução do setor vai junto em cada tarefa que eles receberem.' : ''}`;
  }

  editarSetor(de, { setor, nome, cor, instrucao, agentes } = {}) {
    if (!this.ehMaestro(de)) return 'Só o maestro muda setores.';
    const setores = this.cerebro.setores();
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
      const a = this.agentesPorNome(agentes);
      if (a.erro) return a.erro;
      const r = this.areaEmVolta(a.ids, s.id);
      Object.assign(novo, r.area);
      movidos = r.movidos;
      for (const m of movidos) this.cerebro.posicaoSalvar(m.id, m.x, m.y, m.w, m.h);
    }
    this.cerebro.setorSalvar(novo);
    if (movidos.length) this.avisar({ tipo: 'palco', acao: 'organizado', posicoes: movidos });
    this.avisar({ tipo: 'setor', acao: 'salvo', setor: novo });
    const membros = [...this.ativas.keys()].filter(id => this.cerebro.setorDe(id)?.id === s.id).map(id => this.nomeDe(id));
    return `Setor ${novo.nome} atualizado. Dentro dele: ${membros.length ? membros.join(', ') : 'ninguém'}.${movidos.length ? ' Juntei os cartões num lugar livre.' : ''}`;
  }

  removerSetor(de, { setor } = {}) {
    if (!this.ehMaestro(de)) return 'Só o maestro remove setores.';
    const s = this.cerebro.setores().find(x => x.nome.toLowerCase() === String(setor ?? '').trim().toLowerCase());
    if (!s) return `Não há setor chamado "${setor}".`;
    this.cerebro.setorApagar(s.id);
    this.avisar({ tipo: 'setor', acao: 'removido', id: s.id });
    return `Removi o setor ${s.nome}. Os agentes continuam no palco, só saíram do setor.`;
  }

  entregarArquivo(de, caminho, nome) {
    try {
      const destino = this.arquivos.copiar(de, 'entregues', caminho, nome, this.cfg.max_arquivo_mb * 1048576);
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

  enfileirar(j, de, texto, formatado = null) {
    const n = this.cerebro.mensagemRegistrar(de, j.id, texto);
    const naFrente = j.caixa.length + (j.entregando || !LIVRE.has(j.estado) ? 1 : 0);
    j.caixa.push([n, de, (formatado || this.formatar(de, texto, j.id)) + this.avisoDeNome(j.id)]);
    this.avisar({ tipo: 'mensagem', fase: 'enviada', de, para: j.id, texto: texto.slice(0, 240), n });
    this.tentarEntregar(j);
    return naFrente;
  }

  tentarEntregar(j, espera = 0) {
    if (!j.viva || j.entregando || !j.caixa.length || !LIVRE.has(j.estado)) return;
    j.entregando = true;
    setTimeout(() => this.colar(j), espera);
  }

  colar(j) {
    if (!j.viva || !j.caixa.length || !LIVRE.has(j.estado)) { j.entregando = false; return; }
    const [n, de, texto] = j.caixa.shift();
    j.escrever(COLAR_INICIO + texto.replace(/\r\n/g, '\n') + COLAR_FIM);
    j.estado = 'pensando'; // até o gancho confirmar, ninguém mais cola por cima
    j.teveTurno = true;
    const a = this.provedores.adaptador(j.provedor) || {};
    // o Codex no Windows trata um Enter colado logo depois do texto como parte da colagem (vira quebra de linha)
    const espera = a.enterDepois || 400;
    j.ocupadoAte = Date.now() + espera + 5000;
    setTimeout(() => {
      j.escrever('\r');
      j.entregando = false;
      this.cerebro.mensagemEntregue(n);
      this.cerebro.sessaoEstado(j.id, 'pensando');
      this.avisar({ tipo: 'mensagem', fase: 'entregue', de, para: j.id, n });
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
    const ferramenta = dados.ferramenta || null;
    const entrada = dados.entrada && typeof dados.entrada === 'object' ? dados.entrada : {};
    let estado = ESTADO_POR_EVENTO[evento] || null;
    if (evento === 'Notification' && !pedePermissao(dados)) {
      // "parado há um tempo": o agente espera entrada; não trava a caixa e ainda destrava entrega
      estado = j.estado === 'precisa de você' ? null : 'esperando você';
    }
    if (estado) { j.estado = estado; this.cerebro.sessaoEstado(id, estado); }
    if (evento === 'SessionStart' || evento === 'UserPromptSubmit') j.pergunta = null;
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
    const toques = evento === 'PostToolUse' ? this.toques(ferramenta, entrada) : [];
    for (const [destino, tipo, rel] of toques) {
      this.cerebro.registrarToque(id, destino, tipo);
      if (tipo === 'gravou' && rel) this.cerebro.sincronizarArquivo(rel).then(erro => this.avisar({ tipo: 'cerebro', mudou: rel, erro }));
    }
    this.avisar({ tipo: 'evento', sessao_id: id, evento, estado, ferramenta, resumo, toques: toques.map(([d, t]) => ({ destino: d, tipo: t })), ...(semPergunta === null ? { pergunta: null } : {}) });
    try { this.aoEvento?.(id, evento, ferramenta, entrada); } catch { /* quem acompanha não atrapalha o agente */ }
    if (evento === 'SessionStart') this.tentarEntregar(j, 2000); // a tela do agente ainda está montando
    else if (evento === 'Stop' || evento === 'Notification') this.tentarEntregar(j, 600);
  }

  /** O que a ferramenta tocou: notas do cérebro e servidores MCP. */
  toques(ferramenta, entrada) {
    if (!ferramenta) return [];
    const saida = [];
    const nota = caminho => {
      const rel = this.fonte.relativo(caminho);
      return rel ? [idDoCaminho(rel), rel] : null;
    };
    if (this.fonte.tipo === 'pasta' && ['Read', 'Write', 'Edit', 'MultiEdit'].includes(ferramenta)) {
      const n = nota(entrada.file_path);
      if (n) saida.push([n[0], ferramenta === 'Read' ? 'leu' : 'gravou', n[1]]);
    }
    const m = /^mcp__([^_]+(?:[-_][^_]+)*?)__(.+)$/.exec(ferramenta);
    if (m && m[1] !== 'engram') {
      const [, servidor, nomeF] = m;
      if (this.fonte.tipo === 'remoto' && servidor === this.fonte.servidor && /^arquivos_(ler|gravar|editar)$/.test(nomeF)) {
        const n = nota(entrada.caminho);
        if (n) saida.push([n[0], nomeF === 'arquivos_ler' ? 'leu' : 'gravou', n[1]]);
      } else if (!/^arquivos_/.test(nomeF)) {
        saida.push([servidor, 'consultou', null]);
      }
    }
    return saida;
  }
}

function pedePermissao(d) {
  const tipo = String(d.tipo_aviso || '').toLowerCase();
  if (tipo) return tipo.includes('permission');
  const t = String(d.mensagem || '').toLowerCase();
  return t.includes('permission') || t.includes('permissão') || t.includes('approve');
}

function posicaoValida(p) {
  const num = (v, padrao, a, b) => (Number.isFinite(Number(v)) ? Math.max(a, Math.min(Number(v), b)) : padrao);
  return [num(p.x, 0, -1e6, 1e6), num(p.y, 0, -1e6, 1e6), num(p.w, TAMANHO_PADRAO[0], 360, 2400), num(p.h, TAMANHO_PADRAO[1], 240, 1600)];
}

function resumoEvento(evento, ferramenta, e, mensagem) {
  if (evento === 'Notification') return mensagem.slice(0, 200);
  if (!ferramenta) return '';
  const nome = ferramenta.replace(/^mcp__[^_]+(?:[-_][^_]+)*?__/, '');
  const alvo = ['para', 'nome', 'caminho', 'pasta', 'sistema', 'id', 'tabela', 'file_path', 'pattern', 'description', 'command'].map(k => e[k]).find(Boolean) || '';
  return `${nome} ${alvo}`.trim().slice(0, 200);
}

module.exports = { Janelas, posicaoValida, MotorErro, VARIAVEIS_FORA };
