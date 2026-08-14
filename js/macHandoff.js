const browserSession = require('tabState.js')
/* Handoff support for macOS */

module.exports = {
  initialize: function () {
    if (window.platformType === 'mac') {
      browserSession.tasks.on('tab-selected', function (id) {
        if (browserSession.tabs.get(id)) {
          if (browserSession.tabs.get(id).private) {
            ipc.send('handoffUpdate', { url: '' })
          } else {
            ipc.send('handoffUpdate', { url: browserSession.tabs.get(id).url })
          }
        }
      })
      browserSession.tasks.on('tab-updated', function (id, key) {
        if (key === 'url' && browserSession.tabs.getSelected() === id) {
          if (browserSession.tabs.get(id).private) {
            ipc.send('handoffUpdate', { url: '' })
          } else {
            ipc.send('handoffUpdate', { url: browserSession.tabs.get(id).url })
          }
        }
      })
    }
  }
}
