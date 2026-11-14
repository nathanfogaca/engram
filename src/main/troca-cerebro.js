// O cérebro tem duas fontes guardadas ao mesmo tempo em cfg.cerebro: a pasta neste computador (pasta) e o
// servidor (url, token_env, ca, pasta_remota, servidor = nome do MCP com que os agentes o enxergam). O campo
// "fonte" diz qual está em uso, e a pessoa alterna na hora, pelo palco, sem reiniciar o app.
//
// Trocar: confere a fonte nova (o servidor tem de responder), troca o índice (o da fonte que sai fica guardado
// no banco e o da que entra volta na hora), passa a vigiar a nova e sincroniza só o que mudou. Se o servidor não
// responder, o cérebro fica no Local: o palco nunca fica sem cérebro.
//
// Nesta versão a fonte é uma só para todos os palcos. Para virar por palco, cada palco guardaria a sua fonte, o
// índice ganharia a chave da fonte em cada nota e quem lê o cérebro (Cerebro, Janelas) pediria a fonte do palco
// em vez de usar this.fonte. O resto (testar, aplicar, avisar) serve como está.

const fs = require('node:fs');
const path = require('node:path');
const { FontePasta, FonteRemota } = require('./fontes');

// variáveis que guardam a chave de outro serviço (modelos, nuvens, git) ou do próprio Engram: o valor da variável do
// token vai para o servidor do cérebro, então essas ficam de fora
const VARIAVEL_PROIBIDA = /^(ANTHROPIC|CLAUDE|OPENAI|CODEX|GEMINI|GOOGLE|GCLOUD|AZURE|AWS|GITHUB|GH|GITLAB|NPM|HF|HUGGINGFACE|MISTRAL|COHERE|GROQ|DEEPSEEK|OPENROUTER|XAI|OPENCODE)(_|$)|^ENGRAM_(TOKEN|SESSAO|URL)$/i;
const NOME_MCP = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

class TrocaDeCerebro {
  constructor({ cfg, cerebro, janelas, mcps, avisar, salvarCerebro, sincronizar, registrar, fonte, pastaPadrao }) {
    Object.assign(this, { cfg, cerebro, janelas, mcps, avisar, salvarCerebro, sincronizar, pastaPadrao });
    this.registrar = registrar || (() => {});
    this.fonte = fonte;
    this.trocando = null;
    this.erroServidor = null;
    this.aoTrocar = []; // quem mais guarda a fonte (ex.: o diário) e precisa saber da nova
  }

  servidorConfigurado() { return /^https?:\/\//i.test(String(this.cfg.cerebro.url || '').trim()); }

  /** O nome que aparece no rótulo: o do MCP cadastrado com o mesmo endereço, o nome configurado ou o host. */
  nomeServidor() {
    if (!this.servidorConfigurado()) return null;
    const m = this.mcps?.porUrl?.(this.cfg.cerebro.url);
    if (m) return m.nome || m.id;
    const configurado = String(this.cfg.cerebro.servidor || '').trim();
    if (configurado && configurado !== 'cerebro') return configurado;
    try { return new URL(this.cfg.cerebro.url).hostname; } catch { return configurado || 'servidor'; }
  }

  estado() {
    return {
      ativa: this.fonte.tipo,
      trocando: this.trocando,
      local: { pasta: this.fonte.tipo === 'pasta' ? this.fonte.pasta : this.cfg.cerebro.pasta },
      servidor: { configurado: this.servidorConfigurado(), nome: this.nomeServidor(), erro: this.erroServidor },
    };
  }

  criar(tipo) {
    if (tipo === 'remoto') {
      // os agentes enxergam o servidor pelo nome do MCP cadastrado com o mesmo endereço
      const m = this.mcps?.porUrl?.(this.cfg.cerebro.url);
      if (m) this.cfg.cerebro.servidor = m.id;
      return new FonteRemota(this.cfg.cerebro);
    }
    return new FontePasta(this.cfg.cerebro.pasta || this.pastaPadrao);
  }

  /** Passa a vigiar a fonte em uso (a pasta avisa quando um arquivo muda; o servidor é lido de tempos em tempos). */
  vigiar() { this.fonte.observar(() => this.sincronizar()); }

  /**
   * Troca a fonte em uso. `refazer`: a mesma fonte, mas a configuração dela mudou (Ajustes). Responde quando
   * terminar; se o servidor não responder, lança o erro com a mensagem pronta e o cérebro fica no Local.
   */
  async trocar(tipo, { refazer = false } = {}) {
    if (tipo !== 'pasta' && tipo !== 'remoto') throw new Error('fonte desconhecida: use "pasta" ou "remoto"');
    if (this.trocando) throw new Error('o cérebro já está trocando: espere terminar');
    if (!refazer && tipo === this.fonte.tipo) return { ativa: tipo, mudou: false };
    if (tipo === 'remoto' && !this.servidorConfigurado()) throw new Error('o servidor do cérebro não está configurado: preencha em Ajustes > Geral > Cérebro');
    this.trocando = tipo;
    this.avisar({ tipo: 'cerebro_fonte', acao: 'trocando', para: tipo });
    const falhou = erro => { this.registrar(erro); this.avisar({ tipo: 'cerebro_fonte', acao: 'falhou', ativa: this.fonte.tipo, erro }); return new Error(erro); };
    try {
      let nova;
      try {
        nova = this.criar(tipo);
        await nova.testar();
      } catch (e) {
        const motivo = String(e?.message || e).slice(0, 240);
        if (tipo !== 'remoto') throw falhou(`a pasta do cérebro não abriu (${motivo}): o cérebro continua ${this.fonte.tipo === 'remoto' ? 'no Servidor' : 'como estava'}`);
        this.erroServidor = motivo;
        // o palco nunca fica sem cérebro: se o servidor em uso foi reconfigurado e não responde, volta para o Local
        let voltou = false;
        if (this.fonte.tipo === 'remoto') {
          try { const local = this.criar('pasta'); await local.testar(); this.aplicar(local); voltou = true; } catch (e2) { this.registrar(`cérebro: nem a pasta local abriu (${e2.message})`); }
        }
        throw falhou(`o servidor do cérebro não respondeu (${motivo}): o cérebro ${voltou ? 'voltou para o' : 'continua no'} Local`);
      }
      if (tipo === 'remoto') this.erroServidor = null;
      try { this.aplicar(nova); } catch (e) { throw falhou(`não deu para trocar o índice do cérebro (${String(e?.message || e).slice(0, 200)}): ele continua como estava`); }
      return { ativa: tipo, mudou: true };
    } finally {
      this.trocando = null;
    }
  }

  /**
   * Põe a fonte nova em uso. O índice troca primeiro, numa transação: se falhar, nada mudou (a fonte antiga
   * continua em uso e vigiada) e o erro sobe.
   */
  aplicar(nova) {
    const antiga = this.fonte;
    // o índice da fonte que sai fica guardado; o da que entra volta na hora (a constelação já aparece)
    this.cerebro.trocarIndice(antiga.chave, nova.chave);
    try { antiga.parar?.(); } catch { /* segue */ }
    this.fonte = nova;
    this.cerebro.fonte = nova;
    this.janelas.fonte = nova;
    for (const f of this.aoTrocar) { try { f(nova); } catch { /* segue */ } }
    this.cfg.cerebro.fonte = nova.tipo;
    try { this.salvarCerebro({ fonte: nova.tipo }); } catch (e) { this.registrar(`cérebro: não gravou a fonte no config.json (${e.message})`); }
    this.vigiar();
    this.registrar(`cérebro: agora ${nova.tipo === 'remoto' ? `no servidor (${this.nomeServidor()})` : `na pasta ${nova.pasta}`}`);
    this.avisar({ tipo: 'cerebro_fonte', acao: 'trocado', ativa: nova.tipo, nome: nova.tipo === 'remoto' ? this.nomeServidor() : null });
    Promise.resolve().then(() => this.sincronizar()).catch(() => {}); // lê só o que mudou desde a última vez
  }

  /** Assinatura da configuração de uma fonte: mudou, a fonte em uso é refeita. */
  assinatura(tipo, c = this.cfg.cerebro) {
    return tipo === 'remoto'
      ? JSON.stringify(['remoto', c.url || '', c.token_env || '', c.ca || '', c.pasta_remota || 'cerebro'])
      : JSON.stringify(['pasta', path.resolve(c.pasta || this.pastaPadrao).toLowerCase()]);
  }

  /**
   * Confere o que veio dos Ajustes, sem gravar nada: devolve os campos limpos ou lança o erro de preenchimento.
   * A rota chama antes de gravar o resto dos Ajustes, para um erro aqui não deixar metade gravada.
   */
  validarAjuste(b = {}) {
    if (this.trocando) throw new Error('o cérebro está trocando agora: espere terminar e salve de novo');
    const c = {};
    if (b.pasta !== undefined) {
      const p = String(b.pasta || '').trim();
      if (p) {
        try { fs.mkdirSync(p, { recursive: true }); } catch (e) { throw new Error(`a pasta do cérebro não pode ser criada (${e.message})`); }
        if (!fs.statSync(p).isDirectory()) throw new Error('o caminho da pasta do cérebro não é uma pasta');
      }
      c.pasta = p;
    }
    if (b.url !== undefined) {
      const u = String(b.url || '').trim();
      if (u && !/^https?:\/\/[^\s/]+/i.test(u)) throw new Error('o endereço do servidor tem de começar com http:// ou https://');
      if (u) { try { new URL(u); } catch { throw new Error('o endereço do servidor não é válido'); } }
      c.url = u;
    }
    if (b.token_env !== undefined) {
      const t = String(b.token_env || '').trim();
      if (t && !/^[A-Za-z_][A-Za-z0-9_]{0,99}$/.test(t)) throw new Error('o nome da variável do token só pode ter letras, números e _');
      // o valor dessa variável vai para o servidor: não pode ser a chave de um modelo, de uma nuvem ou do próprio Engram
      if (t && VARIAVEL_PROIBIDA.test(t)) throw new Error(`a variável ${t} guarda a chave de outro serviço e não vai para o servidor do cérebro: crie uma variável só para o token dele`);
      c.token_env = t;
    }
    if (b.ca !== undefined) {
      const ca = String(b.ca || '').trim();
      if (ca && !fs.existsSync(ca)) throw new Error('o arquivo do certificado (CA) não existe');
      c.ca = ca;
    }
    if (b.pasta_remota !== undefined) c.pasta_remota = String(b.pasta_remota || '').trim().replace(/^\/+|\/+$/g, '') || 'cerebro';
    if (b.servidor !== undefined) {
      const sv = String(b.servidor || '').trim();
      if (sv && !NOME_MCP.test(sv)) throw new Error('o nome do MCP só pode ter letras, números, ponto, hífen e _ (até 64)');
    }
    const url = c.url !== undefined ? c.url : this.cfg.cerebro.url;
    if (url) { const m = this.mcps?.porUrl?.(url); c.servidor = m ? m.id : String(b.servidor || this.cfg.cerebro.servidor || 'cerebro').trim() || 'cerebro'; }
    return c;
  }

  /**
   * Ajustes > Geral > Cérebro: grava a pasta e o servidor (os dois ficam guardados; um não apaga o outro). Se a
   * configuração da fonte em uso mudou, ela é refeita na hora; `fonte` (opcional) troca a fonte em uso.
   */
  async ajustar(b = {}, c = this.validarAjuste(b)) {
    if (this.trocando) throw new Error('o cérebro está trocando agora: espere terminar e salve de novo');
    const antes = this.assinatura(this.fonte.tipo);
    this.salvarCerebro(c);
    Object.assign(this.cfg.cerebro, c);
    if (!this.cfg.cerebro.pasta) this.cfg.cerebro.pasta = this.pastaPadrao;

    // daqui em diante a configuração já está gravada: se a troca falhar, volta como aviso (não como erro)
    const tentar = async (...a) => {
      try { return await this.trocar(...a); } catch (e) { return { ativa: this.fonte.tipo, mudou: false, aviso: e.message }; }
    };
    const querida = b.fonte === 'pasta' || b.fonte === 'remoto' ? b.fonte : this.fonte.tipo;
    let r;
    if (querida === 'remoto' && !this.servidorConfigurado()) {
      // sem servidor configurado, o que estava no servidor vai para o Local
      if (this.fonte.tipo === 'remoto') { r = await tentar('pasta'); r = { ...r, aviso: r.aviso || 'sem endereço do servidor: o cérebro foi para o Local' }; }
      else r = { ativa: this.fonte.tipo, mudou: false };
    } else if (querida !== this.fonte.tipo) r = await tentar(querida);
    else if (this.assinatura(querida) !== antes) r = await tentar(querida, { refazer: true });
    else r = { ativa: this.fonte.tipo, mudou: false };
    // o seletor do topo relê o estado (o servidor pode ter passado a existir, ou mudado de nome)
    this.avisar({ tipo: 'cerebro_fonte', acao: 'config', ativa: this.fonte.tipo });
    return r;
  }
}

module.exports = { TrocaDeCerebro };
