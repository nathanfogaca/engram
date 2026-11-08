<p align="center">
  <img src=".github/midia/engram.png" alt="Engram" height="88">
</p>

<h1 align="center">Engram</h1>

<h3 align="center">Um time de agentes de IA trabalhando junto, no seu computador.</h3>

<p align="center">
  Claude Code e Codex em cartões num palco, ligados por linhas que você desenha.<br>
  Um maestro divide o trabalho, um revisor confere, e o que o time aprende vai para um cérebro de notas que fica com você.
</p>

<p align="center">
  <a href="https://github.com/nathanfogaca/engram/releases/latest"><img alt="Versão mais recente" src="https://img.shields.io/github/v/release/nathanfogaca/engram?label=vers%C3%A3o&color=7c5cff"></a>
  <img alt="Windows 10 e 11" src="https://img.shields.io/badge/Windows-10%20%C2%B7%2011-0078D4?logo=windows&logoColor=white">
  <img alt="Claude Code e Codex" src="https://img.shields.io/badge/agentes-Claude%20Code%20%C2%B7%20Codex-d97757">
  <img alt="Electron 44" src="https://img.shields.io/badge/Electron-44-47848F?logo=electron&logoColor=white">
</p>

<p align="center">
  <img src=".github/midia/time.webp" alt="O palco do Engram com três agentes: o Maestro pede a página de contato ao Front-end, a entrega passa pelo Revisor e volta ao Maestro" width="920">
</p>
<p align="center"><sub>Um pedido de verdade: o Maestro passa a página de contato ao Front-end, a entrega vai primeiro ao Revisor e só depois volta ao Maestro.</sub></p>

## Baixar

<div align="center">
<table>
  <tr>
    <td align="center" width="420">
      <img src="https://cdn.jsdelivr.net/gh/devicons/devicon@v2.16.0/icons/windows11/windows11-original.svg" height="56" alt="Windows"><br>
      <b>Windows</b><br>
      Windows 10 e 11 · 64 bits<br>
      <img alt="Versão mais recente" src="https://img.shields.io/github/v/release/nathanfogaca/engram?label=&color=7c5cff&style=flat-square"><br><br>
      <a href="https://github.com/nathanfogaca/engram/releases/latest/download/Engram-windows-x64.exe"><b>Baixar o instalador</b></a><br>
      <sub><code>.exe</code> · instala só para o seu usuário</sub>
    </td>
  </tr>
</table>
</div>

<p align="center"><sub>Todas as versões ficam em <a href="https://github.com/nathanfogaca/engram/releases">Releases</a>. As novas chegam sozinhas: o app avisa e atualiza sem derrubar os agentes.</sub></p>

**Antes de começar**, tenha pelo menos um agente pronto: [Claude Code](https://claude.com/claude-code) ou [Codex](https://developers.openai.com/codex) instalado e com login feito. O Engram usa a sua assinatura; chave de API é opcional, em **Ajustes → Contas**.

<details>
<summary><b>Primeira vez</b> (o instalador ainda não tem certificado de assinatura)</summary>

- Se o Windows mostrar "O Windows protegeu o computador", clique em **Mais informações → Executar assim mesmo**.
- Na primeira abertura, um guia leva você pelo tema, pelas contas e pelo agente padrão, e já monta o primeiro time.

</details>

## Um tour rápido

### Monte o time

Clique em **+ Agente** e escolha o agente, o modelo e o papel de cada janela. Arraste uma linha da borda de um cartão até outro e os dois passam a conversar: as mensagens correm pela linha. O **maestro** recebe o seu pedido, divide em tarefas e junta as respostas. Os agentes rodam num motor à parte: fechar, reiniciar ou atualizar o app não derruba ninguém, e a conversa continua de onde parou.

<p align="center"><img src=".github/midia/palco-perto.webp" alt="O palco: o Maestro ligado ao Front-end e ao Revisor, com o Front-end escrevendo a página" width="920"></p>

### Revisão no caminho

<table>
  <tr>
    <td width="55%" valign="top">
      <br>Clique na linha entre dois agentes e escolha quem revisa. Tudo o que um entrega passa pelo outro, junto com a tarefa original, antes de chegar a quem pediu.<br><br>
      O revisor confere e entrega com o que verificou, ou devolve uma vez dizendo o que corrigir. O selo <b>✓ revisão</b> na linha mostra quem revisa quem.
    </td>
    <td width="45%" valign="top"><img src=".github/midia/revisao.webp" alt="O Front-end entrega, a linha com o selo de revisão leva ao Revisor, que confere antes de passar ao Maestro"></td>
  </tr>
</table>

### Veja o agente escrevendo

O olho no cartão abre **Visualizar trabalho**, uma janela à parte para acompanhar o agente: as linhas novas entram sendo digitadas, as que saem ficam vermelhas antes de sumir, e ao lado aparecem os arquivos que ele mexeu e a linha do tempo de cada passo. A aba **Mudanças** mostra o antes e depois de cada arquivo.

<p align="center"><img src=".github/midia/trabalho.webp" alt="A janela Visualizar trabalho: o Front-end escrevendo sobre.html e depois o bloco novo no estilo.css" width="920"></p>

### O cérebro

Notas em Markdown ligadas por `[[id]]`, desenhadas como uma rede de neurônios viva. Os agentes leem antes de investigar e gravam o que aprendem; quando um deles lê uma nota, a linha acende até ela. O cérebro fica numa pasta sua, ou num servidor da equipe por MCP.

<p align="center"><img src=".github/midia/cerebro.webp" alt="O cérebro com 75 notas e o Front-end lendo notas sobre cupons e entrega" width="820"></p>

Busque com **Ctrl+K** e abra a nota no leitor: o que ela aponta e quem aponta para ela.

<p align="center"><img src=".github/midia/cerebro-nota.webp" alt="A nota Cupom não aplica no carrinho aberta, com as ligações acesas no cérebro" width="920"></p>

### Código

O lado VS Code do Engram: explorador de arquivos, editor Monaco com abas, terminais, busca rápida (**Ctrl+P**) e paleta de comandos (**Ctrl+Shift+P**). Com o IntelliSense, o Python ganha autocompletar com tipos, documentação ao passar o mouse, ir para a definição e erros sublinhados. Quando um agente mexe num arquivo aberto, o editor recarrega sozinho.

<p align="center"><img src=".github/midia/codigo.webp" alt="O editor com pedidos.py, a documentação de aplicar_cupom ao passar o mouse e o terminal rodando o script" width="920"></p>

No Git, as mudanças aparecem lado a lado. A mensagem do commit a IA escreve por você, e dá para fazer push, trocar de branch e publicar no GitHub sem sair do app.

<p align="center"><img src=".github/midia/git.webp" alt="O painel Git com três alterações e o antes e depois do estilo.css" width="920"></p>

### Extensões e temas do VS Code

Busque na loja Open VSX ou traga as extensões que já estão no seu VS Code ou Cursor. Temas de cores, temas de ícones, realce de sintaxe e snippets funcionam no Engram, e cada extensão mostra antes o que dela funciona aqui.

<p align="center"><img src=".github/midia/extensoes.webp" alt="A loja de extensões com o Dracula Theme Official instalado" width="920"></p>

**Ctrl+K Ctrl+T** troca o tema de cores com prévia ao vivo, como no VS Code.

<p align="center"><img src=".github/midia/temas-vscode.webp" alt="A paleta de temas passando por vários temas até o Dracula" width="920"></p>

### Prévias

Quando um agente entrega um arquivo, ele abre numa prévia, como os artefatos do Claude: página HTML rodando de verdade (com os erros do console à vista), imagem, vídeo, áudio, PDF, Markdown e planilha CSV. A prévia recarrega sozinha quando o arquivo muda e guarda as versões.

<table>
  <tr>
    <td width="50%"><img src=".github/midia/previa-html.webp" alt="A prévia da página de contato"><br><sub><b>HTML.</b> A página que o Front-end criou, rodando.</sub></td>
    <td width="50%"><img src=".github/midia/previa-planilha.webp" alt="A prévia da planilha de vendas"><br><sub><b>CSV.</b> A planilha de vendas como tabela.</sub></td>
  </tr>
</table>

### Navegador

Subiu um servidor no terminal? O Engram percebe o endereço, avisa e abre o site dentro dele, como computador, tablet ou celular.

<table>
  <tr>
    <td width="50%"><img src=".github/midia/navegador-painel.webp" alt="O site rodando em localhost no navegador do Engram, no tamanho de computador"><br><sub><b>Computador.</b> O localhost aberto ao lado do código.</sub></td>
    <td width="50%"><img src=".github/midia/navegador-celular.webp" alt="O mesmo site no tamanho de celular"><br><sub><b>Celular.</b> O mesmo site, no tamanho de um telefone.</sub></td>
  </tr>
</table>

### Fluxos

O projeto em blocos ligados, no estilo do n8n: tela, rota, tratamento, banco. Uma IA lê a pasta e monta o mapa sozinha; os agentes marcam o bloco em que estão mexendo e ele acende com o nome de cada um. Clique num bloco para ver os arquivos e as ligações, e para pedir uma mudança só nele.

<p align="center"><img src=".github/midia/fluxos.webp" alt="O fluxo Calcular pedido, com o bloco Pedido.subtotal aceso porque o Front-end está mexendo nele" width="920"></p>

### MCPs, skills e contas

<table>
  <tr>
    <td width="33%"><img src=".github/midia/mcps.webp" alt="A área de MCPs"><br><sub><b>MCPs.</b> Cadastre, teste e escolha para quais agentes cada servidor vale. Traga os que já estão no Claude Code e no Codex.</sub></td>
    <td width="33%"><img src=".github/midia/skills.webp" alt="O editor de skills"><br><sub><b>Skills.</b> Biblioteca de SKILL.md com editor e prévia ao vivo. Importe <code>.zip</code> ou <code>.skill</code>.</sub></td>
    <td width="33%"><img src=".github/midia/contas.webp" alt="As contas dos agentes"><br><sub><b>Contas.</b> Login de cada agente pela tela. Chaves e tokens ficam no cofre do Windows.</sub></td>
  </tr>
</table>

### Temas

Aurora, Oceano, Brasa, Grafite, Claro e Alto contraste. Troca na hora.

<p align="center"><img src=".github/midia/temas-engram.webp" alt="Os seis temas do Engram" width="920"></p>

## O que ele faz

- **Palco de agentes**: cada agente é um cartão; linhas ligam quem conversa com quem, e o maestro coordena.
- **Vários agentes**: Claude Code e Codex completos, no mesmo time; Gemini CLI e OpenCode como experimentais. Cada janela com o seu modelo.
- **O time não cai**: os agentes rodam num motor separado do app.
- **Revisão no caminho**: um revisor confere as entregas antes de chegarem a quem pediu.
- **Visualizar trabalho**: uma janela para ver o código sendo escrito.
- **Cérebro de notas**: Markdown ligado por `[[id]]`, lido e escrito pelos agentes, numa pasta sua.
- **Código**: editor Monaco, terminais, git, busca rápida e IntelliSense.
- **Extensões do VS Code**: temas, ícones, realce de sintaxe e snippets, pela Open VSX.
- **Prévias e navegador**: HTML, imagem, vídeo, PDF, Markdown e CSV; localhost como computador, tablet ou celular.
- **Fluxos**: o projeto mapeado em blocos, aceso enquanto o time trabalha.
- **Conversa legível**: o cartão mostra a conversa em texto, sem gastar token, com leitor grande e arquivos por agente.
- **MCPs, skills e contas**: tudo pela tela, com segredos no cofre do Windows.

## Para desenvolver

O [LEIAME.md](LEIAME.md) explica como rodar pelo código-fonte, gerar o instalador e como as partes do app conversam.
