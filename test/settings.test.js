const assert = require('node:assert/strict')
const EventEmitter = require('node:events')
const test = require('node:test')

const createSettings = require('../js/util/settings/settingsMain.js')
const createSettingsCache = require('../js/util/settings/settingsCache.js')

function createIPC () {
  const ipc = new EventEmitter()
  ipc.handlers = new Map()
  ipc.handle = function (channel, handler) {
    ipc.handlers.set(channel, handler)
  }
  return ipc
}

function createMemoryStorage (initialValue) {
  const writes = []
  return {
    writes,
    read: () => initialValue,
    write: async snapshot => { writes.push(snapshot) }
  }
}

test('Settings owns defaults and persists legacy migrations', async function () {
  const storage = createMemoryStorage(JSON.stringify({
    darkMode: true,
    filtering: { trackers: true }
  }))
  const settings = createSettings({ ipc: createIPC(), storage })

  const result = await settings.initialize('/unused')

  assert.deepEqual(result, { ok: true, migrated: true })
  assert.equal(settings.get('darkMode'), 1)
  assert.deepEqual(settings.get('filtering'), {
    blockingLevel: 2,
    contentTypes: [],
    exceptionDomains: []
  })
  assert.equal(settings.get('startupTabOption'), 2)
  assert.equal(settings.get('newWindowOption'), 1)
  assert.deepEqual(await settings.set('readerDayTheme', 'sepia'), { ok: true, revision: 1 })
  assert.equal(storage.writes.length, 2)
  assert.equal(Object.hasOwn(storage.writes[0].filtering, 'trackers'), false)
})

test('Settings connection returns values and their authoritative revision together', async function () {
  const ipc = createIPC()
  const settings = createSettings({ ipc, storage: createMemoryStorage('{}') })
  await settings.initialize('/unused')
  await settings.set('siteTheme', false)
  const event = {}

  ipc.emit('settings:connect', event)

  assert.equal(event.returnValue.revision, 1)
  assert.equal(event.returnValue.values.siteTheme, false)
})

test('Settings recovers from malformed files with validated defaults', async function () {
  const warnings = []
  const storage = createMemoryStorage('{not json')
  const settings = createSettings({
    ipc: createIPC(),
    storage,
    warn: (...args) => warnings.push(args)
  })

  const result = await settings.initialize('/unused')

  assert.equal(result.ok, true)
  assert.equal(settings.get('siteTheme'), true)
  assert.deepEqual(settings.get('proxy'), {})
  assert.equal(warnings.length, 1)
  assert.equal(storage.writes.length, 1)
})

test('Settings serializes durable changes, reports failures, and recovers its queue', async function () {
  const controlledWrites = []
  let controlWrites = false
  const storage = {
    read: () => '{}',
    write: function (snapshot) {
      if (!controlWrites) return Promise.resolve()
      return new Promise(function (resolve, reject) {
        controlledWrites.push({ reject, resolve, snapshot })
      })
    }
  }
  const sent = []
  const contents = {
    isDestroyed: () => false,
    send: (channel, change) => sent.push({ channel, change })
  }
  const settings = createSettings({
    getAllWebContents: () => [contents],
    ipc: createIPC(),
    storage
  })
  await settings.initialize('/unused')
  controlWrites = true

  const changes = []
  const errors = []
  settings.listen(key => changes.push(key))
  settings.onError(error => errors.push(error))

  const first = settings.set('siteTheme', false)
  const second = settings.set('startupTabOption', 3)
  await Promise.resolve()
  assert.equal(controlledWrites.length, 1)
  assert.equal(settings.get('siteTheme'), true)

  controlledWrites[0].resolve()
  await first
  await Promise.resolve()
  assert.equal(controlledWrites.length, 2)
  controlledWrites[1].reject(new Error('disk full'))

  assert.deepEqual(await second, {
    ok: false,
    error: { code: 'SETTINGS_PERSISTENCE_FAILED', message: 'disk full' }
  })
  assert.equal(settings.get('siteTheme'), false)
  assert.equal(settings.get('startupTabOption'), 2)

  const third = settings.set('smoothScrolling', false)
  await Promise.resolve()
  assert.equal(controlledWrites.length, 3)
  controlledWrites[2].resolve()
  assert.deepEqual(await third, { ok: true, revision: 2 })

  assert.deepEqual(changes, ['siteTheme', 'smoothScrolling'])
  assert.equal(errors[0].code, 'SETTINGS_PERSISTENCE_FAILED')
  assert.deepEqual(sent.map(item => item.change.revision), [1, 2])
})

test('Settings rejects unknown keys and invalid values before persistence', async function () {
  const storage = createMemoryStorage('{}')
  const settings = createSettings({ ipc: createIPC(), storage })
  await settings.initialize('/unused')
  const writesAfterInitialization = storage.writes.length

  assert.equal((await settings.set('notASetting', true)).error.code, 'UNKNOWN_SETTING')
  assert.equal((await settings.set('startupTabOption', 99)).error.code, 'INVALID_SETTING_VALUE')
  assert.equal(storage.writes.length, writesAfterInitialization)
})

test('Settings cache adapters share synchronous reads, durable writes, and change ordering', async function () {
  let applyChange
  const writes = []
  const cache = createSettingsCache({
    connect: callback => {
      applyChange = callback
      return { revision: 0, values: { proxy: {}, siteTheme: true } }
    },
    set: async (key, value) => {
      writes.push({ key, value })
      return { ok: true, revision: 1 }
    }
  })

  const proxy = cache.get('proxy')
  proxy.type = 1
  assert.deepEqual(cache.get('proxy'), {})

  const values = []
  const globalChanges = []
  cache.listen('siteTheme', value => values.push(value))
  cache.listen(key => globalChanges.push(key))
  assert.deepEqual(await cache.set('siteTheme', false), { ok: true, revision: 1 })
  assert.equal(cache.get('siteTheme'), true)

  applyChange({ key: 'siteTheme', revision: 1, value: false })
  assert.equal(cache.get('siteTheme'), false)
  assert.deepEqual(values, [true, false])
  assert.deepEqual(globalChanges, ['siteTheme'])
  assert.deepEqual(writes, [{ key: 'siteTheme', value: false }])
})

test('Settings connection closes the snapshot-subscription hydration gap', function () {
  const cache = createSettingsCache({
    connect: listener => {
      const snapshot = { revision: 1, values: { siteTheme: true } }
      listener({ key: 'siteTheme', revision: 2, value: false })
      return snapshot
    },
    set: () => Promise.resolve({ ok: true })
  })

  assert.equal(cache.get('siteTheme'), false)
})

test('Settings cache rejects invalid connection snapshots', function () {
  const createCache = values => createSettingsCache({
    connect: () => ({ revision: 0, values }),
    set: () => Promise.resolve({ ok: true })
  })

  assert.throws(() => createCache([]), /invalid snapshot/)
  assert.throws(() => createCache(null), /invalid snapshot/)
})

test('Settings cache ignores duplicate revisions and reports gaps', function () {
  let applyChange
  const cache = createSettingsCache({
    connect: callback => {
      applyChange = callback
      return { revision: 3, values: { siteTheme: true } }
    },
    set: () => Promise.resolve({ ok: true })
  })
  const errors = []
  cache.onError(error => errors.push(error))

  applyChange({ key: 'siteTheme', revision: 3, value: false })
  applyChange({ key: 'siteTheme', revision: 5, value: false })

  assert.equal(cache.get('siteTheme'), true)
  assert.equal(errors[0].code, 'SETTINGS_REVISION_GAP')
})

test('file Settings storage uses the atomic writer', async function () {
  const calls = []
  const storage = createSettings.createFileStorage({
    atomicWriter: function (filePath, data, options, callback) {
      calls.push({ data, filePath, options })
      callback()
    },
    filePath: '/tmp/min-settings-test.json',
    fs: { readFileSync: () => '{}' }
  })

  await storage.write({ siteTheme: true })

  assert.deepEqual(calls, [{
    data: '{"siteTheme":true}',
    filePath: '/tmp/min-settings-test.json',
    options: {}
  }])
})
