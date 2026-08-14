const createSettingsCache = require('./settingsCache.js')

const settings = createSettingsCache({
  getSnapshot: function () {
    return window.ipc.sendSync('settings:get-snapshot')
  },
  onChange: function (callback) {
    window.ipc.on('settings:changed', function (event, change) {
      callback(change)
    })
  },
  set: function (key, value) {
    return window.ipc.invoke('settings:set', { key, value })
  }
})

module.exports = settings
