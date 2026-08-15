const createSettingsCache = require('./settingsCache.js')
const rendererHost = require('../../rendererHost.js')

const settings = createSettingsCache({
  connect: function (callback) {
    return rendererHost.connectSettings(callback)
  },
  set: function (key, value) {
    return rendererHost.setSetting(key, value)
  }
})

module.exports = settings
