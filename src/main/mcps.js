// Servidores MCP do Engram: a pessoa cadastra uma vez (HTTP ou stdio), testa, liga e desliga, e escolhe
// para quais agentes vale. Cada janela recebe os MCPs ativos no formato do CLI dela (provedores.js).
// Segredos (tokens em cabeçalho ou variável) ficam no cofre do Windows; no arquivo fica só a marca.
// Valores com ${VAR} são lidos das variáveis de ambiente na hora de abrir a janela.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { spawn } = require('node:child_process');

const ID = /^[A-Za-z0-9_-]{1,40}$/;
const AGENTES = ['claude', 'codex', 'gemini', 'opencode'];
const COFRE = '\u0000cofre'; // marca no arquivo: o valor está no cofre do Windows
const PARECE_SEGREDO = /authorization|token|key|secret|senha|password|cookie|bearer|credential|api[-_]?key/i;

function expandir(valor) {
  return String(valor ?? '').replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, nome) => process.env[nome] ?? '');
}

class Mcps {
  constructor({ dados, cofre, cfg, provedores, registrar }) {
    this.arquivo = path.join(dados, 'mcps.json');
    this.cofre = cofre;
    this.cfg = cfg;
    this.provedores = provedores;
    this.registrar = registrar || (() => {});
    this.estado = this.ler();
  }

  ler() {
    try {
      const d = JSON.parse(fs.readFileSync(this.arquivo, 'utf8').replace(/^﻿/, ''));
      return { servidores: Array.isArray(d.servidores) ? d.servidores : [], so_engram: !!d.so_engram };
    } catch { return { servidores: [], so_engram: false }; }
  }

  gravar() {
    fs.writeFileSync(this.arquivo, JSON.stringify(this.estado, null, 2), 'utf8');
  }

  /** Para a tela: segredos viram "no cofre", nunca o valor. */
  listar() {
    const mascarar = obj => Object.fromEntries(Object.entries(obj || {}).map(([k, v]) => [k, v === COFRE ? { cofre: true } : v]));
    return {
      so_engram: this.estado.so_engram,
      servidores: this.estado.servidores.map(s => ({ ...s, headers: mascarar(s.headers), env: mascarar(s.env) })),
    };
  }

  achar(id) { return this.estado.servidores.find(s => s.id === id) || null; }

  /**
   * Cria ou atualiza. `def.headers`/`def.env`: { nome: valor | { cofre: true } (mantém) }.
   * `segredos`: { "headers.Authorization": "valor" } vão para o cofre.
   */
  async salvar(def, segredos = {}, idAntigo = null) {
    const id = String(def.id || '').trim();
    if (!ID.test(id)) throw new Error('o nome curto do MCP só pode ter letras, números, - e _ (até 40)');
    if (id === 'engram') throw new Error('"engram" é o nome reservado das ferramentas do time');
    if (idAntigo !== id && this.achar(id)) throw new Error(`já existe um MCP chamado ${id}`);
    const tipo = def.tipo === 'stdio' ? 'stdio' : 'http';
    const s = {
      id, nome: String(def.nome || id).slice(0, 60), tipo, ativo: def.ativo !== false,
      agentes: Array.isArray(def.agentes) && def.agentes.length && !def.agentes.includes('todos') ? def.agentes.filter(a => AGENTES.includes(a)) : ['todos'],
      liberar: !!def.liberar, origem: def.origem ? String(def.origem).slice(0, 80) : undefined,
    };
    if (tipo === 'http') {
      s.url = String(def.url || '').trim();
      if (!/^https?:\/\/\S+$/i.test(s.url) && !/^https?:\/\/\$\{/.test(s.url)) throw new Error('o endereço tem de começar com http:// ou https://');
      s.headers = {};
      if (def.ca) s.ca = String(def.ca);
    } else {
      s.comando = String(def.comando || '').trim();
      if (!s.comando) throw new Error('falta o comando que abre o servidor');
      s.args = (Array.isArray(def.args) ? def.args : []).map(String);
      s.env = {};
      if (def.cwd) s.cwd = String(def.cwd);
    }
    const anterior = idAntigo ? this.achar(idAntigo) : null;
    const campo = tipo === 'http' ? 'headers' : 'env';
    for (const [k, v] of Object.entries(def[campo] || {})) {
      const nome = String(k).trim();
      if (!nome) continue;
      const chaveCofre = `${campo}.${nome}`;
      if (segredos[chaveCofre] !== undefined && segredos[chaveCofre] !== '') {
        await this.cofre.gravar(`mcp:${id}:${chaveCofre}`, String(segredos[chaveCofre]));
        s[campo][nome] = COFRE;
      } else if (v && typeof v === 'object' && v.cofre) {
        // mantém o que já estava no cofre (troca de nome do MCP: copia)
        if (anterior && idAntigo !== id) {
          const velho = await this.cofre.ler(`mcp:${idAntigo}:${chaveCofre}`);
          if (velho) await this.cofre.gravar(`mcp:${id}:${chaveCofre}`, velho);
        }
        s[campo][nome] = COFRE;
      } else {
        s[campo][nome] = String(v ?? '');
      }
    }
    if (anterior) {
      // segredos que sumiram do formulário saem do cofre
      for (const c of ['headers', 'env']) {
        for (const [k, v] of Object.entries(anterior[c] || {})) {
          if (v === COFRE && (idAntigo !== id || s[c]?.[k] !== COFRE)) await this.cofre.apagar(`mcp:${idAntigo}:${c}.${k}`).catch(() => {});
        }
      }
      this.estado.servidores = this.estado.servidores.map(x => (x.id === idAntigo ? s : x));
    } else {
      this.estado.servidores.push(s);
    }
    this.gravar();
    return s;
  }

  async remover(id) {
    const s = this.achar(id);
    if (!s) throw new Error('MCP não encontrado');
    for (const c of ['headers', 'env']) for (const [k, v] of Object.entries(s[c] || {})) if (v === COFRE) await this.cofre.apagar(`mcp:${id}:${c}.${k}`).catch(() => {});
    this.estado.servidores = this.estado.servidores.filter(x => x.id !== id);
    this.gravar();
  }

  alternar(id, ativo) {
    const s = this.achar(id);
    if (!s) throw new Error('MCP não encontrado');
    s.ativo = !!ativo;
    this.gravar();
  }

  opcoes({ so_engram }) {
    if (so_engram !== undefined) this.estado.so_engram = !!so_engram;
    this.gravar();
  }

  valeParaAgente(s, provedor) { return s.agentes.includes('todos') || s.agentes.includes(provedor); }

  /** Os MCPs ativos para um agente (lista leve, para a tela de novo agente). */
  ativosPara(provedor) {
    return this.estado.servidores.filter(s => s.ativo && this.valeParaAgente(s, provedor)).map(s => ({ id: s.id, nome: s.nome }));
  }

  /** Com os valores de verdade (cofre e ${VAR} resolvidos), para entrar numa janela. */
  async resolver(s) {
    const r = { ...s, headers: {}, env: {} };
    for (const c of ['headers', 'env']) {
      for (const [k, v] of Object.entries(s[c] || {})) r[c][k] = v === COFRE ? (await this.cofre.ler(`mcp:${s.id}:${c}.${k}`)) || '' : expandir(v);
    }
    if (r.url) r.url = expandir(r.url);
    if (r.args) r.args = r.args.map(expandir);
    return r;
  }

  /** MCPs de uma janela: os escolhidos (ou todos os ativos que valem para o agente), já resolvidos. */
  async paraJanela(provedor, escolhidos = null) {
    const lista = this.estado.servidores.filter(s => s.ativo && this.valeParaAgente(s, provedor) && (!escolhidos || escolhidos.includes(s.id)));
    const saida = [];
    for (const s of lista) {
      try { saida.push(await this.resolver(s)); } catch (e) { this.registrar(`MCP ${s.id}: ${e.message}`); }
    }
    return saida;
  }

  liberados() { return this.estado.servidores.filter(s => s.ativo && s.liberar).map(s => s.id); }

  // ---------------------------------------------------------------- testar a conexão

  async testar(idOuDef, segredos = {}) {
    let s = typeof idOuDef === 'string' ? this.achar(idOuDef) : idOuDef;
    if (!s) throw new Error('MCP não encontrado');
    s = await this.resolver({ ...s, headers: { ...(s.headers || {}) }, env: { ...(s.env || {}) } });
    for (const [k, v] of Object.entries(segredos || {})) {
      const [c, nome] = k.split(/\.(.+)/);
      if (v && (c === 'headers' || c === 'env')) s[c][nome] = String(v);
    }
    const inicio = Date.now();
    let r;
    try { r = s.tipo === 'stdio' ? await testarStdio(s) : await testarHttp(s); } catch (e) { r = { ok: false, erro: e.message }; }
    return { ...r, ms: Date.now() - inicio };
  }

  // ---------------------------------------------------------------- encontrar e importar dos CLIs

  /** MCPs já configurados direto nos CLIs (Claude Code e Codex), para trazer para o Engram. */
  async encontrados(bruto = false) {
    const saida = [];
    const casa = os.homedir();
    try {
      const c = JSON.parse(fs.readFileSync(path.join(casa, '.claude.json'), 'utf8'));
      for (const [nome, d] of Object.entries(c.mcpServers || {})) saida.push(daClaude(nome, d, 'Claude Code (global)'));
      const projeto = c.projects?.[this.cfg.pasta_trabalho] || c.projects?.[this.cfg.pasta_trabalho.replace(/\\/g, '/')];
      for (const [nome, d] of Object.entries(projeto?.mcpServers || {})) saida.push(daClaude(nome, d, 'Claude Code (pasta de trabalho)'));
    } catch { /* sem config do Claude */ }
    try {
      const d = JSON.parse(fs.readFileSync(path.join(this.cfg.pasta_trabalho, '.mcp.json'), 'utf8'));
      for (const [nome, x] of Object.entries(d.mcpServers || {})) saida.push(daClaude(nome, x, '.mcp.json da pasta de trabalho'));
    } catch { /* sem .mcp.json */ }
    const codex = this.provedores.comando('codex');
    if (codex) {
      const { rodar } = require('./provedores');
      const r = await rodar(codex, ['mcp', 'list', '--json'], { timeout: 20_000 });
      try {
        for (const x of JSON.parse(r.saida)) {
          const t = x.transport || {};
          const interno = /[\\/]\.codex[\\/]|OpenAI[\\/]Codex/i.test(`${t.command || ''} ${t.cwd || ''} ${(t.args || []).join(' ')}`);
          if (interno) continue; // servidores do próprio app do Codex
          if (t.type === 'stdio') saida.push({ id: x.name, nome: x.name, tipo: 'stdio', comando: t.command, args: t.args || [], env: t.env || {}, origem: 'Codex' });
          else saida.push({ id: x.name, nome: x.name, tipo: 'http', url: t.url, headers: t.http_headers || {}, origem: 'Codex' });
        }
      } catch { /* versão sem --json */ }
    }
    const ja = new Set(this.estado.servidores.map(s => s.id));
    const vistos = new Set();
    return saida.filter(s => s && ID.test(s.id) && s.id !== 'engram' && !vistos.has(s.id) && vistos.add(s.id))
      .map(s => (bruto ? s : { ...s, importado: ja.has(s.id), headers: mascararSegredos(s.headers), env: mascararSegredos(s.env) }));
  }

  /** Traz um MCP encontrado: valores que parecem segredo (sem ${VAR}) vão para o cofre. */
  async importar(id) {
    const brutos = await this.encontrados(true);
    const s = brutos.find(x => x.id === id);
    if (!s) throw new Error('não achei esse MCP nos CLIs');
    if (this.achar(id)) throw new Error(`já existe um MCP chamado ${id} no Engram`);
    const segredos = {};
    const def = { ...s, agentes: ['todos'], ativo: true };
    for (const c of ['headers', 'env']) {
      def[c] = {};
      for (const [k, v] of Object.entries(s[c] || {})) {
        if (PARECE_SEGREDO.test(k) && !/\$\{[A-Za-z_]/.test(String(v))) segredos[`${c}.${k}`] = String(v);
        else def[c][k] = v;
      }
    }
    return this.salvar(def, segredos);
  }

}

const mascararSegredos = obj => Object.fromEntries(Object.entries(obj || {}).map(([k, v]) => [k, PARECE_SEGREDO.test(k) && !/\$\{[A-Za-z_]/.test(String(v)) ? { cofre: true, oculto: true } : v]));

function daClaude(nome, d, origem) {
  if (!d || typeof d !== 'object') return null;
  const tipo = d.type === 'stdio' || (!d.type && d.command) ? 'stdio' : 'http';
  if (tipo === 'stdio') return { id: nome, nome, tipo, comando: d.command, args: d.args || [], env: d.env || {}, origem };
  return { id: nome, nome, tipo, url: d.url, headers: d.headers || {}, origem };
}

// ---------------------------------------------------------------- cliente MCP mínimo (só para testar)

const PEDIDO_INICIO = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'engram-teste', version: '1' } } };

function postar(url, corpo, headers, ca, sessao) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const dados = JSON.stringify(corpo);
    const cab = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Content-Length': Buffer.byteLength(dados), ...headers };
    if (sessao) cab['Mcp-Session-Id'] = sessao;
    const opcoes = { method: 'POST', headers: cab, timeout: 15_000 };
    if (ca) { try { opcoes.ca = fs.readFileSync(ca); } catch { return reject(new Error(`não li o certificado ${ca}`)); } }
    const req = mod.request(u, opcoes, res => {
      let texto = '';
      res.setEncoding('utf8');
      res.on('data', c => { texto += c; if (texto.length > 4_000_000) req.destroy(); });
      res.on('end', () => resolve({ status: res.statusCode, tipo: String(res.headers['content-type'] || ''), sessao: res.headers['mcp-session-id'] || sessao, texto, autenticar: res.headers['www-authenticate'] }));
    });
    req.on('timeout', () => req.destroy(new Error('o servidor não respondeu em 15 s')));
    req.on('error', e => reject(new Error(traduzirErro(e))));
    req.end(dados);
  });
}

function lerResposta(r, id) {
  if (r.tipo.includes('text/event-stream')) {
    for (const bloco of r.texto.split(/\r?\n\r?\n/)) {
      const dados = bloco.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('');
      if (!dados) continue;
      try { const j = JSON.parse(dados); if (j.id === id) return j; } catch { /* outro evento */ }
    }
    return null;
  }
  try { return JSON.parse(r.texto); } catch { return null; }
}

async function testarHttp(s) {
  const r1 = await postar(s.url, PEDIDO_INICIO, s.headers, s.ca);
  if (r1.status === 401 || r1.status === 403) {
    const oauth = /Bearer/i.test(r1.autenticar || '');
    return { ok: false, erro: oauth ? 'o servidor pede login (OAuth). Entre pelo terminal do agente com /mcp, ou confira o token.' : `acesso negado (${r1.status}): confira o token ou o cabeçalho` };
  }
  if (r1.status >= 400) return { ok: false, erro: `o servidor respondeu ${r1.status}` };
  const ini = lerResposta(r1, 1);
  if (!ini?.result) return { ok: false, erro: ini?.error?.message || 'a resposta não parece de um servidor MCP' };
  await postar(s.url, { jsonrpc: '2.0', method: 'notifications/initialized' }, s.headers, s.ca, r1.sessao).catch(() => {});
  const r2 = await postar(s.url, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, s.headers, s.ca, r1.sessao);
  const lista = lerResposta(r2, 2);
  return { ok: true, servidor: ini.result.serverInfo || {}, ferramentas: (lista?.result?.tools || []).map(t => t.name) };
}

function testarStdio(s) {
  return new Promise(resolve => {
    const { comandoExecutavel } = require('./provedores');
    const [exe, ...pre] = comandoExecutavel(s.comando);
    let filho;
    try {
      filho = spawn(exe, [...pre, ...(s.args || [])], { cwd: s.cwd || os.homedir(), env: { ...process.env, ...s.env }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) { return resolve({ ok: false, erro: traduzirErro(e) }); }
    let buffer = '', erroTexto = '', fim = false, ini = null;
    const terminar = r => { if (fim) return; fim = true; clearTimeout(relogio); try { filho.kill(); } catch { /* já saiu */ } resolve(r); };
    const relogio = setTimeout(() => terminar({ ok: false, erro: `não respondeu em 25 s${erroTexto ? `: ${erroTexto.trim().split('\n').pop().slice(0, 200)}` : ''}` }), 25_000);
    const mandar = m => { try { filho.stdin.write(JSON.stringify(m) + '\n'); } catch { /* fechou */ } };
    filho.on('error', e => terminar({ ok: false, erro: traduzirErro(e) }));
    filho.on('exit', codigo => terminar({ ok: false, erro: `o servidor fechou (código ${codigo})${erroTexto ? `: ${erroTexto.trim().split('\n').pop().slice(0, 200)}` : ''}` }));
    filho.stderr.on('data', d => { erroTexto = (erroTexto + d).slice(-4000); });
    filho.stdout.on('data', d => {
      buffer += d;
      let i;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const linha = buffer.slice(0, i).trim();
        buffer = buffer.slice(i + 1);
        let m;
        try { m = JSON.parse(linha); } catch { continue; }
        if (m.id === 1) {
          if (!m.result) return terminar({ ok: false, erro: m.error?.message || 'resposta inválida' });
          ini = m.result;
          mandar({ jsonrpc: '2.0', method: 'notifications/initialized' });
          mandar({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        } else if (m.id === 2) {
          terminar({ ok: true, servidor: ini?.serverInfo || {}, ferramentas: (m.result?.tools || []).map(t => t.name) });
        }
      }
    });
    mandar(PEDIDO_INICIO);
  });
}

function traduzirErro(e) {
  const c = e.code || '';
  if (c === 'ENOTFOUND') return 'não achei o servidor (nome não resolve: rede, VPN ou endereço errado)';
  if (c === 'ECONNREFUSED') return 'conexão recusada: o servidor não está rodando nesse endereço';
  if (c === 'ETIMEDOUT' || c === 'ECONNRESET') return 'a conexão caiu ou demorou demais';
  if (c === 'ENOENT') return 'não achei o comando (confira o caminho ou se está instalado)';
  if (/self.signed|unable to verify|UNABLE_TO_GET_ISSUER/i.test(`${c} ${e.message}`)) return 'certificado não confiável: informe o arquivo do certificado (CA) da empresa';
  return e.message;
}

module.exports = { Mcps, COFRE, AGENTES, expandir };
