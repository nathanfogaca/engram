// O git da vista Código, no estilo do Controle de Código do VS Code: situação, antes e depois, preparar e
// despreparar, descartar, commit, branches, pull, push, sincronizar, iniciar o repositório e publicar no GitHub.
// Os caminhos (rels) são relativos à pasta aberta, que pode ser uma subpasta do repositório.
// Veio do Orbion (Lucas Lessa), que passou a fazer parte do Engram.

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

// O git devolve o caminho longo; nomes curtos do Windows (FULANO~1) e maiúsculas não podem atrapalhar a comparação.
const real = p => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
const paraRel = (base, abs) => path.relative(base, abs).split(path.sep).join('/');

function rodar(programa, args, cwd, timeout = 120_000) {
  return new Promise(resolve => {
    // Sem pergunta no terminal: o login do GitHub, se faltar, abre na janela do Git Credential Manager.
    execFile(programa, args, {
      cwd, windowsHide: true, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8', timeout,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' },
    }, (erro, stdout, stderr) => resolve({ ok: !erro, saida: stdout || '', erro: `${stderr || ''}`.trim() || erro?.message || '' }));
  });
}

/** Roda e devolve a saída; se falhar, lança a mensagem do git (sem as linhas de dica dele). */
async function exigir(pasta, args, timeout) {
  const r = await rodar('git', args, real(pasta), timeout);
  if (!r.ok) {
    const linhas = r.erro.split('\n').map(l => l.trim()).filter(l => l && !/^hint:/i.test(l));
    throw new Error(linhas.join('\n') || `git ${args[0]} falhou`);
  }
  return r.saida;
}

const talvez = async (pasta, args) => { const r = await rodar('git', args, real(pasta)); return r.ok ? r.saida : null; };
const temCommits = async pasta => (await rodar('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], real(pasta))).ok;
const temUpstream = async pasta => (await rodar('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], real(pasta))).ok;
const caminhos = rels => (rels?.length ? rels : ['.']);

/** A situação do repositório, para o explorador, a vista Git e a barra de status. null se a pasta não está no git. */
async function situacao(pastaOriginal) {
  const pasta = real(pastaOriginal);
  const raiz = await talvez(pasta, ['rev-parse', '--show-toplevel']);
  if (raiz == null) return null;
  const ramo = ((await talvez(pasta, ['branch', '--show-current'])) || '').trim();
  const saida = (await talvez(pasta, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.'])) || '';
  const base = real(raiz.trim());
  const arquivos = {}; // uma letra por arquivo, para o explorador
  const preparados = {}; // o que vai no próximo commit (o índice)
  const alterados = {}; // o que mudou e ainda não foi preparado
  const CONFLITO = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);
  const partes = saida.split('\0');
  for (let i = 0; i < partes.length; i++) {
    const p = partes[i];
    if (!p) continue;
    const x = p[0], y = p[1], caminho = p.slice(3);
    if (x === 'R' || x === 'C') i++; // o próximo item é o nome antigo
    const rel = paraRel(pasta, path.resolve(base, caminho));
    if (rel.startsWith('..')) continue;
    arquivos[rel] = x === '?' ? 'U' : x === 'A' || y === 'A' ? 'A' : x === 'D' || y === 'D' ? 'D' : x === 'R' ? 'R' : 'M';
    if (CONFLITO.has(x + y)) { alterados[rel] = '!'; continue; }
    if (x === '?') alterados[rel] = 'U';
    else {
      if (x !== ' ') preparados[rel] = x === 'C' ? 'A' : x;
      if (y !== ' ') alterados[rel] = y;
    }
  }
  // quanto falta puxar (atras) e enviar (frente), e se a branch já está no servidor
  const upstream = ((await talvez(pasta, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])) || '').trim() || null;
  let atras = 0, frente = 0;
  if (upstream) [atras, frente] = ((await talvez(pasta, ['rev-list', '--left-right', '--count', '@{u}...HEAD'])) || '0\t0').trim().split(/\s+/).map(n => Number(n) || 0);
  const remoto = ((await talvez(pasta, ['remote', 'get-url', 'origin'])) || '').trim() || null;
  return { ramo, arquivos, preparados, alterados, upstream, atras, frente, remoto, temCommits: await temCommits(pasta) };
}

/** O arquivo como estava no último commit ('' se não existia). */
async function noCommit(pastaOriginal, absoluto) {
  const pasta = real(pastaOriginal);
  const raiz = await talvez(pasta, ['rev-parse', '--show-toplevel']);
  if (raiz == null) return '';
  return (await talvez(pasta, ['show', `HEAD:${paraRel(real(raiz.trim()), real(absoluto))}`])) ?? '';
}

/** O conteúdo preparado (no índice) de um arquivo; vazio se ele não estiver lá. */
async function noIndice(pasta, rel) {
  return (await talvez(pasta, ['show', `:./${rel}`])) ?? '';
}

const preparar = (pasta, rels) => exigir(pasta, ['add', '-A', '--', ...caminhos(rels)]);

async function despreparar(pasta, rels) {
  if (await temCommits(pasta)) await exigir(pasta, ['restore', '--staged', '--', ...caminhos(rels)]);
  else await exigir(pasta, ['rm', '-r', '--cached', '--quiet', '--', ...caminhos(rels)]); // repositório sem nenhum commit ainda
}

/** Volta os arquivos rastreados para o que está preparado (ou no último commit). Os novos vão para a lixeira. */
async function descartar(pasta, rels, novos, paraLixeira) {
  const rastreados = rels.filter(r => !novos.includes(r));
  if (rastreados.length) await exigir(pasta, ['restore', '--worktree', '--', ...rastreados]);
  for (const rel of novos) await paraLixeira(rel);
}

/** Faz o commit e devolve o hash curto. Sem nada preparado e com "tudo", prepara tudo antes (como o VS Code). */
async function commit(pasta, mensagem, { tudo = false } = {}) {
  if (!String(mensagem || '').trim()) throw new Error('Escreva a mensagem do commit.');
  if (tudo) await preparar(pasta, []);
  await exigir(pasta, ['commit', '-m', String(mensagem).trim()]);
  return (await exigir(pasta, ['rev-parse', '--short', 'HEAD'])).trim();
}

async function ramos(pasta) {
  const locais = (await exigir(pasta, ['branch', '--format=%(refname:short)%09%(HEAD)%09%(upstream:short)'])).split('\n').filter(Boolean).map(l => {
    const [nome, atual, upstream] = l.split('\t');
    return { nome, atual: atual === '*', upstream: upstream || null };
  });
  const remotos = (await exigir(pasta, ['branch', '-r', '--format=%(refname:short)'])).split('\n').filter(n => n && !/\/HEAD$/.test(n) && n.includes('/'));
  return { locais, remotos };
}

async function trocarRamo(pasta, nome) {
  const { locais } = await ramos(pasta);
  if (locais.some(r => r.nome === nome)) return exigir(pasta, ['switch', nome]);
  // branch só do servidor (origin/x): cria a local acompanhando a remota
  return exigir(pasta, ['switch', '-c', nome.replace(/^[^/]+\//, ''), '--track', nome]);
}

async function criarRamo(pasta, nome) {
  const limpo = String(nome || '').trim().replace(/\s+/g, '-');
  if (!limpo) throw new Error('Dê um nome para a branch.');
  await exigir(pasta, ['check-ref-format', '--branch', limpo]);
  await exigir(pasta, ['switch', '-c', limpo]);
  return limpo;
}

async function puxar(pasta) {
  if (!(await temUpstream(pasta))) throw new Error('Esta branch ainda não está no servidor. Publique a branch primeiro.');
  await exigir(pasta, ['pull'], 300_000);
}

/** Envia os commits. Branch nova (sem upstream) é publicada no origin, como o "Publicar Branch" do VS Code. */
async function enviar(pasta) {
  if (await temUpstream(pasta)) return exigir(pasta, ['push'], 300_000);
  const remotos = (await exigir(pasta, ['remote'])).split('\n').filter(Boolean);
  if (!remotos.length) throw new Error('Este repositório não tem servidor (remote). Use "Publicar no GitHub".');
  return exigir(pasta, ['push', '-u', remotos.includes('origin') ? 'origin' : remotos[0], 'HEAD'], 300_000);
}

async function sincronizar(pasta) {
  if (await temUpstream(pasta)) await exigir(pasta, ['pull'], 300_000);
  await enviar(pasta);
}

const buscar = pasta => exigir(pasta, ['fetch', '--all', '--prune'], 300_000);
const iniciar = pasta => exigir(pasta, ['init', '-b', 'main']);

/** Cria o repositório no GitHub com o GitHub CLI (gh), liga como origin e envia. Devolve o endereço dele. */
async function publicarNoGitHub(pasta, { nome, privado = true }) {
  if (!(await temCommits(pasta))) throw new Error('Faça o primeiro commit antes de publicar.');
  const limpo = String(nome || '').trim().replace(/\s+/g, '-');
  if (!limpo) throw new Error('Dê um nome para o repositório.');
  const r = await rodar('gh', ['repo', 'create', limpo, privado ? '--private' : '--public', '--source', '.', '--remote', 'origin', '--push'], real(pasta), 300_000);
  if (!r.ok) {
    if (/ENOENT/.test(r.erro)) throw new Error('O GitHub CLI (gh) não está instalado neste computador.');
    if (/auth login|not logged/i.test(r.erro)) throw new Error('Entre na sua conta do GitHub antes: rode "gh auth login" num terminal.');
    throw new Error(r.erro || 'O GitHub CLI não conseguiu criar o repositório.');
  }
  return (/https:\/\/github\.com\/\S+/.exec(`${r.saida}\n${r.erro}`) || [''])[0].replace(/\.git$/, '');
}

/** O que está preparado, para a IA escrever a mensagem do commit (ou tudo, se nada estiver preparado). */
async function diffParaMensagem(pasta, limite = 40_000) {
  let diff = await exigir(pasta, ['diff', '--cached', '--stat', '--patch', '--no-color']);
  if (!diff.trim()) {
    diff = await exigir(pasta, ['diff', '--stat', '--patch', '--no-color']);
    const novos = (await exigir(pasta, ['ls-files', '--others', '--exclude-standard'])).trim();
    if (novos) diff += `\nArquivos novos:\n${novos}`;
  }
  return diff.length > limite ? `${diff.slice(0, limite)}\n… (cortado)` : diff;
}

module.exports = {
  situacao, noCommit, noIndice, preparar, despreparar, descartar, commit, ramos, trocarRamo, criarRamo,
  puxar, enviar, sincronizar, buscar, iniciar, publicarNoGitHub, diffParaMensagem,
};
