const assert = require('node:assert/strict')
const EventEmitter = require('node:events')
const path = require('node:path')
const test = require('node:test')

const createAppRuntime = require('../main/main.js')

function createRecordingApp () {
  const app = new EventEmitter()
  app.commandLine = { appendSwitch: function () {} }
  app.getName = () => 'Min'
  app.getPath = () => '/tmp/min-test'
  app.getVersion = () => 'test'
  app.quit = function () {}
  app.requestSingleInstanceLock = () => true
  return app
}

test('App Runtime routes structured command palette state through one interface', function () {
  const app = createRecordingApp()
  const ipc = new EventEmitter()
  const handlers = new Map()
  ipc.handle = (channel, handler) => handlers.set(channel, handler)
  const calls = []
  const commandPalette = {
    present: function (sender, state) {
      calls.push({ sender, state })
      return { ok: true }
    }
  }

  const runtime = createAppRuntime({
    buildAppMenu: function () {},
    commandPalette,
    createDockMenu: function () {},
    electron: {
      app,
      BaseWindow: function () {},
      BrowserWindow: function () {},
      crashReporter: { start: function () {} },
      ipcMain: ipc,
      Menu: { setApplicationMenu: function () {} },
      session: { defaultSession: {} },
      WebContentsView: function () {}
    },
    fs: {},
    installSessionPolicies: function () {},
    installThemePolicy: function () {},
    path,
    places: {
      connect: function () {},
      destroy: function () {},
      getWindow: function () {},
      initialize: function () {}
    },
    registryInstaller: {},
    rootDir: '/tmp/min-test',
    settings: { get: function () {} },
    windows: {
      getAll: () => [],
      getCurrent: function () {},
      windowFromContents: function () {}
    }
  })

  assert.equal(runtime.isPrimaryInstance, true)
  assert.deepEqual(Array.from(handlers.keys()), ['command-palette:present'])
  const sender = { id: 3 }
  const state = { visible: true, input: '>', candidates: [], selectedIndex: 0 }
  assert.deepEqual(handlers.get('command-palette:present')({ sender }, state), { ok: true })
  assert.deepEqual(calls, [{ sender, state }])
})
