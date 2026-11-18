// Os ajustes do Engram pelas mãos de um agente (ferramentas "ajustes" e "ajustar" do time).
//
// Ver é livre. Mudar sempre passa pela pessoa: o pedido aparece numa janela do Engram com o antes e o depois
// de cada item, e só vale se ela aceitar. Dá para mudar o cérebro (servidor ou local), cadastrar ou atualizar
// um MCP HTTP, o contexto de todas as janelas e alguns ajustes gerais.
//
// Segredo nunca passa pelo agente: um cabeçalho de MCP que leva chave tem de citar uma variável do Windows
// (${NOME}), e o valor fica só neste computador. MCP de comando (stdio) roda programa, então fica com a pessoa.

const crypto = require('node:crypto');
const fs = require('node:fs');

const ESPERA_RESPOSTA = 50_000; // o Codex desiste de uma ferramenta em 60 s: a resposta volta antes disso
const VALIDADE_PEDIDO = 5 * 60_000; // sem resposta, o pedido some e nada muda
const PARECE_SEGREDO = /authorization|token|key|secret|senha|password|cookie|bearer|credential|api[-_]?key/i;
const SO_VARIAVEL = /^\s*(?:(?:Bearer|Basic|Token)\s+)?\$\{[A-Za-z_][A-Za-z0-9_]*\}\s*$/i;
const ID_MCP = /^[A-Za-z0-9_-]{1,40}$/;
const AGENTES = ['claude', 'codex', 'antigravity', 'opencode'];

const curto = (t, n = 140) => { const s = String(t ?? ''); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
const legivel = v => (v === true ? 'ligado' : v === false ? 'desligado' : v === null || v === undefined || v === '' ? '(vazio)' : String(v));

/** O que fazer com o erro da última tentativa de usar o servidor do cérebro. */
function dicaCerebro(erro, c = {}) {
  const e = String(erro || '');
  if (!e) return null;
  if (/variável de ambiente .* não está definida/.test(e)) {
    return `O Engram não enxerga a variável ${c.token_env || 'do token'}: ele só lê as variáveis do Windows quando abre (e uma atualização automática reabre com as antigas). Feche pela bandeja ("Sair (os agentes continuam rodando)") e abra pelo ícone. Se a variável nem existe no Windows, rode o instalador do servidor.`;
  }
  if (/não vale para/.test(e)) return 'O endereço tem de usar o nome que está no certificado do servidor (o nome completo), não um apelido nem o IP.';
  if (/não é o do arquivo de CA/.test(e)) return 'O certificado indicado não é o deste servidor: confira o arquivo .crt.';
  if (/fora do prazo/.test(e)) return 'O certificado do servidor venceu (ou o relógio deste computador está errado).';
  if (/UNABLE_TO_VERIFY|SELF_SIGNED|self.signed|certificate/i.test(e)) return 'O servidor usa certificado próprio: preencha o certificado (CA) com o arquivo .crt dele.';
  if (/HTTP 40[13]/.test(e)) return 'O servidor recusou o token: ele venceu, foi pausado ou é de outro computador. Peça um acesso novo a quem cuida do servidor.';
  if (/RECUSADO|não existe|not found/i.test(e)) return 'A pasta no servidor não existe: confira o nome da pasta das notas.';
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH|não respondeu|sem resposta/.test(e)) return 'O servidor não atende daqui: confira se este computador está na rede certa e se o servidor está no ar.';
  return null;
}

class AjustesDoAgente {
  constructor({ cfg, mcps, trocaCerebro, janelas, avisar, salvarConfig, mudouMcps, versao }) {
    Object.assign(this, { cfg, mcps, trocaCerebro, janelas, avisar, salvarConfig, mudouMcps, versao });
    this.pedido = null;
  }

  // ---------------------------------------------------------------- ver

  ver() {
    const c = this.cfg.cerebro || {};
    const erro = this.trocaCerebro.estado().servidor.erro || null;
    const escondido = (nome, v) => (v && typeof v === 'object' ? '(guardado no cofre do Windows)'
      : PARECE_SEGREDO.test(nome) && !SO_VARIAVEL.test(String(v)) ? '(valor escondido)' : v);
    return {
      versao: this.versao,
      cerebro: {
        em_uso: this.trocaCerebro.fonte.tipo === 'remoto' ? 'servidor' : 'local',
        pasta_local: c.pasta || null,
        servidor: {
          endereco: c.url || null,
          variavel_do_token: c.token_env || null,
          variavel_existe_no_engram: c.token_env ? !!process.env[c.token_env] : null,
          certificado: c.ca || null,
          certificado_existe: c.ca ? fs.existsSync(c.ca) : null,
          pasta_no_servidor: c.pasta_remota || 'cerebro',
          nome_do_mcp: c.servidor || null,
          ultimo_erro: erro,
          dica: dicaCerebro(erro, c),
        },
      },
      mcps: this.mcps.listar().servidores.map(s => ({
        id: s.id, nome: s.nome, tipo: s.tipo, endereco: s.url || null, ativo: s.ativo, agentes: s.agentes, liberado_sem_perguntar: !!s.liberar,
        cabecalhos: Object.fromEntries(Object.entries(s.headers || {}).map(([k, v]) => [k, escondido(k, v)])),
      })),
      contexto: this.cfg.contexto || '',
      gerais: {
        pasta_trabalho: this.cfg.pasta_trabalho || null, max_janelas: this.cfg.max_janelas,
        pensamento_no_palco: this.cfg.pensamento_no_palco !== false, atualizar_sozinho: this.cfg.atualizar_sozinho !== false,
      },
      pedido_esperando_a_pessoa: this.pedido ? `${this.pedido.itens.length} mudança(s) pedida(s) por ${this.pedido.quem}` : null,
    };
  }

  // ---------------------------------------------------------------- montar o pedido

  /** Confere o pedido e monta o antes e o depois de cada item, sem gravar nada. Lança o erro de preenchimento. */
  preparar(a = {}) {
    const itens = [], avisos = [], acoes = [];

    // MCP primeiro: um cérebro no mesmo endereço passa a usar o nome dele
    if (a.mcp !== undefined) {
      const x = a.mcp;
      if (!x || typeof x !== 'object') throw new Error('mcp: mande um objeto { id, endereco, ... }');
      const id = String(x.id || '').trim();
      if (!ID_MCP.test(id)) throw new Error('mcp.id: só letras, números, - e _ (até 40)');
      if (id === 'engram') throw new Error('"engram" é o nome reservado das ferramentas do time');
      const existente = this.mcps.listar().servidores.find(s => s.id === id) || null;
      if (existente && existente.tipo === 'stdio') throw new Error(`o MCP ${id} roda um programa (stdio): esse tipo só a pessoa muda, em Ajustes > MCPs`);
      const def = existente ? { ...existente, headers: { ...(existente.headers || {}) } } : { id, nome: id, tipo: 'http', ativo: true, agentes: ['todos'], liberar: false, headers: {} };
      if (x.nome !== undefined) def.nome = curto(x.nome, 60);
      if (x.endereco !== undefined) def.url = String(x.endereco || '').trim();
      if (!def.url) throw new Error('mcp.endereco: falta o endereço (https://...)');
      if (!/^https?:\/\/\S+$/i.test(def.url)) throw new Error('mcp.endereco tem de começar com http:// ou https://');
      if (x.cabecalhos !== undefined) {
        if (!x.cabecalhos || typeof x.cabecalhos !== 'object' || Array.isArray(x.cabecalhos)) throw new Error('mcp.cabecalhos: use { "Nome": "valor" }');
        for (const [k, v] of Object.entries(x.cabecalhos)) {
          const nome = String(k).trim();
          if (!nome) continue;
          if (v === null || v === '') { delete def.headers[nome]; continue; }
          const valor = String(v);
          if ((PARECE_SEGREDO.test(nome) || PARECE_SEGREDO.test(valor)) && !SO_VARIAVEL.test(valor)) {
            throw new Error(`o cabeçalho ${nome} leva segredo: o valor tem de citar uma variável do Windows, como "Bearer \${NOME_DA_VARIAVEL}" (o valor de verdade nunca passa pelo agente)`);
          }
          def.headers[nome] = valor;
        }
      }
      if (x.agentes !== undefined) {
        const l = (Array.isArray(x.agentes) ? x.agentes : [x.agentes]).map(y => {
          const s = String(y).toLowerCase();
          return s === 'gemini' ? 'antigravity' : s;
        });
        def.agentes = !l.length || l.includes('todos') ? ['todos'] : [...new Set(l.filter(y => AGENTES.includes(y)))];
        if (!def.agentes.length) throw new Error(`mcp.agentes: use "todos" ou ${AGENTES.join(', ')}`);
      }
      if (x.liberar !== undefined) def.liberar = !!x.liberar;
      if (x.ativo !== undefined) def.ativo = !!x.ativo;
      const cab = h => Object.entries(h || {}).map(([k, v]) => `${k}: ${v && typeof v === 'object' ? '(no cofre)' : v}`).join('; ') || '(nenhum)';
      const descrever = s => `${s.url} · para ${s.agentes.join(', ')} · ${s.liberar ? 'sem pedir permissão' : 'pedindo permissão'} · ${s.ativo ? 'ligado' : 'desligado'} · cabeçalhos: ${cab(s.headers)}`;
      const antes = existente ? descrever(existente) : '(não existe)', depois = descrever(def);
      if (antes !== depois || (existente && x.nome !== undefined && existente.nome !== def.nome)) {
        itens.push({ area: 'MCPs', campo: `${existente ? 'atualizar' : 'cadastrar'} ${id}`, antes, depois });
        if (def.liberar && !(existente && existente.liberar)) avisos.push(`As ferramentas do MCP ${id} vão rodar sem pedir permissão nas janelas novas.`);
        let host = def.url;
        try { host = new URL(def.url).host; } catch { /* fica o endereço */ }
        for (const v of Object.values(def.headers)) {
          const m = typeof v === 'string' && /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/.exec(v);
          if (m) avisos.push(`O valor da variável ${m[1]} vai para ${host} nas janelas que usarem o MCP ${id}.`);
        }
        acoes.push(async () => {
          await this.mcps.salvar(def, {}, existente ? id : null);
          this.mudouMcps();
          return `MCP ${id} ${existente ? 'atualizado' : 'cadastrado'} (vale para as janelas que abrirem daqui em diante)`;
        });
      }
    }

    if (a.cerebro !== undefined) {
      const x = a.cerebro;
      if (!x || typeof x !== 'object') throw new Error('cerebro: mande um objeto { usar, endereco, ... }');
      const b = {};
      const mapa = { endereco: 'url', variavel_do_token: 'token_env', certificado: 'ca', pasta_no_servidor: 'pasta_remota', pasta_local: 'pasta' };
      for (const [k, campo] of Object.entries(mapa)) if (x[k] !== undefined) b[campo] = String(x[k] ?? '');
      if (x.usar !== undefined) {
        if (!['servidor', 'local'].includes(x.usar)) throw new Error('cerebro.usar: use "servidor" ou "local"');
        b.fonte = x.usar === 'servidor' ? 'remoto' : 'pasta';
      }
      const c = this.trocaCerebro.validarAjuste(b); // variável proibida, certificado que não existe, endereço inválido...
      const atual = this.cfg.cerebro || {};
      const rotulos = { url: 'endereço do servidor', token_env: 'variável do token', ca: 'certificado (CA)', pasta_remota: 'pasta no servidor', pasta: 'pasta local' };
      const antesDoCerebro = itens.length;
      for (const [campo, rot] of Object.entries(rotulos)) {
        if (c[campo] !== undefined && String(c[campo] || '') !== String(atual[campo] || (campo === 'pasta_remota' ? 'cerebro' : ''))) itens.push({ area: 'Cérebro', campo: rot, antes: legivel(atual[campo]), depois: legivel(c[campo]) });
      }
      const fonteAtual = this.trocaCerebro.fonte.tipo;
      const nomeFonte = f => (f === 'remoto' ? 'servidor' : 'local');
      if (b.fonte && b.fonte !== fonteAtual) itens.push({ area: 'Cérebro', campo: 'em uso', antes: nomeFonte(fonteAtual), depois: nomeFonte(b.fonte) });
      if (itens.length > antesDoCerebro) {
        const url = c.url !== undefined ? c.url : atual.url, token = c.token_env !== undefined ? c.token_env : atual.token_env;
        if (url && token && (c.url !== undefined || c.token_env !== undefined)) {
          let host = url;
          try { host = new URL(url).host; } catch { /* fica o endereço */ }
          avisos.push(`O Engram vai mandar o valor da variável ${token} para ${host} sempre que ler o cérebro no servidor.`);
        }
        acoes.push(async () => {
          const r = await this.trocaCerebro.ajustar(b, this.trocaCerebro.validarAjuste(b));
          if (r?.aviso) {
            const dica = dicaCerebro(this.trocaCerebro.estado().servidor.erro, this.cfg.cerebro);
            return `cérebro: a configuração foi salva, mas ${r.aviso}.${dica ? ` Dica: ${dica}` : ''}`;
          }
          return `cérebro: agora ${this.trocaCerebro.fonte.tipo === 'remoto' ? 'no servidor' : 'na pasta local'}`;
        });
      }
    }

    if (a.contexto !== undefined) {
      const novo = String(a.contexto ?? '').slice(0, 20_000);
      const velho = this.cfg.contexto || '';
      if (novo !== velho) {
        itens.push({ area: 'Contexto de todas as janelas', campo: 'texto', antes: curto(velho) || '(vazio)', depois: curto(novo) || '(vazio)', texto_novo: novo });
        acoes.push(async () => { this.salvarConfig({ contexto: novo }); this.cfg.contexto = novo; return 'contexto salvo (vale para as janelas que abrirem daqui em diante)'; });
      }
    }

    if (a.gerais !== undefined) {
      const g = a.gerais;
      if (!g || typeof g !== 'object') throw new Error('gerais: mande um objeto');
      const parcial = {};
      if (g.max_janelas !== undefined) {
        const n = Math.round(Number(g.max_janelas));
        if (!(n >= 1 && n <= 64)) throw new Error('gerais.max_janelas: use um número de 1 a 64');
        parcial.max_janelas = n;
      }
      if (g.pasta_trabalho !== undefined) {
        const p = String(g.pasta_trabalho || '').trim();
        if (!p || !fs.existsSync(p) || !fs.statSync(p).isDirectory()) throw new Error('gerais.pasta_trabalho: a pasta não existe');
        parcial.pasta_trabalho = p;
      }
      for (const k of ['pensamento_no_palco', 'atualizar_sozinho']) if (g[k] !== undefined) parcial[k] = !!g[k];
      const nomes = { max_janelas: 'máximo de janelas', pasta_trabalho: 'pasta de trabalho', pensamento_no_palco: 'bolha de pensamento no palco', atualizar_sozinho: 'atualizar sozinho' };
      const atualDe = k => (k === 'pensamento_no_palco' || k === 'atualizar_sozinho' ? this.cfg[k] !== false : this.cfg[k]);
      const mudou = Object.fromEntries(Object.entries(parcial).filter(([k, v]) => v !== atualDe(k)));
      for (const [k, v] of Object.entries(mudou)) itens.push({ area: 'Geral', campo: nomes[k], antes: legivel(atualDe(k)), depois: legivel(v) });
      if (Object.keys(mudou).length) {
        acoes.push(async () => { this.salvarConfig(mudou); Object.assign(this.cfg, mudou); return `geral: ${Object.keys(mudou).map(k => nomes[k]).join(', ')} salvo`; });
      }
    }

    return { itens, avisos: [...new Set(avisos)], acoes };
  }

  // ---------------------------------------------------------------- pedir e responder

  /** Pede a mudança: mostra na tela e espera a pessoa (até ~50 s; depois, a resposta ainda vale). */
  async pedir(de, a = {}) {
    let p;
    try { p = this.preparar(a); } catch (e) { return `Não dá para pedir isso: ${e.message}.`; }
    if (!p.itens.length) return 'Nada mudaria: o que você mandou já é o que está nos ajustes (veja com a ferramenta ajustes).';
    if (this.pedido) return `Já há um pedido de ajuste esperando a pessoa responder na tela do Engram (${this.pedido.quem}). Espere ela responder.`;
    let resolver;
    const resposta = new Promise(r => { resolver = r; });
    const pedido = {
      id: crypto.randomUUID().slice(0, 8), de, quem: this.janelas.nomeDe(de), motivo: curto(a.motivo || '', 400),
      itens: p.itens, avisos: p.avisos, acoes: p.acoes, resolver,
    };
    this.pedido = pedido;
    pedido.prazo = setTimeout(() => this.encerrar(pedido, false, 'A pessoa não respondeu em 5 minutos: o pedido foi descartado e nada mudou.'), VALIDADE_PEDIDO);
    this.avisar({ tipo: 'ajustes_pedido', pedido: this.paraTela(pedido) });
    let espera;
    const tempo = new Promise(r => { espera = setTimeout(() => r(null), ESPERA_RESPOSTA); });
    const r = await Promise.race([resposta, tempo]);
    clearTimeout(espera);
    return r ?? 'O pedido está na tela do Engram, esperando a pessoa. Se ela aceitar, a mudança vale; confira depois com a ferramenta ajustes.';
  }

  paraTela(p) { return { id: p.id, quem: p.quem, motivo: p.motivo, itens: p.itens, avisos: p.avisos }; }

  pendente() { return this.pedido && !this.pedido.aplicando ? this.paraTela(this.pedido) : null; }

  encerrar(p, aceito, texto) {
    if (this.pedido === p) this.pedido = null;
    clearTimeout(p.prazo);
    this.avisar({ tipo: 'ajustes_pedido_fim', id: p.id, aceito, texto });
    p.resolver(texto);
  }

  /** A pessoa respondeu na tela. Aceito: aplica na ordem (MCP, cérebro, contexto, geral) e conta o que deu. */
  async responder(id, aceitar) {
    const p = this.pedido;
    if (!p || p.id !== id || p.aplicando) throw new Error('esse pedido não está mais esperando');
    clearTimeout(p.prazo);
    if (!aceitar) { this.encerrar(p, false, 'A pessoa recusou o pedido: nada mudou.'); return { ok: true, resultado: null }; }
    p.aplicando = true; // mantém this.pedido ocupado até terminar para ninguém abrir outro no meio
    try {
      const feitos = [];
      for (const f of p.acoes) {
        try { feitos.push(await f()); } catch (e) { feitos.push(`não deu: ${e.message}`); }
      }
      const texto = `A pessoa aceitou. ${feitos.join(' · ')}`;
      this.encerrar(p, true, texto);
      return { ok: true, resultado: texto };
    } finally {
      if (this.pedido === p) this.pedido = null;
    }
  }
}

module.exports = { AjustesDoAgente, dicaCerebro };
