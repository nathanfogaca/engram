// Gancho dos agentes: o CLI chama este script a cada evento (início, pedido, ferramenta, fim de turno)
// com um JSON na entrada. Ele manda um resumo curto para o Engram, que desenha o estado e as linhas.
// O Codex chama o mesmo script pelo "notify", com o JSON como último argumento (fim de turno).
// Regras: nunca falha (sai sempre com 0, sem saída na tela) e nunca manda conteúdo, só o alvo.

const http = require('node:http');

const CAMPOS = ['caminho', 'pasta', 'sistema', 'id', 'tabela', 'termo', 'file_path', 'path', 'pattern',
  'description', 'command', 'url', 'subagent_type', 'para', 'nome'];

function curto(entrada) {
  const saida = {};
  if (entrada && typeof entrada === 'object') {
    for (const c of CAMPOS) {
      const v = entrada[c];
      // o comando vai mais inteiro: o Engram procura nele as notas do cérebro que o agente abriu ou gravou
      if (['string', 'number'].includes(typeof v)) saida[c] = String(v).slice(0, c === 'command' ? 4000 : 200);
    }
  }
  return saida;
}

const { ENGRAM_URL: url, ENGRAM_TOKEN: token, ENGRAM_SESSAO: sessao } = process.env;

function mandar(corpo) {
  corpo = JSON.stringify(corpo);
  const req = http.request(`${url.replace(/\/$/, '')}/eventos`, {
    method: 'POST', timeout: 2000,
    headers: { 'Content-Type': 'application/json', 'X-Engram-Token': token, 'Content-Length': Buffer.byteLength(corpo) },
  }, res => { res.resume(); res.on('end', () => process.exit(0)); });
  req.on('error', () => process.exit(0));
  req.on('timeout', () => { req.destroy(); process.exit(0); });
  req.end(corpo);
}

const ultimo = process.argv[process.argv.length - 1];
if (process.argv.length > 2 && ultimo.trim().startsWith('{')) {
  // Codex (notify): {"type":"agent-turn-complete","thread-id":...}
  if (!url || !token || !sessao) process.exit(0);
  let d = {};
  try { d = JSON.parse(ultimo); } catch { process.exit(0); }
  if (d.type === 'agent-turn-complete') mandar({ sessao, evento: 'Stop', externo: String(d['thread-id'] || '').slice(0, 80) });
  else process.exit(0);
} else {
let bruto = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { bruto += c; });
process.stdin.on('end', () => {
  if (!url || !token || !sessao) process.exit(0);
  let d;
  try { d = JSON.parse(bruto); } catch { process.exit(0); }
  mandar({
    sessao, evento: d.hook_event_name, ferramenta: d.tool_name || null, entrada: curto(d.tool_input),
    mensagem: String(d.message || '').slice(0, 300), tipo_aviso: String(d.notification_type || '').slice(0, 60),
  });
});
}
setTimeout(() => process.exit(0), 4000);
