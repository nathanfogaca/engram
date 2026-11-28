// O rosto de cada agente: um robozinho desenhado em SVG, sempre o mesmo para o mesmo agente (a semente é o id).
// Muda o formato da cabeça, os olhos, a boca, a antena e as orelhas; a cor vem do modelo e o acessório, do papel
// (coroa do maestro, óculos do revisor, lápis do redator, livro do bibliotecário). Os olhos piscam sozinhos.

const NS = "http://www.w3.org/2000/svg";
let serie = 0;

function hash(s) {
  let h = 2166136261;
  for (const c of String(s)) { h ^= c.codePointAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function sorteio(semente) {
  let x = hash(semente) || 1;
  return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return (x >>> 0) / 4294967296; };
}
function hsl(hex) {
  const n = parseInt(String(hex).replace("#", "").padEnd(6, "0").slice(0, 6), 16);
  const r = (n >> 16 & 255) / 255, g = (n >> 8 & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return [0, 0, l * 100];
  const d = max - min, s = l > .5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s * 100, l * 100];
}
const tom = (h, s, l) => `hsl(${Math.round((h + 360) % 360)} ${Math.round(s)}% ${Math.round(l)}%)`;

function no(tag, at = {}, ...filhos) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(at)) if (v !== undefined && v !== null) e.setAttribute(k, String(v));
  for (const f of filhos) if (f) e.append(f);
  return e;
}

/**
 * avatar({ semente, cor, papel, tamanho }) -> <svg class="av-svg">. A semente é o id do agente; a cor, a do modelo.
 */
export function avatar({ semente = "", cor = "#8b7bff", papel = "", tamanho = 48 } = {}) {
  const r = sorteio(semente || "agente");
  const um = lista => lista[Math.floor(r() * lista.length)];
  const id = `av${++serie}`;
  const [h, s] = hsl(cor);
  const giro = (r() - .5) * 70;
  const fundo1 = tom(h + giro, Math.min(90, s + 10), 58);
  const fundo2 = tom(h + giro + 45, Math.min(85, s), 30);
  const olho = tom(h, 100, 86);
  const borda = tom(h, 90, 70);

  const svg = no("svg", { viewBox: "0 0 64 64", width: tamanho, height: tamanho, class: "av-svg", "aria-hidden": "true" });
  svg.append(no("defs", {},
    no("linearGradient", { id: `${id}f`, x1: 0, y1: 0, x2: 1, y2: 1 }, no("stop", { offset: 0, "stop-color": fundo1 }), no("stop", { offset: 1, "stop-color": fundo2 })),
    no("radialGradient", { id: `${id}b`, cx: .3, cy: .2, r: .6 }, no("stop", { offset: 0, "stop-color": "#fff", "stop-opacity": .45 }), no("stop", { offset: 1, "stop-color": "#fff", "stop-opacity": 0 })),
    no("linearGradient", { id: `${id}c`, x1: 0, y1: 0, x2: 0, y2: 1 }, no("stop", { offset: 0, "stop-color": "#1b2236" }), no("stop", { offset: 1, "stop-color": "#070a12" })),
    no("filter", { id: `${id}g`, x: "-50%", y: "-50%", width: "200%", height: "200%" },
      no("feGaussianBlur", { stdDeviation: 1.3, result: "b" }), no("feMerge", {}, no("feMergeNode", { in: "b" }), no("feMergeNode", { in: "SourceGraphic" })))));
  svg.append(no("circle", { cx: 32, cy: 32, r: 32, fill: `url(#${id}f)` }), no("circle", { cx: 32, cy: 32, r: 32, fill: `url(#${id}b)` }));

  // antena ou orelhas atrás da cabeça
  const topo = papel === "maestro" ? "coroa" : um(["antena", "antena", "duas", "barbatana", "nada"]);
  if (topo === "antena") svg.append(no("line", { x1: 32, y1: 17, x2: 32, y2: 8, stroke: borda, "stroke-width": 2.2, "stroke-linecap": "round" }),
    no("circle", { cx: 32, cy: 7, r: 3, fill: olho, filter: `url(#${id}g)`, class: "av-luz" }));
  if (topo === "duas") svg.append(no("path", { d: "M24 18 L19 9 M40 18 L45 9", stroke: borda, "stroke-width": 2, "stroke-linecap": "round", fill: "none" }),
    no("circle", { cx: 19, cy: 9, r: 2.4, fill: olho, class: "av-luz" }), no("circle", { cx: 45, cy: 9, r: 2.4, fill: olho, class: "av-luz" }));
  if (topo === "barbatana") svg.append(no("path", { d: "M26 18 Q32 4 38 18 Z", fill: borda, opacity: .9 }));
  const orelha = um(["parafuso", "fone", "nada"]);
  if (orelha === "parafuso") svg.append(no("rect", { x: 10, y: 30, width: 6, height: 10, rx: 2, fill: borda }), no("rect", { x: 48, y: 30, width: 6, height: 10, rx: 2, fill: borda }));
  if (orelha === "fone") svg.append(no("path", { d: "M14 36 Q14 14 32 14 Q50 14 50 36", stroke: borda, "stroke-width": 2.5, fill: "none" }),
    no("rect", { x: 10, y: 31, width: 7, height: 12, rx: 3.5, fill: borda }), no("rect", { x: 47, y: 31, width: 7, height: 12, rx: 3.5, fill: borda }));

  // a cabeça (vidro escuro) e a tela do rosto
  const cabeca = um(["quadrada", "redonda", "capsula", "larga"]);
  const formas = {
    quadrada: { x: 15, y: 17, w: 34, h: 32, rx: 10 }, redonda: { x: 15, y: 16, w: 34, h: 34, rx: 17 },
    capsula: { x: 17, y: 15, w: 30, h: 36, rx: 15 }, larga: { x: 12, y: 19, w: 40, h: 28, rx: 11 },
  };
  const f = formas[cabeca];
  svg.append(no("rect", { x: f.x, y: f.y, width: f.w, height: f.h, rx: f.rx, fill: `url(#${id}c)`, stroke: borda, "stroke-width": 1.6 }));
  svg.append(no("rect", { x: f.x + 4, y: f.y + 5, width: f.w - 8, height: f.h - 12, rx: Math.max(4, f.rx - 4), fill: "#04060c", opacity: .75 }));

  // olhos (piscam: a classe av-olhos tem a animação no CSS do app)
  const cy = f.y + f.h / 2 - 1;
  const olhos = no("g", { class: "av-olhos", fill: olho, stroke: olho, filter: `url(#${id}g)` });
  const tipoOlho = um(["pontos", "visor", "feliz", "ciclope", "quadrados", "pontos"]);
  if (tipoOlho === "pontos") olhos.append(no("circle", { cx: 26, cy, r: 3.4, stroke: "none" }), no("circle", { cx: 38, cy, r: 3.4, stroke: "none" }));
  if (tipoOlho === "visor") olhos.append(no("rect", { x: f.x + 7, y: cy - 2.6, width: f.w - 14, height: 5.2, rx: 2.6, stroke: "none", class: "av-visor" }));
  if (tipoOlho === "feliz") olhos.append(no("path", { d: `M22.5 ${cy + 1.5} Q26 ${cy - 3.5} 29.5 ${cy + 1.5} M34.5 ${cy + 1.5} Q38 ${cy - 3.5} 41.5 ${cy + 1.5}`, fill: "none", "stroke-width": 2.4, "stroke-linecap": "round" }));
  if (tipoOlho === "ciclope") olhos.append(no("circle", { cx: 32, cy, r: 5.5, stroke: "none" }), no("circle", { cx: 33.5, cy: cy - 1.5, r: 1.6, fill: "#04060c", stroke: "none" }));
  if (tipoOlho === "quadrados") olhos.append(no("rect", { x: 22.5, y: cy - 3, width: 6, height: 6, rx: 1.2, stroke: "none" }), no("rect", { x: 35.5, y: cy - 3, width: 6, height: 6, rx: 1.2, stroke: "none" }));
  olhos.style.setProperty("animation-delay", `${-(r() * 6).toFixed(2)}s`);
  svg.append(olhos);

  // boca
  const by = f.y + f.h - 10;
  const boca = tipoOlho === "visor" ? um(["grade", "linha", "nada"]) : um(["sorriso", "linha", "grade", "o", "sorriso"]);
  if (boca === "sorriso") svg.append(no("path", { d: `M27 ${by} Q32 ${by + 4} 37 ${by}`, stroke: olho, "stroke-width": 2, fill: "none", "stroke-linecap": "round", opacity: .9 }));
  if (boca === "linha") svg.append(no("line", { x1: 28, y1: by + 1, x2: 36, y2: by + 1, stroke: olho, "stroke-width": 2, "stroke-linecap": "round", opacity: .8 }));
  if (boca === "grade") for (let i = 0; i < 4; i++) svg.append(no("rect", { x: 26 + i * 3.4, y: by - 1, width: 2, height: 4, rx: 1, fill: olho, opacity: .75 }));
  if (boca === "o") svg.append(no("circle", { cx: 32, cy: by + 1, r: 2, fill: "none", stroke: olho, "stroke-width": 1.8, opacity: .85 }));

  // acessório do papel
  if (topo === "coroa") {
    svg.append(no("path", { d: "M20 17 L22 6 L27.5 12 L32 3.5 L36.5 12 L42 6 L44 17 Z", fill: "#f5c451", stroke: "#fff3c4", "stroke-width": .8, filter: `url(#${id}g)`, class: "av-coroa" }),
      no("circle", { cx: 32, cy: 12.5, r: 1.6, fill: "#fff" }));
  }
  if (papel === "revisor") svg.append(no("g", { fill: "none", stroke: "#e8eefc", "stroke-width": 1.6, opacity: .95 },
    no("circle", { cx: 26, cy, r: 5.6 }), no("circle", { cx: 38, cy, r: 5.6 }), no("line", { x1: 31.6, y1: cy, x2: 32.4, y2: cy })));
  if (papel === "redator") svg.append(no("g", { transform: "rotate(35 50 22)" },
    no("rect", { x: 47, y: 8, width: 5, height: 22, rx: 1.2, fill: "#facc15" }), no("path", { d: "M47 30 L49.5 35 L52 30 Z", fill: "#fde68a" }), no("rect", { x: 47, y: 8, width: 5, height: 4, rx: 1, fill: "#fb7185" })));
  if (papel === "bibliotecario") svg.append(no("g", {},
    no("rect", { x: 42, y: 44, width: 15, height: 11, rx: 1.5, fill: "#38d6f5", stroke: "#e0f7ff", "stroke-width": .8 }), no("line", { x1: 49.5, y1: 44, x2: 49.5, y2: 55, stroke: "#0b3a4a", "stroke-width": 1 })));
  return svg;
}
