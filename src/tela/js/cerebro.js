// Cérebro: o grafo de notas como uma rede de neurônios dentro de dois hemisférios (vistos de cima).
// Cada nota é um neurônio (corpo, núcleo e dendritos); as ligações são fibras curvas; impulsos correm
// pelas fibras quando um agente toca uma nota (pulso/cometa) e, de vez em quando, sozinhos.

import { COR_TIPO, corModelo, nomeModelo, limitar, movimentoReduzido, NOME_TIPO_UM } from "./util.js";

// de que lado mora cada tipo: esquerdo (casos e memória) e direito (estrutura)
const LADO = { chamado: -1, padrao: -1, guia: -1, sessao: -1, pendente: -1, sistema: 1, tabela: 1, projeto: 1 };
const RAIO = { sistema: 6.5, padrao: 5.5, chamado: 4.6, tabela: 5, projeto: 5.5, guia: 4.5, sessao: 4, pendente: 3, agente: 9 };
const COMPRIMENTO = 110;

function semente(s) { return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; }; }
function hashTexto(t) { let h = 2166136261; for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) % 2147483646 + 1; }
function hexRgb(h) { const n = parseInt(String(h).replace("#", "").slice(0, 6), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
const rgba = (h, a) => { const [r, g, b] = hexRgb(h); return `rgba(${r},${g},${b},${a})`; };
const mistura = (h, alvo, k) => { const a = hexRgb(h), b = hexRgb(alvo); return "#" + a.map((v, i) => Math.round(v + (b[i] - v) * k).toString(16).padStart(2, "0")).join(""); };
const ladoDe = n => LADO[n.tipo] || -1;

export class Cerebro {
  constructor(tela, { aoAbrir, aoAgente }) {
    this.tela = tela;
    this.ctx = tela.getContext("2d");
    this.aoAbrir = aoAbrir;
    this.aoAgente = aoAgente;
    this.nos = new Map();
    this.arestas = [];
    this.vizinhos = new Map();
    this.adj = new Map(); // id -> [{ no, e }]
    this.v = { x: 0, y: 0, z: 1 };
    this.calor = 1;
    this.sobre = null;
    this.selecionado = null;
    this.destaque = null; // Set de ids (busca)
    this.ocultos = new Set();
    this.impulsos = [];
    this.aneis = [];
    this.ativo = false;
    this.ajustado = false;
    this.dpr = 1;
    this.tamHemi = 260;
    this.cortex = null;
    this.fundo = null;
    this.mouse = { x: innerWidth / 2, y: innerHeight / 2 };
    this.proximoDisparo = 0;
    this.instalar();
    this.redimensionar();
  }

  // ---------------------------------------------------------------- dados

  definir(grafo) {
    const antigos = this.nos;
    const novos = new Map();
    for (const n of grafo.nos) {
      const v = antigos.get(n.id);
      novos.set(n.id, {
        ...n, x: v?.x, y: v?.y, vx: 0, vy: 0,
        fase: v?.fase ?? Math.random() * Math.PI * 2, act: v?.act || 0, pot: 0, refr: 0,
        brilho: v ? v.brilho : 0, // neurônio novo nasce apagado e acende
        grau: 0, preso: false, sprite: null,
        cor: n.tipo === "agente" ? corModelo(n.modelo) : COR_TIPO[n.tipo] || "#8b95aa",
      });
    }
    this.nos = novos;
    this.arestas = grafo.arestas
      .filter(a => novos.has(a.origem) && novos.has(a.destino) && a.origem !== a.destino)
      .map(a => ({ ...a, de: novos.get(a.origem), para: novos.get(a.destino), sinal: hashTexto(a.origem + a.destino) % 2 ? 1 : -1 }));
    this.vizinhos = new Map();
    this.adj = new Map([...novos.keys()].map(id => [id, []]));
    for (const a of this.arestas) {
      a.de.grau++; a.para.grau++;
      if (!this.vizinhos.has(a.origem)) this.vizinhos.set(a.origem, new Set());
      if (!this.vizinhos.has(a.destino)) this.vizinhos.set(a.destino, new Set());
      this.vizinhos.get(a.origem).add(a.destino);
      this.vizinhos.get(a.destino).add(a.origem);
      this.adj.get(a.origem).push({ no: a.para, e: a });
      this.adj.get(a.destino).push({ no: a.de, e: a });
    }
    for (const n of novos.values()) {
      n.r = (RAIO[n.tipo] || 4.5) + (n.tipo === "agente" || n.tipo === "pendente" ? 0 : Math.min(7, Math.sqrt(n.grau) * 1.6));
      const antes = antigos.get(n.id);
      if (antes && antes.r === n.r && antes.cor === n.cor) n.sprite = antes.sprite;
    }
    const tamAntes = this.tamHemi;
    this.medirHemisferios();
    if (!this.cortex || Math.abs(this.tamHemi - tamAntes) / tamAntes > 0.08) this.cortex = null;
    for (const n of novos.values()) if (n.x === undefined) this.posicaoInicial(n);
    const adicionados = [...novos.keys()].filter(k => !antigos.has(k)).length;
    const mudou = novos.size !== antigos.size || adicionados > 0;
    if (mudou) this.calor = Math.max(this.calor, antigos.size ? 0.5 : 1);
    // primeira carga ou muita nota nova de uma vez (importação, sincronização grande): reorganiza tudo
    // antes do próximo quadro, senão a simulação esfria antes de espalhar e os neurônios ficam embolados
    if (!antigos.size || adicionados > Math.max(8, novos.size * 0.2)) {
      this.calor = 1;
      for (let i = 0; i < 360; i++) this.passo(true);
      this.ajustado = false;
      if (this.ativo) this.enquadrar();
    }
  }

  posicaoInicial(n) {
    if (n.tipo === "agente") { n.x = 0; n.y = this.tamHemi * 1.22; return; }
    // perto de um vizinho que já tem lugar e mora do mesmo lado
    for (const { no } of this.adj.get(n.id) || []) {
      if (no.x !== undefined && no.tipo !== "agente" && ladoDe(no) === ladoDe(n)) { n.x = no.x + (Math.random() - .5) * 50; n.y = no.y + (Math.random() - .5) * 50; return; }
    }
    const h = this.hemisferios()[ladoDe(n) < 0 ? 0 : 1];
    n.x = h.cx + (Math.random() - .5) * h.rx; n.y = h.cy + (Math.random() - .5) * h.ry * 1.3;
  }

  // ---------------------------------------------------------------- forma: dois hemisférios
  medirHemisferios() {
    const visiveis = [...this.nos.values()].filter(n => n.tipo !== "agente" && !this.ocultos.has(n.tipo));
    const porLado = Math.max(1, ...[-1, 1].map(l => visiveis.filter(n => ladoDe(n) === l).length));
    this.tamHemi = Math.max(200, Math.sqrt(porLado * COMPRIMENTO * COMPRIMENTO / Math.PI) * 1.2);
  }

  hemisferios() {
    const ry = this.tamHemi, rx = ry * 0.62, sep = ry * 0.07;
    return [{ cx: -rx - sep, cy: 0, rx, ry, lado: -1 }, { cx: rx + sep, cy: 0, rx, ry, lado: 1 }];
  }

  // contorno no ângulo a: mais estreito na frente (em cima), achatado na fissura, com ondas do córtex
  pontoContorno(h, a, esc = 1, ondas = true) {
    const medial = Math.cos(a) * -h.lado > 0 ? 0.82 + 0.18 * (1 - Math.abs(Math.cos(a))) : 1;
    const frente = 1 + 0.1 * Math.sin(a);
    const onda = ondas ? 1 + 0.022 * Math.sin(a * 13 + h.lado) + 0.012 * Math.sin(a * 29) : 1;
    return [h.cx + Math.cos(a) * h.rx * medial * frente * onda * esc, h.cy + Math.sin(a) * h.ry * onda * esc];
  }

  conter(n, hs) {
    const h = hs[ladoDe(n) < 0 ? 0 : 1];
    const a = Math.atan2((n.y - h.cy) / h.ry, (n.x - h.cx) / h.rx);
    const [bx, by] = this.pontoContorno(h, a, 0.86, false);
    const dn = Math.hypot(n.x - h.cx, n.y - h.cy), db = Math.hypot(bx - h.cx, by - h.cy);
    if (dn > db) { n.x = h.cx + (n.x - h.cx) * db / dn; n.y = h.cy + (n.y - h.cy) * db / dn; n.vx *= .3; n.vy *= .3; }
    if (h.lado < 0 && n.x > -8) n.x = -8;
    if (h.lado > 0 && n.x < 8) n.x = 8;
  }

  // ---------------------------------------------------------------- simulação

  passo(forcar = false) {
    const nos = [...this.nos.values()].filter(n => !this.ocultos.has(n.tipo));
    const notas = nos.filter(n => n.tipo !== "agente");
    const alfa = this.calor;
    if (alfa > 0.05 || forcar) {
      const rep = 5200 * Math.max(alfa, .2);
      for (let i = 0; i < notas.length; i++) {
        const a = notas[i];
        for (let j = i + 1; j < notas.length; j++) {
          const b = notas[j];
          let dx = a.x - b.x, dy = a.y - b.y;
          let d2 = dx * dx + dy * dy;
          if (d2 > 160000) continue;
          if (d2 < 0.01) { dx = Math.random() - .5; dy = Math.random() - .5; d2 = .25; }
          const d = Math.sqrt(d2), f = rep / d2;
          a.vx += dx / d * f; a.vy += dy / d * f; b.vx -= dx / d * f; b.vy -= dy / d * f;
        }
      }
      for (const e of this.arestas) {
        const a = e.de, b = e.para;
        if (this.ocultos.has(a.tipo) || this.ocultos.has(b.tipo)) continue;
        // fibras entre hemisférios, dos agentes e do guia não puxam: são só desenhadas
        if (a.tipo === "agente" || b.tipo === "agente" || a.tipo === "guia" || b.tipo === "guia" || ladoDe(a) !== ladoDe(b)) continue;
        const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1, f = (d - COMPRIMENTO) * 0.012;
        a.vx += dx / d * f; a.vy += dy / d * f; b.vx -= dx / d * f; b.vy -= dy / d * f;
      }
      const hs = this.hemisferios();
      for (const n of notas) {
        const h = hs[ladoDe(n) < 0 ? 0 : 1];
        n.vx += (h.cx - n.x) * 0.0006; n.vy += (h.cy - n.y) * 0.0006; // atração leve: os neurônios se espalham até a borda
        const perto = Math.abs(n.x);
        if (perto < h.rx * 0.35) n.vx += h.lado * (h.rx * 0.35 - perto) * 0.02; // a fissura empurra para fora
        if (n.preso) { n.vx = n.vy = 0; continue; }
        const lim = 9 * Math.max(alfa, .1) + .4;
        n.x += limitar(n.vx, -lim, lim); n.y += limitar(n.vy, -lim, lim);
        n.vx *= 0.6; n.vy *= 0.6;
        this.conter(n, hs);
      }
      this.calor = Math.max(0.03, this.calor * 0.985);
    }
    // agentes em fila embaixo, como o tronco que lê o cérebro
    const ag = nos.filter(n => n.tipo === "agente");
    ag.forEach((n, i) => { n.x = (i - (ag.length - 1) / 2) * 130; n.y = this.tamHemi * 1.22 + (i % 2) * 26; });
  }

  // ---------------------------------------------------------------- impulsos

  disparar(n, forca = 1, cor = null) {
    const agora = performance.now();
    if (!n || agora < n.refr) return;
    n.act = Math.min(1.4, n.act + forca); n.refr = agora + 700; n.pot = 0;
    for (const { no, e } of this.adj.get(n.id) || []) {
      if (this.ocultos.has(no.tipo) || no.tipo === "guia" || n.tipo === "guia") continue;
      this.lancar(e, n, no, cor || n.cor);
    }
  }

  lancar(e, de, para, cor) {
    const d = Math.hypot(para.x - de.x, para.y - de.y);
    this.impulsos.push({ e, de, para, cor, ini: performance.now(), dur: Math.max(300, d / 380 * 1000) });
  }

  chegou(imp) {
    imp.e.brilho = 1;
    const alvo = imp.para;
    alvo.pot += 0.75;
    if (imp.cometa) { alvo.act = Math.min(1.4, alvo.act + .9); return; }
    if (alvo.pot >= 1 && Math.random() < 0.5) this.disparar(alvo, .9);
    else alvo.act = Math.min(1, alvo.act + .35);
  }

  /** Um agente tocou a nota: o neurônio dispara e um anel se abre em volta. */
  pulso(id, cor) {
    const n = this.nos.get(id);
    if (!n) return;
    this.aneis.push({ n, cor: cor || n.cor, t0: performance.now() });
    n.refr = 0;
    this.disparar(n, 1.2, cor);
  }

  /** Um impulso corre de um nó a outro (agente → nota, colega → colega). */
  cometa(deId, paraId, cor) {
    const de = this.nos.get(deId), para = this.nos.get(paraId);
    if (!de || !para) return;
    const e = this.arestas.find(a => (a.de === de && a.para === para) || (a.de === para && a.para === de)) || { de, para, sinal: 1, brilho: 0 };
    this.impulsos.push({ e, de, para, cor: cor || de.cor, ini: performance.now(), dur: 1100, cometa: true });
    de.act = Math.min(1.4, de.act + .8);
  }

  realcarBusca(ids) {
    this.destaque = ids && ids.length ? new Set(ids) : null;
  }

  focar(id) {
    const n = this.nos.get(id);
    if (!n) return;
    this.selecionado = id;
    this.animarVista(innerWidth / 2 - n.x * 1.3, innerHeight / 2 - n.y * 1.3, 1.3);
  }

  enquadrar(animado = true) {
    const nos = [...this.nos.values()].filter(n => !this.ocultos.has(n.tipo));
    if (!nos.length) return;
    const hs = this.hemisferios();
    const x1 = Math.min(hs[0].cx - hs[0].rx * 1.1, ...nos.map(n => n.x)) - 30, x2 = Math.max(hs[1].cx + hs[1].rx * 1.1, ...nos.map(n => n.x)) + 30;
    const y1 = Math.min(-hs[0].ry * 1.05, ...nos.map(n => n.y)) - 30, y2 = Math.max(hs[0].ry * 1.05, ...nos.map(n => n.y)) + 50;
    const z = limitar(Math.min((innerWidth - 120) / (x2 - x1), (innerHeight - 220) / (y2 - y1)), 0.2, 1.6);
    const x = innerWidth / 2 - ((x1 + x2) / 2) * z, y = (innerHeight + 40) / 2 - ((y1 + y2) / 2) * z;
    if (animado) this.animarVista(x, y, z);
    else this.v = { x, y, z };
  }

  agitar() {
    for (const n of this.nos.values()) { n.vx += (Math.random() - 0.5) * 40; n.vy += (Math.random() - 0.5) * 40; }
    this.calor = 1;
    // e uma onda de impulsos, para o cérebro "acordar"
    const notas = [...this.nos.values()].filter(n => n.tipo !== "agente" && !this.ocultos.has(n.tipo));
    for (let i = 0; i < Math.min(6, notas.length); i++) setTimeout(() => this.disparar(notas[Math.floor(Math.random() * notas.length)], 1), i * 180);
    setTimeout(() => this.enquadrar(), 1400);
  }

  animarVista(x, y, z) {
    const de = { ...this.v }, t0 = performance.now(), dur = movimentoReduzido ? 1 : 700;
    this.anima = agora => {
      const t = limitar((agora - t0) / dur, 0, 1), e = 1 - Math.pow(1 - t, 3);
      this.v = { x: de.x + (x - de.x) * e, y: de.y + (y - de.y) * e, z: de.z + (z - de.z) * e };
      if (t >= 1) this.anima = null;
    };
  }

  // ---------------------------------------------------------------- laço

  ligar() {
    if (this.ativo) return;
    this.ativo = true;
    this.redimensionar();
    if (!this.ajustado && this.nos.size) { this.enquadrar(false); this.ajustado = true; }
    const quadro = agora => {
      if (!this.ativo) return;
      this.anima?.(agora);
      this.passo();
      this.desenhar(agora);
      requestAnimationFrame(quadro);
    };
    requestAnimationFrame(quadro);
  }

  desligar() {
    this.ativo = false;
  }

  redimensionar() {
    this.dpr = Math.min(devicePixelRatio || 1, 2);
    this.tela.width = Math.floor(innerWidth * this.dpr);
    this.tela.height = Math.floor(innerHeight * this.dpr);
    this.fundo = null;
  }

  // ---------------------------------------------------------------- desenho pré-pronto (neurônio, córtex, fundo)

  neuronio(n) {
    if (n.sprite) return n.sprite;
    const c = n.cor, rnd = semente(hashTexto(n.id));
    const agente = n.tipo === "agente";
    const alcance = n.r * 5.1;
    const tam = Math.ceil((alcance + n.r * 2) * 2 + 8);
    const oc = document.createElement("canvas"); oc.width = oc.height = tam * 2;
    const x = oc.getContext("2d"); x.scale(2, 2); x.translate(tam / 2, tam / 2);
    x.lineCap = "round";
    // dendritos: ramos que saem do corpo e se dividem, mais finos a cada divisão
    const ramo = (px, py, ang, comp, larg, prof) => {
      const curva = (rnd() - .5) * 0.9;
      const mx = px + Math.cos(ang + curva) * comp * .55, my = py + Math.sin(ang + curva) * comp * .55;
      const ex = px + Math.cos(ang) * comp, ey = py + Math.sin(ang) * comp;
      const grad = x.createLinearGradient(px, py, ex, ey);
      grad.addColorStop(0, rgba(c, 0.55 - prof * 0.12)); grad.addColorStop(1, rgba(c, 0.04));
      x.strokeStyle = grad; x.lineWidth = larg;
      x.beginPath(); x.moveTo(px, py); x.quadraticCurveTo(mx, my, ex, ey); x.stroke();
      if (prof <= 1) { // espinhas dendríticas
        x.fillStyle = rgba(c, 0.35);
        for (let k = 0; k < 3; k++) {
          const t = .3 + rnd() * .6;
          const sx = (1 - t) * (1 - t) * px + 2 * (1 - t) * t * mx + t * t * ex, sy = (1 - t) * (1 - t) * py + 2 * (1 - t) * t * my + t * t * ey;
          x.beginPath(); x.arc(sx + (rnd() - .5) * 3, sy + (rnd() - .5) * 3, .7, 0, 6.28); x.fill();
        }
      }
      if (prof < 2 && comp > 6) {
        const filhos = 1 + (rnd() < .6 ? 1 : 0);
        for (let f = 0; f < filhos; f++) ramo(ex, ey, ang + (rnd() - .5) * 1.3, comp * (.5 + rnd() * .25), larg * .58, prof + 1);
      }
    };
    if (!agente) {
      const ramos = Math.round(6 + rnd() * 2);
      for (let k = 0; k < ramos; k++) {
        const ang = (k / ramos) * Math.PI * 2 + (rnd() - .5) * .7;
        ramo(Math.cos(ang) * n.r * .7, Math.sin(ang) * n.r * .7, ang, alcance * (.45 + rnd() * .35), n.r * .42, 0);
      }
    }
    // corpo celular irregular, com membrana iluminada e núcleo
    const corpoCor = agente ? "#eafff7" : c;
    const pts = 14, forma = [];
    for (let k = 0; k < pts; k++) { const a = k / pts * Math.PI * 2; forma.push([Math.cos(a) * n.r * (.84 + rnd() * .3), Math.sin(a) * n.r * (.84 + rnd() * .3)]); }
    x.beginPath();
    for (let k = 0; k < pts; k++) {
      const [ax, ay] = forma[k], [bx, by] = forma[(k + 1) % pts], mx = (ax + bx) / 2, my = (ay + by) / 2;
      if (k === 0) x.moveTo(mx, my); else x.quadraticCurveTo(ax, ay, mx, my);
    }
    x.closePath();
    const corpo = x.createRadialGradient(-n.r * .3, -n.r * .3, n.r * .1, 0, 0, n.r * 1.15);
    corpo.addColorStop(0, mistura(corpoCor, "#ffffff", .75)); corpo.addColorStop(.45, corpoCor); corpo.addColorStop(1, mistura(corpoCor, "#000000", .55));
    x.fillStyle = corpo; x.fill();
    x.strokeStyle = rgba(mistura(corpoCor, "#ffffff", .5), .6); x.lineWidth = .8; x.stroke();
    x.fillStyle = rgba("#ffffff", agente ? .95 : .8);
    x.beginPath(); x.arc(n.r * .08, n.r * .05, n.r * (agente ? .42 : .3), 0, 6.28); x.fill();
    n.sprite = { canvas: oc, tam };
    return n.sprite;
  }

  desenharCortex() {
    const hs = this.hemisferios(), pad = 60;
    const largura = (hs[1].cx + hs[1].rx * 1.15) * 2 + pad * 2, altura = hs[0].ry * 2.3 + pad * 2;
    const res = Math.min(2, 2400 / largura);
    const oc = document.createElement("canvas"); oc.width = Math.ceil(largura * res); oc.height = Math.ceil(altura * res);
    const x = oc.getContext("2d"); x.scale(res, res); x.translate(largura / 2, altura / 2);
    const rnd = semente(3);
    const caminho = (h, esc, amp = 0, ondas = 0, fase = 0) => {
      x.beginPath();
      for (let k = 0; k <= 180; k++) {
        const a = k / 180 * Math.PI * 2;
        const [px, py] = this.pontoContorno(h, a, esc + (amp ? Math.sin(a * ondas + fase) * amp : 0));
        if (k === 0) x.moveTo(px, py); else x.lineTo(px, py);
      }
      x.closePath();
    };
    for (const h of hs) {
      x.save();
      caminho(h, 1);
      const fundo = x.createRadialGradient(h.cx, h.cy - h.ry * .25, 10, h.cx, h.cy, h.ry * 1.05);
      fundo.addColorStop(0, "rgba(120,110,255,.085)"); fundo.addColorStop(.7, "rgba(80,90,200,.035)"); fundo.addColorStop(1, "rgba(60,70,160,.015)");
      x.fillStyle = fundo; x.fill();
      x.strokeStyle = "rgba(170,180,255,.2)"; x.lineWidth = 1.5; x.shadowColor = "rgba(139,123,255,.7)"; x.shadowBlur = 18; x.stroke();
      x.clip();
      x.shadowBlur = 0;
      // giros e sulcos: curvas onduladas que acompanham o contorno, cada vez mais para dentro
      for (let k = 0; k < 30; k++) {
        caminho(h, .2 + k / 30 * .82, .025 + rnd() * .03, 6 + Math.floor(rnd() * 7), rnd() * 6.28);
        x.strokeStyle = `rgba(150,160,255,${.025 + rnd() * .04})`; x.lineWidth = 1 + rnd() * 1.8; x.stroke();
      }
      x.restore();
    }
    // tronco: um brilho suave embaixo, de onde vêm os agentes
    const tr = x.createRadialGradient(0, hs[0].ry * 1.2, 4, 0, hs[0].ry * 1.2, hs[0].ry * .45);
    tr.addColorStop(0, "rgba(126,242,200,.08)"); tr.addColorStop(1, "rgba(126,242,200,0)");
    x.fillStyle = tr; x.fillRect(-largura / 2, 0, largura, altura / 2);
    this.cortex = { canvas: oc, largura, altura };
  }

  desenharFundo() {
    const W = innerWidth, H = innerHeight;
    const oc = document.createElement("canvas"); oc.width = W; oc.height = H;
    const x = oc.getContext("2d"), rnd = semente(99);
    x.filter = "blur(3px)";
    for (let k = 0; k < 60; k++) {
      const px = rnd() * W, py = rnd() * H, r = 1.5 + rnd() * 3, c = ["#6a7bff", "#38d6f5", "#b794ff"][k % 3];
      x.strokeStyle = rgba(c, .08); x.lineWidth = 1;
      for (let b = 0; b < 5; b++) {
        const a = rnd() * 6.28, l = 20 + rnd() * 50;
        x.beginPath(); x.moveTo(px, py); x.quadraticCurveTo(px + Math.cos(a + .4) * l * .6, py + Math.sin(a + .4) * l * .6, px + Math.cos(a) * l, py + Math.sin(a) * l); x.stroke();
      }
      x.fillStyle = rgba(c, .25); x.beginPath(); x.arc(px, py, r, 0, 6.28); x.fill();
    }
    this.fundo = oc;
  }

  // ---------------------------------------------------------------- desenho de cada quadro

  foco() {
    // o que está em evidência: selecionado/sobre + vizinhos, ou o resultado da busca
    const centro = this.sobre || this.selecionado;
    if (centro) return new Set([centro, ...(this.vizinhos.get(centro) || [])]);
    return this.destaque;
  }

  curva(e, t) {
    const a = e.de, b = e.para;
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, dx = b.x - a.x, dy = b.y - a.y;
    const k = 0.18 * (e.sinal || 1);
    const cx = mx - dy * k, cy = my + dx * k;
    return [(1 - t) * (1 - t) * a.x + 2 * (1 - t) * t * cx + t * t * b.x, (1 - t) * (1 - t) * a.y + 2 * (1 - t) * t * cy + t * t * b.y, cx, cy];
  }

  desenhar(agora) {
    const { ctx, dpr } = this;
    const { x: vx, y: vy, z } = this.v;
    const t = agora / 1000;
    const res = movimentoReduzido ? 0 : 1;
    const visivel = n => !this.ocultos.has(n.tipo);
    if (!this.cortex) this.desenharCortex();
    if (!this.fundo) this.desenharFundo();

    // atividade espontânea: de vez em quando um neurônio dispara sozinho
    if (res && agora > this.proximoDisparo) {
      const notas = [...this.nos.values()].filter(n => n.tipo !== "agente" && n.tipo !== "pendente" && n.tipo !== "guia" && visivel(n));
      if (notas.length) this.disparar(notas[Math.floor(Math.random() * notas.length)], .9);
      this.proximoDisparo = agora + 1600 + Math.random() * 2200;
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    ctx.globalAlpha = 1;
    ctx.drawImage(this.fundo, (this.mouse.x - innerWidth / 2) * -0.012 * res, (this.mouse.y - innerHeight / 2) * -0.012 * res);
    ctx.setTransform(dpr * z, 0, 0, dpr * z, dpr * vx, dpr * vy);
    ctx.drawImage(this.cortex.canvas, -this.cortex.largura / 2, -this.cortex.altura / 2, this.cortex.largura, this.cortex.altura);
    const foco = this.foco();

    // fibras: curvas, com o degradê das cores das pontas
    ctx.globalCompositeOperation = "lighter";
    for (const e of this.arestas) {
      if (!visivel(e.de) || !visivel(e.para)) continue;
      e.brilho = (e.brilho || 0) * 0.965;
      const acesa = foco ? foco.has(e.origem) && foco.has(e.destino) : false;
      const doGuia = e.de.tipo === "guia" || e.para.tipo === "guia";
      if (doGuia && !acesa) continue;
      const agente = e.de.tipo === "agente" || e.para.tipo === "agente";
      const base = e.ao_vivo ? .5 : agente ? .2 : .12;
      const alfa = foco ? (acesa ? .6 : base * .2) : base + e.brilho * .45;
      const [, , cx, cy] = this.curva(e, 0);
      const gr = ctx.createLinearGradient(e.de.x, e.de.y, e.para.x, e.para.y);
      gr.addColorStop(0, rgba(e.de.cor, alfa)); gr.addColorStop(1, rgba(e.para.cor, alfa));
      ctx.strokeStyle = gr;
      ctx.lineWidth = (acesa ? 1.9 : 1.1 + e.brilho * 1.2 + (e.ao_vivo ? .6 : 0)) / Math.sqrt(z);
      if (e.ao_vivo) { ctx.setLineDash([6, 6]); ctx.lineDashOffset = -t * 40 * res; }
      ctx.beginPath(); ctx.moveTo(e.de.x, e.de.y); ctx.quadraticCurveTo(cx, cy, e.para.x, e.para.y); ctx.stroke();
      if (e.ao_vivo) ctx.setLineDash([]);
    }

    // impulsos correndo pelas fibras, com rastro
    this.impulsos = this.impulsos.filter(imp => {
      const k = (agora - imp.ini) / imp.dur;
      if (k >= 1) { this.chegou(imp); return false; }
      if (!visivel(imp.de) || !visivel(imp.para)) return false;
      const ida = imp.de === imp.e.de;
      for (let i = 0; i < 7; i++) {
        const q = Math.max(0, k - i * 0.025), [px, py] = this.curva(imp.e, ida ? q : 1 - q);
        ctx.fillStyle = rgba(i === 0 ? "#ffffff" : imp.cor, i === 0 ? .95 : .5 * (1 - i / 7));
        ctx.beginPath(); ctx.arc(px, py, (i === 0 ? 2.6 : 2.1 - i * .2) / Math.sqrt(z), 0, 6.28); ctx.fill();
      }
      const [hx, hy] = this.curva(imp.e, ida ? k : 1 - k);
      const halo = ctx.createRadialGradient(hx, hy, 0, hx, hy, 13);
      halo.addColorStop(0, rgba(imp.cor, .5)); halo.addColorStop(1, rgba(imp.cor, 0));
      ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(hx, hy, 13, 0, 6.28); ctx.fill();
      return true;
    });

    // halo de cada neurônio (cresce quando ele dispara)
    for (const n of this.nos.values()) {
      if (!visivel(n) || n.tipo === "pendente") continue;
      n.brilho = Math.min(1, n.brilho + 0.03);
      n.act *= 0.955; n.pot *= 0.985;
      const apagado = foco && !foco.has(n.id);
      const raio = n.r * (3.2 + n.act * 4) * (this.sobre === n.id ? 1.3 : 1);
      const hg = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, raio);
      hg.addColorStop(0, rgba(n.cor, ((apagado ? .04 : .2) + n.act * .5) * n.brilho));
      hg.addColorStop(1, rgba(n.cor, 0));
      ctx.fillStyle = hg; ctx.beginPath(); ctx.arc(n.x, n.y, raio, 0, 6.28); ctx.fill();
    }

    // anéis: onde um agente acabou de mexer
    this.aneis = this.aneis.filter(p => agora - p.t0 < 1600);
    for (const p of this.aneis) {
      const k = (agora - p.t0) / 1600;
      for (const atraso of [0, .25]) {
        const q = limitar(k - atraso, 0, 1);
        if (!q) continue;
        ctx.globalAlpha = (1 - q) * .9; ctx.strokeStyle = p.cor; ctx.lineWidth = 2.5 * (1 - q) + .5;
        ctx.beginPath(); ctx.arc(p.n.x, p.n.y, p.n.r + q * 70, 0, 6.28); ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";

    // neurônios: corpo e dendritos (pré-desenhados), balançando de leve
    for (const n of this.nos.values()) {
      if (!visivel(n)) continue;
      const apagado = foco && !foco.has(n.id);
      if (n.tipo === "pendente") {
        // nota citada que ainda não existe: um neurônio fantasma
        ctx.globalAlpha = (apagado ? .15 : .55) * n.brilho;
        ctx.setLineDash([2.5, 2.5]); ctx.strokeStyle = "#8b95aa"; ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.arc(n.x, n.y, n.r * 1.4, 0, 6.28); ctx.stroke(); ctx.setLineDash([]);
        continue;
      }
      ctx.globalAlpha = (apagado ? .22 : 1) * n.brilho;
      const s = this.neuronio(n), giro = Math.sin(t * .5 + n.fase) * .05 * res;
      const escala = (1 + n.act * .12 + (n.tipo === "agente" ? Math.sin(t * 2.4 + n.fase) * .05 * res : 0)) * (this.sobre === n.id ? 1.18 : 1);
      ctx.save(); ctx.translate(n.x, n.y); ctx.rotate(giro); ctx.scale(escala, escala);
      ctx.drawImage(s.canvas, -s.tam / 2, -s.tam / 2, s.tam, s.tam);
      ctx.restore();
      if (n.tipo === "agente") {
        const r = n.r * 1.9 + Math.sin(t * 2.4 + n.fase) * 2 * res;
        ctx.strokeStyle = rgba(n.cor, .55 + Math.sin(t * 2.4 + n.fase) * .3 * res); ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, 6.28); ctx.stroke();
        if (["pensando", "trabalhando"].includes(n.estado)) {
          const a0 = t * 4 * res;
          ctx.strokeStyle = n.cor; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(n.x, n.y, r + 6, a0, a0 + Math.PI * 1.2); ctx.stroke();
        }
      }
    }

    // rótulos: os mais importantes primeiro; quem colide com um rótulo já desenhado fica para quando aproximar
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    const peso = n => (n.id === this.sobre ? 1e6 : 0) + (n.tipo === "agente" ? 1e5 : 0) + (foco?.has(n.id) ? 1e4 : 0) + n.grau;
    const ocupados = [];
    for (const n of [...this.nos.values()].sort((a, b) => peso(b) - peso(a))) {
      if (!visivel(n)) continue;
      const emFoco = foco?.has(n.id);
      const mostra = n.tipo === "agente" || emFoco || z > 1.15 || n.grau >= 5 || n.tipo === "sistema" || n.tipo === "padrao";
      if (!mostra || (foco && !emFoco)) continue;
      const texto = n.tipo === "agente" ? `${n.titulo} · ${nomeModelo(n.modelo)}`
        : ["chamado", "tabela", "pendente"].includes(n.tipo) ? n.id : encurtarRotulo(n.titulo);
      const tam = (n.tipo === "agente" ? 12.5 : emFoco ? 12 : 11) / Math.sqrt(z);
      ctx.font = `${n.tipo === "agente" || emFoco ? 650 : 500} ${tam}px "Segoe UI Variable Text", "Segoe UI", sans-serif`;
      const y = n.y + n.r * 2.1, larg = ctx.measureText(texto).width, folga = 3 / z;
      const caixa = [n.x - larg / 2 - folga, y - folga, n.x + larg / 2 + folga, y + tam * 1.25 + folga];
      if (n.id !== this.sobre && ocupados.some(o => caixa[0] < o[2] && caixa[2] > o[0] && caixa[1] < o[3] && caixa[3] > o[1])) continue;
      ocupados.push(caixa);
      ctx.globalAlpha = n.brilho;
      ctx.lineWidth = 3.5 / Math.sqrt(z);
      ctx.strokeStyle = "rgba(4,6,10,.92)";
      ctx.strokeText(texto, n.x, y);
      ctx.fillStyle = emFoco || n.tipo === "agente" ? "#ffffff" : "#c9d1e2";
      ctx.fillText(texto, n.x, y);
    }
    ctx.globalAlpha = 1;
  }

  // ---------------------------------------------------------------- interação

  noPonto(cx, cy) {
    const x = (cx - this.v.x) / this.v.z, y = (cy - this.v.y) / this.v.z;
    let melhor = null, dist = Infinity;
    for (const n of this.nos.values()) {
      if (this.ocultos.has(n.tipo)) continue;
      const d = Math.hypot(n.x - x, n.y - y);
      if (d < Math.max(n.r * 1.7, 10 / this.v.z) && d < dist) { melhor = n; dist = d; }
    }
    return melhor;
  }

  instalar() {
    const tela = this.tela;
    let gesto = null;
    tela.addEventListener("pointerdown", e => {
      const n = this.noPonto(e.clientX, e.clientY);
      tela.setPointerCapture(e.pointerId);
      gesto = n
        ? { tipo: "no", n, x: e.clientX, y: e.clientY, moveu: false }
        : { tipo: "pan", x: e.clientX, y: e.clientY, vx: this.v.x, vy: this.v.y, moveu: false };
      if (n) n.preso = true;
      tela.classList.add("arrastando");
    });
    tela.addEventListener("pointermove", e => {
      this.mouse = { x: e.clientX, y: e.clientY };
      if (gesto) {
        const dx = e.clientX - gesto.x, dy = e.clientY - gesto.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) gesto.moveu = true;
        if (gesto.tipo === "pan") { this.v.x = gesto.vx + dx; this.v.y = gesto.vy + dy; }
        else if (gesto.n.tipo !== "agente") {
          gesto.n.x = (e.clientX - this.v.x) / this.v.z;
          gesto.n.y = (e.clientY - this.v.y) / this.v.z;
          this.calor = Math.max(this.calor, 0.25);
        }
        return;
      }
      const n = this.noPonto(e.clientX, e.clientY);
      this.sobre = n ? n.id : null;
      tela.classList.toggle("sobre", !!n);
      this.dica(n, e.clientX, e.clientY);
    });
    tela.addEventListener("pointerup", () => {
      if (!gesto) return;
      tela.classList.remove("arrastando");
      if (gesto.tipo === "no") {
        gesto.n.preso = false;
        if (!gesto.moveu) {
          this.selecionado = gesto.n.id;
          gesto.n.refr = 0;
          this.disparar(gesto.n, 1.3);
          if (gesto.n.tipo === "agente") this.aoAgente(gesto.n.id.slice("sessao:".length));
          else this.aoAbrir(gesto.n.id);
        }
      } else if (!gesto.moveu) {
        this.selecionado = null;
      }
      gesto = null;
    });
    tela.addEventListener("pointerleave", () => { this.sobre = null; this.dica(null); });
    tela.addEventListener("wheel", e => {
      e.preventDefault();
      const f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0016));
      const z = limitar(this.v.z * f, 0.15, 4), k = z / this.v.z;
      this.v.x = e.clientX - (e.clientX - this.v.x) * k;
      this.v.y = e.clientY - (e.clientY - this.v.y) * k;
      this.v.z = z;
    }, { passive: false });
    window.addEventListener("resize", () => this.redimensionar());
  }

  dica(n) {
    const caixa = document.getElementById("cerebro-info");
    if (!n) {
      caixa.dataset.sobre = "";
      this.mostrarResumo();
      return;
    }
    caixa.dataset.sobre = "1";
    const tipo = n.tipo === "agente" ? `Agente · ${nomeModelo(n.modelo)} · ${n.estado || ""}` : `${NOME_TIPO_UM[n.tipo] || n.tipo} · ${n.id}`;
    caixa.replaceChildren();
    const b = document.createElement("b");
    b.textContent = n.titulo || n.id;
    caixa.append(b, document.createTextNode(`${tipo}${n.situacao ? " · " + n.situacao : ""} · ${this.vizinhos.get(n.id)?.size || 0} ligações`));
  }

  mostrarResumo() {
    const caixa = document.getElementById("cerebro-info");
    if (caixa.dataset.sobre === "1") return;
    const notas = [...this.nos.values()].filter(n => n.tipo !== "agente" && n.tipo !== "pendente").length;
    const pendentes = [...this.nos.values()].filter(n => n.tipo === "pendente").length;
    caixa.replaceChildren();
    const b = document.createElement("b");
    b.textContent = `${notas} notas · ${this.arestas.length} ligações`;
    caixa.append(b, document.createTextNode(`${pendentes} a documentar`));
  }
}

function encurtarRotulo(t) {
  t = t || "";
  return t.length > 34 ? t.slice(0, 33) + "…" : t;
}
