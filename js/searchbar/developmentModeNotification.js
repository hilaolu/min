var searchbarPlugins = require('searchbar/searchbarPlugins.js')
const runtimeConfiguration = require('rendererHost.js').getRuntimeConfiguration()

function initialize () {
  searchbarPlugins.register('developmentModeNotification', {
    index: 0,
    trigger: function (text) {
      return runtimeConfiguration.developmentMode
    },
    showResults: function () {
      searchbarPlugins.reset('developmentModeNotification')
      searchbarPlugins.addResult('developmentModeNotification', {
        title: 'Development Mode Enabled',
        icon: 'carbon:warning-alt'
      })
    }
  })
}

module.exports = { initialize }
