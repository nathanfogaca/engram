<div align="center">

<img src="docs/img/engram.png" width="88" alt="">

# Engram

**Um time de agentes de IA, trabalhando junto no seu computador.**

Agentes como Claude Code e Codex em cartões num palco, ligados por linhas que você desenha.<br>
Um maestro divide o trabalho, cada um usa o modelo certo, e o que eles aprendem vai para um cérebro de notas que fica com você.

[**⬇ Baixar para Windows**](https://github.com/nathanfogaca/engram/releases/latest/download/Engram-windows-x64.exe) · [Site](https://nathanfogaca.github.io/engram/) · [Versões](https://github.com/nathanfogaca/engram/releases)

<img src="docs/img/palco.webp" alt="O palco do Engram: o maestro, o analista (Codex) e o redator resolvendo dois chamados" width="100%">

</div>

## O que ele faz

| | |
|---|---|
| **Palco de agentes** | Cada agente é um cartão. Arraste uma linha entre dois e eles conversam; as mensagens correm pela linha. Um **maestro** recebe o pedido, delega e junta os resultados. |
| **Vários agentes** | Claude Code e Codex completos, no mesmo time. Gemini CLI e OpenCode como experimentais. Cada janela com o seu modelo. |
| **O time não cai** | Os agentes rodam num motor separado: fechar, reiniciar ou atualizar o app não derruba ninguém, e a conversa continua de onde parou. |
| **Cérebro de notas** | Notas em Markdown ligadas por `[[id]]`, vistas como uma constelação viva. Os agentes leem antes de investigar e gravam o que aprendem. Fica numa pasta sua. |
| **Conversa legível** | O cartão mostra a conversa em texto, sem gastar token. Leitor grande, arquivos por agente (mande logs e prints; ele devolve o que fez). |
| **MCPs fáceis** | Cadastre, teste, ligue e desligue servidores MCP (HTTP ou programa local), por agente. Traga os que já estão no Claude Code e no Codex. |
| **Skills** | Biblioteca de skills (SKILL.md) com editor e prévia; importe `.zip` ou `.skill`. |
| **Contas e cofre** | Login de cada CLI pela tela; chaves de API e tokens no Gerenciador de Credenciais do Windows. |
| **Temas** | Aurora, Oceano, Brasa, Grafite, Claro e Alto contraste. Troca na hora. |
| **Atualização automática** | Novas versões chegam sozinhas pelo GitHub Releases. |

<table>
<tr>
<td width="50%"><img src="docs/img/cerebro.webp" alt="A constelação do cérebro"><br><sub><b>Cérebro.</b> Notas, ligações e os agentes que tocaram cada uma.</sub></td>
<td width="50%"><img src="docs/img/leitor.webp" alt="O leitor grande"><br><sub><b>Leitor.</b> A conversa do maestro com as respostas dos colegas.</sub></td>
</tr>
<tr>
<td><img src="docs/img/mcps.webp" alt="A área de MCPs"><br><sub><b>MCPs.</b> Testar a conexão mostra as ferramentas do servidor.</sub></td>
<td><img src="docs/img/skills.webp" alt="O editor de skills"><br><sub><b>Skills.</b> Editor com prévia ao vivo.</sub></td>
</tr>
<tr>
<td><img src="docs/img/novo-agente.webp" alt="Novo agente"><br><sub><b>Novo agente.</b> Agente, modelo, papel e MCPs da janela.</sub></td>
<td><img src="docs/img/tema-claro.webp" alt="Tema claro"><br><sub><b>Temas.</b> O palco no tema Claro.</sub></td>
</tr>
</table>

## Instalar

1. Baixe o [**Engram-windows-x64.exe**](https://github.com/nathanfogaca/engram/releases/latest/download/Engram-windows-x64.exe) e rode. Ele instala só para o seu usuário.
2. Se o Windows avisar "editor desconhecido", clique em **Mais informações → Executar assim mesmo** (o instalador ainda não tem certificado de assinatura).
3. Na primeira vez, um guia leva você pelo tema, pelas contas e pelo agente padrão, e abre o primeiro time.

**Requisitos:** Windows 10 ou 11 (64 bits) e pelo menos um agente com conta: [Claude Code](https://claude.com/claude-code) ou [Codex](https://developers.openai.com/codex).
