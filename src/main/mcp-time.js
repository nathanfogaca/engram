// As ferramentas do time (MCP): equipe, enviar, ver_tela, entregar_arquivo, criar_agente.
// Cada janela manda o próprio id no cabeçalho X-Engram-Sessao.

const VERSAO_MAXIMA = '2025-06-18';

function ferramentas(janelas) {
  const papeis = Object.keys(janelas.cfg.papeis).filter(p => p !== 'maestro');
  // agentes instalados neste computador e os modelos de cada um (para o maestro escolher)
  const agentes = janelas.provedores.resumo().filter(p => p.instalado);
  const opcoes = agentes.map(p => `${p.id} (${p.nome}): ${p.modelos.map(m => m.id).filter(Boolean).join(', ') || 'só o padrão'}`).join('; ');
  const objeto = (props, obrig = []) => ({ type: 'object', properties: props, required: obrig, additionalProperties: false });
  return [
    { name: 'equipe', description: 'Mostra quem você é no Engram e os colegas ligados a você por uma linha no palco (nome, papel, modelo, estado). Só com esses colegas dá para falar.', inputSchema: objeto({}), annotations: { readOnlyHint: true } },
    { name: 'enviar', description: 'Manda uma mensagem para um colega ligado a você. Ela entra na conversa dele como um pedido; se ele estiver ocupado, entra quando terminar o turno. Ele não vê a sua conversa: mande tudo o que ele precisa. A resposta chega na sua conversa marcada com [Engram · mensagem de ...].',
      inputSchema: objeto({ para: { type: 'string', description: 'nome do colega, como aparece em equipe' }, mensagem: { type: 'string', description: 'a tarefa ou o resultado, completo' } }, ['para', 'mensagem']) },
    { name: 'ver_tela', description: 'Mostra as últimas linhas do terminal de um colega ligado a você, para acompanhar sem interromper.',
      inputSchema: objeto({ quem: { type: 'string' }, linhas: { type: 'integer', minimum: 10, maximum: 200, default: 60 } }, ['quem']), annotations: { readOnlyHint: true } },
    { name: 'entregar_arquivo', description: 'Devolve um arquivo à pessoa: copia para a pasta entregues/ da sua janela, e ela vê na área de arquivos da sua conversa. Se você já gravou direto em entregues/, não precisa chamar.',
      inputSchema: objeto({ caminho: { type: 'string', description: 'caminho completo do arquivo' }, nome: { type: 'string', description: 'nome com que ele aparece (opcional)' } }, ['caminho']) },
    { name: 'criar_agente', description: `Só para o maestro. Abre uma janela nova no palco, já ligada a você, e opcionalmente já manda a primeira tarefa. Modelo leve para tarefa simples, forte para análise difícil. Sem "agente", usa o mesmo agente (CLI) que você. Máximo de ${janelas.cfg.max_janelas} janelas abertas. Agentes e modelos disponíveis: ${opcoes}.`,
      inputSchema: objeto({
        nome: { type: 'string' }, papel: { type: 'string', enum: papeis },
        agente: { type: 'string', enum: agentes.map(p => p.id), description: 'qual CLI de agente abrir' },
        modelo: { type: 'string', description: 'id do modelo (vazio = padrão do agente)' }, tarefa: { type: 'string' },
      }, ['nome', 'papel']) },
  ];
}

const texto = (t, erro = false) => ({ content: [{ type: 'text', text: t }], isError: erro });

async function tratar(janelas, sessao, m) {
  if (!m || typeof m !== 'object' || m.id === undefined || m.id === null) return null; // notificação
  const ok = result => ({ jsonrpc: '2.0', id: m.id, result });
  const p = m.params || {};
  if (m.method === 'initialize') {
    const pedida = String(p.protocolVersion || VERSAO_MAXIMA);
    return ok({ protocolVersion: pedida < VERSAO_MAXIMA ? pedida : VERSAO_MAXIMA, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'engram', version: require('electron').app.getVersion() }, instructions: 'Ferramentas do time do Engram. Use equipe para ver com quem você pode falar e enviar para delegar ou devolver resultados.' });
  }
  if (m.method === 'ping') return ok({});
  if (m.method === 'tools/list') return ok({ tools: ferramentas(janelas) });
  if (m.method === 'tools/call') {
    const a = p.arguments || {};
    const codex = p._meta && p._meta['x-codex-turn-metadata']; // o Codex diz a id da conversa dele
    if (codex && codex.thread_id) janelas.registrarExterno(sessao, String(codex.thread_id));
    if (!janelas.ativas.has(sessao)) return ok(texto('Esta janela não está aberta no Engram.', true));
    try {
      switch (p.name) {
        case 'equipe': return ok(texto(JSON.stringify(janelas.equipe(sessao), null, 2)));
        case 'enviar': return ok(texto(janelas.enviar(sessao, String(a.para || ''), String(a.mensagem || ''))));
        case 'ver_tela': return ok(texto(janelas.verTela(sessao, String(a.quem || ''), a.linhas ?? 60)));
        case 'entregar_arquivo': return ok(texto(janelas.entregarArquivo(sessao, String(a.caminho || ''), a.nome)));
        case 'criar_agente': return ok(texto(await janelas.criarAgente(sessao, String(a.nome || ''), String(a.papel || 'livre'), String(a.modelo || ''), a.tarefa, a.agente ? String(a.agente) : null)));
        default: return { jsonrpc: '2.0', id: m.id, error: { code: -32602, message: `ferramenta desconhecida: ${p.name}` } };
      }
    } catch (e) {
      return ok(texto(`Erro no Engram: ${e.message}`, true));
    }
  }
  return { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `método desconhecido: ${m.method}` } };
}

module.exports = { tratar };
