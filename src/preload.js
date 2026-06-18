const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hudApi', {
  listSources: () => ipcRenderer.invoke('sources:list'),
  captureSource: (sourceId) => ipcRenderer.invoke('capture:source', sourceId),
  showOverlay: () => ipcRenderer.invoke('overlay:show'),
  hideOverlay: () => ipcRenderer.invoke('overlay:hide'),
  updateOverlay: (payload) => ipcRenderer.send('overlay:update', payload),
  onOverlayUpdate: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('overlay:update', listener);
    return () => ipcRenderer.removeListener('overlay:update', listener);
  },
});
