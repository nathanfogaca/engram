// Atualização automática: confere o GitHub Releases (ou um endereço próprio, configurável), baixa em
// segundo plano, confere a integridade (SHA-512 do latest.yml) e instala sozinha quando a pessoa não
// está usando a janela, ou na hora pelo botão. Os agentes não caem: estão no motor, fora da pasta
// de instalação.

const { app } = require('electron');
const { autoUpdater } = require('electron-updater');

class Atualizador {
  constructor({ cfg, registrar, avisar, janela, aoInstalar }) {
    this.cfg = cfg;
    this.registrar = registrar;
    this.avisar = avisar;
    this.janela = janela; // função que devolve a BrowserWindow atual
    this.aoInstalar = aoInstalar;
    this.estado = { estado: 'parado', versao_atual: app.getVersion(), versao_nova: null, progresso: 0, erro: null, notas: null };
    this.semFocoDesde = null;
    this.ativo = app.isPackaged;
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
    u.on('checking-for-update', () => this.mudar({ estado: 'verificando', erro: null }));
    u.on('update-not-available', () => this.mudar({ estado: 'em dia' }));
    u.on('update-available', info => this.mudar({ estado: 'baixando', versao_nova: info.version, progresso: 0, notas: notas(info) }));
    u.on('download-progress', p => this.mudar({ estado: 'baixando', progresso: Math.round(p.percent || 0) }));
    u.on('update-downloaded', info => {
      this.mudar({ estado: 'pronta', versao_nova: info.version, progresso: 100, notas: notas(info) });
      this.registrar(`atualização ${info.version} baixada e conferida`);
    });
    u.on('error', e => this.mudar({ estado: 'erro', erro: String(e?.message || e).split('\n')[0] }));

    setTimeout(() => this.verificar(), (this.cfg.atualizacao_primeira_s ?? 15) * 1000);
    setInterval(() => this.verificar(), Math.max(10, this.cfg.atualizacao_intervalo_min ?? 120) * 60_000);
    // instala sozinha quando a pessoa não está usando a janela
    setInterval(() => this.talvezInstalar(), 15_000);
  }

  async verificar() {
    if (!this.ativo || ['baixando', 'pronta', 'instalando'].includes(this.estado.estado)) return this.estado;
    try { await autoUpdater.checkForUpdates(); } catch (e) { this.mudar({ estado: 'erro', erro: String(e.message || e).split('\n')[0] }); }
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
