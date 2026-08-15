const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

function loadPlacesDatabase ({ openError } = {}) {
  const alerts = []
  const ipcMessages = []
  const requiredModules = []
  const versions = []

  class Dexie {
    version (number) {
      const version = { number }
      versions.push(version)
      return { stores: function (schema) { version.schema = schema } }
    }

    open () {
      return openError ? Promise.reject(openError) : Promise.resolve()
    }
  }

  const context = vm.createContext({
    console: { log: function () {} },
    Dexie,
    performance: { now: () => 0 },
    require: function (request) {
      requiredModules.push(request)
      if (request === 'electron') {
        return {
          ipcRenderer: {
            send: message => ipcMessages.push(message)
          }
        }
      }
      if (request === './databaseSchema.js') return require('../js/util/databaseSchema.js')
      throw new Error(`Cannot find module '${request}'`)
    },
    window: {
      alert: message => alerts.push(message)
    }
  })
  const source = fs.readFileSync(
    path.resolve(__dirname, '../js/util/database.js'),
    'utf8'
  )

  vm.runInContext(source, context, { filename: 'database.js' })

  return { alerts, context, ipcMessages, requiredModules, versions }
}

test('Places database loads with its purpose-specific hidden-renderer adapter', function () {
  const loaded = loadPlacesDatabase()

  assert.ok(loaded.context.db)
  assert.deepEqual(loaded.requiredModules, ['electron', './databaseSchema.js'])
  assert.deepEqual(loaded.versions.map(version => version.number), [1, 2])
  assert.equal(loaded.versions[1].schema.places, '++id, &url, visitCount, lastVisit, *searchIndex')
})

test('Places database requests application shutdown after a backing-store collision', async function () {
  const loaded = loadPlacesDatabase({
    openError: new Error('Internal error opening backing store for indexedDB.open')
  })

  await Promise.resolve()
  await Promise.resolve()

  assert.equal(loaded.alerts.length, 1)
  assert.deepEqual(loaded.ipcMessages, ['quit'])
})

test('Places schema migration preserves version-1 records while removing unused indexes', async function () {
  const Dexie = require('dexie')
  const { indexedDB, IDBKeyRange } = require('fake-indexeddb')
  Dexie.dependencies.indexedDB = indexedDB
  Dexie.dependencies.IDBKeyRange = IDBKeyRange
  await Dexie.delete('browsingData2')

  const fixture = new Dexie('browsingData2')
  fixture.version(1).stores({
    places: '++id, &url, title, color, visitCount, lastVisit, pageHTML, extractedText, *searchIndex, isBookmarked, *tags, metadata',
    readingList: 'url, time, visitCount, pageHTML, article, extraData'
  })
  await fixture.open()
  await fixture.places.add({
    url: 'https://example.com',
    title: 'Preserved bookmark',
    color: '#fff',
    visitCount: 7,
    lastVisit: 1234,
    pageHTML: '<body>legacy</body>',
    extractedText: 'searchable body',
    searchIndex: ['searchabl', 'bodi'],
    isBookmarked: true,
    tags: ['docs'],
    metadata: { source: 'fixture' }
  })
  fixture.close()

  const ipc = { send: function () {} }
  const context = vm.createContext({
    console: { log: function () {} },
    Dexie,
    module: { exports: {} },
    performance: { now: () => 0 },
    require: function (request) {
      if (request === 'electron') return { ipcRenderer: ipc }
      if (request === './databaseSchema.js') return require('../js/util/databaseSchema.js')
      return require(request)
    },
    window: { alert: function () {} }
  })
  const source = fs.readFileSync(path.resolve(__dirname, '../js/util/database.js'), 'utf8')
  vm.runInContext(source, context, { filename: 'database.js' })
  await context.db.open()

  const restored = await context.db.places.get({ url: 'https://example.com' })
  const indexes = context.db.places.schema.indexes.map(index => index.name).sort()
  const fullTextIds = await context.db.places.where('searchIndex').equals('searchabl').primaryKeys()

  assert.equal(restored.title, 'Preserved bookmark')
  assert.equal(restored.extractedText, 'searchable body')
  assert.equal(restored.isBookmarked, true)
  assert.deepEqual(restored.tags, ['docs'])
  assert.deepEqual(fullTextIds, [restored.id])
  assert.deepEqual(indexes, ['lastVisit', 'searchIndex', 'url', 'visitCount'])

  context.db.close()
  await Dexie.delete('browsingData2')
})
