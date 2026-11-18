// Medidor de uso por agente: tokens de entrada e de saída na conversa inteira e no dia, e um custo estimado
// quando o modelo tem preço conhecido. Lê só o que os CLIs já gravam no disco, sem chamar modelo:
// - Claude Code: o "usage" de cada resposta no .jsonl da conversa. A mesma resposta aparece em várias linhas
//   (uma por bloco), todas com o mesmo usage: conta uma vez por id de mensagem.
// - Codex: os eventos token_count do rollout (last_token_usage de cada um; o modelo vem do turn_context).
// - Antigravity e OpenCode: ainda não (não gravam a conversa num arquivo que o Engram lê).
// O custo é o preço de tabela da API: quem usa a assinatura (conta) não paga por token, então é só uma
// referência de tamanho. A pessoa pode trocar ou acrescentar preços no config.json (precos).

const fsp = require('node:fs/promises');
const zlib = require('node:zlib');

// US$ por milhão de tokens: [entrada, saída, leitura de cache]. Escrita de cache: 1,25 × a entrada (5 min) ou 2 × (1 h).
// Preços da API em 03/11/2026; o que não está aqui aparece só em tokens.
const PRECOS = {
  'claude-fable-5-2': [8, 40, 0.2], 'claude-mythos-5-2': [8, 40, 0.2],
  'claude-fable-5-1': [10, 50, 1], 'claude-mythos-5-1': [10, 50, 1], 'claude-fable-5': [10, 50, 1],
  'claude-opus-5-5': [4, 20, 0.2], 'claude-opus-5': [5, 25, 0.5], 'claude-opus-4-8': [5, 25, 0.5], 'claude-opus-4-7': [5, 25, 0.5], 'claude-opus-4-6': [5, 25, 0.5],
  'claude-sonnet-5-5': [2, 10, 0.1], 'claude-sonnet-5': [2, 10, 0.2], 'claude-sonnet-4-6': [3, 15, 0.3],
  'claude-haiku-5-5': [0.1, 0.5, 0.01], 'claude-haiku-4-5': [1, 5, 0.1],
};
const MAX_LEITURA = 16 * 1024 * 1024; // por volta; a conversa enorme é lida em várias voltas

const dois = n => String(n).padStart(2, '0');
const diaDe = d => `${d.getFullYear()}-${dois(d.getMonth() + 1)}-${dois(d.getDate())}`;
const vazio = () => ({ entrada: 0, cache_escrita: 0, cache_lida: 0, saida: 0, custo: 0, sem_preco: 0, respostas: 0 });

function somar(alvo, t) { for (const k of Object.keys(alvo)) alvo[k] += t[k] || 0; }

class Uso {
  constructor(cfg = {}) {
    this.cfg = cfg;
    this.sessoes = new Map(); // id → { caminho, lido, ids: Set, total, dias: Map, modelo, provedor }
  }

  /** O preço do modelo: o do config (precos) ou o da tabela; aceita nome com sufixo ([1m], data...). */
  preco(modelo) {
    const m = String(modelo || '').toLowerCase().replace(/\[.*?\]/g, '').trim();
    const proprios = this.cfg.precos || {};
    const tabela = { ...PRECOS, ...proprios };
    if (tabela[m]) return tabela[m];
    const chave = Object.keys(tabela).sort((a, b) => b.length - a.length).find(k => m.startsWith(k));
    return chave ? tabela[chave] : null;
  }

  /** Os tokens de uma resposta, já com o custo. `t`: { entrada, cache_escrita_5m, cache_escrita_1h, cache_lida, saida }. */
  conta(modelo, t) {
    const p = this.preco(modelo);
    const escrita = (t.cache_escrita_5m || 0) + (t.cache_escrita_1h || 0);
    const r = { entrada: t.entrada || 0, cache_escrita: escrita, cache_lida: t.cache_lida || 0, saida: t.saida || 0, custo: 0, sem_preco: 0, respostas: 1 };
    if (p) {
      const [e, s, l] = p;
      r.custo = (r.entrada * e + (t.cache_escrita_5m || 0) * e * 1.25 + (t.cache_escrita_1h || 0) * e * 2 + r.cache_lida * (l ?? e * 0.1) + r.saida * s) / 1e6;
    } else r.sem_preco = 1;
    return r;
  }

  estado(id, provedor, caminho) {
    let e = this.sessoes.get(id);
    if (!e || e.caminho !== caminho) {
      e = { caminho, lido: 0, ids: new Map(), total: vazio(), dias: new Map(), modelo: e?.modelo || null, provedor };
      this.sessoes.set(id, e);
    }
    return e;
  }

  registrar(e, quando, modelo, tokens, novaResposta = true) {
    const r = this.conta(modelo, tokens);
    if (!novaResposta) r.respostas = 0; // a mesma resposta crescendo não conta como outra
    somar(e.total, r);
    const d = diaDe(quando instanceof Date && !Number.isNaN(quando.getTime()) ? quando : new Date());
    if (!e.dias.has(d)) e.dias.set(d, vazio());
    somar(e.dias.get(d), r);
    if (modelo) e.modelo = modelo;
  }

  /**
   * Lê o que a conversa ganhou desde a última vez. Devolve true se algo mudou. Assíncrono: a primeira leitura de
   * uma conversa grande pode demorar segundos (disco frio, antivírus) e não pode travar o app.
   */
  async atualizar(id, provedor, caminho) {
    if (!caminho || !['claude', 'codex'].includes(provedor)) return false;
    const e = this.estado(id, provedor, caminho);
    if (e.lendo) return false;
    e.lendo = true;
    try { return await this.ler(e, id, provedor, caminho); } finally { e.lendo = false; }
  }

  async ler(e, id, provedor, caminho) {
    let texto;
    if (caminho.endsWith('.zst')) {
      if (e.lido > 0) return false; // compactada: não muda mais
      try { texto = zlib.zstdDecompressSync(await fsp.readFile(caminho)).toString('utf8'); } catch { return false; }
      e.lido = 1;
    } else {
      let tam;
      try { tam = (await fsp.stat(caminho)).size; } catch { return false; }
      if (tam < e.lido) { // o arquivo recomeçou: conta de novo do zero
        Object.assign(e, { lido: 0, ids: new Map(), total: vazio(), dias: new Map() });
      }
      if (tam === e.lido) return false;
      const n = Math.min(tam - e.lido, MAX_LEITURA);
      const buf = Buffer.alloc(n);
      const fh = await fsp.open(caminho, 'r');
      try { await fh.read(buf, 0, n, e.lido); } finally { await fh.close(); }
      const fim = buf.lastIndexOf(0x0a); // só linhas inteiras; o resto fica para a próxima
      if (fim < 0) {
        if (n === MAX_LEITURA) e.lido += n; // linha única maior que 16 MB: pula para não travar a leitura
        else e.incompleto = true;
        return false;
      }
      e.incompleto = false;
      texto = buf.subarray(0, fim + 1).toString('utf8');
      e.lido += fim + 1;
    }
    let mudou = false;
    for (const linha of texto.split('\n')) {
      if (!linha) continue;
      if (provedor === 'claude' ? !linha.includes('"usage"') : !linha.includes('token_count') && !linha.includes('turn_context')) continue;
      let d;
      try { d = JSON.parse(linha); } catch { continue; }
      if (provedor === 'claude') mudou = this.linhaClaude(e, d) || mudou;
      else mudou = this.linhaCodex(e, d) || mudou;
    }
    return mudou;
  }

  linhaClaude(e, d) {
    const m = d.message;
    const u = m?.usage;
    if (!u || d.type !== 'assistant') return false;
    const chave = m.id || d.requestId || d.uuid;
    const c = u.cache_creation || {};
    const h1 = c.ephemeral_1h_input_tokens || 0;
    const m5 = c.ephemeral_5m_input_tokens ?? Math.max(0, (u.cache_creation_input_tokens || 0) - h1);
    const agora = { entrada: u.input_tokens || 0, cache_escrita_5m: m5, cache_escrita_1h: h1, cache_lida: u.cache_read_input_tokens || 0, saida: u.output_tokens || 0 };
    // a mesma resposta aparece em várias linhas (uma por bloco) e, no streaming, a saída pode vir crescendo:
    // vale o maior valor de cada campo, e só a diferença entra na conta
    const antes = chave ? e.ids.get(chave) : null;
    const delta = {};
    let algum = false;
    for (const k of Object.keys(agora)) { delta[k] = Math.max(0, agora[k] - (antes?.[k] || 0)); if (delta[k]) algum = true; }
    if (chave) e.ids.set(chave, antes ? Object.fromEntries(Object.keys(agora).map(k => [k, Math.max(agora[k], antes[k] || 0)])) : agora);
    if (antes && !algum) return false;
    this.registrar(e, new Date(d.timestamp), m.model, delta, !antes);
    return true;
  }

  linhaCodex(e, d) {
    const p = d.payload || {};
    if (d.type === 'turn_context' && p.model) { e.modelo = p.model; return false; }
    if (p.type !== 'token_count' || !p.info?.last_token_usage) return false;
    const u = p.info.last_token_usage;
    const lida = u.cached_input_tokens || 0, escrita = u.cache_write_input_tokens || 0;
    // no Codex, input_tokens já inclui o que veio do cache
    this.registrar(e, new Date(d.timestamp), e.modelo, { entrada: Math.max(0, (u.input_tokens || 0) - lida - escrita), cache_escrita_5m: escrita, cache_lida: lida, saida: u.output_tokens });
    return true;
  }

  /** O uso de uma janela: a conversa inteira e hoje. */
  resumo(id, dia = diaDe(new Date())) {
    const e = this.sessoes.get(id);
    if (!e) return null;
    return { modelo: e.modelo, conversa: { ...e.total }, hoje: { ...(e.dias.get(dia) || vazio()) } };
  }

  /** Hoje, somando todas as janelas acompanhadas (o rodapé do painel). */
  hoje(dia = diaDe(new Date())) {
    const t = vazio();
    for (const e of this.sessoes.values()) if (e.dias.has(dia)) somar(t, e.dias.get(dia));
    return t;
  }
}

module.exports = { Uso, PRECOS };
