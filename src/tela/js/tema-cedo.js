// Aplica o último tema antes de a página desenhar (sem piscar o tema padrão). O app confirma depois.
try {
  const tema = localStorage.getItem("engram.tema");
  if (tema) document.documentElement.dataset.tema = tema;
} catch { /* sem armazenamento: fica o padrão até o app responder */ }
