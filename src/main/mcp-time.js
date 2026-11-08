// As ferramentas do time (MCP): equipe, enviar, ver_tela, entregar_arquivo, as do maestro (criar_agente,
// ligar, desligar, organizar_palco e os setores) e as dos fluxos.
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
    { name: 'enviar', description: 'Manda uma mensagem para um colega ligado a você. Ela entra na conversa dele como um pedido; se ele estiver ocupado, entra quando terminar o turno. Ele não vê a sua conversa: mande tudo o que ele precisa. A resposta chega na sua conversa marcada com [Engram · mensagem de ...]. Se as suas entregas passam por um revisor (veja em equipe), o Engram leva tudo o que você mandar a ele.',
      inputSchema: objeto({ para: { type: 'string', description: 'nome do colega, como aparece em equipe' }, mensagem: { type: 'string', description: 'a tarefa ou o resultado, completo' } }, ['para', 'mensagem']) },
    { name: 'ver_tela', description: 'Mostra as últimas linhas do terminal de um colega ligado a você, para acompanhar sem interromper.',
      inputSchema: objeto({ quem: { type: 'string' }, linhas: { type: 'integer', minimum: 10, maximum: 200, default: 60 } }, ['quem']), annotations: { readOnlyHint: true } },
    { name: 'entregar_arquivo', description: 'Devolve um arquivo à pessoa: copia para a pasta entregues/ da sua janela, e ela vê na área de arquivos da sua conversa. Se você já gravou direto em entregues/, não precisa chamar.',
      inputSchema: objeto({ caminho: { type: 'string', description: 'caminho completo do arquivo' }, nome: { type: 'string', description: 'nome com que ele aparece (opcional)' } }, ['caminho']) },
    { name: 'fluxos', description: 'Mostra os fluxos do projeto (a vista Fluxos do Engram, no estilo do n8n): cada funcionalidade em blocos (tela, rota, tratamento, banco...) com ids e arquivos. Veja antes de marcar ou desenhar.', inputSchema: objeto({}), annotations: { readOnlyHint: true } },
    { name: 'fluxo_desenhar', description: 'Desenha (ou completa) um fluxo do projeto na vista Fluxos do Engram, em blocos ligados no estilo do n8n. Use para mostrar à pessoa o plano de uma funcionalidade antes de construir, ou para registrar uma que você mapeou. Bloco sem arquivos aparece como previsto (tracejado). Mesmo id = mesmo bloco: dá para completar depois.',
      inputSchema: objeto({ fluxo: { type: 'object', description: '{ id (opcional), nome, blocos, ligacoes }', properties: {
        id: { type: 'string' }, nome: { type: 'string' },
        blocos: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, tipo: { type: 'string', enum: ['tela', 'componente', 'rota', 'servico', 'banco', 'fila', 'ia', 'externo', 'evento', 'arquivo'] }, titulo: { type: 'string' }, detalhe: { type: 'string' }, arquivos: { type: 'array', items: { type: 'string' } } }, required: ['id', 'tipo', 'titulo'] } },
        ligacoes: { type: 'array', items: { type: 'object', properties: { de: { type: 'string' }, para: { type: 'string' }, rotulo: { type: 'string' } }, required: ['de', 'para'] } },
      }, required: ['nome', 'blocos'] } }, ['fluxo']) },
    { name: 'fluxo_marcar', description: 'Marca na vista Fluxos do Engram o bloco em que você está mexendo (trabalhando), que terminou (feito) ou que deu problema (falhou): a pessoa vê o bloco acender com o seu nome. Mande também os arquivos que você criou ou mudou nele (caminhos relativos à pasta do projeto).',
      inputSchema: objeto({ fluxo: { type: 'string', description: 'id do fluxo (veja em fluxos)' }, bloco: { type: 'string', description: 'id do bloco' }, estado: { type: 'string', enum: ['trabalhando', 'feito', 'falhou'] }, arquivos: { type: 'array', items: { type: 'string' } } }, ['fluxo', 'bloco', 'estado']) },
    { name: 'criar_agente', description: `Só para o maestro. Abre uma janela nova no palco, já ligada a você, e opcionalmente já manda a primeira tarefa. Modelo leve para tarefa simples, forte para análise difícil. Sem "agente", usa o mesmo agente (CLI) que você. Máximo de ${janelas.cfg.max_janelas} janelas abertas. Agentes e modelos disponíveis: ${opcoes}.`,
      inputSchema: objeto({
        nome: { type: 'string' }, papel: { type: 'string', enum: papeis },
        agente: { type: 'string', enum: agentes.map(p => p.id), description: 'qual CLI de agente abrir' },
        modelo: { type: 'string', description: 'id do modelo (vazio = padrão do agente)' }, tarefa: { type: 'string' },
        setor: { type: 'string', description: 'nome de um setor do palco (veja em equipe): o agente nasce dentro dele e recebe a instrução do setor' },
      }, ['nome', 'papel']) },
    { name: 'ligar', description: 'Só para o maestro. Liga duas janelas abertas no palco com uma linha, como a pessoa faz arrastando, para elas conversarem pelo enviar. Use os nomes como aparecem em equipe; uma das pontas pode ser você.',
      inputSchema: objeto({ a: { type: 'string', description: 'nome de uma ponta' }, b: { type: 'string', description: 'nome da outra ponta' } }, ['a', 'b']) },
    { name: 'desligar', description: 'Só para o maestro. Tira a linha entre duas janelas: elas deixam de conversar. Se a ligação tiver revisão, ela sai junto, então o Engram recusa até você confirmar com a pessoa (confirmar_revisao=true). A resposta avisa se algum colega ficou sem caminho até você.',
      inputSchema: objeto({ a: { type: 'string' }, b: { type: 'string' }, confirmar_revisao: { type: 'boolean', description: 'só depois de a pessoa concordar em apagar a revisão da ligação' } }, ['a', 'b']) },
    { name: 'organizar_palco', description: 'Só para o maestro, e só quando a pessoa pedir para organizar ou arrumar o palco: nunca por conta própria, porque muda a posição que ela deixou nos cartões. Modo "time": você no centro e os colegas em volta, agrupados por papel; quem está dentro de um setor fica onde está. Modo "lista": posições dadas por você, em posicoes [{ nome, x, y }] (pixels do palco, o seu cartão em 0,0 fica no centro). Depois a tela enquadra o time.',
      inputSchema: objeto({
        modo: { type: 'string', enum: ['time', 'lista'] },
        posicoes: { type: 'array', items: { type: 'object', properties: { nome: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' } }, required: ['nome', 'x', 'y'] }, description: 'só no modo lista' },
      }, ['modo']) },
    { name: 'renomear', description: 'Só para o maestro, quando a pessoa pedir. Muda o nome de uma janela aberta (pode ser você). O nome é único entre as janelas abertas; a conversa da janela continua a mesma.',
      inputSchema: objeto({ quem: { type: 'string', description: 'nome atual, como aparece em equipe' }, nome: { type: 'string', description: 'nome novo, até 40 letras' } }, ['quem', 'nome']) },
    { name: 'criar_setor', description: 'Só para o maestro, quando a pessoa pedir. Cria um setor no palco (uma área com nome, cor e instrução, como a pessoa desenha com o botão Setor) em volta dos agentes dados. Quem está dentro recebe a instrução do setor junto com cada tarefa, e o organizar_palco não tira ninguém de dentro. Se o retângulo em volta deles pegaria outro agente ou encostaria noutro setor, o Engram junta os cartões num lugar livre.',
      inputSchema: objeto({
        nome: { type: 'string', description: 'até 24 letras, ex.: Time NBS' },
        agentes: { type: 'array', items: { type: 'string' }, description: 'nomes dos agentes que ficam dentro, como aparecem em equipe' },
        instrucao: { type: 'string', description: 'o que esse setor faz e as regras dele (vai junto em cada tarefa)' },
        cor: { type: 'string', enum: ['violeta', 'ciano', 'magenta', 'ambar', 'verde', 'coral'], description: 'sem cor, usa uma que ainda não está em uso' },
      }, ['nome', 'agentes']) },
    { name: 'editar_setor', description: 'Só para o maestro, quando a pessoa pedir. Muda nome, cor ou instrução de um setor; com agentes, refaz a área em volta deles (quem ficar fora sai do setor).',
      inputSchema: objeto({
        setor: { type: 'string', description: 'nome atual do setor' }, nome: { type: 'string', description: 'nome novo' },
        instrucao: { type: 'string' }, cor: { type: 'string', enum: ['violeta', 'ciano', 'magenta', 'ambar', 'verde', 'coral'] },
        agentes: { type: 'array', items: { type: 'string' } },
      }, ['setor']) },
    { name: 'remover_setor', description: 'Só para o maestro, quando a pessoa pedir. Tira um setor do palco; os agentes continuam onde estão.',
      inputSchema: objeto({ setor: { type: 'string', description: 'nome do setor' } }, ['setor']) },
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
        case 'fluxos': return ok(texto(janelas.fluxos ? janelas.fluxos.paraAgente() : 'Os fluxos não estão disponíveis.'));
        case 'fluxo_desenhar': return ok(texto(janelas.fluxos.desenhar(sessao, a.fluxo)));
        case 'fluxo_marcar': return ok(texto(janelas.fluxos.marcar(sessao, a)));
        case 'entregar_arquivo': return ok(texto(janelas.entregarArquivo(sessao, String(a.caminho || ''), a.nome)));
        case 'criar_agente': return ok(texto(await janelas.criarAgente(sessao, String(a.nome || ''), String(a.papel || 'livre'), String(a.modelo || ''), a.tarefa, a.agente ? String(a.agente) : null, a.setor ? String(a.setor) : '')));
        case 'ligar': return ok(texto(janelas.ligarJanelas(sessao, String(a.a ?? ''), String(a.b ?? ''))));
        case 'desligar': return ok(texto(janelas.desligarJanelas(sessao, String(a.a ?? ''), String(a.b ?? ''), a.confirmar_revisao === true)));
        case 'organizar_palco': return ok(texto(janelas.organizarPalco(sessao, String(a.modo || ''), a.posicoes)));
        case 'renomear': return ok(texto(janelas.renomearPeloMaestro(sessao, String(a.quem ?? ''), String(a.nome ?? ''))));
        case 'criar_setor': return ok(texto(janelas.criarSetor(sessao, a)));
        case 'editar_setor': return ok(texto(janelas.editarSetor(sessao, a)));
        case 'remover_setor': return ok(texto(janelas.removerSetor(sessao, a)));
        default: return { jsonrpc: '2.0', id: m.id, error: { code: -32602, message: `ferramenta desconhecida: ${p.name}` } };
      }
    } catch (e) {
      return ok(texto(`Erro no Engram: ${e.message}`, true));
    }
  }
  return { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `método desconhecido: ${m.method}` } };
}

module.exports = { tratar };
