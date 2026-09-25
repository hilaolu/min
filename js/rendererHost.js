const { normalizeRuntimeConfiguration } = require('../main/browserChromeRuntime.js')

const HOST_OPERATIONS = [
  'addSpellcheckerWord',
  'backupBookmarks',
  'backupCorruptBrowserSession',
  'chooseNewTabBackground',
  'cancelDownload',
  'clearBrowsingData',
  'closeWindow',
  'connectSettings',
  'connectPlaces',
  'copyPageLink',
  'copyText',
  'createWindow',
  'exportBookmarks',
  'focusBrowserChrome',
  'getDroppedFileURL',
  'grantPermission',
  'importBookmarks',
  'invokeTabContent',
  'loadBrowserSession',
  'loadNewTabBackground',
  'loadSystemHosts',
  'loadUserScripts',
  'maximizeWindow',
  'minimizeWindow',
  'onBrowserChromeActivated',
  'onBrowserChromeInput',
  'onBrowserCommand',
  'onBrowserSessionChanges',
  'onBrowserSessionSnapshotRequested',
  'onDownloadNavigation',
  'onDownloadChanged',
  'onFileViewChanged',
  'onPDFRequested',
  'onPermissionsChanged',
  'onTabContentEvent',
  'onTabContentMessage',
  'onUserScriptsChanged',
  'onWindowStateChanged',
  'openUserScriptsDirectory',
  'openDownload',
  'promptForTagRename',
  'removeNewTabBackground',
  'presentCommandPalette',
  'provideBrowserSessionSnapshot',
  'publishBrowserSessionChanges',
  'quitApplication',
  'readClipboardText',
  'releaseDownload',
  'revealDownload',
  'revokePermission',
  'requestBrowserSessionSnapshot',
  'requestPlaces',
  'saveBrowserSession',
  'savePage',
  'searchVaultFiles',
  'setUserScriptsWatching',
  'setHandoffURL',
  'sendPlacesMessage',
  'setSetting',
  'setWindowFullScreen',
  'showContextMenu',
  'showApplicationMenu',
  'showFocusModeWarning',
  'startDownloadDrag',
  'unmaximizeWindow'
]

function unavailableHost () {
  const error = new Error('Browser Chrome Host is unavailable')
  error.code = 'BROWSER_CHROME_HOST_UNAVAILABLE'
  return error
}

function createRendererHost (adapter) {
  if (!adapter || typeof adapter.getRuntimeConfiguration !== 'function') {
    throw unavailableHost()
  }
  const runtimeConfiguration = normalizeRuntimeConfiguration(adapter.getRuntimeConfiguration())
  HOST_OPERATIONS.forEach(function (operation) {
    if (typeof adapter[operation] !== 'function') {
      throw unavailableHost()
    }
  })

  const host = {
    getRuntimeConfiguration: function () {
      return runtimeConfiguration
    }
  }
  HOST_OPERATIONS.forEach(function (operation) {
    host[operation] = function (...args) {
      return adapter[operation](...args)
    }
  })
  return Object.freeze(host)
}

function createInMemoryRendererHost (runtimeConfiguration, operations = {}) {
  const adapter = {
    getRuntimeConfiguration: function () {
      return runtimeConfiguration
    }
  }
  HOST_OPERATIONS.forEach(function (operation) {
    adapter[operation] = operations[operation] || function () {}
  })
  return createRendererHost(adapter)
}

let defaultHost
function getDefaultHost () {
  if (!defaultHost) {
    if (typeof window === 'undefined' || !window.browserChromeHost) {
      throw unavailableHost()
    }
    defaultHost = createRendererHost(window.browserChromeHost)
  }
  return defaultHost
}

module.exports = {
  createInMemoryRendererHost,
  createRendererHost,
  getRuntimeConfiguration: function () {
    return getDefaultHost().getRuntimeConfiguration()
  }
}

// Keep the default facade in sync with the adapter contract without resolving
// the preload host until an operation is actually called.
HOST_OPERATIONS.forEach(function (operation) {
  module.exports[operation] = function (...args) {
    return getDefaultHost()[operation](...args)
  }
})
