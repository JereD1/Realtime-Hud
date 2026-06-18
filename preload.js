const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  getSources:       ()     => ipcRenderer.invoke('get-sources'),
  getStreamId:      (id)   => ipcRenderer.invoke('get-stream-id', id),
  templatesReady:   ()     => ipcRenderer.invoke('templates-ready'),
  getLayouts:       ()     => ipcRenderer.invoke('get-layouts'),
  saveLayout:       (data) => ipcRenderer.invoke('save-layout', data),
  deleteLayout:     (data) => ipcRenderer.invoke('delete-layout', data),
  registerPlayer:   (data) => ipcRenderer.send('register-player', data),
  unregisterPlayer: (data) => ipcRenderer.send('unregister-player', data),
  analyseBatch:     (data) => ipcRenderer.invoke('analyse-batch', data),
  saveAliveTemplate:(data) => ipcRenderer.invoke('save-alive-template', data),
  resetAll:         ()     => ipcRenderer.send('reset-all'),
  setAllAlive:      (data) => ipcRenderer.send('set-all-alive', data),
  openRegionSelector: (data) => ipcRenderer.send('open-region-selector', data),
  confirmRegion:    (data) => ipcRenderer.send('region-confirmed', data),
  cancelOverlay:    ()     => ipcRenderer.send('overlay-cancelled'),
  on: (channel, fn) => {
    const allowed = ['region-set','match-scores','state-change','post-result','post-error','init-overlay','all-alive-sent']
    if (allowed.includes(channel)) ipcRenderer.on(channel, (_, ...args) => fn(...args))
  },
  off: (channel) => ipcRenderer.removeAllListeners(channel),
})
