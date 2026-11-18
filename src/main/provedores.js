// Provedores de agente: cada CLI (Claude Code, Codex, Antigravity, OpenCode) diz como é achado,
// instalado, logado e aberto numa janela do Engram, como o time (MCP) e o prompt entram nele,
// e como o estado da janela é lido (ganchos, aviso de fim de turno ou a própria tela).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');

const CASA = os.homedir();
const LOCAL = process.env.LOCALAPPDATA || path.join(CASA, 'AppData', 'Local');
const toml = s => JSON.stringify(String(s)); // string TOML básica (os escapes do JSON valem em TOML)
const MODELO_LIVRE = /^[\w.:/@[\]-]{1,100}$/;

/** Nome da variável que leva um valor de MCP até a janela (o arquivo e a linha de comando só citam o nome). */
function variavel(env, i, chave, valor) {
  const nome = `ENGRAM_MCP_${i}_${String(chave).replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`;
  env[nome] = valor;
  return nome;
}

// Perguntas que os CLIs fazem na tela (aprovar ferramenta, confiar na pasta, escolher opção)
const PERGUNTA_GERAL = /enter to (confirm|submit|continue)|esc to cancel|\(y\/n\)|Press Enter|Do you want to|Would you like to|Allow the .* to run|Do you trust|❯\s*\d+\./i;

const ADAPTADORES = {
  claude: {
    nome: 'Claude Code',
    empresa: 'Anthropic',
    comando: 'claude',
    candidatos: [path.join(CASA, '.local', 'bin', 'claude.exe')],
    instalar: 'irm https://claude.ai/install.ps1 | iex',
    site: 'https://claude.com/claude-code',
    entrar: ['auth', 'login'],
    sair: ['auth', 'logout'],
    chave: { env: 'ANTHROPIC_API_KEY', rotulo: 'Chave de API da Anthropic', exemplo: 'sk-ant-…', site: 'https://console.anthropic.com/settings/keys' },
    ganchos: true,
    conversa: 'claude',
    modelos: () => [
      { id: '', nome: 'Padrão do Claude Code' },
      { id: 'claude-opus-5-5', nome: 'Opus 5.5', resumo: 'O mais forte: análise difícil, coordenação' },
      { id: 'claude-sonnet-5-5', nome: 'Sonnet 5.5', resumo: 'Equilíbrio entre força e velocidade' },
      { id: 'claude-haiku-5-5', nome: 'Haiku 5.5', resumo: 'Rápido e leve: tarefas simples' },
      { id: 'claude-fable-5-1', nome: 'Fable 5.1', resumo: 'Para textos e narrativa' },
    ],
    async status(exe) {
      const r = await rodar(exe, ['auth', 'status']);
      try {
        const j = JSON.parse(r.saida.slice(r.saida.indexOf('{')));
        if (!j.loggedIn) return { conectado: false };
        const como = { 'claude.ai': 'conta Claude', console: 'conta do Console', api_key: 'chave de API' }[j.authMethod] || j.authMethod || 'conta';
        const plano = j.subscriptionType ? `plano ${String(j.subscriptionType).replace(/^./, l => l.toUpperCase())}` : null;
        return { conectado: true, como, conta: j.email || j.account?.email || null, plano };
      } catch { return { conectado: null, erro: 'não deu para ler o login' }; }
    },
    montar(c) {
      const env = c.chave ? { ANTHROPIC_API_KEY: c.chave } : {};
      const servidores = { engram: { type: 'http', url: c.mcpUrl, headers: { 'X-Engram-Token': '${ENGRAM_TOKEN}', 'X-Engram-Sessao': c.id } } };
      (c.mcps || []).forEach((s, i) => {
        if (s.tipo === 'http') {
          const headers = Object.fromEntries(Object.entries(s.headers || {}).map(([k, v]) => [k, `\${${variavel(env, i, k, v)}}`]));
          servidores[s.id] = { type: 'http', url: s.url, headers };
        } else {
          const e = Object.fromEntries(Object.entries(s.env || {}).map(([k, v]) => [k, `\${${variavel(env, i, k, v)}}`]));
          servidores[s.id] = { type: 'stdio', command: s.comando, args: s.args || [], env: e };
        }
      });
      const arqMcp = path.join(c.dirJanelas, `${c.id}.mcp.json`);
      fs.writeFileSync(arqMcp, JSON.stringify({ mcpServers: servidores }, null, 1));
      const argv = [...(c.retomar ? ['--resume', c.id] : ['--session-id', c.id])];
      if (c.modelo) argv.push('--model', c.modelo);
      argv.push('--settings', c.arquivoGanchos, '--mcp-config', arqMcp, '--append-system-prompt-file', c.arqPrompt);
      if (c.soEngram) argv.push('--strict-mcp-config'); // só os MCPs do Engram (ignora os configurados direto no Claude)
      if (c.pluginSkills) argv.push('--plugin-dir', c.pluginSkills);
      for (const d of c.pastas) argv.push('--add-dir', d);
      argv.push('--name', c.nome);
      return { argv, env };
    },
  },

  codex: {
    nome: 'Codex',
    empresa: 'OpenAI',
    comando: 'codex',
    candidatos: [path.join(LOCAL, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe')],
    instalar: 'irm https://chatgpt.com/codex/install.ps1 | iex',
    site: 'https://developers.openai.com/codex',
    entrar: ['login'],
    sair: ['logout'],
    chave: { env: 'CODEX_API_KEY', rotulo: 'Chave de API da OpenAI', exemplo: 'sk-…', site: 'https://platform.openai.com/api-keys' },
    ganchos: false, // tem ganchos, mas o Codex pede revisão manual de cada um; usamos o "notify" e a tela
    enterDepois: 1200,
    conversa: 'codex',
    ocupado: /esc to interrupt/i,
    pergunta: /enter to (confirm|submit|continue)|esc to skip|Allow the .{1,80} to run|Would you like to (run|make) the following|Do you trust the contents/i,
    modelos() {
      const lista = [{ id: '', nome: 'Padrão do Codex' }];
      try {
        const cache = JSON.parse(fs.readFileSync(path.join(process.env.CODEX_HOME || path.join(CASA, '.codex'), 'models_cache.json'), 'utf8'));
        for (const m of (cache.models || []).filter(x => x.visibility === 'list').sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))) {
          lista.push({ id: m.slug, nome: m.display_name || m.slug });
        }
      } catch { /* sem cache: fica o padrão e o campo livre */ }
      return lista;
    },
    async status(exe) {
      const r = await rodar(exe, ['login', 'status']);
      const t = `${r.saida}\n${r.erro}`;
      if (/Logged in using ChatGPT/i.test(t)) return { conectado: true, como: 'conta ChatGPT' };
      if (/Logged in using an API key/i.test(t)) return { conectado: true, como: 'chave de API' };
      if (/Not logged in/i.test(t)) return { conectado: false };
      return { conectado: null, erro: t.trim().split('\n').pop()?.slice(0, 120) || 'não deu para ler o login' };
    },
    montar(c) {
      const instrucoes = `${c.prompt}\n\n(Engram: janela ${c.id})`;
      const opcoes = [
        '-c', `notify=[${toml(c.runtime.node)}, ${toml(c.runtime.gancho)}]`,
        '-c', 'check_for_update_on_startup=false',
        '-c', `mcp_servers.engram.url=${toml(c.mcpUrl)}`,
        '-c', 'mcp_servers.engram.env_http_headers={"X-Engram-Token"="ENGRAM_TOKEN","X-Engram-Sessao"="ENGRAM_SESSAO"}',
        '-c', 'mcp_servers.engram.default_tools_approval_mode="approve"',
        '-c', `developer_instructions=${toml(instrucoes)}`,
      ];
      const env = c.chave ? { CODEX_API_KEY: c.chave } : {};
      (c.mcps || []).forEach((s, i) => {
        const pre = `mcp_servers.${s.id}`;
        if (s.tipo === 'http') {
          opcoes.push('-c', `${pre}.url=${toml(s.url)}`);
          const cab = Object.entries(s.headers || {}).map(([k, v]) => `${toml(k)}=${toml(variavel(env, i, k, v))}`);
          if (cab.length) opcoes.push('-c', `${pre}.env_http_headers={${cab.join(', ')}}`);
        } else {
          opcoes.push('-c', `${pre}.command=${toml(s.comando)}`, '-c', `${pre}.args=[${(s.args || []).map(toml).join(', ')}]`);
          // o servidor stdio espera os nomes originais: vão no ambiente e o Codex repassa (env_vars)
          const nomes = Object.keys(s.env || {});
          for (const k of nomes) env[k] = s.env[k];
          if (nomes.length) opcoes.push('-c', `${pre}.env_vars=[${nomes.map(toml).join(', ')}]`);
        }
        opcoes.push('-c', `${pre}.enabled=true`);
        if (s.liberar) opcoes.push('-c', `${pre}.default_tools_approval_mode="approve"`);
      });
      if (c.modelo) opcoes.push('-m', c.modelo);
      // --add-dir faz o Codex sair com erro quando o modo dele é só leitura; writable_roots só vale quando pode escrever
      opcoes.push('-c', `sandbox_workspace_write.writable_roots=[${c.pastas.map(toml).join(', ')}]`);
      const argv = c.retomar && c.externo ? ['resume', ...opcoes, c.externo] : opcoes;
      return { argv, env };
    },
  },

  antigravity: {
    nome: 'Antigravity',
    empresa: 'Google',
    comando: 'agy',
    candidatos: [
      path.join(LOCAL, 'agy', 'bin', 'agy.exe'),
      path.join(LOCAL, 'Programs', 'Antigravity', 'bin', 'agy.exe'),
    ],
    instalar: 'irm https://antigravity.google/cli/install.ps1 | iex',
    site: 'https://antigravity.google/docs',
    entrar: [], // na primeira vez o próprio Antigravity CLI abre o login Google
    sair: null,
    chave: { env: 'GEMINI_API_KEY', rotulo: 'Chave de API do Gemini', exemplo: 'AIza…', site: 'https://aistudio.google.com/apikey' },
    ganchos: false,
    experimental: false,
    ocupado: /esc to cancel|Thinking\.\.\.|\(thinking\)|Generating/i,
    pergunta: /Allow execution|Apply this change\?|Waiting for user confirmation|Do you want to proceed|Blocked/i,
    modelos: () => [
      { id: '', nome: 'Padrão do Antigravity' },
      { id: 'gemini-4-carbon-high', nome: 'Gemini 4 Carbon (High)', resumo: 'Raciocínio profundo e código complexo' },
      { id: 'gemini-4-carbon-medium', nome: 'Gemini 4 Carbon (Medium)', resumo: 'Equilíbrio entre inteligência e velocidade' },
      { id: 'gemini-4-carbon-low', nome: 'Gemini 4 Carbon (Low)', resumo: 'Carbon com resposta mais rápida' },
      { id: 'gemini-4-argon-high', nome: 'Gemini 4 Argon (High)', resumo: 'Alta precisão para tarefas exigentes' },
      { id: 'gemini-4-argon-medium', nome: 'Gemini 4 Argon (Medium)', resumo: 'Uso geral equilibrado' },
      { id: 'gemini-4-argon-low', nome: 'Gemini 4 Argon (Low)', resumo: 'Argon rápido' },
      { id: 'gemini-4-hydrogen-xhigh', nome: 'Gemini 4 Hydrogen (XHigh)', resumo: 'Esforço máximo de raciocínio' },
      { id: 'gemini-4-hydrogen-high', nome: 'Gemini 4 Hydrogen (High)', resumo: 'Alta capacidade analítica' },
      { id: 'gemini-4-hydrogen-medium', nome: 'Gemini 4 Hydrogen (Medium)', resumo: 'Equilibrado' },
      { id: 'gemini-4-hydrogen-low', nome: 'Gemini 4 Hydrogen (Low)', resumo: 'Leve e rápido' },
      { id: 'gemini-3.8-flash-high', nome: 'Gemini 3.8 Flash (High)', resumo: 'Rápido com raciocínio reforçado' },
      { id: 'gemini-3.8-flash-medium', nome: 'Gemini 3.8 Flash (Medium)', resumo: 'Rápido para tarefas diretas' },
      { id: 'gemini-3.8-flash-low', nome: 'Gemini 3.8 Flash (Low)', resumo: 'Mais rápido e econômico' },
      { id: 'gemini-pro-orchestrator', nome: 'Orchestrator (Carbon)', resumo: 'Coordenação e planejamento (Carbon)' },
      { id: 'gemini-pro-orchestrator-argon', nome: 'Orchestrator (Argon)', resumo: 'Coordenação e planejamento (Argon)' },
      { id: 'claude-opus-4-6-thinking', nome: 'Claude Opus 4.6 (Thinking)', resumo: 'Opus 4.6 no Antigravity' },
      { id: 'claude-sonnet-4-6', nome: 'Claude Sonnet 4.6 (Thinking)', resumo: 'Sonnet 4.6 no Antigravity' },
      { id: 'gpt-oss-120b-medium', nome: 'GPT-OSS 120B (Medium)', resumo: 'Modelo aberto 120B' },
    ],
    async status() {
      const pasta = path.join(CASA, '.gemini');
      for (const arq of [
        path.join(pasta, 'oauth_creds.json'),
        path.join(pasta, 'google_accounts.json'),
        path.join(pasta, 'antigravity-cli', 'jetski_state.pbtxt'),
      ]) {
        try { if (fs.existsSync(arq) && fs.statSync(arq).size > 20) return { conectado: true, como: 'conta Google' }; } catch { /* segue */ }
      }
      return { conectado: false };
    },
    montar(c) {
      // O prompt, o MCP do time, os ganchos e as skills entram numa pasta de workspace (--add-dir) com um plugin nativo
      const dir = path.join(c.dirJanelas, `${c.id}.antigravity`);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* segue */ }
      const dirPlugin = path.join(dir, '.agents', 'plugins', 'engram');
      fs.mkdirSync(path.join(dirPlugin, 'rules'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'GEMINI.md'), c.prompt, 'utf8');
      fs.writeFileSync(path.join(dir, 'AGENTS.md'), c.prompt, 'utf8');
      fs.writeFileSync(path.join(dirPlugin, 'rules', 'AGENTS.md'), c.prompt, 'utf8');
      fs.writeFileSync(path.join(dirPlugin, 'plugin.json'), JSON.stringify({
        name: 'engram', description: 'Integração Engram', version: '1.0.0',
      }, null, 2), 'utf8');

      const mcpUrlSessao = `${c.mcpUrl}?sessao=${encodeURIComponent(c.id)}&token=${encodeURIComponent(c.token)}`;
      const mcpServers = {
        engram: { url: mcpUrlSessao, headers: { 'X-Engram-Token': c.token, 'X-Engram-Sessao': c.id } },
      };
      (c.mcps || []).forEach(s => {
        mcpServers[s.id] = s.tipo === 'http'
          ? { url: s.url, ...(Object.keys(s.headers || {}).length ? { headers: s.headers } : {}) }
          : { command: s.comando, args: s.args || [], ...(Object.keys(s.env || {}).length ? { env: s.env } : {}) };
      });
      fs.writeFileSync(path.join(dirPlugin, 'mcp_config.json'), JSON.stringify({ mcpServers }, null, 2), 'utf8');

      if (c.runtime?.node && c.runtime?.gancho) {
        const cmd = `"${c.runtime.node.replace(/\\/g, '/')}" "${c.runtime.gancho.replace(/\\/g, '/')}"`;
        const hooks = {
          engram: {
            SessionStart: [{ command: `${cmd} SessionStart`, timeout: 5 }],
            PreInvocation: [{ command: `${cmd} UserPromptSubmit`, timeout: 5 }],
            PreToolUse: [{ matcher: '.*', hooks: [{ command: `${cmd} PreToolUse`, timeout: 5 }] }],
            PostToolUse: [{ matcher: '.*', hooks: [{ command: `${cmd} PostToolUse`, timeout: 5 }] }],
            Stop: [{ command: `${cmd} Stop`, timeout: 5 }],
          },
        };
        fs.writeFileSync(path.join(dirPlugin, 'hooks.json'), JSON.stringify(hooks, null, 2), 'utf8');
      }

      if (c.pluginSkillsAntigravity && fs.existsSync(c.pluginSkillsAntigravity)) {
        try { fs.cpSync(c.pluginSkillsAntigravity, path.join(dirPlugin, 'skills'), { recursive: true }); } catch { /* segue */ }
      }

      const argv = [];
      if (c.retomar && c.externo) argv.push('--conversation', c.externo);
      if (c.modelo) argv.push('--model', c.modelo);
      for (const p of [dir, ...c.pastas]) argv.push('--add-dir', p);
      return { argv, env: { ...(c.chave ? { GEMINI_API_KEY: c.chave } : {}) } };
    },
  },

  opencode: {
    nome: 'OpenCode',
    empresa: 'código aberto, vários provedores',
    comando: 'opencode',
    candidatos: [],
    instalar: 'npm install -g opencode-ai',
    site: 'https://opencode.ai',
    entrar: ['auth', 'login'],
    sair: ['auth', 'logout'],
    chave: null, // cada provedor do OpenCode tem a sua chave: "Entrar" abre o login dele
    ganchos: false,
    experimental: true,
    ocupado: /esc (to )?interrupt|working…|thinking…/i,
    pergunta: /Permission required|Allow once|Always allow/i,
    modelos: () => [{ id: '', nome: 'Padrão do OpenCode' }],
    async status(exe) {
      const r = await rodar(exe, ['auth', 'list']);
      const n = /(\d+)\s+credentials?/i.exec(`${r.saida}\n${r.erro}`);
      if (n) return Number(n[1]) > 0 ? { conectado: true, como: `${n[1]} provedor(es)` } : { conectado: false };
      return { conectado: null, erro: 'não deu para ler o login' };
    },
    montar(c) {
      const env = {};
      const mcp = { engram: { type: 'remote', url: c.mcpUrl, enabled: true, headers: { 'X-Engram-Token': '{env:ENGRAM_TOKEN}', 'X-Engram-Sessao': c.id } } };
      (c.mcps || []).forEach((s, i) => {
        const refs = obj => Object.fromEntries(Object.entries(obj || {}).map(([k, v]) => [k, `{env:${variavel(env, i, k, v)}}`]));
        mcp[s.id] = s.tipo === 'http'
          ? { type: 'remote', url: s.url, enabled: true, headers: refs(s.headers) }
          : { type: 'local', command: [s.comando, ...(s.args || [])], enabled: true, environment: refs(s.env) };
      });
      const argv = c.modelo ? ['-m', c.modelo] : [];
      return { argv, env: { ...env, OPENCODE_CONFIG_CONTENT: JSON.stringify({ mcp, instructions: [c.arqPrompt] }) } };
    },
  },
};

/** Roda o CLI e devolve a saída (sem lançar erro: código ≠ 0 também é resposta). */
function rodar(cmd, args, { timeout = 15_000, entrada = null } = {}) {
  const [exe, ...pre] = cmd;
  return new Promise(resolve => {
    const filho = execFile(exe, [...pre, ...args], { windowsHide: true, timeout, maxBuffer: 4 << 20, env: envLimpo() }, (erro, saida, falha) => {
      resolve({ codigo: erro ? (erro.code ?? 1) : 0, saida: String(saida || ''), erro: String(falha || ''), falhou: erro && erro.code === 'ENOENT' });
    });
    if (entrada !== null) filho.stdin.end(entrada); else filho.stdin.end();
  });
}

function envLimpo() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(CLAUDECODE|CLAUDE_CODE_|ELECTRON_RUN_AS_NODE)/i.test(k)) delete env[k];
  return env;
}

/**
 * Os CLIs instalados pelo npm viram um atalho .cmd, que o terminal não abre direto com segurança.
 * Lemos o atalho e chamamos o node com o script dele.
 */
function resolverAtalho(caminho) {
  if (!/\.(cmd|bat)$/i.test(caminho)) return [caminho];
  try {
    const texto = fs.readFileSync(caminho, 'utf8');
    const m = /"%(?:dp0|~dp0)%\\?([^"]+?\.(?:c?js|mjs))"/i.exec(texto);
    if (m) {
      const script = path.join(path.dirname(caminho), m[1]);
      const local = path.join(path.dirname(caminho), 'node.exe');
      const node = fs.existsSync(local) ? local : acharNoPath('node');
      if (node && fs.existsSync(script)) return [node, script];
    }
  } catch { /* segue para cmd.exe */ }
  const cmdExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
  return [cmdExe, '/d', '/s', '/c', caminho];
}

function normalizarId(id) {
  const s = String(id || '');
  return s === 'gemini' ? 'antigravity' : s;
}

function acharNoPath(nome) {
  try {
    const linhas = execFileSync('where.exe', [nome], { encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    return linhas.find(l => /\.exe$/i.test(l)) || linhas.find(l => /\.(cmd|bat)$/i.test(l)) || linhas[0] || null;
  } catch { return null; }
}

/** Um comando de MCP stdio (npx, uvx, caminho...) em algo que o Node consegue abrir sem shell. */
function comandoExecutavel(comando) {
  if (/[\\/]/.test(comando) && fs.existsSync(comando)) return resolverAtalho(comando) || [comando];
  const achado = acharNoPath(comando);
  if (achado) return resolverAtalho(achado) || [achado];
  return [comando];
}

class Provedores {
  constructor({ cfg, cofre, salvarConfig, registrar }) {
    this.cfg = cfg;
    this.cofre = cofre;
    this.salvarConfig = salvarConfig;
    this.registrar = registrar;
    this.cache = new Map(); // id -> { quando, info }
  }

  ids() { return Object.keys(ADAPTADORES); }
  adaptador(id) {
    const k = normalizarId(id);
    return Object.hasOwn(ADAPTADORES, k) ? ADAPTADORES[k] : null;
  } // só os de verdade (nada de "constructor")

  /** Comando para abrir o CLI ([exe] ou [node, script]); null se não está instalado. */
  comando(id) {
    id = normalizarId(id);
    const a = ADAPTADORES[id];
    if (!a) return null;
    const execs = this.cfg.executaveis || {};
    const proprio = execs[id] || (id === 'antigravity' ? execs.gemini : '') || (id === 'claude' ? this.cfg.claude_exe : '');
    for (const c of [proprio, ...a.candidatos]) if (c && fs.existsSync(c)) return resolverAtalho(c);
    const achado = acharNoPath(a.comando);
    return achado ? resolverAtalho(achado) : null;
  }

  modoConta(id) {
    id = normalizarId(id);
    const contas = this.cfg.contas || {};
    const cfgConta = contas[id] || (id === 'antigravity' ? contas.gemini : null);
    return cfgConta?.modo === 'chave' ? 'chave' : 'conta';
  }

  async info(id, forcar = false) {
    id = normalizarId(id);
    const guardado = this.cache.get(id);
    if (!forcar && guardado && Date.now() - guardado.quando < 120_000) return guardado.info;
    const a = ADAPTADORES[id];
    const cmd = this.comando(id);
    const info = {
      id, nome: a.nome, empresa: a.empresa, experimental: !!a.experimental, site: a.site,
      instalado: !!cmd, versao: null, instalar: a.instalar,
      pode_entrar: Array.isArray(a.entrar), pode_sair: Array.isArray(a.sair),
      chave: a.chave ? { rotulo: a.chave.rotulo, exemplo: a.chave.exemplo, site: a.chave.site } : null,
      modo: this.modoConta(id), tem_chave: false, conectado: false, como: null, conta: null, plano: null,
      modelos: a.modelos(),
    };
    if (a.chave) {
      try {
        info.tem_chave = !!(await this.cofre.ler(id)) || (id === 'antigravity' && !!(await this.cofre.ler('gemini')));
      } catch (e) { info.erro_cofre = e.message; }
    }
    if (cmd) {
      const v = await rodar(cmd, ['--version'], { timeout: 10_000 });
      info.versao = (/\d+\.\d+(\.\d+)?[\w.-]*/.exec(v.saida) || [null])[0];
      if (info.modo === 'chave' && info.tem_chave) Object.assign(info, { conectado: true, como: 'chave de API (no cofre do Windows)' });
      else { try { Object.assign(info, await a.status(cmd)); } catch (e) { info.erro = e.message; } }
    }
    this.cache.set(id, { quando: Date.now(), info });
    return info;
  }

  async todos(forcar = false) {
    return Promise.all(this.ids().map(id => this.info(id, forcar)));
  }

  /** Lista leve para a tela (sem rodar nada que demore). */
  resumo() {
    return this.ids().map(id => {
      const a = ADAPTADORES[id];
      const c = this.cache.get(id)?.info;
      return { id, nome: a.nome, experimental: !!a.experimental, instalado: c ? c.instalado : !!this.comando(id), conectado: c ? c.conectado : null, modelos: a.modelos() };
    });
  }

  modeloValido(id, modelo) {
    id = normalizarId(id);
    if (!modelo) return true;
    return ADAPTADORES[id]?.modelos().some(m => m.id === modelo) || MODELO_LIVRE.test(modelo);
  }

  nomeModelo(id, modelo) {
    id = normalizarId(id);
    const a = ADAPTADORES[id] || ADAPTADORES.claude;
    return a.modelos().find(m => m.id === (modelo || ''))?.nome || modelo || 'padrão';
  }

  /** Chave de API para injetar na janela (só no modo chave). */
  async chaveParaJanela(id) {
    id = normalizarId(id);
    if (!ADAPTADORES[id]?.chave || this.modoConta(id) !== 'chave') return null;
    return (await this.cofre.ler(id)) || (id === 'antigravity' ? await this.cofre.ler('gemini') : null);
  }

  async guardarChave(id, chave) {
    id = normalizarId(id);
    const a = ADAPTADORES[id];
    if (!a?.chave) throw new Error('este provedor não usa chave de API pelo Engram');
    chave = String(chave || '').trim();
    if (chave.length < 12 || /\s/.test(chave)) throw new Error('a chave parece incompleta');
    await this.cofre.gravar(id, chave);
    this.mudarModo(id, 'chave');
  }

  async esquecerChave(id) {
    id = normalizarId(id);
    await this.cofre.apagar(id);
    if (id === 'antigravity') await this.cofre.apagar('gemini').catch(() => {});
    this.mudarModo(id, 'conta');
  }

  mudarModo(id, modo) {
    id = normalizarId(id);
    const contas = { ...(this.cfg.contas || {}), [id]: { ...((this.cfg.contas || {})[id] || {}), modo } };
    this.cfg.contas = contas;
    this.salvarConfig({ contas });
    this.cache.delete(id);
  }

  /** O comando (para um terminal do Engram) que faz login, logout ou instala. */
  comandoDe(id, acao) {
    id = normalizarId(id);
    const a = ADAPTADORES[id];
    if (!a) throw new Error('provedor desconhecido');
    if (acao === 'instalar') {
      const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      return [ps, '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', a.instalar];
    }
    const cmd = this.comando(id);
    if (!cmd) throw new Error(`${a.nome} não está instalado`);
    const args = acao === 'entrar' ? a.entrar : acao === 'sair' ? a.sair : null;
    if (!Array.isArray(args)) throw new Error(`o ${a.nome} não tem esse comando`);
    return [...cmd, ...args];
  }

  esquecerCache(id) { if (id) this.cache.delete(id); else this.cache.clear(); }
}

module.exports = { Provedores, ADAPTADORES, PERGUNTA_GERAL, rodar, comandoExecutavel };
