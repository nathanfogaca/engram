// Conexão HTTPS com servidor de certificado próprio (o arquivo "CA" que a pessoa indica).
//
// O Node aceita, como "ca", o próprio certificado autoassinado do servidor. O Electron usa BoringSSL, que
// recusa esse certificado quando ele não é de autoridade (CA:FALSE, o comum em certificado autoassinado):
// a conexão cai com UNABLE_TO_VERIFY_LEAF_SIGNATURE. Aqui a conferência é feita à mão, ANTES de qualquer
// byte do pedido (e do token) sair: o certificado apresentado tem de ser o próprio arquivo do CA ou ter
// sido assinado por ele, valer para o endereço e estar no prazo. Qualquer outro certificado é recusado.

const crypto = require('node:crypto');
const net = require('node:net');
const tls = require('node:tls');

/** Abre a conexão TLS e só a devolve depois de conferir o certificado do servidor contra o CA. */
function conectarComCa(url, caPem, tempo = 15_000) {
  return new Promise((resolve, reject) => {
    let ca;
    try { ca = new crypto.X509Certificate(caPem); } catch { return reject(new Error('o arquivo do certificado (CA) não é um certificado válido')); }
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const ip = net.isIP(host) !== 0;
    const s = tls.connect({
      host, port: Number(url.port) || 443, servername: ip ? undefined : host,
      ca: caPem, rejectUnauthorized: false, ALPNProtocols: ['http/1.1'],
    });
    const falhar = e => { s.destroy(); reject(e); };
    s.setTimeout(tempo, () => falhar(new Error('o servidor não respondeu')));
    s.once('error', e => reject(new Error(`sem conexão com o servidor (${e.code || e.message})`)));
    s.once('secureConnect', () => {
      s.setTimeout(0);
      if (s.authorized) return resolve(s); // a biblioteca de TLS já confiou (e conferiu o nome)
      const par = s.getPeerX509Certificate();
      if (!par) return falhar(new Error('o servidor não apresentou certificado'));
      const doCa = par.fingerprint256 === ca.fingerprint256 || (par.checkIssued(ca) && par.verify(ca.publicKey));
      if (!doCa) return falhar(new Error(`o certificado do servidor não é o do arquivo de CA (${s.authorizationError || 'não confere'})`));
      if (!(ip ? par.checkIP(host) : par.checkHost(host))) return falhar(new Error(`o certificado do servidor não vale para ${host}`));
      const agora = Date.now();
      if (agora < Date.parse(par.validFrom) || agora > Date.parse(par.validTo)) return falhar(new Error('o certificado do servidor está fora do prazo'));
      resolve(s);
    });
  });
}

/** Opções para http(s).request: com CA próprio, a conexão já conferida; sem, as opções normais. */
async function opcoesDeConexao(url, caPem, tempo) {
  if (url.protocol !== 'https:' || !caPem) return {};
  const s = await conectarComCa(url, caPem, tempo);
  return { createConnection: () => s }; // sem agent: o pedido usa esta conexão (com agent, ele abriria outra)
}

module.exports = { conectarComCa, opcoesDeConexao };
