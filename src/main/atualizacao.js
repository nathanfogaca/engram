// Atualização automática: confere o GitHub Releases (ou um endereço próprio, configurável), baixa em
// segundo plano, confere a integridade (SHA-512 do latest.yml) e instala sozinha quando a pessoa não
// está usando a janela, ou na hora pelo botão. Os agentes não caem: estão no motor, fora da pasta
// de instalação.

const { app } = require('electron');
const { autoUpdater } = require('electron-updater');

// De onde vêm as versões. Fica fixo aqui (e não só no app-update.yml do instalador) para que um
// instalador montado sem o repositório certo nunca fique sem atualização. "atualizacao_repo" troca.
const REPO_PADRAO = 'nathanfogaca/engram';

function erroClaro(e) {
  const t = String(e?.message || e || '');
  if (/\b404\b/.test(t)) return 'não achei as versões no GitHub (o endereço de atualização está errado)';
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|ECONNRESET|net::ERR_/i.test(t)) return 'sem conexão com o GitHub agora';
  if (/sha512|checksum/i.test(t)) return 'o arquivo baixado não bateu com a assinatura (SHA-512); ele foi descartado';
  return t.split('\n')[0].slice(0, 200);
}

class Atualizador {
  constructor({ cfg, registrar, avisar, janela, aoInstalar }) {
    this.cfg = cfg;
    this.registrar = registrar;
    this.avisar = avisar;
    this.janela = janela; // função que devolve a BrowserWindow atual
    this.aoInstalar = aoInstalar;
    this.ativo = app.isPackaged;
    this.estado = { estado: 'parado', versao_atual: app.getVersion(), versao_nova: null, progresso: 0, erro: null, notas: null, conferido_em: null, ativo: this.ativo };
    this.semFocoDesde = null;
  }

  mudar(parcial) {
    Object.assign(this.estado, parcial);
    this.avisar({ tipo: 'atualizacao', ...this.estado });
  }

  iniciar() {
    if (!this.ativo) return; // em desenvolvimento não há o que atualizar
    const u = autoUpdater;
    u.autoDownload = true;
    u.autoInstallOnAppQuit = true; // se a pessoa sair pelo menu, instala na saída
    u.logger = { info: m => this.registrar(`atualização: ${m}`), warn: m => this.registrar(`atualização: ${m}`), error: m => this.registrar(`atualização (erro): ${m}`), debug: () => {} };
    if (this.cfg.atualizacao_url) u.setFeedURL({ provider: 'generic', url: this.cfg.atualizacao_url });
    else {
      const [owner, repo] = String(this.cfg.atualizacao_repo || REPO_PADRAO).split('/');
      u.setFeedURL({ provider: 'github', owner, repo, releaseType: 'release' });
    }
    u.on('checking-for-update', () => this.mudar({ estado: 'verificando', erro: null }));
    u.on('update-not-available', () => this.mudar({ estado: 'em dia', conferido_em: new Date().toISOString() }));
    u.on('update-available', info => this.mudar({ estado: 'baixando', versao_nova: info.version, progresso: 0, notas: notas(info) }));
    u.on('download-progress', p => this.mudar({ estado: 'baixando', progresso: Math.round(p.percent || 0) }));
    u.on('update-downloaded', info => {
      this.mudar({ estado: 'pronta', versao_nova: info.version, progresso: 100, notas: notas(info) });
      this.registrar(`atualização ${info.version} baixada e conferida`);
    });
    u.on('error', e => this.mudar({ estado: 'erro', erro: erroClaro(e), conferido_em: new Date().toISOString() }));

    setTimeout(() => this.verificar(), (this.cfg.atualizacao_primeira_s ?? 15) * 1000);
    setInterval(() => this.verificar(), Math.max(10, this.cfg.atualizacao_intervalo_min ?? 120) * 60_000);
    // instala sozinha quando a pessoa não está usando a janela
    setInterval(() => this.talvezInstalar(), 15_000);
  }

  async verificar() {
    if (!this.ativo || ['baixando', 'pronta', 'instalando'].includes(this.estado.estado)) return this.estado;
    try { await autoUpdater.checkForUpdates(); } catch (e) { this.mudar({ estado: 'erro', erro: erroClaro(e), conferido_em: new Date().toISOString() }); }
    return this.estado;
  }

  talvezInstalar() {
    if (this.estado.estado !== 'pronta' || this.cfg.atualizar_sozinho === false) return;
    const j = this.janela();
    const emUso = j && j.isVisible() && !j.isMinimized() && j.isFocused();
    if (emUso) { this.semFocoDesde = null; return; }
    this.semFocoDesde ??= Date.now();
    if (Date.now() - this.semFocoDesde >= (this.cfg.atualizacao_ociosidade_s ?? 120) * 1000) this.instalar();
  }

  instalar() {
    if (this.estado.estado !== 'pronta') throw new Error('não há atualização pronta');
    this.mudar({ estado: 'instalando' });
    this.registrar(`instalando ${this.estado.versao_nova}: os agentes seguem no motor`);
    this.aoInstalar(); // libera o "fechar esconde na bandeja"
    setTimeout(() => autoUpdater.quitAndInstall(true, true), 400); // silencioso e reabre em seguida
  }
}

function notas(info) {
  const n = info.releaseNotes;
  if (!n) return null;
  if (typeof n === 'string') return n.replace(/<[^>]+>/g, '').slice(0, 2000);
  return n.map(x => `${x.version}: ${String(x.note || '').replace(/<[^>]+>/g, '')}`).join('\n').slice(0, 2000);
}

module.exports = { Atualizador };
