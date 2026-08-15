function createPlacesServiceConnection ({ handleRequest, ipc, ready }) {
  const ports = new Set()

  function closePort (port) {
    ports.delete(port)
    try {
      port.close()
    } catch (error) {}
  }

  function post (port, message) {
    if (!ports.has(port)) return false
    try {
      port.postMessage(message)
      return true
    } catch (error) {
      closePort(port)
      return false
    }
  }

  function connect (event) {
    const port = event.ports?.[0]
    if (!port) return
    ports.add(port)
    port.addEventListener('message', function (messageEvent) {
      const data = messageEvent.data || {}
      let responded = false
      function respond (response) {
        responded = true
        post(port, { ok: response.ok !== false, type: 'response', ...response })
      }
      function respondWithError (error) {
        if (responded || data.callbackId === undefined) return
        respond({
          callbackId: data.callbackId,
          error: { code: 'PLACES_REQUEST_FAILED', message: error.message },
          ok: false
        })
      }
      try {
        Promise.resolve(handleRequest(data, respond, port)).catch(respondWithError)
      } catch (error) {
        respondWithError(error)
      }
    })
    port.addEventListener('close', function () {
      ports.delete(port)
    })
    port.start()
    Promise.resolve(ready).then(function () {
      post(port, { ok: true, type: 'ready' })
    }, function (error) {
      post(port, {
        error: { code: 'PLACES_INITIALIZATION_FAILED', message: error.message },
        ok: false,
        type: 'ready'
      })
    })
  }

  ipc.on('places-connect', connect)

  return {
    destroy: function () {
      ipc.removeListener('places-connect', connect)
      ports.forEach(closePort)
      ports.clear()
    }
  }
}

module.exports = createPlacesServiceConnection
