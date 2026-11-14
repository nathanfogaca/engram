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
- **Palcos:** até 3, alternados pelo item Palcos do menu Ferramentas (barra de baixo).
  - Cada palco tem os seus cartões, linhas, setores, automações e post-its (coluna `palco` no
    banco; o que existia antes ficou no Palco 1).
  - Trocar de palco só muda o que aparece na tela: os agentes de todos os palcos seguem rodando e
    recebendo mensagens.
  - Uma linha só liga cartões do mesmo palco. As ferramentas do maestro valem para o palco dele, e
    quem ele cria nasce nesse palco.
  - O limite de janelas soma os três palcos.
- **Quadro de tarefas** (botão Quadro, ou a tecla Q, ao lado de Ferramentas): cada mensagem que o maestro
  manda pelo `enviar` vira uma tarefa, que passa por delegada → em andamento (chegou ao colega) →
  devolvida (o colega respondeu ao maestro) → entregue (o maestro marca pela ferramenta `tarefas`, ou a
  pessoa marca na folha).
  - O quadro é de cada palco e guarda só o começo da devolutiva; a leitura abre o texto inteiro.
  - O cartão de cada agente mostra a tarefa em que ele está.
- **Diário no cérebro:** uma linha por delegação e devolutiva na nota do dia
  (`sessoes/diario-AAAA-MM-DD.md`). Leva só o assunto e um resumo curto, e e-mail, CPF, CNPJ, telefone e
  token saem mascarados. Fica ligado por padrão (Ajustes > Geral > Palco).
  - A devolutiva de uma automação pode virar nota própria (`automacoes/<nome>/`), pelo interruptor no
    painel da automação.
- **Cenas** (botão Cenas, na barra de baixo): o desenho do time guardado para recriar com um clique.
  - Guarda agentes (nome, papel, CLI e modelo), ligações e revisões, setores e posições. Automações e
    post-its só entram se a pessoa marcar.
  - Nunca guarda conversa, id, pasta, arquivo, token, chave ou MCP.
  - Recriar põe a cena ao lado do que já está no palco, ou num palco vazio (como foi salva). Se o palco
    já tem maestro, não abre outro: as linhas da cena vão para o maestro de lá.
  - Exportar e importar `.json`. O que vem de fora é refeito campo a campo e o resto é descartado.
- **Medidor de uso** (botão Uso, na barra de baixo): o chip do cartão mostra os tokens de entrada e de saída da conversa. O painel mostra
  cache lida, cache escrita e um custo estimado (o preço de tabela da API: para quem usa a conta ou
  assinatura, é só uma referência de tamanho).
  - Lê o que o Claude Code (`.jsonl`) e o Codex (`token_count` do rollout) gravam no disco.
  - Gemini CLI e OpenCode ficam sem medidor: não gravam a conversa num arquivo que o Engram lê.
  - Preços próprios entram no `config.json` (`precos`).
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
- **Cérebro:** uma pasta neste computador e um servidor remoto (MCP com `arquivos_listar` e
  `arquivos_ler`), as duas configurações guardadas juntas. O token fica numa variável de ambiente.
  - A fonte em uso troca na hora, sem reiniciar: pelo seletor no topo (Local | Servidor, ao lado
    da sincronização) ou em "Em uso agora", aqui.
  - O índice de cada fonte fica guardado: a constelação volta na hora, e a sincronização só lê o
    que mudou.
  - Se o servidor não responder na troca, o cérebro fica no Local. Os agentes já abertos recebem
    um aviso na próxima mensagem que o Engram entregar a eles (de um colega, da pessoa pela Conversa
    ou de uma automação), dizendo onde ler e gravar.
  - Nesta versão, a fonte vale para os três palcos.
  - A primeira leitura do servidor (e a de quem atualizou de uma versão antiga, que relê o índice uma
    vez) leva uns 11 minutos para ~450 notas, pelo limite de chamadas por minuto: a constelação vai crescendo e
    o topo mostra "lendo X de Y". Se o Engram fechar no meio, a leitura recomeça na próxima abertura.
- **Limites:** janelas abertas (padrão 24, de 1 a 64; vale também para o `criar_agente` do maestro),
  mensagens entre dois agentes a cada 10 minutos (a trava contra loop) e o tamanho máximo de arquivo
  (vale também para a soma dos anexos de um `enviar`).
- **Palco:** a bolha com o código sendo escrito em cima do cartão, e "Anotar delegações e devolutivas
  no cérebro" (o diário, ligado por padrão).
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
