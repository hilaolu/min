const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

function loadPlacesDatabase ({ openError } = {}) {
  const alerts = []
  const ipcMessages = []
  const requiredModules = []

  class Dexie {
    version () {
      return { stores: function () {} }
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

  return { alerts, context, ipcMessages, requiredModules }
}

test('Places database loads with its purpose-specific hidden-renderer adapter', function () {
  const loaded = loadPlacesDatabase()

  assert.ok(loaded.context.db)
  assert.deepEqual(loaded.requiredModules, ['electron'])
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
