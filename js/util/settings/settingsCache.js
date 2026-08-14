function clone (value) {
  if (value === undefined) return undefined
  return JSON.parse(JSON.stringify(value))
}

function createSettingsCache (host) {
  const values = clone(host.getSnapshot())
  const changeListeners = []
  const errorListeners = []

  function get (key, callback) {
    const value = clone(values[key])
    if (callback) callback(value)
    return value
  }

  function listen (key, callback) {
    if (typeof key === 'function') {
      changeListeners.push({ callback: key })
      return
    }
    callback(get(key))
    changeListeners.push({ callback, key })
  }

  function onError (callback) {
    errorListeners.push(callback)
  }

  function reportError (error) {
    errorListeners.forEach(callback => callback(error))
  }

  function set (key, value) {
    return Promise.resolve(host.set(key, clone(value))).then(function (result) {
      if (!result.ok) reportError(result.error)
      return result
    }, function (error) {
      const result = {
        ok: false,
        error: {
          code: error.code || 'SETTINGS_TRANSPORT_FAILED',
          message: error.message
        }
      }
      reportError(result.error)
      return result
    })
  }

  host.onChange(function (change) {
    if (change.value === undefined) delete values[change.key]
    else values[change.key] = clone(change.value)
    changeListeners.forEach(function (listener) {
      if (!listener.key || listener.key === change.key) {
        listener.callback(listener.key ? get(change.key) : change.key)
      }
    })
  })

  return {
    get,
    listen,
    onError,
    onLoad: callback => callback(),
    set,
    snapshot: () => clone(values)
  }
}

if (typeof module !== 'undefined') {
  module.exports = createSettingsCache
} else {
  window.createSettingsCache = createSettingsCache
}
