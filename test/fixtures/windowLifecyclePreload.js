const { ipcRenderer } = require('electron')

window.addEventListener('beforeunload', function () {
  ipcRenderer.sendSync('test-chrome-unload')
})
