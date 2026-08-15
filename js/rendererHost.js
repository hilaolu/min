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
  'onCommandPaletteFocusRequested',
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
  addSpellcheckerWord: (...args) => getDefaultHost().addSpellcheckerWord(...args),
  backupBookmarks: (...args) => getDefaultHost().backupBookmarks(...args),
  backupCorruptBrowserSession: (...args) => getDefaultHost().backupCorruptBrowserSession(...args),
  chooseNewTabBackground: (...args) => getDefaultHost().chooseNewTabBackground(...args),
  cancelDownload: (...args) => getDefaultHost().cancelDownload(...args),
  clearBrowsingData: (...args) => getDefaultHost().clearBrowsingData(...args),
  closeWindow: (...args) => getDefaultHost().closeWindow(...args),
  connectSettings: (...args) => getDefaultHost().connectSettings(...args),
  connectPlaces: (...args) => getDefaultHost().connectPlaces(...args),
  copyPageLink: (...args) => getDefaultHost().copyPageLink(...args),
  copyText: (...args) => getDefaultHost().copyText(...args),
  createWindow: (...args) => getDefaultHost().createWindow(...args),
  exportBookmarks: (...args) => getDefaultHost().exportBookmarks(...args),
  focusBrowserChrome: (...args) => getDefaultHost().focusBrowserChrome(...args),
  getDroppedFileURL: (...args) => getDefaultHost().getDroppedFileURL(...args),
  grantPermission: (...args) => getDefaultHost().grantPermission(...args),
  getRuntimeConfiguration: function () {
    return getDefaultHost().getRuntimeConfiguration()
  },
  importBookmarks: (...args) => getDefaultHost().importBookmarks(...args),
  invokeTabContent: (...args) => getDefaultHost().invokeTabContent(...args),
  loadBrowserSession: (...args) => getDefaultHost().loadBrowserSession(...args),
  loadNewTabBackground: (...args) => getDefaultHost().loadNewTabBackground(...args),
  loadSystemHosts: (...args) => getDefaultHost().loadSystemHosts(...args),
  loadUserScripts: (...args) => getDefaultHost().loadUserScripts(...args),
  maximizeWindow: (...args) => getDefaultHost().maximizeWindow(...args),
  minimizeWindow: (...args) => getDefaultHost().minimizeWindow(...args),
  onBrowserChromeActivated: (...args) => getDefaultHost().onBrowserChromeActivated(...args),
  onBrowserChromeInput: (...args) => getDefaultHost().onBrowserChromeInput(...args),
  onBrowserCommand: (...args) => getDefaultHost().onBrowserCommand(...args),
  onBrowserSessionChanges: (...args) => getDefaultHost().onBrowserSessionChanges(...args),
  onBrowserSessionSnapshotRequested: (...args) => getDefaultHost().onBrowserSessionSnapshotRequested(...args),
  onCommandPaletteFocusRequested: (...args) => getDefaultHost().onCommandPaletteFocusRequested(...args),
  onDownloadNavigation: (...args) => getDefaultHost().onDownloadNavigation(...args),
  onDownloadChanged: (...args) => getDefaultHost().onDownloadChanged(...args),
  onFileViewChanged: (...args) => getDefaultHost().onFileViewChanged(...args),
  onPDFRequested: (...args) => getDefaultHost().onPDFRequested(...args),
  onPermissionsChanged: (...args) => getDefaultHost().onPermissionsChanged(...args),
  onTabContentEvent: (...args) => getDefaultHost().onTabContentEvent(...args),
  onTabContentMessage: (...args) => getDefaultHost().onTabContentMessage(...args),
  onUserScriptsChanged: (...args) => getDefaultHost().onUserScriptsChanged(...args),
  onWindowStateChanged: (...args) => getDefaultHost().onWindowStateChanged(...args),
  openUserScriptsDirectory: (...args) => getDefaultHost().openUserScriptsDirectory(...args),
  openDownload: (...args) => getDefaultHost().openDownload(...args),
  promptForTagRename: (...args) => getDefaultHost().promptForTagRename(...args),
  removeNewTabBackground: (...args) => getDefaultHost().removeNewTabBackground(...args),
  presentCommandPalette: (...args) => getDefaultHost().presentCommandPalette(...args),
  provideBrowserSessionSnapshot: (...args) => getDefaultHost().provideBrowserSessionSnapshot(...args),
  publishBrowserSessionChanges: (...args) => getDefaultHost().publishBrowserSessionChanges(...args),
  quitApplication: (...args) => getDefaultHost().quitApplication(...args),
  readClipboardText: (...args) => getDefaultHost().readClipboardText(...args),
  releaseDownload: (...args) => getDefaultHost().releaseDownload(...args),
  revealDownload: (...args) => getDefaultHost().revealDownload(...args),
  revokePermission: (...args) => getDefaultHost().revokePermission(...args),
  requestBrowserSessionSnapshot: (...args) => getDefaultHost().requestBrowserSessionSnapshot(...args),
  requestPlaces: (...args) => getDefaultHost().requestPlaces(...args),
  saveBrowserSession: (...args) => getDefaultHost().saveBrowserSession(...args),
  savePage: (...args) => getDefaultHost().savePage(...args),
  setUserScriptsWatching: (...args) => getDefaultHost().setUserScriptsWatching(...args),
  setHandoffURL: (...args) => getDefaultHost().setHandoffURL(...args),
  sendPlacesMessage: (...args) => getDefaultHost().sendPlacesMessage(...args),
  setSetting: (...args) => getDefaultHost().setSetting(...args),
  setWindowFullScreen: (...args) => getDefaultHost().setWindowFullScreen(...args),
  showContextMenu: (...args) => getDefaultHost().showContextMenu(...args),
  showApplicationMenu: (...args) => getDefaultHost().showApplicationMenu(...args),
  showFocusModeWarning: (...args) => getDefaultHost().showFocusModeWarning(...args),
  startDownloadDrag: (...args) => getDefaultHost().startDownloadDrag(...args),
  unmaximizeWindow: (...args) => getDefaultHost().unmaximizeWindow(...args)
}
