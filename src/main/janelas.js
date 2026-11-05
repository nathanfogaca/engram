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
const FERRAMENTAS_TIME = ['equipe', 'enviar', 'ver_tela', 'criar_agente', 'entregar_arquivo'];
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
    for (const t of lista.terminais) if (t.id.startsWith('aux-')) { this.motor.mandar('fechar', { id: t.id }); this.motor.mandar('esquecer', { id: t.id }); }
    const retomar = [];
    for (const s of this.cerebro.sessoes(500)) {
      if (vivos.has(s.id)) { if (!this.ativas.has(s.id)) await this.reanexar(s); }
      else if (s.manter) retomar.push(s);
      else if (!s.encerrada) this.cerebro.sessaoEncerrar(s.id);
    }
    for (const s of retomar) {
      try {
        await this.abrir({ nome: s.nome, modelo: s.modelo, papel: s.papel, provedor: s.provedor || 'claude', retomar: s.id });
        this.avisar({ tipo: 'aviso', texto: `${s.nome} foi reaberto onde parou` });
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
      if (j && !j.caixa.some(([n]) => n === m.n)) j.caixa.push([m.n, m.de, this.formatar(m.de, m.texto)]);
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
      id, nome, modelo, prompt, arqPrompt, retomar: !!retomar, externo: anterior?.externo || null,
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

    await this.motor.pedir('abrir', { id, argv, cwd: this.cfg.pasta_trabalho, env, linhas: 28, colunas: 100 });
    const j = new Janela(id, this.motor, provedor);
    j.arquivosAssinatura = this.arquivos.assinatura(id);
    this.ativas.set(id, j);
    this.cerebro.sessaoCriar(id, nome, provedor, modelo, papel, this.cfg.pasta_trabalho);
    if (mcps !== undefined) this.cerebro.sessaoMcps(id, escolhidos);
    if (posicao) this.cerebro.posicaoSalvar(id, ...posicaoValida(posicao));
    else if (!this.cerebro.posicao(id)) this.cerebro.posicaoSalvar(id, ...this.lugarLivre(ligarA));
    if (ligarA && this.ativas.has(ligarA) && this.cerebro.conectar(ligarA, id)) this.avisar({ tipo: 'conexao', acao: 'criada', a: ligarA, b: id });
    if (tarefa) this.enfileirar(j, tarefa[0], tarefa[1]);
    const info = this.info(id);
    this.avisar({ tipo: 'sessao', sessao: info });
    return info;
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

  janela(id) { return this.ativas.get(id) || this.auxiliares.get(id); }

  // ---------------------------------------------------------------- terminal

  motorSaida(id, texto) {
    const j = this.janela(id);
    if (!j) return;
    j.guardar(texto);
    for (const cb of j.ouvintes) cb(texto);
  }

  motorFim(id) {
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

  /** Agentes sem ganchos (Codex, Gemini, OpenCode): o estado sai da tela e do aviso de fim de turno. */
  estadoPelaTela(id, j, a) {
    const agora = Date.now();
    const tela = j.tela.texto(30);
    if (tela !== j.telaAnterior) { j.telaAnterior = tela; j.telaMudouEm = agora; }
    const fim = tela.split('\n').slice(-12).join('\n');
    let novo;
    if ((a.pergunta || PERGUNTA_TELA).test(fim)) novo = 'precisa de você';
    else if (a.ocupado && a.ocupado.test(fim)) novo = 'trabalhando';
    else if (agora < j.ocupadoAte || agora - j.telaMudouEm < 2500 || agora - j.criadaEm < 4000) return;
    else novo = j.teveTurno ? 'esperando você' : 'pronta';
    if (novo !== j.estado) this.mudarEstado(id, j, novo, 'Tela');
  }

  mudarEstado(id, j, novo, origem) {
    const antes = j.estado;
    j.estado = novo;
    j.pergunta = novo === 'precisa de você' ? { tipo: 'terminal', texto: 'O agente está esperando uma resposta no terminal.' } : null;
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
    return {
      nome: s.nome,
      papel: this.cfg.papeis[s.papel]?.nome || s.papel,
      agente: this.provedores.adaptador(s.provedor || 'claude')?.nome || s.provedor,
      modelo: this.provedores.nomeModelo(s.provedor || 'claude', s.modelo),
      estado: j ? j.estado : 'encerrada',
      mensagens_na_fila: j ? j.caixa.length : 0,
    };
  }

  equipe(id) {
    const colegas = [...this.cerebro.conectados(id)].sort().filter(c => this.ativas.has(c)).map(c => this.descricao(c));
    return { voce: this.descricao(id), colegas, sua_pasta_de_arquivos: this.arquivos.pasta(id) };
  }

  enviar(de, para, texto) {
    const alvo = this.achar(para);
    if (!alvo) return `Não há janela aberta chamada "${para}". Veja os nomes com equipe.`;
    if (alvo === de) return 'Você não pode mandar mensagem para você mesmo.';
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

  async criarAgente(de, nome, papel, modelo, tarefa, provedor = null) {
    const s = this.cerebro.sessao(de);
    if (!s || s.papel !== 'maestro') return 'Só o maestro cria agentes.';
    if (papel === 'maestro') return 'O time tem um maestro só.';
    try {
      const info = await this.abrir({ nome, modelo, papel, provedor: provedor || s.provedor || 'claude', ligarA: de, tarefa: tarefa && String(tarefa).trim() ? [de, String(tarefa).trim()] : null });
      const d = this.descricao(info.id);
      return `Criei ${info.nome} (${d.papel}, ${d.agente}, ${d.modelo}), já ligado a você.${tarefa ? ' A tarefa entra assim que ele estiver pronto.' : ''}`;
    } catch (e) {
      return `Não deu para criar: ${e.message}.`;
    }
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

  formatar(de, texto) {
    if (de === PESSOA) return texto;
    const r = this.descricao(de);
    return `[Engram · mensagem de ${r.nome} (${r.papel}, ${r.modelo})]\n${texto}\n\n(Para responder, use mcp__engram__enviar com para="${r.nome}".)`;
  }

  enfileirar(j, de, texto) {
    const n = this.cerebro.mensagemRegistrar(de, j.id, texto);
    const naFrente = j.caixa.length + (j.entregando || !LIVRE.has(j.estado) ? 1 : 0);
    j.caixa.push([n, de, this.formatar(de, texto)]);
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
    const resumo = resumoEvento(evento, ferramenta, entrada, String(dados.mensagem || ''));
    if (['UserPromptSubmit', 'PreToolUse', 'Stop', 'Notification', 'SessionStart'].includes(evento)) this.cerebro.registrarEvento(id, evento, ferramenta, resumo);
    const toques = evento === 'PostToolUse' ? this.toques(ferramenta, entrada) : [];
    for (const [destino, tipo, rel] of toques) {
      this.cerebro.registrarToque(id, destino, tipo);
      if (tipo === 'gravou' && rel) this.cerebro.sincronizarArquivo(rel).then(erro => this.avisar({ tipo: 'cerebro', mudou: rel, erro }));
    }
    this.avisar({ tipo: 'evento', sessao_id: id, evento, estado, ferramenta, resumo, toques: toques.map(([d, t]) => ({ destino: d, tipo: t })) });
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

module.exports = { Janelas, posicaoValida, MotorErro };
