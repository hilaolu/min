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

test('App Runtime registers command palette lifecycle IPC once through its interface', function () {
  const app = createRecordingApp()
  const ipc = new EventEmitter()
  const commandPalette = {
    destroy: function () {},
    hide: function () {},
    init: function () {},
    show: function () {},
    update: function () {}
  }

  const runtime = createAppRuntime({
    buildAppMenu: function () {},
    buildTouchBar: function () {},
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
    overlayManager: null,
    path,
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
  const channels = [
    'initCommandPaletteOverlay',
    'showCommandPaletteOverlay',
    'hideCommandPaletteOverlay',
    'destroyCommandPaletteOverlay'
  ]
  channels.forEach(function (channel) {
    assert.equal(ipc.listenerCount(channel), 1, `${channel} should have one listener`)
  })
})
