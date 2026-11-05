// Servidor local (127.0.0.1) que os AGENTES usam: as ferramentas do time (MCP) e os ganchos.
// A tela não passa por aqui (ela fala com o app por IPC). Exige o token e o Host certo.

const http = require('node:http');
const crypto = require('node:crypto');

function criarServidorLocal({ cfg, token, janelas, mcp, registrar }) {
  const tokenBuf = Buffer.from(token);
  const hosts = new Set([`127.0.0.1:${cfg.porta}`, `localhost:${cfg.porta}`]);
  const autenticado = req => {
    const dado = Buffer.from(String(req.headers['x-engram-token'] || ''));
    return dado.length === tokenBuf.length && crypto.timingSafeEqual(dado, tokenBuf);
  };
  const responder = (res, status, corpo) => {
    if (corpo === undefined) { res.writeHead(status); res.end(); return; }
    const texto = JSON.stringify(corpo);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(texto) });
    res.end(texto);
  };

  const servidor = http.createServer((req, res) => {
    if (!hosts.has(req.headers.host || '') || req.headers.origin) return responder(res, 403, { erro: 'origem não permitida' });
    if (!autenticado(req)) return responder(res, 401, { erro: 'sem token' });
    if (req.method === 'GET' && req.url === '/mcp') { res.writeHead(405, { Allow: 'POST' }); return res.end(); }
    if (req.method !== 'POST' || !['/mcp', '/eventos'].includes(req.url)) return responder(res, 404, { erro: 'não existe' });
    let bruto = '';
    req.setEncoding('utf8');
    req.on('data', c => { bruto += c; if (bruto.length > 2_000_000) req.destroy(); });
    req.on('end', async () => {
      let corpo;
      try { corpo = JSON.parse(bruto || '{}'); } catch { return responder(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON inválido' } }); }
      if (req.url === '/eventos') {
        try { janelas.evento(corpo); } catch (e) { registrar(`evento: ${e.message}`); }
        return responder(res, 200, { ok: true });
      }
      const sessao = String(req.headers['x-engram-sessao'] || '');
      try {
        if (Array.isArray(corpo)) {
          const respostas = [];
          for (const m of corpo) { const r = await mcp.tratar(janelas, sessao, m); if (r) respostas.push(r); }
          return respostas.length ? responder(res, 200, respostas) : responder(res, 202);
        }
        const r = await mcp.tratar(janelas, sessao, corpo);
        return r ? responder(res, 200, r) : responder(res, 202);
      } catch (e) {
        registrar(`mcp: ${e.message}`);
        return responder(res, 500, { jsonrpc: '2.0', id: corpo?.id ?? null, error: { code: -32603, message: 'erro no Engram' } });
      }
    });
  });
  return new Promise((resolve, reject) => {
    servidor.once('error', reject);
    servidor.listen(cfg.porta, '127.0.0.1', () => resolve(servidor));
  });
}

module.exports = { criarServidorLocal };
