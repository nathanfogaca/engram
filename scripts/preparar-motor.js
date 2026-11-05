// Monta build/motor-runtime: o que o motor precisa para rodar FORA da pasta de instalação
// (node.exe, motor.js, gancho.js e o node-pty). O app copia isso para %LOCALAPPDATA%\Engram\motor\v<N>
// na primeira vez, e assim a atualização troca os arquivos do app sem derrubar os agentes.
// Roda com o próprio Node que vai junto (process.execPath): no GitHub Actions é o do setup-node.

const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.resolve(__dirname, '..');
const DEST = path.join(RAIZ, 'build', 'motor-runtime');
const plataforma = `${process.platform}-${process.arch}`;

fs.rmSync(DEST, { recursive: true, force: true });
fs.mkdirSync(path.join(DEST, 'modulos', '@lydell'), { recursive: true }); // não 'node_modules': o empacotador corta

const exe = process.platform === 'win32' ? 'node.exe' : 'node';
fs.copyFileSync(process.execPath, path.join(DEST, exe));
for (const f of ['motor.js', 'gancho.js']) fs.copyFileSync(path.join(RAIZ, 'src', 'motor', f), path.join(DEST, f));

const semDepuracao = origem => !origem.endsWith('.pdb');
for (const pacote of ['node-pty', `node-pty-${plataforma}`]) {
  const origem = path.join(RAIZ, 'node_modules', '@lydell', pacote);
  if (!fs.existsSync(origem)) throw new Error(`falta ${origem} (rode npm install nesta plataforma)`);
  fs.cpSync(origem, path.join(DEST, 'modulos', '@lydell', pacote), { recursive: true, filter: semDepuracao });
}
// Impressão digital do motor: o app instala cada versão numa pasta própria (motor/<id>). Motor novo
// vai para pasta nova; um motor antigo que ainda esteja rodando continua intacto na dele.
const crypto = require('node:crypto');
const hash = crypto.createHash('sha256');
for (const f of ['motor.js', 'gancho.js']) hash.update(fs.readFileSync(path.join(DEST, f)));
hash.update(process.versions.node).update(require(path.join(RAIZ, 'node_modules', '@lydell', 'node-pty', 'package.json')).version);
const id = hash.digest('hex').slice(0, 12);
fs.writeFileSync(path.join(DEST, 'package.json'), JSON.stringify({ name: 'engram-motor', private: true, id, node: process.versions.node }, null, 2));

const tamanho = d => fs.readdirSync(d, { withFileTypes: true }).reduce((s, e) => s + (e.isDirectory() ? tamanho(path.join(d, e.name)) : fs.statSync(path.join(d, e.name)).size), 0);
console.log(`motor-runtime pronto (Node ${process.versions.node}, ${plataforma}): ${(tamanho(DEST) / 1048576).toFixed(1)} MB`);
