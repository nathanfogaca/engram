# Engram (app desktop)

Palco de agentes de IA ligados por linhas, com cérebro de notas, arquivos por agente, skills e MCPs.
App Electron de verdade: instalador, janela própria, bandeja e atualização pelo GitHub Releases.

## Rodar e empacotar

```powershell
npm install
npm start            # desenvolvimento
npm run dist         # gera dist\Engram-windows-x64.exe (+ latest.yml para a atualização)
```

**Cópia de teste**, sem mexer no Engram de todo dia:

```bash
ENGRAM_DADOS=<pasta> ENGRAM_PORTA=8890 npm start -- --remote-debugging-port=9333
```

Com o app aberto assim, dá para testar e fotografar pelo Playwright com `connect_over_cdp`.

## Como funciona

```
tela (src/tela, servida em engram://app)  ──IPC──  processo principal (src/main)
                                                     ├─ banco SQLite embutido (node:sqlite): cérebro e palco
                                                     ├─ fonte do cérebro: pasta local (padrão) ou servidor MCP
                                                     ├─ servidor 127.0.0.1:<porta> só para os AGENTES: MCP do time + ganchos
                                                     └─ cliente do motor (TCP local, com token)
motor (src/motor/motor.js, Node puro, fora da pasta de instalação)
   └─ terminais dos agentes (node-pty)  ← fechar ou atualizar o app não derruba o time
```

- **A tela não abre porta:**
  - fala com o app por IPC (`preload.js`) e é servida pelo protocolo `engram://`, com CSP;
  - os arquivos dos agentes abrem por `engram://arquivo/...`, isolados (sandbox).
- **Motor no app instalado:**
  - `scripts/preparar-motor.js` monta `build/motor-runtime` (node.exe, motor.js, gancho.js e
    node-pty em `modulos/`);
  - o app copia isso para `%LOCALAPPDATA%\Engram\motor\v1-<id>`;
  - o motor nasce pelo `Start-Process`, sem herdar handles do app (se herdasse, seguraria arquivos
    e portas e travaria a atualização).
- **Agentes:** cada janela escolhe o agente (CLI) e o modelo. Veja "Contas e agentes" abaixo.
- **Dados:** `%APPDATA%\Engram` (banco, config.json, arquivos, cérebro local).

## Primeiro uso

Na primeira vez (sem nenhuma janela aberta, sem ter passado pelo guia e sem ter importado o Engram
antigo), um guia em tela cheia leva por cinco passos:
1. boas-vindas e tema;
2. contas (precisa de pelo menos um agente conectado);
3. agente e modelo padrão;
4. MCPs e skills achados nos CLIs, para trazer (opcional);
5. o primeiro time: Maestro + 2 agentes, Dupla com revisor, ou Um agente só, já ligados no palco.

Dá para pular o guia a qualquer momento. Ele não volta depois de concluído ou pulado
(`primeiro_uso_feito` no `config.json`).

## Ajustes (Ctrl+,)

O botão **Ajustes**, no topo, abre cinco abas: Geral, Aparência, Contas, MCPs e Skills.

### Geral

- **Onde os agentes trabalham:** a pasta de trabalho de cada janela nova.
- **Cérebro:** uma pasta neste computador ou um servidor remoto (MCP com `arquivos_listar` e
  `arquivos_ler`). O token fica numa variável de ambiente. Trocar a fonte vale depois de
  reiniciar; o botão "Reiniciar agora" não derruba os agentes.
- **Limites:** janelas abertas, mensagens entre dois agentes a cada 10 minutos (a trava contra loop) e
  o tamanho máximo de arquivo.
- **Contexto para todos os agentes:** o texto que entra no prompt de toda janela nova (ex.: o mapa dos
  sistemas da empresa).
- **Atualização:** liga e desliga a instalação sozinha.

### Aparência

- **Seis temas:** Aurora (o original), Oceano, Brasa, Grafite, Claro e Alto contraste.
- **Troca:** muda na hora, com transição, e fica salvo. A cor dos botões de janela do Windows
  acompanha o tema.
- **Como funciona:**
  - todas as cores do CSS saem de poucas variáveis (`--tinta`, `--superficie`, `--poco`, `--veu` e
    `--acento1..3`, em canais RGB);
  - cada tema só redefine essas variáveis em `:root[data-tema="..."]`;
  - `js/tema-cedo.js` aplica o último tema antes de desenhar, para não piscar.
- **No tema Claro:** os terminais e a constelação do cérebro continuam escuros, porque foram feitos
  para o escuro.
- **Alto contraste:** fundo preto, bordas fortes, foco amarelo e sem transparência nem desfoque.

### MCPs

- **Cadastro:** HTTP (endereço, cabeçalhos, certificado da empresa) ou stdio (comando, argumentos,
  variáveis). Cada um tem:
  - o botão **Testar**, que conecta, lista as ferramentas e mostra o tempo;
  - uma chave para ligar e desligar;
  - para quais agentes vale;
  - "liberar sem perguntar", que aprova as ferramentas no Claude (`mcp__<nome>`) e no Codex
    (`default_tools_approval_mode`).
- **Segredos:** o cadeado 🔒 manda o valor para o cofre do Windows (`Engram:mcp:<nome>:...`). Valores
  com `${VARIAVEL}` são lidos do ambiente. Nada de token vai para arquivo ou para a linha de comando:
  - os arquivos citam variáveis (`${ENGRAM_MCP_...}` no Claude e no Gemini, `{env:...}` no
    OpenCode, `env_http_headers` e `env_vars` no Codex);
  - o valor vai só no ambiente da janela.
- **Nos seus CLIs:** lista os MCPs já configurados no Claude Code (global, pasta de trabalho e
  `.mcp.json`) e no Codex (`codex mcp list`, sem os internos do app do Codex). **Trazer** copia para o
  Engram, e os tokens vão para o cofre.
- **"Usar só os MCPs do Engram":** no Claude, vira `--strict-mcp-config` e ignora o que estiver
  configurado direto nele.
- **Ao abrir uma janela,** o "+ Agente" mostra os MCPs ativos daquele agente, e dá para tirar algum só
  daquela janela. Quando a janela é reaberta, ela volta com a mesma escolha.
- **Servidores próprios** (de uma empresa, por exemplo) são só mais um MCP. Quem não tem nenhum usa o app normalmente.

### Skills

- **A biblioteca** fica em `%APPDATA%\Engram\skills\<nome>\SKILL.md`. Na aba dá para:
  - criar uma skill, editar com prévia ao vivo (Ctrl+S salva), ver a pasta e remover;
  - importar um `.zip`, um `.skill` (o pacote do skill-creator), uma pasta ou um `SKILL.md`;
  - trazer as que já estão no Claude Code (`~/.claude/skills`) ou no Codex.
- **Cada skill** liga e desliga e escolhe Claude e/ou Codex. Vale para janelas novas.
- **Como cada CLI recebe:**
  - **Claude Code:** entram como um plugin só das janelas do Engram (`--plugin-dir`), com o nome
    `engram:<skill>`. A pasta `~/.claude/skills` da pessoa não é tocada;
  - **Codex:** não aceita pasta extra. O Engram instala em `~/.codex/skills/engram-<nome>` com a marca
    `.engram` e só mexe nas pastas que ele mesmo criou. Ali a skill vale para o Codex inteiro.
- **Testado:** numa janela Claude, `/mcp` mostrou `engram` e o MCP de teste (stdio com segredo do
  cofre) conectados e `/skills` mostrou `engram:resumo-de-chamado`; numa janela Codex, `/mcp` e a
  lista de skills mostraram os mesmos.

### Contas e agentes

A aba **Contas** mostra cada CLI de agente: se está instalado, a versão e o login.
- **Entrar, Sair e Instalar** abrem um terminal de verdade ali dentro, com o comando oficial de cada
  um. Quando ele termina, o Engram confere o login de novo.
- **Chave de API** vai para o Gerenciador de Credenciais do Windows (`Engram:<agente>`), nunca para o
  disco do Engram. Ela só entra nas janelas daquele agente, e só enquanto a conta estiver no modo
  "chave".

| Agente | Login | Time (MCP) | Prompt do Engram | Estado no cartão | Vista Conversa | Retomar |
|---|---|---|---|---|---|---|
| Claude Code | `claude auth login` ou `ANTHROPIC_API_KEY` | `--mcp-config` | `--append-system-prompt-file` | ganchos | sim | `--resume` |
| Codex | `codex login` ou `CODEX_API_KEY` | `-c mcp_servers.engram…` (aprovado só para o Engram) | `-c developer_instructions` | `notify` + tela | sim (`~/.codex/sessions`) | `codex resume <id>` |
| Gemini CLI (experimental) | o próprio CLI pergunta; ou `GEMINI_API_KEY` | settings de sistema por janela | `GEMINI.md` numa pasta incluída | tela | não (abre no Terminal) | abre de novo |
| OpenCode (experimental) | `opencode auth login` | `OPENCODE_CONFIG_CONTENT` | `instructions` | tela | não (abre no Terminal) | abre de novo |

- **Testado neste PC:**
  - Claude + Codex no mesmo time: a Ana (Haiku) perguntou ao Beto (Codex) pelo `enviar` e a resposta
    voltou;
  - motor derrubado: o Codex voltou com `codex resume` e lembrou da conversa;
  - login pela tela (com um CLI de teste) e chave guardada e removida do cofre do Windows.
- **Gemini e OpenCode** não estão instalados aqui. Por isso estão marcados como experimentais: detectar,
  instalar e entrar funcionam pela tela, mas a janela deles ainda não foi testada de ponta a ponta.
- **Pegadinhas do Codex:**
  - ganchos passados por `-c` pedem revisão manual a cada abertura, por isso o estado vem do `notify`
    e da tela;
  - `--add-dir` faz o Codex sair com erro quando ele está em modo só leitura, então as pastas do
    Engram entram como `sandbox_workspace_write.writable_roots`;
  - no Windows, um Enter logo depois de colar vira quebra de linha. O Engram espera 1,2 s e confere
    se ele começou a trabalhar.
- **Caminho próprio de um CLI:** `executaveis` no `config.json` (ex.: `{ "codex": "D:\\ferramentas\\codex.exe" }`).
  Os atalhos `.cmd` do npm são lidos e viram `node <script>`.

## Atualização automática

- **Como o app se atualiza:**
  - confere o GitHub Releases 15 s depois de abrir e a cada 2 h, e baixa em segundo plano;
  - confere o SHA-512 do `latest.yml`;
  - instala sozinho quando a janela não está em uso há 2 min (escondida na bandeja ou sem foco), ou
    na hora pelo selo **"atualizar agora"** na barra do topo;
  - reabre sozinho.
- **Os agentes não caem**, porque estão no motor, fora da pasta de instalação.
- **Para lançar uma versão:**
  1. Uma vez só: crie o repositório no GitHub e suba este projeto. O workflow
     `.github/workflows/lancar.yml` pega o usuário e o repositório do próprio GitHub.
  2. Suba o `version` no `package.json` (ex.: `0.2.0`), faça o commit e `git tag v0.2.0 && git push origin v0.2.0`.
  3. O GitHub Actions empacota e publica. Quem tem o app recebe sozinho.
- **Config (opcional, em `%APPDATA%\Engram\config.json`):**
  - `atualizacao_url` (outro endereço, ex.: servidor interno);
  - `atualizar_sozinho: false`;
  - `atualizacao_intervalo_min`;
  - `atualizacao_ociosidade_s`.
- **Testado** com um "GitHub de mentira" local (servidor servindo o `latest.yml` e o instalador da
  0.1.1):
  - instalei a 0.1.0 e abri um agente;
  - a 0.1.1 foi achada e baixada em 1 s;
  - "atualizar agora" fechou o app, o instalador rodou em silêncio e o app reabriu sozinho na
    0.1.1 em 26 s;
  - **o agente continuou sendo o mesmo processo e a 0.1.1 reencontrou ele.**

## Fases

0. ~~Base: tela portada para IPC, núcleo em Node, motor em Node~~. Testado no app: time
   conversando, app fechado à força com os agentes vivos, reabertura com a conversa seguindo.
1. ~~Instalador NSIS por usuário, ícone, bandeja, motor fora da pasta de instalação, importar o
   Engram antigo~~. Testado o app empacotado e a importação numa cópia do banco.
2. ~~Atualização automática (electron-updater + GitHub Actions)~~. Testado instalar → atualizar
   com um agente rodando.
3. ~~Contas e provedores: Claude Code, Codex, Gemini CLI e OpenCode; login pela tela; chaves no cofre
   do Windows~~. Testado o time misto Claude + Codex e a retomada do Codex.
4. ~~Áreas de MCPs e de skills~~. Testado com uma janela Claude e uma Codex recebendo MCP e skill.
5. ~~Temas, primeiro uso guiado e a aba Geral~~. Testado o guia inteiro (do tema ao time aberto),
   os seis temas no palco, e tema e ajustes salvos depois de reiniciar, com o time reencontrado.
