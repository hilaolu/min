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

  destroy () { this.destroyed = true; this.emit('destroyed') }
  isDestroyed () { return this.destroyed }
  loadURL (url) { this.url = url }
  send (channel, state) { this.messages.push({ channel, state }) }
  setIgnoreMenuShortcuts (value) { this.ignoreMenuShortcuts = value }
}

class RecordingView {
  constructor (options) {
    this.options = options
    this.webContents = new RecordingContents()
    // Electron clears this property when the WebContents dies.
    this.webContents.once('destroyed', () => { this.webContents = null })
  }

  setBounds (bounds) { this.bounds = bounds }
}

function createWindow (width = 1000, height = 800) {
  return Object.assign(new EventEmitter(), {
    chromeFocusCount: 0,
    destroyed: false,
    focusCount: 0,
    focus: function () { this.focusCount++ },
    getContentBounds: () => ({ width, height }),
    isDestroyed: function () { return this.destroyed },
    isVisible: () => true
  })
}

function createHarness () {
  let now = 0
  let nextTimer = 0
  const timers = new Map()
  function advance (milliseconds) {
    now += milliseconds
    for (const [id, timer] of timers) {
      if (timer.at <= now) {
        timers.delete(id)
        timer.callback()
      }
    }
  }
  const senderA = { id: 'sender-a' }
  const senderB = { id: 'sender-b' }
  const windowA = createWindow()
  const windowB = createWindow(500, 300)
  const records = new Map([
    [senderA, { win: windowA }],
    [senderB, { win: windowB }]
  ])
  const attached = new Map()
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
      focus: () => { window.chromeFocusCount++ }
    }),
    pageURL: 'min://app/pages/commandPalette/overlay.html',
    preloadPath: '/app/main/commandPalettePreload.js',
    schedule: (callback, delay) => {
      const id = ++nextTimer
      timers.set(id, { callback, at: now + delay })
      return id
    },
    cancelSchedule: id => timers.delete(id),
    windows
  })

  return {
    attached,
    advance,
    getView: () => createdView,
    presentation,
    senderA,
    senderB,
    timers,
    windowA,
    windowB,
    windows
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
  // Focus must not wait for a timer or overlay readiness: the next key may
  // arrive before either of those completes.
  assert.equal(harness.windowA.chromeFocusCount, 1)
  assert.equal(harness.windowA.focusCount, 1)

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

  // Updating candidates must not steal focus again.
  assert.equal(harness.windowA.chromeFocusCount, 1)
  assert.equal(harness.windowA.focusCount, 1)
})

test('Command Palette presentation owns visibility, routing, layout, and teardown', function () {
  const harness = createHarness()
  harness.presentation.present(harness.senderA, { visible: true })
  const view = harness.getView()
  view.webContents.emit('did-finish-load')

  assert.equal(harness.presentation.present(harness.senderB, { visible: false }).error.code, 'COMMAND_PALETTE_NOT_OWNER')
  assert.equal(harness.presentation.present(harness.senderB, { visible: true }).error.code, 'COMMAND_PALETTE_NOT_OWNER')
  assert.deepEqual(harness.presentation.present(harness.senderB, { open: true, visible: true }), { ok: true })
  assert.equal(harness.windowA.chromeFocusCount, 1)
  assert.equal(harness.windowB.chromeFocusCount, 1)
  assert.deepEqual(view.bounds, { x: 0, y: 20, width: 500, height: 260 })
  assert.equal(harness.presentation.present(harness.senderA, { visible: true }).error.code, 'COMMAND_PALETTE_NOT_OWNER')
  assert.equal(harness.presentation.present(harness.senderA, { visible: false }).error.code, 'COMMAND_PALETTE_NOT_OWNER')
  view.webContents.emit('did-finish-load')
  assert.equal(view.webContents.messages[view.webContents.messages.length - 1].state.visible, true)
  assert.deepEqual(harness.presentation.present(harness.senderB, { visible: false }), { ok: true })
  assert.equal(harness.attached.size, 0)
  assert.equal(harness.windowB.chromeFocusCount, 1)

  const contents = view.webContents
  harness.presentation.destroy()
  assert.equal(contents.destroyed, true)
})

test('hidden Command Palette is retired after 30 seconds, not on every close', function () {
  const harness = createHarness()
  harness.presentation.present(harness.senderA, { visible: false })
  assert.equal(harness.getView(), undefined)
  assert.equal(harness.timers.size, 0)

  harness.presentation.present(harness.senderA, { visible: true })
  const contents = harness.getView().webContents
  harness.advance(60000)
  assert.equal(contents.isDestroyed(), false, 'a visible palette must not expire')
  harness.presentation.present(harness.senderA, { visible: false })
  assert.equal(harness.attached.size, 0)
  assert.equal(harness.timers.size, 1)
  harness.advance(29999)
  assert.equal(contents.isDestroyed(), false)
  harness.presentation.present(harness.senderA, { visible: false })
  harness.advance(1)
  assert.equal(contents.isDestroyed(), true, 'redundant hide must not postpone retirement')
  assert.equal(harness.timers.size, 0)
  assert.equal(harness.presentation.recenter(), false)
})

test('quick reopen reuses Command Palette content and cancels the old idle deadline', function () {
  const harness = createHarness()
  harness.presentation.present(harness.senderA, { visible: true })
  const view = harness.getView()
  const contents = view.webContents
  for (let cycle = 0; cycle < 3; cycle++) {
    harness.presentation.present(harness.senderA, { visible: false })
    harness.advance(20000)
    harness.presentation.present(harness.senderA, { visible: true })
    assert.equal(harness.getView(), view)
    assert.equal(harness.timers.size, 0)
    harness.advance(20000)
    assert.equal(contents.isDestroyed(), false)
  }
  harness.presentation.present(harness.senderA, { visible: false })
  harness.advance(29999)
  assert.equal(contents.isDestroyed(), false)
  harness.advance(1)
  assert.equal(contents.isDestroyed(), true)
})

test('hidden presentation drops payloads and obsolete loads cannot ready a replacement view', function () {
  const harness = createHarness()
  harness.presentation.present(harness.senderA, { visible: true })
  const oldView = harness.getView()
  const oldContents = oldView.webContents
  harness.presentation.present(harness.senderA, {
    visible: false,
    input: 'old query',
    candidates: [{ title: 'old result', displayData: { history: ['old output'] } }]
  })
  oldContents.emit('did-finish-load')
  assert.deepEqual(oldContents.messages[0].state, {
    visible: false, open: false, input: '', candidates: [], selectedIndex: 0
  })
  harness.advance(30000)
  assert.equal(oldContents.isDestroyed(), true)

  harness.presentation.present(harness.senderA, { visible: true, input: 'new query', candidates: [{ title: 'new result' }] })
  const newView = harness.getView()
  assert.notEqual(newView, oldView)
  oldContents.emit('did-finish-load')
  assert.equal(newView.webContents.messages.length, 0)
  newView.webContents.emit('did-finish-load')
  assert.equal(newView.webContents.messages.length, 1)
  assert.equal(newView.webContents.messages[0].state.input, 'new query')
  assert.equal(newView.webContents.messages[0].state.candidates[0].title, 'new result')
  assert.equal(harness.windowA.chromeFocusCount, 2)
  harness.presentation.destroy()
})

test('Command Palette follows its current owner and releases closed-window listeners', function () {
  const harness = createHarness()
  harness.presentation.present(harness.senderA, { visible: true })
  const contents = harness.getView().webContents
  assert.equal(harness.windowA.listenerCount('closed'), 1)
  harness.windowA.emit('close') // A canceled close is not final.
  assert.equal(contents.isDestroyed(), false)
  harness.presentation.present(harness.senderB, { open: true, visible: true })
  assert.equal(harness.windowA.listenerCount('closed'), 0)
  assert.equal(harness.windowB.listenerCount('closed'), 1)
  harness.windowA.emit('closed')
  assert.equal(contents.isDestroyed(), false)
  harness.windowB.emit('closed')
  assert.equal(contents.isDestroyed(), true)
  assert.equal(harness.windowB.listenerCount('closed'), 0)
  assert.equal(harness.attached.size, 0)
  assert.equal(harness.timers.size, 0)
})

test('failed attachment retires an unused view without disturbing a different owner', function () {
  const harness = createHarness()
  const attach = harness.windows.attachOverlay
  harness.windows.attachOverlay = () => false
  assert.equal(harness.presentation.present(harness.senderA, { visible: true }).error.code, 'COMMAND_PALETTE_ATTACH_FAILED')
  const unusedContents = harness.getView().webContents
  harness.advance(30000)
  assert.equal(unusedContents.isDestroyed(), true)

  harness.windows.attachOverlay = attach
  harness.presentation.present(harness.senderA, { visible: true })
  const ownedContents = harness.getView().webContents
  harness.windows.attachOverlay = () => false
  assert.equal(harness.presentation.present(harness.senderB, { open: true, visible: true }).error.code, 'COMMAND_PALETTE_ATTACH_FAILED')
  assert.equal(harness.windowA.listenerCount('closed'), 1)
  assert.equal(harness.windowB.listenerCount('closed'), 0)
  harness.advance(60000)
  assert.equal(ownedContents.isDestroyed(), false)
  harness.presentation.destroy()
})

test('explicit Command Palette teardown cancels retirement and permits a fresh presentation', function () {
  const harness = createHarness()
  harness.presentation.present(harness.senderA, { visible: true })
  const oldView = harness.getView()
  const contents = oldView.webContents
  harness.presentation.present(harness.senderA, { visible: false })
  assert.equal(harness.windowA.listenerCount('closed'), 0)
  assert.equal(harness.timers.size, 1)
  harness.presentation.destroy()
  harness.presentation.destroy()
  assert.equal(contents.isDestroyed(), true)
  assert.equal(harness.timers.size, 0)
  harness.presentation.present(harness.senderA, { visible: true, input: 'fresh' })
  assert.notEqual(harness.getView(), oldView)
  harness.advance(60000)
  assert.equal(harness.getView().webContents.isDestroyed(), false)
  harness.presentation.destroy()
})
