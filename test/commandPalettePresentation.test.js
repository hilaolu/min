const assert = require('node:assert/strict')
const EventEmitter = require('node:events')
const test = require('node:test')

const createCommandPalettePresentation = require('../main/commandPaletteOverlay.js')

class RecordingContents extends EventEmitter {
  constructor () {
    super()
    this.destroyed = false
    this.messages = []
  }

  destroy () { this.destroyed = true }
  isDestroyed () { return this.destroyed }
  loadURL (url) { this.url = url }
  send (channel, state) { this.messages.push({ channel, state }) }
  setIgnoreMenuShortcuts (value) { this.ignoreMenuShortcuts = value }
}

class RecordingView {
  constructor (options) {
    this.options = options
    this.webContents = new RecordingContents()
  }

  setBounds (bounds) { this.bounds = bounds }
}

function createWindow (width = 1000, height = 800) {
  return {
    chromeFocusCount: 0,
    chromeMessages: [],
    destroyed: false,
    focusCount: 0,
    focus: function () { this.focusCount++ },
    getContentBounds: () => ({ width, height }),
    isDestroyed: function () { return this.destroyed },
    isVisible: () => true
  }
}

function createHarness () {
  const senderA = { id: 'sender-a' }
  const senderB = { id: 'sender-b' }
  const windowA = createWindow()
  const windowB = createWindow(500, 300)
  const records = new Map([
    [senderA, { win: windowA }],
    [senderB, { win: windowB }]
  ])
  const attached = new Map()
  const timers = []
  let createdView
  class View extends RecordingView {
    constructor (options) {
      super(options)
      createdView = this
    }
  }
  const windows = {
    attachOverlay: function (id, view, window) {
      attached.set(id, { view, window })
      return true
    },
    detachOverlay: id => attached.delete(id),
    isOverlayAttached: (id, view) => attached.get(id)?.view === view,
    windowFromContents: contents => records.get(contents)
  }
  const presentation = createCommandPalettePresentation({
    WebContentsView: View,
    getWindowWebContents: window => ({
      focus: () => { window.chromeFocusCount++ },
      send: channel => { window.chromeMessages.push(channel) }
    }),
    pageURL: 'min://app/pages/commandPalette/overlay.html',
    preloadPath: '/app/main/commandPalettePreload.js',
    schedule: callback => { timers.push(callback) },
    windows
  })

  return {
    attached,
    getView: () => createdView,
    presentation,
    senderA,
    senderB,
    timers,
    windowA,
    windowB
  }
}

test('Command Palette presentation coalesces readiness and sends one structured state', function () {
  const harness = createHarness()
  const first = harness.presentation.present(harness.senderA, {
    visible: true,
    input: '>',
    candidates: [{ id: 7, title: 'Open', description: 'Open URL' }],
    selectedIndex: 0
  })
  const view = harness.getView()

  assert.deepEqual(first, { ok: true })
  assert.equal(view.webContents.messages.length, 0)
  assert.equal(harness.attached.get('command-palette').window, harness.windowA)

  harness.presentation.present(harness.senderA, {
    visible: true,
    input: '>o',
    candidates: [{ id: 7, title: 'Open' }],
    selectedIndex: 8
  })
  view.webContents.emit('did-finish-load')

  assert.equal(view.webContents.messages.length, 1)
  assert.equal(view.webContents.messages[0].channel, 'command-palette:state')
  assert.deepEqual(view.webContents.messages[0].state, {
    visible: true,
    open: false,
    input: '>o',
    candidates: [{
      id: '7',
      title: 'Open',
      description: '',
      icon: 'carbon:search',
      shortcut: '',
      displayData: {}
    }],
    selectedIndex: 0
  })

  assert.equal(harness.timers.length, 1)
  harness.timers[0]()
  assert.equal(harness.windowA.chromeFocusCount, 1)
  assert.equal(harness.windowA.focusCount, 1)
  assert.deepEqual(harness.windowA.chromeMessages, ['command-palette:focus-input'])
})

test('Command Palette presentation owns visibility, routing, layout, and teardown', function () {
  const harness = createHarness()
  harness.presentation.present(harness.senderA, { visible: true })
  const view = harness.getView()
  view.webContents.emit('did-finish-load')

  assert.equal(harness.presentation.present(harness.senderB, { visible: false }).error.code, 'COMMAND_PALETTE_NOT_OWNER')
  assert.equal(harness.presentation.present(harness.senderB, { visible: true }).error.code, 'COMMAND_PALETTE_NOT_OWNER')
  assert.deepEqual(harness.presentation.present(harness.senderB, { open: true, visible: true }), { ok: true })
  assert.deepEqual(view.bounds, { x: 0, y: 20, width: 500, height: 260 })
  assert.equal(harness.presentation.present(harness.senderA, { visible: true }).error.code, 'COMMAND_PALETTE_NOT_OWNER')
  assert.equal(harness.presentation.present(harness.senderA, { visible: false }).error.code, 'COMMAND_PALETTE_NOT_OWNER')
  view.webContents.emit('did-finish-load')
  assert.equal(view.webContents.messages[view.webContents.messages.length - 1].state.visible, true)
  assert.deepEqual(harness.presentation.present(harness.senderB, { visible: false }), { ok: true })
  assert.equal(harness.attached.size, 0)

  harness.presentation.destroy()
  assert.equal(view.webContents.destroyed, true)
})
