var settingsElectron = require('electron')
var settingsIPC = settingsElectron.ipcRenderer

settingsElectron.contextBridge.exposeInMainWorld('settingsHost', {
  clearBrowsingData: function () {
    if (!window.location.href.startsWith('min://app/pages/settings/')) {
      return Promise.resolve({
        ok: false,
        error: {
          code: 'BROWSING_DATA_ORIGIN_DENIED',
          message: 'Browsing data can only be cleared from Settings'
        }
      })
    }
    return settingsIPC.invoke('clearStorageData')
  },
  connect: function (callback) {
    if (!window.location.href.startsWith('min://')) {
      return { revision: 0, values: {} }
    }
    settingsIPC.on('settings:changed', function settingsChanged (event, change) {
      callback(change)
    })
    return settingsIPC.sendSync('settings:connect')
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
