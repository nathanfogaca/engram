// As fibras do cérebro desenhadas direto na placa de vídeo (WebGL2). No desenho comum (2D), cada fibra
// curva é um caminho que a placa trata um a um: com umas centenas de notas (milhares de fibras) a vista
// travava, e mais ainda com zoom. Aqui todas as fibras vão num lote só, em qualquer zoom.
//
// Cada fibra é uma curva partida em segmentos de reta; cada segmento é um retângulo fino com a borda
// suavizada. A cor vai de uma ponta à outra (degradê de verdade). O que muda a cada quadro (brilho,
// largura, tracejado da leitura ao vivo) fica numa textura pequena, um ponto por fibra.

const VERTICE = `#version 300 es
layout(location = 0) in vec2 aCanto;   // x: 0 ou 1 (ponta do segmento); y: -1 ou +1 (lado)
layout(location = 1) in vec4 aSeg;     // começo e fim do segmento, no mundo
layout(location = 2) in vec4 aCor0;    // cor no começo
layout(location = 3) in vec4 aCor1;    // cor no fim
layout(location = 4) in vec3 aInfo;    // índice da fibra, comprimento até o começo, comprimento até o fim
uniform vec4 uVista;                   // x, y, zoom, pontos por pixel
uniform vec2 uTela;                    // tamanho da tela em pontos
uniform float uLargura;                // quantos pontos vale uma unidade de largura neste zoom
uniform sampler2D uEstado;             // por fibra: R = brilho (alfa), G = largura / 4, B = tracejada
uniform int uColunas;
out vec3 vCor;
out float vAlfa;
out float vDist;
out float vMeia;
out float vComp;
out float vTraco;
void main() {
  int i = int(aInfo.x + 0.5);
  vec4 e = texelFetch(uEstado, ivec2(i % uColunas, i / uColunas), 0);
  float meia = e.g * 4.0 * uLargura * 0.5;
  vec2 p0 = (aSeg.xy * uVista.z + uVista.xy) * uVista.w;
  vec2 p1 = (aSeg.zw * uVista.z + uVista.xy) * uVista.w;
  vec2 d = p1 - p0;
  vec2 n = vec2(-d.y, d.x) / max(length(d), 0.0001);
  float fora = meia + 1.0;
  vec2 p = mix(p0, p1, aCanto.x) + n * aCanto.y * fora;
  gl_Position = e.r > 0.0 ? vec4(p.x / uTela.x * 2.0 - 1.0, 1.0 - p.y / uTela.y * 2.0, 0.0, 1.0) : vec4(2.0, 2.0, 2.0, 1.0);
  vCor = mix(aCor0.rgb, aCor1.rgb, aCanto.x);
  vAlfa = e.r;
  vDist = aCanto.y * fora;
  vMeia = meia;
  vComp = mix(aInfo.y, aInfo.z, aCanto.x);
  vTraco = e.b;
}`;

const FRAGMENTO = `#version 300 es
precision mediump float;
in vec3 vCor;
in float vAlfa;
in float vDist;
in float vMeia;
in float vComp;
in float vTraco;
uniform float uTraco;                  // quanto o tracejado já andou (unidades do mundo)
out vec4 cor;
void main() {
  float a = clamp(vMeia + 0.5 - abs(vDist), 0.0, 1.0) * vAlfa;
  if (vTraco > 0.5) a *= step(fract((vComp - uTraco) / 12.0), 0.5);
  cor = vec4(vCor * a, a);
}`;

const PASSO = 36; // bytes por segmento: 4 números (começo e fim), 2 cores (4 bytes cada) e 3 números (índice e comprimentos)

function hexRgb(h) { const n = parseInt(String(h).replace("#", "").slice(0, 6), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }

export class FibrasGL {
  constructor() {
    this.tela = document.createElement("canvas");
    const gl = this.tela.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, powerPreference: "high-performance" });
    if (!gl) throw new Error("sem WebGL2");
    this.gl = gl;
    const compilar = (tipo, fonte) => {
      const s = gl.createShader(tipo);
      gl.shaderSource(s, fonte); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || "o desenhador das fibras não compilou");
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, compilar(gl.VERTEX_SHADER, VERTICE));
    gl.attachShader(prog, compilar(gl.FRAGMENT_SHADER, FRAGMENTO));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || "o desenhador das fibras não ligou");
    this.prog = prog;
    this.u = Object.fromEntries(["uVista", "uTela", "uLargura", "uEstado", "uColunas", "uTraco"].map(n => [n, gl.getUniformLocation(prog, n)]));

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    // os quatro cantos de um segmento (o mesmo para todos)
    const cantos = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, cantos);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, -1, 0, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    // um registro por segmento
    this.segmentos = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.segmentos);
    const campo = (local, n, tipo, normal, desvio) => {
      gl.enableVertexAttribArray(local);
      gl.vertexAttribPointer(local, n, tipo, normal, PASSO, desvio);
      gl.vertexAttribDivisor(local, 1);
    };
    campo(1, 4, gl.FLOAT, false, 0);
    campo(2, 4, gl.UNSIGNED_BYTE, true, 16);
    campo(3, 4, gl.UNSIGNED_BYTE, true, 20);
    campo(4, 3, gl.FLOAT, false, 24);
    gl.bindVertexArray(null);

    this.estadoTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.estadoTex);
    for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, p, gl.NEAREST);
    for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, p, gl.CLAMP_TO_EDGE);
    this.colunas = 1024;
    this.linhasTex = 0;
    this.estado = new Uint8Array(0); // 4 bytes por fibra: alfa, largura / 4, tracejada, livre
    this.dados = new ArrayBuffer(0);
    this.nSeg = 0;
    this.nFibras = 0;
    this.perdido = false;
    this.tela.addEventListener("webglcontextlost", e => { e.preventDefault(); this.perdido = true; });
  }

  tamanho(largura, altura) {
    if (this.tela.width !== largura || this.tela.height !== altura) { this.tela.width = largura; this.tela.height = altura; }
  }

  /** Refaz os segmentos de todas as fibras pelas posições de agora (só quando alguma coisa se mexe). */
  geometria(arestas) {
    const gl = this.gl, n = arestas.length;
    // quantos segmentos cada fibra pede: mais para as compridas, para a curva não aparecer quebrada com zoom
    let total = 0;
    for (const e of arestas) {
      const comp = Math.hypot(e.para.x - e.de.x, e.para.y - e.de.y);
      e.nSeg = Math.max(3, Math.min(24, Math.ceil(Math.sqrt(comp) * 0.75)));
      total += e.nSeg;
    }
    if (this.dados.byteLength < total * PASSO) this.dados = new ArrayBuffer(Math.ceil(total * 1.25) * PASSO);
    const num = new Float32Array(this.dados), cor = new Uint8Array(this.dados);
    let s = 0;
    for (let i = 0; i < n; i++) {
      const e = arestas[i], a = e.de, b = e.para;
      const k = 0.18 * e.sinal, cx = (a.x + b.x) / 2 - (b.y - a.y) * k, cy = (a.y + b.y) / 2 + (b.x - a.x) * k;
      if (!e.rgb0) { e.rgb0 = hexRgb(e.c0); e.rgb1 = hexRgb(e.c1); }
      const [r0, g0, b0] = e.rgb0, [r1, g1, b1] = e.rgb1;
      let px = a.x, py = a.y, andou = 0;
      for (let j = 1; j <= e.nSeg; j++) {
        const t = j / e.nSeg, u = 1 - t, t0 = (j - 1) / e.nSeg;
        const qx = u * u * a.x + 2 * u * t * cx + t * t * b.x, qy = u * u * a.y + 2 * u * t * cy + t * t * b.y;
        const passo = Math.hypot(qx - px, qy - py);
        const f = s * 9, c = s * PASSO + 16;
        num[f] = px; num[f + 1] = py; num[f + 2] = qx; num[f + 3] = qy;
        cor[c] = r0 + (r1 - r0) * t0; cor[c + 1] = g0 + (g1 - g0) * t0; cor[c + 2] = b0 + (b1 - b0) * t0; cor[c + 3] = 255;
        cor[c + 4] = r0 + (r1 - r0) * t; cor[c + 5] = g0 + (g1 - g0) * t; cor[c + 6] = b0 + (b1 - b0) * t; cor[c + 7] = 255;
        num[f + 6] = i; num[f + 7] = andou; num[f + 8] = andou + passo;
        andou += passo; px = qx; py = qy; s++;
      }
    }
    this.nSeg = s;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.segmentos);
    gl.bufferData(gl.ARRAY_BUFFER, new Uint8Array(this.dados, 0, s * PASSO), gl.DYNAMIC_DRAW);
    if (n !== this.nFibras) {
      this.nFibras = n;
      this.linhasTex = Math.max(1, Math.ceil(n / this.colunas));
      this.estado = new Uint8Array(this.colunas * this.linhasTex * 4);
      gl.bindTexture(gl.TEXTURE_2D, this.estadoTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, this.colunas, this.linhasTex, 0, gl.RGBA, gl.UNSIGNED_BYTE, this.estado);
    }
  }

  /** Desenha as fibras para a vista dada. "estado" já vem preenchido (alfa, largura e tracejado de cada fibra). */
  desenhar({ x, y, z, dpr, traco }) {
    const gl = this.gl;
    gl.viewport(0, 0, this.tela.width, this.tela.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!this.nSeg) return;
    gl.useProgram(this.prog);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE); // as fibras somam a luz umas das outras
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.estadoTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.colunas, this.linhasTex, gl.RGBA, gl.UNSIGNED_BYTE, this.estado);
    gl.uniform1i(this.u.uEstado, 0);
    gl.uniform1i(this.u.uColunas, this.colunas);
    gl.uniform4f(this.u.uVista, x, y, z, dpr);
    gl.uniform2f(this.u.uTela, this.tela.width, this.tela.height);
    gl.uniform1f(this.u.uLargura, Math.sqrt(z) * dpr);
    gl.uniform1f(this.u.uTraco, traco);
    gl.bindVertexArray(this.vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.nSeg);
    gl.bindVertexArray(null);
  }
}
