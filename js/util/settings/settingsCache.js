function clone (value) {
  if (value === undefined) return undefined
  return JSON.parse(JSON.stringify(value))
}

function createSettingsCache (host) {
  const changeListeners = []
  const errorListeners = []
  const pendingChanges = []
  let connected = false
  let revision = 0
  let values = {}

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

  function applyChange (change) {
    if (!change || !Number.isInteger(change.revision) || typeof change.key !== 'string') {
      reportError({
        code: 'INVALID_SETTINGS_CHANGE',
        message: 'Settings received an invalid change'
      })
      return
    }
    if (change.revision <= revision) return
    if (change.revision !== revision + 1) {
      reportError({
        code: 'SETTINGS_REVISION_GAP',
        message: `Settings expected revision ${revision + 1} but received ${change.revision}`
      })
      return
    }

    revision = change.revision
    if (change.value === undefined) delete values[change.key]
    else values[change.key] = clone(change.value)
    changeListeners.forEach(function (listener) {
      if (!listener.key || listener.key === change.key) {
        listener.callback(listener.key ? get(change.key) : change.key)
      }
    })
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

  const connection = host.connect(function (change) {
    if (connected) applyChange(change)
    else pendingChanges.push(change)
  })
  if (!connection || !Number.isInteger(connection.revision) || connection.revision < 0 || !connection.values || typeof connection.values !== 'object' || Array.isArray(connection.values)) {
    throw new Error('Settings connection returned an invalid snapshot')
  }
  revision = connection.revision
  values = clone(connection.values)
  connected = true
  pendingChanges.forEach(applyChange)

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
