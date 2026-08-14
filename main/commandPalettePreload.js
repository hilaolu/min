const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('commandPalettePresentation', {
  onState: function (callback) {
    ipcRenderer.on('command-palette:state', function (event, state) {
      callback(state)
    })
  }
})
