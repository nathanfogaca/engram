// Configuração do Engram. O padrão está aqui; o que a pessoa muda fica em <dados>/config.json.
// Nada aqui é específico de uma pessoa ou empresa: servidores próprios, mapa de sistemas e papéis entram por config.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { app } = require('electron');

const RAIZ = path.resolve(__dirname, '..', '..');

const PROMPT_BASE = `Você está rodando dentro do Engram, na janela "{nome}".

O Engram tem um cérebro: a memória de longo prazo compartilhada pelos agentes, em notas Markdown
ligadas por [[id]]. {cerebro}
- Ao começar um assunto, procure no cérebro antes de investigar do zero.
- Ao aprender algo que vale para as próximas vezes, grave ou atualize a nota certa.

Sua pasta de arquivos no Engram é {pasta}. O que a pessoa te mandar (logs, prints, PDFs,
planilhas) fica em recebidos/, e a mensagem dela traz o caminho: leia o arquivo. Para devolver um
arquivo (planilha, script, relatório, imagem), grave em entregues/ ou use
mcp__engram__entregar_arquivo. Ela vê os arquivos na sua janela.

Você também faz parte de um time. No palco do Engram, as janelas ligadas a você por uma linha são
seus colegas, e só com eles você fala:
- mcp__engram__equipe mostra quem você é e quem está ligado a você (nome, papel, modelo, estado);
- mcp__engram__enviar manda uma mensagem que entra na conversa do colega como um pedido. Ele não vê
  a sua conversa: escreva a tarefa ou o resultado completo, com o contexto necessário;
- mcp__engram__ver_tela mostra o terminal de um colega, para acompanhar sem interromper.
Mensagens de colegas chegam na sua conversa começando com "[Engram · mensagem de ...]". Quando
receber uma tarefa, faça e devolva o resultado com enviar para quem pediu. Não mande mensagem só
para confirmar que recebeu, e não responda a uma resposta que não pede nada.
{contexto}`;

const PAPEIS = {
  maestro: {
    nome: 'Maestro', resumo: 'Rege o time: divide o pedido, delega e junta os resultados',
    prompt: 'Seu papel nesta janela: MAESTRO, quem rege o time. Entenda o pedido, divida em tarefas e delegue com mcp__engram__enviar para os colegas ligados a você (veja papéis e modelos com mcp__engram__equipe). ANTES de delegar, confira se o pedido combina com quem vai receber: se a pessoa citar um sistema ou assunto que não é daquele colega, diga isso e pergunte, ou mande para quem cuida do assunto explicando por quê. Se um colega responder que aquilo não existe no lado dele, não encerre: ofereça perguntar a quem cuida do assunto certo. Acompanhe com mcp__engram__ver_tela quando precisar, junte os resultados e responda. Se faltar alguém, crie com mcp__engram__criar_agente (modelo leve para tarefa simples, forte para análise difícil). Para montar o time no palco, mcp__engram__ligar e mcp__engram__desligar põem e tiram linhas entre os colegas (o equipe mostra com quem cada um fala e quem está no palco sem ligação com você); só arrume os cartões com mcp__engram__organizar_palco quando a pessoa pedir. Prefira coordenar a fazer o trabalho dos outros.',
  },
  livre: { nome: 'Livre', resumo: 'Um agente completo, sem papel definido', prompt: '' },
  revisor: {
    nome: 'Revisor', resumo: 'Confere números, causa, evidência e código do que os colegas mandam',
    prompt: 'Seu papel nesta janela: revisor. Confira o trabalho que os colegas mandarem: números, causa, evidência, código. Devolva o que está certo, o que está errado e o que falta, sem reescrever o que já está bom.',
  },
  redator: {
    nome: 'Redator', resumo: 'Transforma análise técnica em texto claro para quem vai ler',
    prompt: 'Seu papel nesta janela: redator. Transforme análises técnicas em textos claros para quem vai ler, sem jargão e com o que a pessoa precisa fazer.',
  },
  bibliotecario: {
    nome: 'Bibliotecário', resumo: 'Cuida do cérebro: duplicadas, ligações faltando, notas velhas',
    prompt: 'Seu papel nesta janela: bibliotecário do cérebro. Procure notas duplicadas, ligações faltando, notas desatualizadas e ligações para notas que ainda não existem. Mostre o que pretende mudar antes de mudar muita coisa.',
  },
};

// Temas: cor de fundo da janela e dos botões de minimizar/fechar do Windows (o resto é CSS)
const TEMAS = {
  aurora: { nome: 'Aurora', fundo: '#04060a', simbolos: '#c9d1de' },
  oceano: { nome: 'Oceano', fundo: '#020a10', simbolos: '#c3d6e4' },
  brasa: { nome: 'Brasa', fundo: '#0b0605', simbolos: '#e8d6cf' },
  grafite: { nome: 'Grafite', fundo: '#0c0d0f', simbolos: '#d1d5db' },
  claro: { nome: 'Claro', fundo: '#eef1f7', simbolos: '#1e293b' },
  'alto-contraste': { nome: 'Alto contraste', fundo: '#000000', simbolos: '#ffffff' },
};

const PADRAO = {
  porta: 8870, // servidor local das ferramentas do time (MCP) e dos ganchos; a tela usa IPC
  motor_porta: 0, // 0 = porta + 9
  max_janelas: 8,
  max_mensagens_par_10min: 30,
  max_arquivo_mb: 100,
  pasta_trabalho: '', // vazio = pasta do usuário
  claude_exe: '', // vazio = procura no PATH e nos lugares de sempre
  executaveis: {}, // caminho próprio de cada CLI de agente (ex.: { codex: 'C:\\...\\codex.exe' })
  contas: {}, // { claude: { modo: 'conta' | 'chave' } }: a chave em si fica no cofre do Windows
  contexto: '', // texto extra para o prompt de todas as janelas (ex.: mapa dos sistemas da empresa)
  papeis_extra: {}, // papéis próprios da pessoa ou da empresa
  cerebro: { fonte: 'pasta', pasta: '', sincronizar_min: 5 },
  // fonte remota: { fonte: 'remoto', url, token_env, ca, pasta_remota: 'cerebro', servidor: '<nome do MCP>' }
  tema: 'aurora',
};

function dirDados() {
  return app.getPath('userData');
}

function caminhos() {
  const dados = dirDados();
  return {
    dados,
    banco: path.join(dados, 'engram.db'),
    arquivos: path.join(dados, 'arquivos'),
    janelas: path.join(dados, 'janelas'),
    cerebro: path.join(dados, 'cerebro'),
    config: path.join(dados, 'config.json'),
    token: path.join(dados, 'token-local.txt'),
    log: path.join(dados, 'engram.log'),
  };
}

function carregar() {
  const c = caminhos();
  let salvo = {};
  // o Bloco de Notas e o PowerShell 5.1 gravam um BOM no início, e o JSON.parse não aceita
  try { salvo = JSON.parse(fs.readFileSync(c.config, 'utf8').replace(/^\uFEFF/, '')); } catch (e) { if (e.code !== 'ENOENT') registrar(`config.json ilegível: ${e.message}`); }
  const cfg = { ...PADRAO, ...salvo, cerebro: { ...PADRAO.cerebro, ...(salvo.cerebro || {}) } };
  // configurações de versões antigas usavam outro nome para a fonte remota: o que tem endereço é remoto
  if (cfg.cerebro.fonte !== 'pasta' && cfg.cerebro.fonte !== 'remoto') cfg.cerebro.fonte = cfg.cerebro.url ? 'remoto' : 'pasta';
  if (process.env.ENGRAM_PORTA) cfg.porta = Number(process.env.ENGRAM_PORTA);
  if (!cfg.motor_porta) cfg.motor_porta = cfg.porta + 9;
  if (!cfg.pasta_trabalho) cfg.pasta_trabalho = app.getPath('home');
  if (!cfg.cerebro.pasta) cfg.cerebro.pasta = c.cerebro;
  cfg.papeis = { ...PAPEIS, ...cfg.papeis_extra };
  if (!TEMAS[cfg.tema]) cfg.tema = 'aurora';
  cfg.prompt_base = PROMPT_BASE;
  return cfg;
}

function salvar(parcial) {
  const c = caminhos();
  let salvo = {};
  try { salvo = JSON.parse(fs.readFileSync(c.config, 'utf8').replace(/^\uFEFF/, '')); } catch { /* novo */ }
  const novo = { ...salvo, ...parcial };
  fs.mkdirSync(c.dados, { recursive: true });
  fs.writeFileSync(c.config, JSON.stringify(novo, null, 2), 'utf8');
}

function tokenLocal() {
  const c = caminhos();
  try {
    const t = fs.readFileSync(c.token, 'ascii').trim();
    if (t.length >= 32) return t;
  } catch { /* cria */ }
  fs.mkdirSync(c.dados, { recursive: true });
  const t = crypto.randomBytes(32).toString('base64url');
  fs.writeFileSync(c.token, t, 'ascii');
  return t;
}

function registrar(texto) {
  try { fs.appendFileSync(caminhos().log, `${new Date().toISOString()} ${texto}\n`, 'utf8'); } catch { /* sem log */ }
}

module.exports = { RAIZ, PROMPT_BASE, PAPEIS, TEMAS, carregar, salvar, caminhos, tokenLocal, registrar };
