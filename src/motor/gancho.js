// Gancho dos agentes: o CLI chama este script a cada evento (início, pedido, ferramenta, fim de turno)
// com um JSON na entrada. Ele manda um resumo curto para o Engram, que desenha o estado e as linhas.
// O Codex chama o mesmo script pelo "notify", com o JSON como último argumento (fim de turno).
// Regras: nunca falha (sai sempre com 0) e nunca manda conteúdo, só o alvo. A única saída é a de barrar
// (PreToolUse do Claude Code) quando o Engram pede: ferramenta mexendo num arquivo com segredo da pessoa.

const http = require('node:http');

const CAMPOS = ['caminho', 'pasta', 'sistema', 'id', 'tabela', 'termo', 'file_path', 'path', 'pattern',
  'description', 'command', 'url', 'subagent_type', 'para', 'nome'];

const CAMINHOS = new Set(['caminho', 'pasta', 'file_path', 'path']);

function curto(entrada) {
  const saida = {};
  if (entrada && typeof entrada === 'object') {
    const norm = { ...entrada };
    if (norm.Path && !norm.file_path) norm.file_path = norm.Path;
    if (norm.CommandLine && !norm.command) norm.command = norm.CommandLine;
    if (norm.toolSummary && !norm.description) norm.description = norm.toolSummary;
    for (const c of CAMPOS) {
      const v = norm[c];
      // o comando vai mais inteiro (o Engram procura nele as notas que o agente abriu ou gravou), e o caminho também:
      // no Windows ele passa fácil de 200 letras, e cortado ele aponta para outro arquivo
      const max = c === 'command' ? 4000 : CAMINHOS.has(c) ? 1000 : 200;
      if (['string', 'number'].includes(typeof v)) saida[c] = String(v).slice(0, max);
    }
  }
  return saida;
}

const { ENGRAM_URL: url, ENGRAM_TOKEN: token, ENGRAM_SESSAO: sessao } = process.env;

// barrar = true só no PreToolUse do Claude Code: se o Engram responder "negar" (arquivo com segredo que a
// pessoa preencheu), a ferramenta não roda e o agente lê o motivo. Qualquer erro aqui deixa passar.
function mandar(corpo, barrar = false) {
  try {
    corpo = JSON.stringify(corpo);
    const req = http.request(`${url.replace(/\/$/, '')}/eventos`, {
      method: 'POST', timeout: 2000,
      headers: { 'Content-Type': 'application/json', 'X-Engram-Token': token, 'Content-Length': Buffer.byteLength(corpo) },
    }, res => {
      let resposta = '';
      res.setEncoding('utf8');
      res.on('data', c => { if (resposta.length < 20000) resposta += c; });
      res.on('end', () => {
        let negar = null;
        if (barrar) try { negar = JSON.parse(resposta).negar || null; } catch { /* deixa passar */ }
        if (!negar) process.exit(0);
        const saida = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: String(negar).slice(0, 1000) } };
        try { process.stdout.write(JSON.stringify(saida) + '\n', () => process.exit(0)); } catch { process.exit(0); }
      });
    });
    req.on('error', () => process.exit(0));
    req.on('timeout', () => { req.destroy(); process.exit(0); });
    req.end(corpo);
  } catch {
    process.exit(0);
  }
}

const ultimo = process.argv[process.argv.length - 1];
if (process.argv.length > 2 && ultimo.trim().startsWith('{')) {
  // Codex (notify): {"type":"agent-turn-complete","thread-id":...}
  if (!url || !token || !sessao) process.exit(0);
  let d = {};
  try { d = JSON.parse(ultimo); } catch { process.exit(0); }
  if (d && typeof d === 'object' && d.type === 'agent-turn-complete') mandar({ sessao, evento: 'Stop', externo: String(d['thread-id'] || '').slice(0, 80) });
  else process.exit(0);
} else {
  let bruto = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', c => { bruto += c; });
  process.stdin.on('end', () => {
    let d = {};
    try { if (bruto.trim()) d = JSON.parse(bruto); } catch { process.exit(0); }
    if (!d || typeof d !== 'object') process.exit(0);
    if (d.hookEventName) {
      try { process.stdout.write('{}\n'); } catch { /* segue */ }
    }
    if (!url || !token || !sessao) process.exit(0);
    const argEv = process.argv[2] && !process.argv[2].trim().startsWith('{') ? process.argv[2].trim() : '';
    const evento = argEv || d.hook_event_name || (d.hookEventName === 'PreInvocation' ? 'UserPromptSubmit' : d.hookEventName) || '';
    const ferramenta = d.tool_name || d.toolCall?.name || null;
    const entradaBruta = (d.tool_input && typeof d.tool_input === 'object' ? d.tool_input : null)
      || (d.toolCall?.args && typeof d.toolCall.args === 'object' ? d.toolCall.args : {});
    const externo = String(d.session_id || d.conversationId || '').slice(0, 80);
    mandar({
      sessao, evento, ferramenta, entrada: curto(entradaBruta), ...(externo ? { externo } : {}),
      mensagem: String(d.message || '').slice(0, 300), tipo_aviso: String(d.notification_type || '').slice(0, 60),
    }, evento === 'PreToolUse' && d.hook_event_name === 'PreToolUse' && !d.hookEventName);
  });
}
setTimeout(() => process.exit(0), 4000);
