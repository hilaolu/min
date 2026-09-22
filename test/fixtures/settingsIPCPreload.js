// Deliberately bypasses preload URL gates to exercise the main-process boundary.
const { contextBridge, ipcRenderer } = require('electron')
const changes = []
ipcRenderer.on('settings:changed', (event, change) => changes.push(change))
contextBridge.exposeInMainWorld('settingsTest', {
  connect: () => ipcRenderer.sendSync('settings:connect'),
  set: (key, value) => ipcRenderer.invoke('settings:set', { key, value }),
  changes: () => changes
})
