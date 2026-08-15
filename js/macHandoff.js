const browserSession = require('tabState.js')
const rendererHost = require('rendererHost.js')
const runtimeConfiguration = rendererHost.getRuntimeConfiguration()
/* Handoff support for macOS */

module.exports = {
  initialize: function () {
    if (runtimeConfiguration.platform === 'darwin') {
      browserSession.tasks.on('tab-selected', function (id) {
        if (browserSession.tabs.get(id)) {
          if (browserSession.tabs.get(id).private) {
            rendererHost.setHandoffURL(null)
          } else {
            rendererHost.setHandoffURL(browserSession.tabs.get(id).url)
          }
        }
      })
      browserSession.tasks.on('tab-updated', function (id, key) {
        if (key === 'url' && browserSession.tabs.getSelected() === id) {
          if (browserSession.tabs.get(id).private) {
            rendererHost.setHandoffURL(null)
          } else {
            rendererHost.setHandoffURL(browserSession.tabs.get(id).url)
          }
        }
      })
    }
  }
}
