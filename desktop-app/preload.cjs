// Ponte mínima entre as páginas do Jarvis e o app: minimizar/mostrar o HUD, a camada deixar o clique
// passar (ou não, em cima da esfera mini), estado do HUD para a camada e atualização da casca do app.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('jarvisApp', {
  isApp: true,
  minimize: () => ipcRenderer.send('hud:minimize'),
  hide: () => ipcRenderer.send('hud:hide'),
  showHud: () => ipcRenderer.send('hud:show'),
  setIgnore: (ignore) => ipcRenderer.send('ov:ignore', ignore),
  onHud: (cb) => ipcRenderer.on('hud-state', (_e, s) => cb(s)),
  updateApp: () => ipcRenderer.send('app:update'),
})
