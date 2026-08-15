const { readRuntimeArgument } = require('./browserChromeRuntime.js')
const { ASYNC_CHANNEL: FILE_ASYNC_CHANNEL, SYNC_CHANNEL: FILE_SYNC_CHANNEL, USER_SCRIPTS_CHANGED_CHANNEL } = require('./rendererHostFiles.js')

const BROWSER_COMMAND_CHANNELS = new Map([
  ['zoomIn', 'zoom-in'],
  ['zoomOut', 'zoom-out'],
  ['zoomReset', 'zoom-reset'],
  ['print', 'print'],
  ['findInPage', 'find-in-page'],
  ['inspectPage', 'inspect-page'],
  ['openEditor', 'open-editor'],
  ['showBookmarks', 'show-bookmarks'],
  ['showHistory', 'show-history'],
  ['addTab', 'add-tab'],
  ['saveCurrentPage', 'save-current-page'],
  ['addPrivateTab', 'add-private-tab'],
  ['addTask', 'add-task'],
  ['toggleTaskOverlay', 'toggle-task-overlay'],
  ['goBack', 'go-back'],
  ['goForward', 'go-forward'],
  ['enterFocusMode', 'enter-focus-mode'],
  ['exitFocusMode', 'exit-focus-mode']
])

function unwrapResult (result) {
  if (!result || result.ok !== true) {
    const error = new Error(result?.error?.message || 'Renderer Host operation failed')
    error.code = result?.error?.code || 'RENDERER_HOST_OPERATION_FAILED'
    throw error
  }
  return result.value
}

function createBrowserChromeHost (argv, ipc, utilities = {}) {
  const runtimeConfiguration = readRuntimeArgument(argv)
  const downloadIdsByPath = new Map()
  const downloadPathsById = new Map()
  const pendingContextMenus = new Map()
  const pendingPlacesRequests = new Map()
  const clearScheduledTimeout = utilities.clearTimeout || clearTimeout
  const scheduleTimeout = utilities.setTimeout || setTimeout
  const placesConnectionTimeout = Number.isFinite(utilities.placesConnectionTimeout) ? utilities.placesConnectionTimeout : 30000
  const placesRequestTimeout = Number.isFinite(utilities.placesRequestTimeout) ? utilities.placesRequestTimeout : 30000
  let nextDownloadId = 1
  let nextPlacesRequestId = 1
  let placesConnection = null
  let contextMenuListenersInstalled = false

  function installContextMenuListeners () {
    if (contextMenuListenersInstalled) return
    contextMenuListenersInstalled = true
    ipc.on('context-menu-item-selected', function (event, data) {
      const pending = pendingContextMenus.get(data.menuId)
      if (pending) {
        pending.resolve(data.itemId)
        pendingContextMenus.delete(data.menuId)
      }
    })
    ipc.on('context-menu-will-close', function (event, data) {
      setTimeout(function () {
        const pending = pendingContextMenus.get(data.menuId)
        if (pending) {
          pending.resolve(null)
          pendingContextMenus.delete(data.menuId)
        }
      }, 16)
    })
  }

  function getDownloadId (downloadPath) {
    if (!downloadIdsByPath.has(downloadPath)) {
      const id = `download-${nextDownloadId++}`
      downloadIdsByPath.set(downloadPath, id)
      downloadPathsById.set(id, downloadPath)
    }
    return downloadIdsByPath.get(downloadPath)
  }

  function requireDownloadPath (id) {
    const downloadPath = downloadPathsById.get(id)
    if (!downloadPath) {
      const error = new Error('Download is unavailable')
      error.code = 'DOWNLOAD_UNAVAILABLE'
      throw error
    }
    return downloadPath
  }
  function subscribe (channel, callback, transform = value => value) {
    if (typeof callback !== 'function') {
      throw new TypeError('Renderer Host subscription callback must be a function')
    }
    const listener = function (event, value) {
      callback(transform(value))
    }
    ipc.on(channel, listener)
    return function unsubscribe () {
      ipc.removeListener(channel, listener)
    }
  }

  function subscribeToBrowserCommands (callback) {
    const unsubscribers = []
    BROWSER_COMMAND_CHANNELS.forEach(function (type, channel) {
      unsubscribers.push(subscribe(channel, callback, function (data = {}) {
        const command = { type }
        if (type === 'add-tab' && typeof data.url === 'string') {
          command.url = data.url
        }
        return Object.freeze(command)
      }))
    })
    return function unsubscribe () {
      unsubscribers.splice(0).forEach(unsubscribe => unsubscribe())
    }
  }

  function subscribeToWindowState (callback) {
    if (typeof callback !== 'function') {
      throw new TypeError('Renderer Host subscription callback must be a function')
    }
    const state = {
      focused: true,
      fullScreen: false,
      maximized: false
    }
    function notify () {
      callback(Object.freeze({ ...state }))
    }
    const changes = new Map([
      ['focus', { focused: true }],
      ['blur', { focused: false }],
      ['maximize', { maximized: true }],
      ['unmaximize', { maximized: false }],
      ['enter-full-screen', { fullScreen: true }],
      ['leave-full-screen', { fullScreen: false }]
    ])
    const unsubscribers = []
    changes.forEach(function (change, channel) {
      unsubscribers.push(subscribe(channel, function () {
        Object.assign(state, change)
        notify()
      }))
    })
    notify()
    return function unsubscribe () {
      unsubscribers.splice(0).forEach(unsubscribe => unsubscribe())
    }
  }

  function invokeFileOperation (operation, payload) {
    return ipc.invoke(FILE_ASYNC_CHANNEL, { operation, payload }).then(unwrapResult)
  }
  function runSyncFileOperation (operation, payload) {
    return unwrapResult(ipc.sendSync(FILE_SYNC_CHANNEL, { operation, payload }))
  }

  function createPlacesError (code, message) {
    const error = new Error(message)
    error.code = code
    return error
  }

  function rejectPendingPlacesRequests (error) {
    pendingPlacesRequests.forEach(function (pending) {
      clearScheduledTimeout(pending.timeout)
      pending.reject(error)
    })
    pendingPlacesRequests.clear()
  }

  function failPlacesConnection (connection, error) {
    if (!connection || placesConnection !== connection) return
    clearScheduledTimeout(connection.timeout)
    placesConnection = null
    if (typeof connection.port.close === 'function') connection.port.close()
    if (!connection.ready) connection.reject(error)
    rejectPendingPlacesRequests(error)
  }

  function handlePlacesMessage (connection, data = {}) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      failPlacesConnection(connection, createPlacesError('PLACES_CONNECTION_FAILED', 'Places connection received an invalid message'))
      return
    }
    if (data.type === 'ready') {
      if (data.ok !== true) {
        failPlacesConnection(connection, createPlacesError(
          data.ok === false ? data.error?.code || 'PLACES_CONNECTION_FAILED' : 'PLACES_CONNECTION_FAILED',
          data.ok === false ? data.error?.message || 'Places failed to initialize' : 'Places sent an invalid readiness acknowledgement'
        ))
        return
      }
      clearScheduledTimeout(connection.timeout)
      connection.ready = true
      connection.resolve()
      return
    }

    if (!data.callbackId) return
    const pending = pendingPlacesRequests.get(data.callbackId)
    if (!pending) return
    if (data.type !== 'response' || typeof data.ok !== 'boolean') {
      failPlacesConnection(connection, createPlacesError('PLACES_CONNECTION_FAILED', 'Places connection received an invalid response'))
      return
    }
    clearScheduledTimeout(pending.timeout)
    pendingPlacesRequests.delete(data.callbackId)
    if (data.ok === false) {
      pending.reject(createPlacesError(
        data.error?.code || 'PLACES_REQUEST_FAILED',
        data.error?.message || 'Places request failed'
      ))
    } else {
      pending.resolve(data.result)
    }
  }

  function connectToPlaces () {
    if (placesConnection) return placesConnection.promise
    if (typeof utilities.MessageChannel !== 'function') {
      return Promise.reject(createPlacesError('PLACES_UNAVAILABLE', 'Places connection is unavailable'))
    }

    const channel = new utilities.MessageChannel()
    let resolveConnection
    let rejectConnection
    const promise = new Promise(function (resolve, reject) {
      resolveConnection = resolve
      rejectConnection = reject
    })
    const connection = {
      port: channel.port2,
      promise,
      ready: false,
      reject: rejectConnection,
      resolve: resolveConnection,
      timeout: null
    }
    placesConnection = connection
    connection.timeout = scheduleTimeout(function () {
      failPlacesConnection(connection, createPlacesError('PLACES_CONNECTION_TIMEOUT', 'Places did not become ready in time'))
    }, placesConnectionTimeout)
    connection.port.addEventListener('message', event => handlePlacesMessage(connection, event.data))
    connection.port.addEventListener('messageerror', function () {
      failPlacesConnection(connection, createPlacesError('PLACES_CONNECTION_FAILED', 'Places connection received an invalid message'))
    })
    connection.port.addEventListener('close', function () {
      failPlacesConnection(connection, createPlacesError('PLACES_CONNECTION_CLOSED', 'Places connection closed'))
    })

    try {
      ipc.postMessage('places-connect', null, [channel.port1])
      connection.port.start()
    } catch (error) {
      failPlacesConnection(connection, createPlacesError('PLACES_CONNECTION_FAILED', error.message))
    }
    return promise
  }

  function teardownPlaces () {
    const error = createPlacesError('PLACES_CONNECTION_CLOSED', 'Places connection closed')
    const connection = placesConnection
    placesConnection = null
    if (connection) {
      clearScheduledTimeout(connection.timeout)
      if (typeof connection.port.close === 'function') connection.port.close()
      if (!connection.ready) connection.reject(error)
    }
    rejectPendingPlacesRequests(error)
  }

  if (typeof utilities.addTeardownListener === 'function') {
    utilities.addTeardownListener(teardownPlaces)
  }
  return Object.freeze({
    backupBookmarks: function (data) {
      return invokeFileOperation('bookmarks.backup', { data })
    },
    backupCorruptBrowserSession: function (data) {
      return runSyncFileOperation('session.backup-corrupt', { data })
    },
    addSpellcheckerWord: function (word) {
      return ipc.invoke('addWordToSpellCheckerDictionary', word)
    },
    cancelDownload: function (id) {
      ipc.send('cancelDownload', requireDownloadPath(id))
    },
    chooseNewTabBackground: function () {
      return invokeFileOperation('new-tab-background.choose')
    },
    closeWindow: function () {
      return ipc.invoke('close')
    },
    clearBrowsingData: function () {
      return ipc.invoke('clearStorageData')
    },
    connectPlaces: function () {
      return connectToPlaces()
    },
    copyPageLink: function (link) {
      utilities.clipboard.write({
        bookmark: typeof link.title === 'string' ? link.title : '',
        html: typeof link.html === 'string' ? link.html : '',
        text: typeof link.url === 'string' ? link.url : ''
      })
    },
    copyText: function (value) {
      utilities.clipboard.writeText(String(value))
    },
    createWindow: function (options = {}) {
      const request = {}
      if (typeof options.initialTask === 'string') {
        request.initialTask = options.initialTask
      }
      ipc.send('newWindow', request)
    },
    focusBrowserChrome: function () {
      ipc.send('focusMainWebContents')
    },
    exportBookmarks: function (data) {
      return invokeFileOperation('bookmarks.export', { data })
    },
    getRuntimeConfiguration: function () {
      return runtimeConfiguration
    },
    connectSettings: function (callback) {
      subscribe('settings:changed', callback)
      return ipc.sendSync('settings:connect')
    },
    getDroppedFileURL: function (file) {
      const filePath = utilities.webUtils.getPathForFile(file)
      return utilities.pathToFileURL(filePath).href
    },
    importBookmarks: function () {
      return invokeFileOperation('bookmarks.import')
    },
    invokeTabContent: function (tabId, behavior, input) {
      return ipc.invoke('tab-content-command', {
        id: tabId,
        operation: behavior,
        payload: input
      }).then(unwrapResult)
    },
    loadBrowserSession: function () {
      return runSyncFileOperation('session.load')
    },
    loadNewTabBackground: function () {
      return invokeFileOperation('new-tab-background.load')
    },
    loadSystemHosts: function () {
      return invokeFileOperation('system-hosts.load')
    },
    loadUserScripts: function () {
      return invokeFileOperation('user-scripts.load')
    },
    maximizeWindow: function () {
      return ipc.invoke('maximize')
    },
    minimizeWindow: function () {
      return ipc.invoke('minimize')
    },
    onBrowserChromeActivated: function (callback) {
      return subscribe('windowFocus', callback, function () {})
    },
    onBrowserChromeInput: function (callback) {
      return subscribe('before-input-event', callback, function (input = {}) {
        return Object.freeze({
          alt: input.alt === true,
          code: typeof input.code === 'string' ? input.code : '',
          control: input.control === true,
          isAutoRepeat: input.isAutoRepeat === true,
          key: typeof input.key === 'string' ? input.key : '',
          meta: input.meta === true,
          shift: input.shift === true,
          type: input.type === 'keyUp' ? 'keyUp' : 'keyDown'
        })
      })
    },
    onBrowserCommand: function (callback) {
      return subscribeToBrowserCommands(callback)
    },
    onBrowserSessionChanges: function (callback) {
      return subscribe('tab-state-change-receive', callback)
    },
    onBrowserSessionSnapshotRequested: function (callback) {
      return subscribe('read-tab-state', callback, function () {})
    },
    onCommandPaletteFocusRequested: function (callback) {
      return subscribe('command-palette:focus-input', callback, function () {})
    },
    onDownloadNavigation: function (callback) {
      return subscribe('download-navigation', callback)
    },
    onDownloadChanged: function (callback) {
      if (typeof callback !== 'function') {
        throw new TypeError('Renderer Host subscription callback must be a function')
      }
      const listener = function (event, info = {}) {
        if (typeof info.path !== 'string' || !info.path) return
        callback(Object.freeze({
          id: getDownloadId(info.path),
          name: typeof info.name === 'string' ? info.name : '',
          size: Object.freeze({
            received: Number.isFinite(info.size?.received) ? info.size.received : 0,
            total: Number.isFinite(info.size?.total) ? info.size.total : 0
          }),
          status: typeof info.status === 'string' ? info.status : 'progressing'
        }))
      }
      ipc.on('download-info', listener)
      return function unsubscribe () {
        ipc.removeListener('download-info', listener)
      }
    },
    onFileViewChanged: function (callback) {
      return subscribe('set-file-view', callback)
    },
    onPDFRequested: function (callback) {
      return subscribe('openPDF', callback)
    },
    onPermissionsChanged: function (callback) {
      return subscribe('updatePermissions', callback, function (permissions = []) {
        return permissions.map(function (permission) {
          return Object.freeze({
            details: Object.freeze({
              mediaTypes: Array.isArray(permission.details?.mediaTypes)
                ? permission.details.mediaTypes.filter(type => typeof type === 'string')
                : []
            }),
            granted: permission.granted === true,
            origin: typeof permission.origin === 'string' ? permission.origin : '',
            permission: typeof permission.permission === 'string' ? permission.permission : '',
            permissionId: permission.permissionId,
            tabId: permission.tabId
          })
        })
      })
    },
    onTabContentEvent: function (callback) {
      return subscribe('tab-content-event', callback)
    },
    onTabContentMessage: function (callback) {
      return subscribe('tab-content-message', callback)
    },
    onUserScriptsChanged: function (callback) {
      return subscribe(USER_SCRIPTS_CHANGED_CHANNEL, callback, function () {})
    },
    onWindowStateChanged: function (callback) {
      return subscribeToWindowState(callback)
    },
    openUserScriptsDirectory: function () {
      return invokeFileOperation('user-scripts.open-directory')
    },
    openDownload: function (id) {
      return utilities.shell.openPath(requireDownloadPath(id))
    },
    promptForTagRename: function () {
      const result = ipc.sendSync('prompt', {
        text: '',
        values: [{ placeholder: 'Rename Tag', id: 'name', type: 'text' }],
        ok: 'Confirm',
        cancel: 'Cancel',
        width: 500,
        height: 140
      })
      return typeof result?.name === 'string' ? result.name : null
    },
    removeNewTabBackground: function () {
      return invokeFileOperation('new-tab-background.remove')
    },
    presentCommandPalette: function (state) {
      return ipc.invoke('command-palette:present', state)
    },
    provideBrowserSessionSnapshot: function (snapshot) {
      ipc.send('return-tab-state', snapshot)
    },
    publishBrowserSessionChanges: function (changes) {
      ipc.send('tab-state-change', changes)
    },
    quitApplication: function () {
      ipc.send('quit')
    },
    readClipboardText: function () {
      return utilities.clipboard.readText()
    },
    releaseDownload: function (id) {
      const downloadPath = downloadPathsById.get(id)
      if (downloadPath) downloadIdsByPath.delete(downloadPath)
      downloadPathsById.delete(id)
    },
    revealDownload: function (id) {
      return ipc.invoke('showItemInFolder', requireDownloadPath(id))
    },
    revokePermission: function (permissionId) {
      ipc.send('revokePermission', permissionId)
    },
    requestBrowserSessionSnapshot: function () {
      return ipc.sendSync('request-tab-state')
    },
    requestPlaces: function (request) {
      return connectToPlaces().then(function () {
        const connection = placesConnection
        const callbackId = nextPlacesRequestId++
        return new Promise(function (resolve, reject) {
          const timeout = scheduleTimeout(function () {
            pendingPlacesRequests.delete(callbackId)
            reject(createPlacesError('PLACES_REQUEST_TIMEOUT', 'Places request timed out'))
          }, placesRequestTimeout)
          pendingPlacesRequests.set(callbackId, { reject, resolve, timeout })
          try {
            connection.port.postMessage({ ...request, callbackId })
          } catch (error) {
            const connectionError = createPlacesError('PLACES_CONNECTION_CLOSED', error.message)
            failPlacesConnection(connection, connectionError)
            if (pendingPlacesRequests.has(callbackId)) {
              clearScheduledTimeout(timeout)
              pendingPlacesRequests.delete(callbackId)
              reject(connectionError)
            }
          }
        })
      })
    },
    saveBrowserSession: function (data, options = {}) {
      if (options.sync === true) {
        return runSyncFileOperation('session.save', { data })
      }
      return invokeFileOperation('session.save', { data })
    },
    savePage: function (tabId, suggestedName) {
      return invokeFileOperation('page.save', { suggestedName, tabId })
    },
    setUserScriptsWatching: function (enabled) {
      return invokeFileOperation('user-scripts.set-watching', { enabled: enabled === true })
    },
    setHandoffURL: function (url) {
      ipc.send('handoffUpdate', { url: typeof url === 'string' ? url : '' })
    },
    sendPlacesMessage: function (message) {
      return connectToPlaces().then(function () {
        const connection = placesConnection
        try {
          connection.port.postMessage(message)
        } catch (error) {
          const connectionError = createPlacesError('PLACES_CONNECTION_CLOSED', error.message)
          failPlacesConnection(connection, connectionError)
          throw connectionError
        }
      })
    },
    setSetting: function (key, value) {
      return ipc.invoke('settings:set', { key, value })
    },
    showContextMenu: function (request) {
      installContextMenuListeners()
      return new Promise(function (resolve) {
        pendingContextMenus.set(request.id, { resolve })
        ipc.send('open-context-menu', request)
      })
    },
    setWindowFullScreen: function (fullScreen) {
      return ipc.invoke('setFullScreen', fullScreen === true)
    },
    showApplicationMenu: function (position) {
      ipc.send('showSecondaryMenu', {
        x: Number.isFinite(position?.x) ? position.x : 0,
        y: Number.isFinite(position?.y) ? position.y : 0
      })
    },
    showFocusModeWarning: function () {
      return ipc.invoke('showFocusModeDialog2')
    },
    startDownloadDrag: function (id) {
      return ipc.invoke('startFileDrag', requireDownloadPath(id))
    },
    grantPermission: function (permissionId) {
      ipc.send('permissionGranted', permissionId)
    },
    unmaximizeWindow: function () {
      return ipc.invoke('unmaximize')
    }
  })
}

function installBrowserChromeHost ({ argv, contextBridge, contextIsolated, ipc, target, utilities }) {
  const host = createBrowserChromeHost(argv, ipc, utilities)
  if (contextIsolated) {
    contextBridge.exposeInMainWorld('browserChromeHost', host)
  } else {
    Object.defineProperty(target, 'browserChromeHost', {
      configurable: false,
      enumerable: true,
      value: host,
      writable: false
    })
  }
  return host
}

if (process.type === 'renderer') {
  const { clipboard, contextBridge, ipcRenderer, shell, webUtils } = require('electron')
  const { pathToFileURL } = require('url')
  installBrowserChromeHost({
    argv: process.argv,
    contextBridge,
    contextIsolated: process.contextIsolated,
    ipc: ipcRenderer,
    target: window,
    utilities: {
      addTeardownListener: callback => window.addEventListener('unload', callback, { once: true }),
      clipboard,
      MessageChannel: window.MessageChannel,
      pathToFileURL,
      shell,
      webUtils
    }
  })
}

module.exports = { createBrowserChromeHost, installBrowserChromeHost }
