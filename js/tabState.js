const BrowserSession = require('./tabState/browserSession.js')
const rendererHost = require('./rendererHost.js')

let currentSession = null

function initialize (options = {}) {
  currentSession = new BrowserSession({
    ...options,
    windowId: options.windowId || rendererHost.getRuntimeConfiguration().windowId
  })
  return currentSession
}

function get () {
  if (!currentSession) {
    throw new Error('Browser Session has not been initialized')
  }
  return currentSession
}

const browserSession = { BrowserSession, get, initialize }

;[
  'acquireTask',
  'applyChanges',
  'closeTab',
  'closeTask',
  'createTask',
  'duplicateTab',
  'emit',
  'getCopyableSnapshot',
  'getPersistenceRevision',
  'getPersistedSnapshot',
  'getTab',
  'moveTabBy',
  'moveTabToIndex',
  'moveTabToTask',
  'moveTask',
  'on',
  'onChange',
  'openTab',
  'restoreClosedTab',
  'restoreSnapshot',
  'releaseTask',
  'selectTab',
  'selectTask',
  'updateTab',
  'updateTask'
].forEach(method => {
  browserSession[method] = (...args) => get()[method](...args)
})

Object.defineProperties(browserSession, {
  tabs: { get: () => get().tabs },
  tasks: { get: () => get().tasks },
  windowId: { get: () => get().windowId }
})

module.exports = browserSession
