function createPlacesManager ({ BrowserWindow, pageURL }) {
  let placesWindow = null
  let ready = false
  let pendingConnections = []

  function closePort (port) {
    if (port && typeof port.close === 'function') port.close()
  }

  function isDestroyed (target) {
    return typeof target?.isDestroyed === 'function' && target.isDestroyed()
  }

  function discardPendingConnection (connection) {
    pendingConnections = pendingConnections.filter(candidate => candidate !== connection)
    closePort(connection.port)
  }

  function invalidate (target) {
    if (placesWindow !== target) return
    ready = false
    placesWindow = null
    closePendingConnections()
    if (!isDestroyed(target)) target.destroy()
  }

  function transferConnection (connection) {
    if (!placesWindow || !ready || isDestroyed(placesWindow.webContents) || isDestroyed(connection.sender)) {
      discardPendingConnection(connection)
      return false
    }
    pendingConnections = pendingConnections.filter(candidate => candidate !== connection)
    const target = placesWindow
    try {
      target.webContents.postMessage('places-connect', null, [connection.port])
    } catch (error) {
      closePort(connection.port)
      invalidate(target)
      return false
    }
    return true
  }

  function closePendingConnections () {
    pendingConnections.splice(0).forEach(connection => closePort(connection.port))
  }

  function initialize () {
    if (placesWindow && !isDestroyed(placesWindow)) return placesWindow

    ready = false
    placesWindow = new BrowserWindow({
      width: 300,
      height: 300,
      show: false,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false
      }
    })
    const initializedWindow = placesWindow
    initializedWindow.webContents.once('did-finish-load', function () {
      if (placesWindow !== initializedWindow) return
      ready = true
      pendingConnections.slice().forEach(transferConnection)
    })
    initializedWindow.webContents.once('did-fail-load', function () {
      invalidate(initializedWindow)
    })
    initializedWindow.webContents.once('render-process-gone', function () {
      invalidate(initializedWindow)
    })
    initializedWindow.once('closed', function () {
      if (placesWindow !== initializedWindow) return
      ready = false
      placesWindow = null
      closePendingConnections()
    })
    initializedWindow.loadURL(pageURL)
    return initializedWindow
  }

  function connect (sender, port) {
    if (!sender || !port || isDestroyed(sender)) {
      closePort(port)
      return false
    }
    const connection = { port, sender }
    if (typeof sender.once === 'function') {
      sender.once('destroyed', function () {
        if (pendingConnections.includes(connection)) discardPendingConnection(connection)
      })
    }
    if (typeof port.once === 'function') {
      port.once('close', function () {
        pendingConnections = pendingConnections.filter(candidate => candidate !== connection)
      })
    }
    if (!placesWindow || isDestroyed(placesWindow) || isDestroyed(placesWindow.webContents)) initialize()
    if (ready) return transferConnection(connection)
    pendingConnections.push(connection)
    return true
  }

  function destroy () {
    const target = placesWindow
    ready = false
    placesWindow = null
    closePendingConnections()
    if (target && !isDestroyed(target)) target.destroy()
  }

  return {
    connect,
    destroy,
    getWindow: () => placesWindow,
    initialize,
    isReady: () => ready
  }
}

module.exports = createPlacesManager
