// A passagem segura entre a tela e o app: só estas funções existem para a página.

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const terminais = new Map(); // id -> { aoInicio, aoDados, aoFim }
ipcRenderer.on('terminal:dados', (_e, { id, dados, inicio, colunas, linhas }) => {
  const t = terminais.get(id);
  if (!t) return;
  if (inicio) t.aoInicio?.({ colunas, linhas });
  t.aoDados(dados);
});
ipcRenderer.on('terminal:fim', (_e, id) => { terminais.get(id)?.aoFim?.(); terminais.delete(id); });

contextBridge.exposeInMainWorld('engram', {
  api: (metodo, caminho, corpo) => ipcRenderer.invoke('api', { metodo, caminho, corpo }),
  aoVivo: cb => {
    const f = (_e, m) => cb(m);
    ipcRenderer.on('aovivo', f);
    return () => ipcRenderer.off('aovivo', f);
  },
  terminal: {
    abrir(id, { aoInicio, aoDados, aoFim }) {
      terminais.set(id, { aoInicio, aoDados, aoFim });
      ipcRenderer.send('terminal:abrir', id);
      return {
        enviar: dados => ipcRenderer.send('terminal:entrada', { id, dados }),
        tamanho: (colunas, linhas) => ipcRenderer.send('terminal:tamanho', { id, colunas, linhas }),
        fechar: () => { terminais.delete(id); ipcRenderer.send('terminal:fechar', id); },
      };
    },
  },
  caminhoDoArquivo: arquivo => { try { return webUtils.getPathForFile(arquivo) || ''; } catch { return ''; } },
});
