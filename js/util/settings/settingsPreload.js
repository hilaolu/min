var settingsElectron = require('electron')
var settingsIPC = settingsElectron.ipcRenderer

settingsElectron.contextBridge.exposeInMainWorld('settingsHost', {
  getSnapshot: function () {
    if (!window.location.href.startsWith('min://')) return {}
    return settingsIPC.sendSync('settings:get-snapshot')
  },
  onChange: function (callback) {
    if (!window.location.href.startsWith('min://')) return
    settingsIPC.on('settings:changed', function (event, change) {
      callback(change)
    })
  },
  set: function (key, value) {
    if (!window.location.href.startsWith('min://')) {
      return Promise.resolve({
        ok: false,
        error: { code: 'SETTINGS_ORIGIN_DENIED', message: 'Settings are only available to internal pages' }
      })
    }
    return settingsIPC.invoke('settings:set', { key, value })
  }
})
