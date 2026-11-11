// Que arquivos .md uma chamada de ferramenta tocou, quando ela não diz o arquivo num campo próprio:
// um comando de terminal (Get-Content, cat, Set-Content, redirecionamento), um apply_patch, ou o código que
// o Codex roda (tools.exec_command, tools.apply_patch, tools.mcp__servidor__ferramenta).
// Daqui saem só candidatos (caminho + leu/gravou): quem chama confere se é mesmo uma nota do cérebro.

const os = require('node:os');
const path = require('node:path');

const ENTRE_ASPAS = /(["'])((?:(?!\1)[^\r\n])*?\.md)\1/gi;
const SOLTO = /[^\s"'`<>|;,()=]+\.md(?![\w-])/gi;
const SEPARADOR = /[|;\n]|&&/g;

const ESCREVE = ['Set-Content', 'Add-Content', 'Out-File', 'New-Item', 'Clear-Content', 'Remove-Item', 'Tee-Object', 'tee', 'touch', 'rm', 'del',
  'sed\\s+-i', 'WriteAllText', 'WriteAllLines', 'AppendAllText', 'writeFileSync', 'appendFileSync', 'write_text'];
const COPIA = ['Copy-Item', 'Move-Item', 'Rename-Item', 'cp', 'mv', 'copy', 'move', 'ren'];
const SO_OLHA = ['Test-Path', 'Get-Item', 'Get-ChildItem', 'Resolve-Path', 'Join-Path', 'Split-Path', 'Set-Location', 'ls', 'dir', 'cd', 'pushd', 'stat', 'test', 'find', 'fd'];
const LE = ['Get-Content', 'Select-String', 'cat', 'type', 'more', 'less', 'head', 'tail', 'bat', 'rg', 'grep', 'findstr', 'gc', 'sls',
  'ReadAllText', 'ReadAllLines', 'readFileSync', 'read_text'];
// o verbo não pode ser um pedaço de caminho (C:\notas\type\x.md) nem de outra palavra
const VERBO = new RegExp(`(?<![\\w.\\\\/-])(${[...ESCREVE, ...COPIA, ...SO_OLHA, ...LE].join('|')})(?![\\w\\\\/-])`, 'gi');
const eh = (lista, verbo) => lista.some(v => new RegExp(`^${v}$`, 'i').test(verbo));
const SAIDA_ANTES = /(?:^|\s)(?:-o|--output|-OutFile|-Destination|-NewName)\s+["']?$/i;
const REDIRECIONA = /\d?>>?\s*["']?$/;
const ABRE_PARA_ESCREVER = /^["']?\s*,\s*["'][wax]/;

/** Desfaz as barras de um texto que veio dentro de uma string (JSON ou JavaScript). */
function desescapar(texto) {
  // ã (acento escrito como código, comum em JSON) vira a letra; o resto, o caractere depois da barra
  return String(texto).replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, c) => (c.length === 5 ? String.fromCharCode(parseInt(c.slice(1), 16))
    : c === 'n' ? '\n' : c === 'r' ? '\r' : c === 't' ? '\t' : c));
}

/** Caminho de verdade: "~", variáveis da pasta do usuário e o jeito do Git Bash (/c/Users/...). */
function expandir(caminho) {
  let c = String(caminho).trim();
  c = c.replace(/^(~|\$HOME|\$\{HOME\}|\$env:USERPROFILE|%USERPROFILE%)(?=[\\/]|$)/i, () => os.homedir());
  c = c.replace(/^\/([a-zA-Z])\//, (_, letra) => `${letra.toUpperCase()}:/`);
  return c;
}

/** Os .md citados num texto, com a posição de cada um. */
function caminhosMd(texto) {
  const achados = [];
  let resto = texto;
  for (const m of texto.matchAll(ENTRE_ASPAS)) {
    achados.push({ caminho: m[2], ini: m.index + 1, fim: m.index + 1 + m[2].length });
    resto = resto.slice(0, m.index) + ' '.repeat(m[0].length) + resto.slice(m.index + m[0].length);
  }
  for (const m of resto.matchAll(SOLTO)) achados.push({ caminho: m[0], ini: m.index, fim: m.index + m[0].length });
  return achados.filter(a => !/[*?]/.test(a.caminho) && a.caminho.length < 400).sort((a, b) => a.ini - b.ini);
}

/** Pastas para onde o comando foi (cd, Set-Location, pushd): caminho relativo depois disso parte delas. */
function pastasDoComando(comando) {
  const saida = [];
  for (const m of comando.matchAll(/(?<![\w-])(?:cd|Set-Location|pushd|sl)\s+(?:-(?:Literal)?Path\s+)?(?:(["'])(.+?)\1|([^\s;|&]+))/gi)) saida.push(expandir(m[2] || m[3]));
  return saida;
}

/**
 * Os .md que um comando de terminal leu ou gravou: [{ caminho, tipo: 'leu' | 'gravou', bases }].
 * Decide pelo verbo mais perto (antes do arquivo, no mesmo trecho do comando) e pelo redirecionamento.
 */
function notasDoComando(comando, bases = []) {
  comando = String(comando || '');
  if (!/\.md/i.test(comando)) return [];
  // o texto de um heredoc (<<EOF ... EOF) ou de uma here-string do PowerShell (@' ... '@) é conteúdo, não comando
  comando = comando.replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2\s*(?=\n|$)/g, m => m.slice(0, m.indexOf('\n')))
    .replace(/@(['"])\r?\n[\s\S]*?\r?\n\1@/g, '@@');
  const achados = caminhosMd(comando);
  if (!achados.length) return [];
  const cortes = [0, ...[...comando.matchAll(SEPARADOR)].map(m => m.index + m[0].length), comando.length];
  const trechoDe = pos => { let i = 0; while (i + 1 < cortes.length && cortes[i + 1] <= pos) i++; return i; };
  const todasBases = [...pastasDoComando(comando), ...bases.filter(Boolean)];
  const saida = [];
  for (const a of achados) {
    const t = trechoDe(a.ini);
    const antes = comando.slice(cortes[t], a.ini);
    const depois = comando.slice(a.fim, a.fim + 24);
    const verbos = [...antes.matchAll(VERBO)];
    const verbo = verbos.length ? verbos[verbos.length - 1][1] : '';
    let tipo = 'leu';
    if (REDIRECIONA.test(antes) || SAIDA_ANTES.test(antes) || ABRE_PARA_ESCREVER.test(depois)) tipo = 'gravou';
    else if (eh(ESCREVE, verbo)) tipo = 'gravou';
    else if (eh(COPIA, verbo)) tipo = achados.some(o => o.ini > a.ini && trechoDe(o.ini) === t) ? 'leu' : 'gravou'; // só o destino é gravado
    else if (eh(SO_OLHA, verbo)) continue; // conferiu se existe, listou: não abriu a nota
    saida.push({ caminho: expandir(a.caminho), tipo, bases: todasBases });
  }
  return saida;
}

/** O que um apply_patch escreve, arquivo por arquivo: as linhas novas (+) e quantas saem (-). Para a bolha do palco. */
function trechosDoPatch(texto) {
  const saida = [];
  let atual = null;
  for (const bruta of String(texto || '').split('\n')) {
    const linha = bruta.replace(/\r$/, '');
    const m = /^\*\*\* (Add|Update|Delete) File: (.+?)\s*$/.exec(linha);
    if (m) { atual = { arquivo: expandir(m[2]), novo: m[1] === 'Add', novas: [], menos: 0 }; saida.push(atual); continue; }
    if (!atual || linha.startsWith('***')) continue; // fim do patch, "Move to:"
    if (linha.startsWith('+')) atual.novas.push(linha.slice(1));
    else if (linha.startsWith('-')) atual.menos++;
  }
  return saida.filter(t => t.novas.length || t.menos);
}

/** Os arquivos de um apply_patch (todos gravados). */
function notasDoPatch(texto) {
  const saida = [];
  for (const m of String(texto || '').matchAll(/^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+?)\s*$/gm)) {
    if (/\.md$/i.test(m[1])) saida.push({ caminho: expandir(m[1]), tipo: 'gravou', bases: [] });
  }
  return saida;
}

/**
 * Uma chamada de ferramenta do Codex, do jeito que ele grava na conversa.
 * `texto` é a entrada bruta; `escapado` diz se ela veio dentro de uma string (código do "exec", argumentos em JSON).
 * Devolve { arquivos: [{ caminho, tipo, bases }], mcps: [{ ferramenta, entrada }] }.
 */
function analisarCodex({ nome = '', texto = '', escapado = true, base = '' }) {
  const bruto = String(texto || '');
  const limpo = escapado ? desescapar(bruto) : bruto;
  const mcps = [];
  if (nome.includes('__')) {
    let entrada = {};
    try { entrada = JSON.parse(bruto); } catch { /* sem argumentos legíveis */ }
    mcps.push({ ferramenta: nome, entrada: entrada && typeof entrada === 'object' ? entrada : {} });
  }
  // dentro do código: tools.mcp__servidor__ferramenta(...), tools["mcp__servidor-x__ferramenta"](...) ou
  // tools.servidor__ferramenta(...): quem chama confere se o servidor é um MCP conhecido
  for (const m of bruto.matchAll(/tools(?:\.([\w$]+)|\[\s*(["'])([\w$-]+)\2\s*\])\s*\(\s*(\{[\s\S]*?\})?\s*\)/g)) {
    const nomeF = m[1] || m[3];
    if (!nomeF.includes('__')) continue; // exec_command, apply_patch...: não são de MCP
    let entrada = {};
    if (m[4]) {
      try { entrada = JSON.parse(m[4]); } catch {
        const c = /["']?caminho["']?\s*:\s*(["'])(.+?)\1/.exec(desescapar(m[4]));
        if (c) entrada = { caminho: c[2] };
      }
    }
    mcps.push({ ferramenta: nomeF, entrada });
  }
  // os argumentos vêm em JSON (exec_command({"cmd": ..., "workdir": ...}), shell({"command": [...]})): o comando é
  // lido de dentro da string; senão as aspas dela pareceriam aspas de um caminho ("cat padroes/x.md")
  const valor = chave => [...bruto.matchAll(new RegExp(`["']?(?:${chave})["']?\\s*:\\s*("(?:[^"\\\\]|\\\\.)*"|\\[(?:\\s*"(?:[^"\\\\]|\\\\.)*"\\s*,?)*\\s*\\])`, 'g'))]
    .map(m => { try { const v = JSON.parse(m[1]); return Array.isArray(v) ? v.join(' ') : String(v); } catch { return null; } })
    .filter(v => v !== null);
  const pasta = valor('workdir|working_directory|cwd')[0];
  const bases = [pasta ? expandir(pasta) : '', base].filter(Boolean);
  const arquivos = notasDoPatch(limpo).map(a => ({ ...a, bases }));
  const comandos = valor('cmd|command');
  const semPatch = t => t.replace(/\*\*\* Begin Patch[\s\S]*?(\*\*\* End Patch|$)/g, ' ');
  for (const c of comandos.length ? comandos : [limpo]) for (const a of notasDoComando(semPatch(c), bases)) arquivos.push(a);
  return { arquivos, mcps };
}

/** Caminho absoluto de um candidato: o primeiro, entre as bases, que existe (`existe` confere). */
function resolver(candidato, existe) {
  const c = candidato.caminho;
  if (path.isAbsolute(c) || /^[A-Za-z]:[\\/]/.test(c)) { const abs = path.resolve(c); return existe(abs) ? abs : null; }
  for (const base of candidato.bases || []) {
    const abs = path.resolve(base, c);
    if (existe(abs)) return abs;
  }
  return null;
}

module.exports = { notasDoComando, notasDoPatch, trechosDoPatch, analisarCodex, resolver, desescapar, caminhosMd };
