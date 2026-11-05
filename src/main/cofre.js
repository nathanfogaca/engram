// Cofre de credenciais: chaves de API dos provedores ficam no Gerenciador de Credenciais do Windows
// (o mesmo cofre do sistema que guarda senhas de rede), nunca em texto puro no disco do Engram.
// O segredo vai para o PowerShell pela entrada padrão, nunca pela linha de comando.
// Fora do Windows: arquivo cifrado pelo safeStorage do Electron (chaveiro do sistema).

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const PREFIXO = 'Engram:';

const SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class EngramCofre {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct CRED {
    public int Flags; public int Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;
    public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CredWriteW(ref CRED c, int flags);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CredReadW(string alvo, int tipo, int flags, out IntPtr c);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CredDeleteW(string alvo, int tipo, int flags);
  [DllImport("advapi32.dll")] static extern void CredFree(IntPtr p);
  public static string Ler(string alvo) {
    IntPtr p;
    if (!CredReadW(alvo, 1, 0, out p)) return null;
    try {
      CRED c = (CRED)Marshal.PtrToStructure(p, typeof(CRED));
      if (c.CredentialBlobSize == 0) return "";
      byte[] b = new byte[c.CredentialBlobSize];
      Marshal.Copy(c.CredentialBlob, b, 0, b.Length);
      return Encoding.Unicode.GetString(b);
    } finally { CredFree(p); }
  }
  public static void Gravar(string alvo, string usuario, string segredo) {
    byte[] b = Encoding.Unicode.GetBytes(segredo);
    CRED c = new CRED();
    c.Type = 1; c.TargetName = alvo; c.UserName = usuario; c.Persist = 2; c.Comment = "Engram";
    c.CredentialBlobSize = b.Length;
    c.CredentialBlob = Marshal.AllocHGlobal(b.Length);
    try {
      Marshal.Copy(b, 0, c.CredentialBlob, b.Length);
      if (!CredWriteW(ref c, 0)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    } finally { Marshal.FreeHGlobal(c.CredentialBlob); }
  }
  public static bool Apagar(string alvo) { return CredDeleteW(alvo, 1, 0); }
}
'@
$ms = New-Object System.IO.MemoryStream
[Console]::OpenStandardInput().CopyTo($ms)
$p = [System.Text.Encoding]::UTF8.GetString($ms.ToArray()) | ConvertFrom-Json
$r = @{ ok = $true }
switch ($p.op) {
  'ler'    { $s = [EngramCofre]::Ler($p.alvo); if ($s -ne $null) { $r.segredo64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($s)) } }
  'gravar' { [EngramCofre]::Gravar($p.alvo, $p.usuario, $p.segredo) }
  'apagar' { $r.apagou = [EngramCofre]::Apagar($p.alvo) }
}
$r | ConvertTo-Json -Compress
`;

function rodarPowerShell(pedido) {
  return new Promise((resolve, reject) => {
    const filho = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')],
      { windowsHide: true, timeout: 30_000, maxBuffer: 1 << 20 }, (erro, saida, falha) => {
        if (erro) return reject(new Error(`cofre do Windows: ${(falha || erro.message).toString().trim().split('\n').pop()}`));
        try { resolve(JSON.parse(saida.toString().trim().split(/\r?\n/).pop())); } catch { reject(new Error('cofre do Windows: resposta inválida')); }
      });
    filho.stdin.end(JSON.stringify(pedido));
  });
}

class Cofre {
  constructor({ dados, safeStorage }) {
    this.cache = new Map();
    this.windows = process.platform === 'win32';
    this.safeStorage = safeStorage;
    this.arquivo = path.join(dados, 'cofre.bin'); // só fora do Windows
  }

  /** Lê um segredo (null se não houver). Fica em memória enquanto o app roda. */
  async ler(nome) {
    if (this.cache.has(nome)) return this.cache.get(nome);
    let valor = null;
    if (this.windows) {
      const r = await rodarPowerShell({ op: 'ler', alvo: PREFIXO + nome });
      valor = r.segredo64 ? Buffer.from(r.segredo64, 'base64').toString('utf8') : null;
    }
    else valor = this.lerArquivo()[nome] ?? null;
    this.cache.set(nome, valor);
    return valor;
  }

  async gravar(nome, segredo) {
    segredo = String(segredo || '');
    if (!segredo) throw new Error('segredo vazio');
    if (this.windows) await rodarPowerShell({ op: 'gravar', alvo: PREFIXO + nome, usuario: nome, segredo });
    else { const t = this.lerArquivo(); t[nome] = segredo; this.gravarArquivo(t); }
    this.cache.set(nome, segredo);
  }

  async apagar(nome) {
    if (this.windows) await rodarPowerShell({ op: 'apagar', alvo: PREFIXO + nome });
    else { const t = this.lerArquivo(); delete t[nome]; this.gravarArquivo(t); }
    this.cache.set(nome, null);
  }

  lerArquivo() {
    try { return JSON.parse(this.safeStorage.decryptString(fs.readFileSync(this.arquivo))); } catch { return {}; }
  }

  gravarArquivo(t) {
    if (!this.safeStorage.isEncryptionAvailable()) throw new Error('o sistema não oferece um cofre para guardar a chave');
    fs.writeFileSync(this.arquivo, this.safeStorage.encryptString(JSON.stringify(t)));
  }
}

module.exports = { Cofre };
