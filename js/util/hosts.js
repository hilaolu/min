const rendererHost = require('../rendererHost.js')

var hosts = []

if (typeof window !== 'undefined' && window.browserChromeHost) {
  rendererHost.loadSystemHosts().then(function (loadedHosts) {
    loadedHosts.forEach(function (host) {
      hosts.push(host)
    })
  }).catch(function (error) {
    console.warn('error retrieving hosts file', error)
  })
}

module.exports = hosts
