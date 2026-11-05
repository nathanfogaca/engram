// Cérebro: o grafo de notas como uma constelação viva (canvas, simulação de forças própria).

import { COR_TIPO, COR_LIGACAO, corModelo, nomeModelo, limitar, movimentoReduzido, NOME_TIPO_UM } from "./util.js";

const RAIO = { agente: 15, sistema: 10, padrao: 9, chamado: 7, tabela: 7.5, projeto: 8, guia: 6, sessao: 6, pendente: 4.5 };
const COMPRIMENTO = { toca: 95, "caso de": 80, continua: 70, parecido: 110, envolve: 120, "parte de": 100, relacionado: 120, cita: 140, time: 170 };

export class Cerebro {
  constructor(tela, { aoAbrir, aoAgente }) {
    this.tela = tela;
    this.ctx = tela.getContext("2d");
    this.aoAbrir = aoAbrir;
    this.aoAgente = aoAgente;
    this.nos = new Map();
    this.arestas = [];
    this.vizinhos = new Map();
    this.v = { x: 0, y: 0, z: 1 };
    this.calor = 1;
    this.sobre = null;
    this.selecionado = null;
    this.destaque = null; // Set de ids (busca)
    this.ocultos = new Set();
    this.pulsos = [];
    this.cometas = [];
    this.sprites = new Map();
    this.ativo = false;
    this.ajustado = false;
    this.dpr = 1;
    this.instalar();
    this.redimensionar();
  }

  // ---------------------------------------------------------------- dados

  definir(grafo) {
    const novos = new Map();
    const antigos = this.nos;
    for (const n of grafo.nos) {
      const velho = antigos.get(n.id);
      const base = velho || this.posicaoInicial(n, grafo.arestas, antigos);
      novos.set(n.id, {
        ...n, x: base.x, y: base.y, vx: velho?.vx || 0, vy: velho?.vy || 0,
        fase: velho?.fase ?? Math.random() * Math.PI * 2,
        r: RAIO[n.tipo] || 6, cor: n.tipo === "agente" ? corModelo(n.modelo) : COR_TIPO[n.tipo] || "#8b95aa",
        brilho: velho?.brilho ?? (velho ? 1 : 0), // estrela nova nasce apagada e acende
        grau: 0, preso: velho?.preso || false,
      });
    }
    this.nos = novos;
    this.arestas = grafo.arestas
      .filter(a => novos.has(a.origem) && novos.has(a.destino))
      .map(a => ({ ...a, de: novos.get(a.origem), para: novos.get(a.destino) }));
    this.vizinhos = new Map();
    for (const a of this.arestas) {
      a.de.grau++;
      a.para.grau++;
      if (!this.vizinhos.has(a.origem)) this.vizinhos.set(a.origem, new Set());
      if (!this.vizinhos.has(a.destino)) this.vizinhos.set(a.destino, new Set());
      this.vizinhos.get(a.origem).add(a.destino);
      this.vizinhos.get(a.destino).add(a.origem);
    }
    for (const n of novos.values()) if (n.tipo !== "agente" && n.tipo !== "pendente") n.r += Math.min(n.grau * 0.7, 9);
    const mudou = novos.size !== antigos.size || [...novos.keys()].some(k => !antigos.has(k));
    if (mudou) this.calor = Math.max(this.calor, antigos.size ? 0.5 : 1);
    if (!antigos.size) {
      for (let i = 0; i < 260; i++) this.passo(); // aquece antes do primeiro quadro
      this.ajustado = false;
    }
  }

  posicaoInicial(n, arestas, antigos) {
    for (const a of arestas) {
      const outro = a.origem === n.id ? a.destino : a.destino === n.id ? a.origem : null;
      const viz = outro && (this.nos.get(outro) || antigos.get(outro));
      if (viz) return { x: viz.x + (Math.random() - 0.5) * 60, y: viz.y + (Math.random() - 0.5) * 60 };
    }
    const ang = Math.random() * Math.PI * 2, raio = 80 + Math.random() * 260;
    return { x: Math.cos(ang) * raio, y: Math.sin(ang) * raio };
  }

  // ---------------------------------------------------------------- simulação

  passo() {
    const nos = [...this.nos.values()].filter(n => !this.ocultos.has(n.tipo));
    const alfa = this.calor;
    for (let i = 0; i < nos.length; i++) {
      const a = nos[i];
      for (let j = i + 1; j < nos.length; j++) {
        const b = nos[j];
        let dx = b.x - a.x, dy = b.y - a.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 0.25; }
        if (d2 > 360000) continue;
        const d = Math.sqrt(d2), ux = dx / d, uy = dy / d;
        let f = (4000 * alfa) / d2; // repulsão: cada estrela empurra as outras
        const min = a.r + b.r + 14;
        if (d < min) f += (min - d) * 0.3; // colisão: não deixa sobrepor
        a.vx -= ux * f; a.vy -= uy * f;
        b.vx += ux * f; b.vy += uy * f;
      }
    }
    for (const a of this.arestas) {
      if (this.ocultos.has(a.de.tipo) || this.ocultos.has(a.para.tipo)) continue;
      const dx = a.para.x - a.de.x, dy = a.para.y - a.de.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const alvo = (COMPRIMENTO[a.tipo] || 100) * (a.ao_vivo ? 1.4 : 1) * (a.de.tipo === "guia" ? 1.6 : 1);
      const forca = a.de.tipo === "guia" ? 0.004 : 0.02;
      const f = (d - alvo) * forca * alfa;
      const fx = dx / d * f, fy = dy / d * f;
      a.de.vx += fx; a.de.vy += fy;
      a.para.vx -= fx; a.para.vy -= fy;
    }
    for (const n of nos) {
      n.vx -= n.x * 0.0018 * alfa;
      n.vy -= n.y * 0.0018 * alfa;
      if (n.preso) { n.vx = 0; n.vy = 0; continue; }
      n.vx *= 0.82; n.vy *= 0.82;
      n.x += limitar(n.vx, -40, 40);
      n.y += limitar(n.vy, -40, 40);
    }
    this.calor = Math.max(0.035, this.calor * 0.992); // nunca para de todo: o cérebro respira
  }

  // ---------------------------------------------------------------- efeitos

  pulso(id, cor) {
    const n = this.nos.get(id);
    if (n) this.pulsos.push({ n, cor: cor || n.cor, t0: performance.now() });
  }

  cometa(deId, paraId, cor) {
    const de = this.nos.get(deId), para = this.nos.get(paraId);
    if (de && para) this.cometas.push({ de, para, cor: cor || de.cor, t0: performance.now() });
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
    const x1 = Math.min(...nos.map(n => n.x)) - 60, x2 = Math.max(...nos.map(n => n.x)) + 60;
    const y1 = Math.min(...nos.map(n => n.y)) - 60, y2 = Math.max(...nos.map(n => n.y)) + 60;
    const z = limitar(Math.min((innerWidth - 120) / (x2 - x1), (innerHeight - 220) / (y2 - y1)), 0.2, 1.6);
    const x = innerWidth / 2 - ((x1 + x2) / 2) * z, y = (innerHeight + 40) / 2 - ((y1 + y2) / 2) * z;
    if (animado) this.animarVista(x, y, z);
    else this.v = { x, y, z };
  }

  agitar() {
    for (const n of this.nos.values()) {
      n.vx += (Math.random() - 0.5) * 40;
      n.vy += (Math.random() - 0.5) * 40;
    }
    this.calor = 1;
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
  }

  sprite(cor) {
    if (this.sprites.has(cor)) return this.sprites.get(cor);
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    const g = c.getContext("2d");
    const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0, cor);
    grad.addColorStop(0.18, cor + "cc");
    grad.addColorStop(0.42, cor + "44");
    grad.addColorStop(1, cor + "00");
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
    this.sprites.set(cor, c);
    return c;
  }

  foco() {
    // o que está em evidência: selecionado/sobre + vizinhos, ou o resultado da busca
    const centro = this.sobre || this.selecionado;
    if (centro) return new Set([centro, ...(this.vizinhos.get(centro) || [])]);
    return this.destaque;
  }

  desenhar(agora) {
    const { ctx, dpr } = this;
    const { x: vx, y: vy, z } = this.v;
    const t = agora / 1000;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    ctx.setTransform(dpr * z, 0, 0, dpr * z, dpr * vx, dpr * vy);
    const foco = this.foco();
    const visivel = n => !this.ocultos.has(n.tipo);
    const res = movimentoReduzido ? 0 : 1;

    // linhas
    for (const a of this.arestas) {
      if (!visivel(a.de) || !visivel(a.para)) continue;
      const doGuia = a.de.tipo === "guia";
      const acesa = foco ? foco.has(a.origem) && foco.has(a.destino) : false;
      if (doGuia && !acesa) continue;
      const cor = COR_LIGACAO[a.tipo] || "#5b6880";
      ctx.globalAlpha = foco ? (acesa ? 0.9 : 0.05) : a.ao_vivo ? 0.85 : 0.22;
      ctx.strokeStyle = cor;
      ctx.lineWidth = (acesa ? 1.8 : a.ao_vivo ? 1.6 : 1) / Math.sqrt(z);
      if (a.ao_vivo) {
        ctx.setLineDash([6, 6]);
        ctx.lineDashOffset = -t * 40 * res;
      }
      ctx.beginPath();
      ctx.moveTo(a.de.x, a.de.y);
      ctx.lineTo(a.para.x, a.para.y);
      ctx.stroke();
      if (a.ao_vivo) ctx.setLineDash([]);
    }

    // brilho (aditivo)
    ctx.globalCompositeOperation = "lighter";
    for (const n of this.nos.values()) {
      if (!visivel(n)) continue;
      n.brilho = Math.min(1, n.brilho + 0.03);
      const resp = 1 + 0.12 * Math.sin(t * 1.6 + n.fase) * res;
      const apagado = foco && !foco.has(n.id);
      const tam = n.r * (n.tipo === "agente" ? 7 : 5.2) * resp * (this.sobre === n.id ? 1.35 : 1);
      ctx.globalAlpha = (apagado ? 0.12 : n.tipo === "pendente" ? 0.25 : 0.85) * n.brilho;
      ctx.drawImage(this.sprite(n.cor), n.x - tam / 2, n.y - tam / 2, tam, tam);
    }

    // pulsos (onde um agente acabou de mexer)
    this.pulsos = this.pulsos.filter(p => agora - p.t0 < 1600);
    for (const p of this.pulsos) {
      const k = (agora - p.t0) / 1600;
      for (const atraso of [0, 0.25]) {
        const q = limitar(k - atraso, 0, 1);
        if (!q) continue;
        ctx.globalAlpha = (1 - q) * 0.9;
        ctx.strokeStyle = p.cor;
        ctx.lineWidth = 2.5 * (1 - q) + 0.5;
        ctx.beginPath();
        ctx.arc(p.n.x, p.n.y, p.n.r + q * 70, 0, Math.PI * 2);
        ctx.stroke();
      }
      const tam = p.n.r * 12 * (1 - k);
      ctx.globalAlpha = 1 - k;
      ctx.drawImage(this.sprite(p.cor), p.n.x - tam / 2, p.n.y - tam / 2, tam, tam);
    }

    // cometas (agente → nota que ele leu/gravou)
    this.cometas = this.cometas.filter(c => agora - c.t0 < 1300);
    for (const c of this.cometas) {
      const k = (agora - c.t0) / 1300, e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      for (let i = 0; i < 10; i++) {
        const q = limitar(e - i * 0.025, 0, 1);
        const x = c.de.x + (c.para.x - c.de.x) * q, y = c.de.y + (c.para.y - c.de.y) * q;
        const tam = (i === 0 ? 34 : 26 - i * 2);
        ctx.globalAlpha = (1 - i / 10) * 0.9;
        ctx.drawImage(this.sprite(i === 0 ? "#ffffff" : c.cor), x - tam / 2, y - tam / 2, tam, tam);
      }
    }
    ctx.globalCompositeOperation = "source-over";

    // núcleos
    for (const n of this.nos.values()) {
      if (!visivel(n)) continue;
      const apagado = foco && !foco.has(n.id);
      const resp = 1 + 0.06 * Math.sin(t * 1.6 + n.fase) * res;
      const r = n.r * resp * (this.sobre === n.id ? 1.25 : 1);
      ctx.globalAlpha = (apagado ? 0.25 : 1) * n.brilho;
      if (n.tipo === "pendente") {
        ctx.setLineDash([2.5, 2.5]);
        ctx.strokeStyle = "#7d879a";
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        continue;
      }
      ctx.fillStyle = n.tipo === "agente" ? "#0b0f17" : n.cor;
      ctx.beginPath();
      if (n.tipo === "padrao") {
        ctx.moveTo(n.x, n.y - r * 1.25); ctx.lineTo(n.x + r * 1.25, n.y); ctx.lineTo(n.x, n.y + r * 1.25); ctx.lineTo(n.x - r * 1.25, n.y); ctx.closePath();
      } else if (n.tipo === "tabela") {
        const s = r * 0.92;
        ctx.roundRect(n.x - s, n.y - s, s * 2, s * 2, s * 0.35);
      } else if (n.tipo === "sistema") {
        for (let i = 0; i < 6; i++) {
          const a = Math.PI / 3 * i + Math.PI / 6;
          i ? ctx.lineTo(n.x + Math.cos(a) * r * 1.15, n.y + Math.sin(a) * r * 1.15) : ctx.moveTo(n.x + Math.cos(a) * r * 1.15, n.y + Math.sin(a) * r * 1.15);
        }
        ctx.closePath();
      } else {
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      }
      ctx.fill();
      if (n.tipo === "agente") {
        ctx.strokeStyle = n.cor;
        ctx.lineWidth = 2.5;
        ctx.stroke();
        if (["pensando", "trabalhando"].includes(n.estado)) {
          ctx.strokeStyle = n.cor;
          ctx.lineWidth = 2;
          ctx.beginPath();
          const a0 = t * 4 * res;
          ctx.arc(n.x, n.y, r + 6, a0, a0 + Math.PI * 1.2);
          ctx.stroke();
        }
      } else {
        ctx.fillStyle = "rgba(255,255,255,.55)";
        ctx.beginPath();
        ctx.arc(n.x - r * 0.3, n.y - r * 0.3, r * 0.32, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // rótulos
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (const n of this.nos.values()) {
      if (!visivel(n)) continue;
      const emFoco = foco?.has(n.id);
      const mostra = n.tipo === "agente" || emFoco || z > 1.15 || n.grau >= 5 || n.tipo === "sistema" || n.tipo === "padrao";
      if (!mostra || (foco && !emFoco)) continue;
      const texto = n.tipo === "agente" ? `${n.titulo} · ${nomeModelo(n.modelo)}`
        : ["chamado", "tabela", "pendente"].includes(n.tipo) ? n.id : encurtarRotulo(n.titulo);
      const tam = (n.tipo === "agente" ? 12.5 : emFoco ? 12 : 11) / Math.sqrt(z);
      ctx.font = `${n.tipo === "agente" || emFoco ? 650 : 500} ${tam}px "Segoe UI Variable Text", "Segoe UI", sans-serif`;
      ctx.globalAlpha = n.brilho;
      ctx.lineWidth = 3.5 / Math.sqrt(z);
      ctx.strokeStyle = "rgba(4,6,10,.92)";
      const y = n.y + n.r + 6;
      ctx.strokeText(texto, n.x, y);
      ctx.fillStyle = emFoco || n.tipo === "agente" ? "#ffffff" : "#b9c3d6";
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
      if (d < n.r + 8 / this.v.z && d < dist) { melhor = n; dist = d; }
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
      if (gesto) {
        const dx = e.clientX - gesto.x, dy = e.clientY - gesto.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) gesto.moveu = true;
        if (gesto.tipo === "pan") { this.v.x = gesto.vx + dx; this.v.y = gesto.vy + dy; }
        else {
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

  dica(n, x, y) {
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
