const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

const initializeBrowsingDataSettings = require('../pages/settings/browsingData.js')

function createButton () {
  let clickListener
  return {
    disabled: false,
    addEventListener: function (event, listener) {
      if (event === 'click') clickListener = listener
    },
    click: function () {
      return clickListener()
    }
  }
}

test('Browsing Data setting confirms and reports successful cleanup', async function () {
  const button = createButton()
  const status = { textContent: '' }
  const calls = []
  let finishClearing

  initializeBrowsingDataSettings({
    button,
    confirm: function (message) {
      calls.push(['confirm', message])
      return true
    },
    host: {
      clearBrowsingData: function () {
        calls.push(['clear'])
        return new Promise(function (resolve) {
          finishClearing = resolve
        })
      }
    },
    status
  })

  const clearing = button.click()

  assert.equal(button.disabled, true)
  assert.equal(status.textContent, 'Clearing browsing data…')
  assert.match(calls[0][1], /cookies, site storage, and caches/i)
  assert.deepEqual(calls.slice(1), [['clear']])

  finishClearing()
  await clearing

  assert.equal(button.disabled, false)
  assert.equal(status.textContent, 'Browsing data cleared.')
})

test('Browsing Data setting leaves data intact when confirmation is canceled', async function () {
  const button = createButton()
  const status = { textContent: '' }
  let clearCalls = 0

  initializeBrowsingDataSettings({
    button,
    confirm: () => false,
    host: {
      clearBrowsingData: function () {
        clearCalls++
      }
    },
    status
  })

  await button.click()

  assert.equal(clearCalls, 0)
  assert.equal(button.disabled, false)
  assert.equal(status.textContent, '')
})

test('Browsing Data setting reports cleanup failures and restores the button', async function () {
  const button = createButton()
  const status = { textContent: '' }
  const errors = []

  initializeBrowsingDataSettings({
    button,
    confirm: () => true,
    host: {
      clearBrowsingData: function () {
        return Promise.resolve({
          ok: false,
          error: { message: 'cleanup failed' }
        })
      }
    },
    logger: { error: (...args) => errors.push(args) },
    status
  })

  await button.click()

  assert.equal(button.disabled, false)
  assert.equal(status.textContent, 'Could not clear browsing data. Try again.')
  assert.equal(errors.length, 1)
  assert.match(errors[0][1].message, /cleanup failed/)
})

test('Settings page includes the Browsing Data controls and controller', function () {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../pages/settings/index.html'),
    'utf8'
  )

  assert.match(source, /id="clear-browsing-data"/)
  assert.match(source, /id="clear-browsing-data-status"/)
  assert.match(source, /aria-describedby="clear-browsing-data-description"/)
  assert.match(source, /<script src="browsingData\.js"><\/script>/)
})

function loadSettingsHost (href) {
  const invocations = []
  let exposedHost
  const ipc = {
    invoke: function (channel, payload) {
      invocations.push([channel, payload])
      return Promise.resolve()
    },
    on: function () {},
    sendSync: function () {
      return { revision: 0, values: {} }
    }
  }
  const context = vm.createContext({
    Promise,
    require: function (request) {
      assert.equal(request, 'electron')
      return {
        contextBridge: {
          exposeInMainWorld: function (name, host) {
            assert.equal(name, 'settingsHost')
            exposedHost = host
          }
        },
        ipcRenderer: ipc
      }
    },
    window: { location: { href } }
  })
  const source = fs.readFileSync(
    path.resolve(__dirname, '../js/util/settings/settingsPreload.js'),
    'utf8'
  )

  vm.runInContext(source, context, { filename: 'settingsPreload.js' })
  return { host: exposedHost, invocations }
}

test('Settings host exposes browsing-data cleanup only to the Settings page', async function () {
  const internal = loadSettingsHost('min://app/pages/settings/index.html')

  await internal.host.clearBrowsingData()

  assert.deepEqual(internal.invocations, [['clearStorageData', undefined]])

  const external = loadSettingsHost('https://example.com/')
  const denied = await external.host.clearBrowsingData()

  assert.equal(denied.ok, false)
  assert.equal(denied.error.code, 'BROWSING_DATA_ORIGIN_DENIED')
  assert.deepEqual(external.invocations, [])
})
