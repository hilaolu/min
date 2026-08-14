const path = require('path')
const writeFileAtomic = require('write-file-atomic')

const schema = {
  PDFInvertColors: { default: false, validate: value => typeof value === 'boolean' },
  clientID: { optional: true, validate: value => typeof value === 'string' },
  collectUsageStats: { default: true, validate: value => typeof value === 'boolean' },
  customBangs: { default: [], validate: Array.isArray },
  customUserAgent: { default: null, validate: value => value === null || typeof value === 'string' },
  darkMode: { default: 2, validate: value => [-1, 0, 1, 2].includes(value) },
  darkThemeIsActive: { optional: true, validate: value => typeof value === 'boolean' },
  enableAutoplay: { default: false, validate: value => typeof value === 'boolean' },
  enableQUIC: { default: false, validate: value => typeof value === 'boolean' },
  filtering: {
    default: { blockingLevel: 1, contentTypes: [], exceptionDomains: [] },
    validate: value => isPlainObject(value) &&
      [0, 1, 2].includes(value.blockingLevel) &&
      Array.isArray(value.contentTypes) &&
      value.contentTypes.every(type => ['image', 'script'].includes(type)) &&
      Array.isArray(value.exceptionDomains) &&
      value.exceptionDomains.every(domain => typeof domain === 'string')
  },
  filteringBlockedCount: { default: 0, validate: value => Number.isFinite(value) && value >= 0 },
  installTime: { optional: true, validate: value => Number.isFinite(value) },
  keyMap: { default: {}, validate: isPlainObject },
  lastBookmarksBackup: { optional: true, validate: value => Number.isFinite(value) },
  newWindowOption: { default: 1, validate: value => [1, 2].includes(value) },
  openTabsInForeground: { default: false, validate: value => typeof value === 'boolean' },
  pdfDayTheme: { optional: true, validate: isTheme },
  pdfNightTheme: { optional: true, validate: isTheme },
  proxy: { default: {}, validate: isPlainObject },
  readerData: { optional: true, validate: value => typeof value === 'string' },
  readerDayTheme: { optional: true, validate: isTheme },
  readerNightTheme: { optional: true, validate: isTheme },
  restartNow: { default: false, validate: value => typeof value === 'boolean' },
  searchEngine: { default: { name: 'DuckDuckGo' }, validate: isPlainObject },
  showDividerBetweenTabs: { default: false, validate: value => typeof value === 'boolean' },
  siteTheme: { default: true, validate: value => typeof value === 'boolean' },
  smoothScrolling: { default: true, validate: value => typeof value === 'boolean' },
  startupTabOption: { default: 2, validate: value => [1, 2, 3].includes(value) },
  updateNotificationsEnabled: { default: true, validate: value => typeof value === 'boolean' },
  usageData: { optional: true, validate: value => value === null || isPlainObject(value) },
  useSeparateTitlebar: { default: false, validate: value => typeof value === 'boolean' },
  userscriptsEnabled: { default: false, validate: value => typeof value === 'boolean' },
  windowAlwaysOnTop: { default: false, validate: value => typeof value === 'boolean' }
}

function isPlainObject (value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isTheme (value) {
  return ['dark', 'light', 'sepia'].includes(value)
}

function clone (value) {
  if (value === undefined) return undefined
  return JSON.parse(JSON.stringify(value))
}

function errorResult (code, message) {
  return { ok: false, error: { code, message } }
}

function migrate (rawSettings) {
  const migrated = { ...rawSettings }

  if (typeof migrated.darkMode === 'boolean') {
    migrated.darkMode = migrated.darkMode ? 1 : 2
  }

  if (isPlainObject(migrated.filtering)) {
    const filtering = {
      blockingLevel: 1,
      contentTypes: [],
      exceptionDomains: [],
      ...migrated.filtering
    }
    if (typeof filtering.trackers === 'boolean') {
      filtering.blockingLevel = filtering.trackers ? 2 : 0
      delete filtering.trackers
    }
    migrated.filtering = filtering
  }

  return migrated
}

function normalize (rawSettings) {
  const migrated = migrate(isPlainObject(rawSettings) ? rawSettings : {})
  const normalized = {}

  Object.keys(schema).forEach(function (key) {
    const definition = schema[key]
    const value = migrated[key]
    if (value !== undefined && definition.validate(value)) {
      normalized[key] = clone(value)
    } else if (Object.hasOwn(definition, 'default')) {
      normalized[key] = clone(definition.default)
    }
  })

  return normalized
}

function createFileStorage ({ filePath, fs, atomicWriter = writeFileAtomic }) {
  return {
    read: function () {
      return fs.readFileSync(filePath, 'utf8')
    },
    write: function (snapshot) {
      return new Promise(function (resolve, reject) {
        atomicWriter(filePath, JSON.stringify(snapshot), {}, function (error) {
          if (error) reject(error)
          else resolve()
        })
      })
    }
  }
}

function createSettings ({ fs, getAllWebContents, ipc, storage, warn = console.warn }) {
  let values = normalize({})
  let persistenceQueue = Promise.resolve()
  let initialized = false
  let revision = 0
  const changeListeners = []
  const errorListeners = []

  function get (key) {
    return clone(values[key])
  }

  function snapshot () {
    return clone(values)
  }

  function runChangeCallbacks (key, value) {
    changeListeners.forEach(function (listener) {
      if (!listener.key || listener.key === key) {
        listener.cb(listener.key ? clone(value) : key)
      }
    })
  }

  function runErrorCallbacks (error) {
    errorListeners.forEach(listener => listener(error))
  }

  function listen (key, cb) {
    if (typeof key === 'function') {
      changeListeners.push({ cb: key })
      return
    }
    cb(get(key))
    changeListeners.push({ key, cb })
  }

  function onError (listener) {
    errorListeners.push(listener)
  }

  function broadcast (change) {
    if (!getAllWebContents) return
    getAllWebContents().forEach(function (contents) {
      if (!contents.isDestroyed || !contents.isDestroyed()) {
        contents.send('settings:changed', clone(change))
      }
    })
  }

  function queueWrite (operation) {
    const write = persistenceQueue.then(operation)
    persistenceQueue = write.catch(function () {})
    return write
  }

  function set (key, value) {
    const definition = schema[key]
    if (!definition) {
      const result = errorResult('UNKNOWN_SETTING', `Unsupported setting: ${key}`)
      runErrorCallbacks(result.error)
      return Promise.resolve(result)
    }

    if (value === undefined && !definition.optional) {
      const result = errorResult('INVALID_SETTING_VALUE', `Invalid value for setting: ${key}`)
      runErrorCallbacks(result.error)
      return Promise.resolve(result)
    }
    if (value !== undefined && !definition.validate(value)) {
      const result = errorResult('INVALID_SETTING_VALUE', `Invalid value for setting: ${key}`)
      runErrorCallbacks(result.error)
      return Promise.resolve(result)
    }

    const nextValue = clone(value)
    return queueWrite(async function () {
      const nextValues = snapshot()
      if (nextValue === undefined) delete nextValues[key]
      else nextValues[key] = nextValue
      await storage.write(nextValues)
      values = nextValues
      revision++
      runChangeCallbacks(key, nextValue)
      broadcast({ key, revision, value: nextValue })
      return { ok: true, revision }
    }).catch(function (error) {
      const result = errorResult('SETTINGS_PERSISTENCE_FAILED', error.message)
      runErrorCallbacks(result.error)
      return result
    })
  }

  function installIPC () {
    ipc.on('settings:get-snapshot', function (event) {
      event.returnValue = snapshot()
    })
    ipc.handle('settings:set', function (event, request) {
      if (!request || typeof request.key !== 'string') {
        return errorResult('INVALID_SETTINGS_REQUEST', 'A setting key is required')
      }
      return set(request.key, request.value)
    })
  }

  function initialize (userDataPath) {
    if (initialized) return Promise.resolve({ ok: true })
    initialized = true
    storage = storage || createFileStorage({
      filePath: path.join(userDataPath, 'settings.json'),
      fs
    })

    let rawSettings = {}
    let shouldPersist = false
    try {
      const fileData = storage.read()
      if (fileData) rawSettings = JSON.parse(fileData)
    } catch (error) {
      if (error.code !== 'ENOENT') {
        warn('Error reading settings file:', error)
      }
      shouldPersist = error.code !== 'ENOENT'
    }

    values = normalize(rawSettings)
    shouldPersist = shouldPersist || JSON.stringify(values) !== JSON.stringify(rawSettings)
    installIPC()

    if (!shouldPersist) return Promise.resolve({ ok: true })
    return queueWrite(() => storage.write(snapshot())).then(function () {
      return { ok: true, migrated: true }
    }).catch(function (error) {
      const result = errorResult('SETTINGS_PERSISTENCE_FAILED', error.message)
      runErrorCallbacks(result.error)
      return result
    })
  }

  return { get, initialize, listen, onError, set, snapshot }
}

createSettings.createFileStorage = createFileStorage

module.exports = createSettings
