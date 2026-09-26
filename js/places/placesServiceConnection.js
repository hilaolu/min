function createPlacesServiceConnection ({ handleRequest, ipc, ready, onIdle, onActive, idleDelay = 30000, schedule = setTimeout, cancelSchedule = clearTimeout }) {
  const ports = new Set()
  let activeWork = 0
  let initialized = false
  let destroyed = false
  let generation = 0
  let idleTimer = null

  function cancelIdle () {
    if (idleTimer !== null) cancelSchedule(idleTimer)
    idleTimer = null
  }

  function considerIdle () {
    if (!onIdle || destroyed || !initialized || ports.size || activeWork || idleTimer !== null) return
    idleTimer = schedule(function () {
      idleTimer = null
      if (!destroyed && ports.size === 0 && activeWork === 0) onIdle(generation)
    }, idleDelay)
  }

  function runTask (work) {
    if (destroyed) return Promise.resolve()
    cancelIdle()
    if (onActive) onActive()
    activeWork++
    function complete () {
      activeWork--
      considerIdle()
    }
    let result
    try {
      result = work()
    } catch (error) {
      complete()
      throw error
    }
    return Promise.resolve(result).then(value => {
      complete()
      return value
    }, error => {
      complete()
      throw error
    })
  }

  Promise.resolve(ready).then(function () {
    initialized = true
    considerIdle()
  }, function () {
    initialized = true
    considerIdle()
  })

  function closePort (port) {
    ports.delete(port)
    try {
      port.close()
    } catch (error) {}
    considerIdle()
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

  function connect (event, data = {}) {
    const port = event.ports?.[0]
    if (!port) return
    cancelIdle()
    if (onActive) onActive()
    generation = data.generation || 0
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
        runTask(() => handleRequest(data, respond, port)).catch(respondWithError)
      } catch (error) {
        respondWithError(error)
      }
    })
    port.addEventListener('close', function () {
      ports.delete(port)
      considerIdle()
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
    runTask,
    destroy: function () {
      destroyed = true
      cancelIdle()
      ipc.removeListener('places-connect', connect)
      ports.forEach(closePort)
      ports.clear()
    }
  }
}

module.exports = createPlacesServiceConnection
