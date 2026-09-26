function createPlacesManager ({ BrowserWindow, pageURL }) {
  let placesWindow = null
  let ready = false
  let pendingConnections = []
  let connectionGeneration = 0

  function closePort (port) {
    if (port && typeof port.close === 'function') port.close()
  }

  function isDestroyed (target) {
    return typeof target?.isDestroyed === 'function' && target.isDestroyed()
  }

  function detachPendingConnection (connection) {
    pendingConnections = pendingConnections.filter(candidate => candidate !== connection)
    if (typeof connection.sender.removeListener === 'function') {
      connection.sender.removeListener('destroyed', connection.onSenderDestroyed)
    }
    if (typeof connection.port.removeListener === 'function') {
      connection.port.removeListener('close', connection.onPortClose)
    }
  }

  function discardPendingConnection (connection) {
    detachPendingConnection(connection)
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
    detachPendingConnection(connection)
    const target = placesWindow
    try {
      target.webContents.postMessage('places-connect', { generation: ++connectionGeneration }, [connection.port])
    } catch (error) {
      closePort(connection.port)
      invalidate(target)
      return false
    }
    return true
  }

  function closePendingConnections () {
    pendingConnections.slice().forEach(discardPendingConnection)
  }

  function initialize () {
    if (placesWindow && !isDestroyed(placesWindow)) return placesWindow

    ready = false
    connectionGeneration = 0
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
    initializedWindow.webContents.on('ipc-message', function (event, channel, data) {
      // A newly transferred port may still be in transit when an old idle
      // notification arrives. Only the latest generation can retire the service.
      if (placesWindow !== initializedWindow || channel !== 'places-idle' || !ready ||
          data?.generation !== connectionGeneration || pendingConnections.length) return
      try {
        if (event.senderFrame !== initializedWindow.webContents.mainFrame) return
      } catch (error) { return }
      invalidate(initializedWindow)
    })
    initializedWindow.webContents.once('did-finish-load', function () {
      if (placesWindow !== initializedWindow) return
      ready = true
      pendingConnections.slice().forEach(connection => {
        // A failed transfer may already have discarded the remaining connections.
        if (pendingConnections.includes(connection)) transferConnection(connection)
      })
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
    connection.onSenderDestroyed = function () {
      if (pendingConnections.includes(connection)) discardPendingConnection(connection)
    }
    connection.onPortClose = function () {
      detachPendingConnection(connection)
    }
    if (typeof sender.once === 'function') {
      sender.once('destroyed', connection.onSenderDestroyed)
    }
    if (typeof port.once === 'function') {
      port.once('close', connection.onPortClose)
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
