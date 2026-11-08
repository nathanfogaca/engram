const dimensions = {
  agente: [640, 814],
  mcp: [1040, 762],
  skills: [1040, 762],
  contas: [1040, 762],
  guia: [906, 590],
  "primeiro-time": [906, 590],
  "palco-hero": [2584, 1530],
};
function image(file, alt, widths = dimensions[file] ? [] : [640, 960, 1520]) {
  const base = `img/2026/${file}`;
  const size = dimensions[file] || [1520, 900];
  const previews = widths.map(width => `${base}${width === size[0] ? "" : `-${width}`}.webp ${width}w`).join(", ");
  return { src: `${base}.webp`, previews: previews || undefined, alt, size };
}

export const views = [
  { id: "palco", icon: "network", label: "Palco", title: "Seu time, na mesma tela", text: "Conecte os cartões para que os agentes troquem tarefas e respostas.", ...image("palco-hero", "Palco do Engram com Maestro, Dev e Revisão conectados por linhas", [480, 768, 1200, 1520]) },
  { id: "cerebro", icon: "brain", label: "Cérebro", title: "Uma memória para o time", text: "Veja as notas ligadas em rede e acompanhe o que cada agente consultou.", ...image("cerebro", "Rede de notas de exemplo com conexões entre sistemas, chamados e agentes") },
  { id: "fluxos", icon: "flow", label: "Fluxos", title: "Acompanhe o caminho de uma tarefa", text: "Veja o projeto em blocos e identifique onde um agente está trabalhando.", ...image("fluxos", "Fluxo de publicação de exemplo, do portal até a fila de processamento") },
  { id: "codigo", icon: "code", label: "Código", title: "Do plano ao arquivo", text: "Abra arquivos, acompanhe mudanças no Git e revise o código no mesmo ambiente.", ...image("codigo", "Vista Código do Engram com a árvore do projeto de exemplo e um arquivo TypeScript aberto") },
];

export const tools = [
  { label: "Leitor", icon: "reader", title: "Leia a conversa inteira", text: "Veja pedidos, respostas e mensagens dos colegas em uma tela maior. A conversa é lida do arquivo local do agente.", ...image("leitor", "Leitor ampliado com o histórico da conversa do Maestro") },
  { label: "Novo agente", icon: "plus", title: "Escolha quem faz o quê", text: "Configure o provedor, o modelo e o papel de cada agente. Escolha também as ferramentas que ele pode usar.", ...image("agente", "Diálogo do Engram para escolher agente, modelo e papel") },
  { label: "MCPs", icon: "plug", title: "Conecte as ferramentas do seu projeto", text: "Cadastre servidores MCP, teste a conexão e escolha quais agentes podem acessar cada ferramenta.", ...image("mcp", "Ajustes de servidores MCP do Engram com duas ferramentas de exemplo") },
  { label: "Skills", icon: "spark", title: "Ensine seu jeito de trabalhar", text: "Crie ou importe skills em Markdown para repetir um checklist, uma revisão ou um padrão do seu time.", ...image("skills", "Biblioteca de skills do Engram com receitas de revisão e resumo") },
  { label: "Contas", icon: "shield", title: "Use as contas que você já tem", text: "Conecte as contas dos provedores no app. Se usar chaves de API, o Engram as guarda no cofre do Windows.", ...image("contas", "Tela de contas do Engram com os provedores disponíveis") },
];

export const themes = [
  ["Aurora", "#a196ff", "palco"],
  ["Oceano", "#36dac5", "tema-oceano"],
  ["Brasa", "#ff9768", "tema-brasa"],
  ["Grafite", "#a2aabe", "tema-grafite"],
  ["Claro", "#f1ecff", "tema-claro"],
  ["Alto contraste", "#ffdb52", "tema-alto-contraste"],
].map(([label, color, file]) => ({ label, color, ...image(file, `Palco do Engram com o tema ${label}`) }));

export const onboarding = [
  { title: "Ajuste o espaço", text: "Escolha um tema e conecte a conta de um agente no guia inicial.", ...image("guia", "Boas-vindas do Engram com as opções de tema") },
  { title: "Monte o primeiro time", text: "Comece com um maestro e dois agentes, uma dupla com revisor ou um agente só.", ...image("primeiro-time", "Guia do Engram com três opções para montar o primeiro time") },
];

export const questions = [
  ["Preciso pagar para usar o Engram?", "O Engram é gratuito e de código aberto. Cada agente usa sua conta ou chave de API, com os limites e preços do provedor."],
  ["Quais agentes posso usar?", "Claude Code e Codex podem trabalhar no mesmo time. Gemini CLI e OpenCode estão disponíveis como integrações experimentais."],
  ["Onde ficam as notas e os arquivos?", "O cérebro pode usar uma pasta local de notas Markdown. Os arquivos dos agentes também ficam no seu computador, e você pode escolher a pasta de trabalho nos ajustes."],
  ["Os agentes param quando fecho a janela?", "Fechar a janela deixa o Engram na bandeja. As sessões rodam em um processo separado, e o app pode reencontrá-las quando você volta."],
  ["Posso trazer MCPs e skills que já uso?", "Sim. As abas MCPs e Skills nos ajustes permitem importar configurações e receitas que você já usa com Claude Code e Codex."],
];
