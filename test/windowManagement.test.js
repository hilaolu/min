const assert = require('node:assert/strict')
const EventEmitter = require('node:events')
const path = require('node:path')
const test = require('node:test')

const createBrowserWindows = require('../main/windowManagement.js')

let nextContentsId = 1

class RecordingWebContents extends EventEmitter {
  constructor () {
    super()
    this.id = nextContentsId++
    this.destroyCount = 0
    this.messages = []
    this.loading = false
  }

  destroy () {
    this.destroyCount++
  }

  focus () {}

  isLoadingMainFrame () {
    return this.loading
  }

  loadURL (url) {
    this.url = url
  }

  send (channel, data) {
    this.messages.push({ channel, data })
  }
}

class RecordingView {
  constructor (options = {}) {
    this.options = options
    this.webContents = new RecordingWebContents()
  }

  setBounds (bounds) {
    this.bounds = bounds
  }
}

class RecordingContentView {
  constructor () {
    this.added = []
    this.children = []
    this.removed = []
  }

  addChildView (view) {
    if (!this.children.includes(view)) {
      this.children.push(view)
    }
    this.added.push(view)
  }

  removeChildView (view) {
    const index = this.children.indexOf(view)
    if (index !== -1) {
      this.children.splice(index, 1)
    }
    this.removed.push(view)
  }
}

class RecordingWindow extends EventEmitter {
  constructor (options) {
    super()
    this.options = options
    this.contentView = new RecordingContentView()
    this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height }
    this.destroyed = false
    this.focused = false
    this.maximized = false
    this.minimized = false
  }

  static getFocusedWindow () {
    return RecordingWindow.focusedWindow || null
  }

  focus () {
    this.focused = true
    RecordingWindow.focusedWindow = this
  }

  getBounds () {
    return { ...this.bounds }
  }

  getContentBounds () {
    return { width: this.bounds.width, height: this.bounds.height }
  }

  getContentView () {
    return this.contentView
  }

  isDestroyed () {
    return this.destroyed
  }

  isFocused () {
    return this.focused
  }

  isMaximized () {
    return this.maximized
  }

  isMinimized () {
    return this.minimized
  }

  maximize () {
    this.maximized = true
  }

  setMenuBarVisibility () {}

  setTouchBar () {}
}

function createRecordingBrowserWindows () {
  const boundsToRead = []
  const writes = []
  let cleanupCount = 0
  let quitCount = 0
  const windows = createBrowserWindows({
    app: {
      getName: () => 'Min',
      getVersion: () => 'test',
      quit: () => { quitCount++ }
    },
    BaseWindow: RecordingWindow,
    browserPage: 'min://app/index.html',
    buildTouchBar: () => null,
    fs: {
      readFileSync: () => {
        if (boundsToRead.length === 0) {
          throw new Error('missing')
        }
        return JSON.stringify(boundsToRead.shift())
      },
      writeFileSync: (filename, data) => writes.push({ filename, data: JSON.parse(data) })
    },
    getSetting: () => false,
    isDevelopmentMode: false,
    onAllWindowsClosed: () => { cleanupCount++ },
    onRecenterOverlay: () => {},
    path,
    platform: 'linux',
    rootDir: '/tmp/min-test',
    screen: {
      getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1600, height: 900 } }),
      getPrimaryDisplay: () => ({ workAreaSize: { width: 1600, height: 900 } })
    },
    setTimeout: callback => callback(),
    userDataPath: '/tmp/min-test',
    WebContentsView: RecordingView
  })

  return {
    getCleanupCount: () => cleanupCount,
    getQuitCount: () => quitCount,
    boundsToRead,
    windows,
    writes
  }
}

function createWithBounds (recording, x) {
  recording.boundsToRead.push({ x, y: 20, width: 800, height: 600, maximized: false })
  return recording.windows.create()
}

test('Browser Window Module owns construction, focus, lookup, and final cleanup', function () {
  const recording = createRecordingBrowserWindows()
  const first = createWithBounds(recording, 10)
  const second = createWithBounds(recording, 30)

  first.focus()
  first.emit('focus')

  assert.equal(recording.windows.getCurrent(), first)
  assert.equal(recording.windows.windowFromContents(recording.windows.getChromeContents(first)).win, first)
  assert.deepEqual(recording.windows.getAll(), [first, second])

  first.emit('close')
  first.emit('closed')
  assert.deepEqual(recording.windows.getAll(), [second])
  assert.equal(recording.getCleanupCount(), 0)

  second.emit('close')
  second.emit('closed')
  second.emit('closed')

  assert.equal(recording.getCleanupCount(), 1)
  assert.equal(recording.getQuitCount(), 1)
})

test('closing a non-current Browser Window persists that exact window bounds', function () {
  const recording = createRecordingBrowserWindows()
  const first = createWithBounds(recording, 10)
  const second = createWithBounds(recording, 300)
  second.focus()
  second.emit('focus')

  first.emit('close')

  assert.equal(recording.windows.getCurrent(), second)
  assert.equal(recording.writes.length, 1)
  assert.deepEqual(recording.writes[0].data, {
    x: 10,
    y: 20,
    width: 800,
    height: 600,
    maximized: false
  })
})

test('Tab Content reselection is stable and does not detach an overlay', function () {
  const recording = createRecordingBrowserWindows()
  const window = createWithBounds(recording, 10)
  const sender = recording.windows.getChromeContents(window)
  const firstTabContent = new RecordingView()
  const secondTabContent = new RecordingView()
  const overlay = new RecordingView()

  recording.windows.registerTabContent(sender, 'tab-1', firstTabContent)
  recording.windows.presentTabContent(sender, 'tab-1', firstTabContent, true)
  recording.windows.attachOverlay('palette', overlay, window)

  const additionsBeforeReselect = window.contentView.added.length
  const removalsBeforeReselect = window.contentView.removed.length
  assert.equal(recording.windows.presentTabContent(sender, 'tab-1', firstTabContent, true), false)
  assert.equal(window.contentView.added.length, additionsBeforeReselect)
  assert.equal(window.contentView.removed.length, removalsBeforeReselect)

  recording.windows.registerTabContent(sender, 'tab-2', secondTabContent)
  recording.windows.presentTabContent(sender, 'tab-2', secondTabContent, true)

  assert.equal(window.contentView.children.includes(firstTabContent), false)
  assert.equal(window.contentView.children.includes(secondTabContent), true)
  assert.equal(window.contentView.children.includes(overlay), true)
  assert.equal(recording.windows.isOverlayAttached('palette', overlay), true)
})

test('closing one Browser Window releases only its ownership and repairs overlay state', function () {
  const recording = createRecordingBrowserWindows()
  const first = createWithBounds(recording, 10)
  const second = createWithBounds(recording, 300)
  const firstTabContent = new RecordingView()
  const secondTabContent = new RecordingView()
  const overlay = new RecordingView()

  recording.windows.registerTabContent(recording.windows.getChromeContents(first), 'tab-1', firstTabContent)
  recording.windows.presentTabContent(recording.windows.getChromeContents(first), 'tab-1', firstTabContent, true)
  recording.windows.registerTabContent(recording.windows.getChromeContents(second), 'tab-2', secondTabContent)
  recording.windows.presentTabContent(recording.windows.getChromeContents(second), 'tab-2', secondTabContent, true)
  recording.windows.attachOverlay('palette', overlay, first)

  first.emit('close')
  first.emit('closed')

  assert.equal(firstTabContent.webContents.destroyCount, 0)
  assert.equal(secondTabContent.webContents.destroyCount, 0)
  assert.equal(recording.windows.getWindowForTabContent('tab-1'), null)
  assert.equal(recording.windows.getWindowForTabContent('tab-2'), second)
  assert.equal(recording.windows.isOverlayAttached('palette', overlay), false)
  assert.equal(second.contentView.children.includes(secondTabContent), true)
})

test('presenting Tab Content in another Browser Window transfers ownership atomically', function () {
  const recording = createRecordingBrowserWindows()
  const first = createWithBounds(recording, 10)
  const second = createWithBounds(recording, 300)
  const tabContent = new RecordingView()
  const firstChrome = recording.windows.getChromeContents(first)
  const secondChrome = recording.windows.getChromeContents(second)

  recording.windows.registerTabContent(firstChrome, 'tab-1', tabContent)
  recording.windows.presentTabContent(firstChrome, 'tab-1', tabContent, true)
  recording.windows.presentTabContent(secondChrome, 'tab-1', tabContent, true)

  assert.equal(recording.windows.ownsTabContent(firstChrome, 'tab-1'), false)
  assert.equal(recording.windows.ownsTabContent(secondChrome, 'tab-1'), true)
  assert.equal(first.contentView.children.includes(tabContent), false)
  assert.equal(second.contentView.children.includes(tabContent), true)
  assert.equal(recording.windows.windowFromContents(tabContent.webContents).win, second)
})

test('Browser Chrome messages share one load listener and flush in order', function () {
  const recording = createRecordingBrowserWindows()
  const window = createWithBounds(recording, 10)
  const chrome = recording.windows.getChromeContents(window)
  chrome.loading = true
  const listenersBefore = chrome.listenerCount('did-finish-load')

  recording.windows.send(window, 'first', { order: 1 })
  recording.windows.send(window, 'second', { order: 2 })
  recording.windows.send(window, 'third', { order: 3 })

  assert.equal(chrome.listenerCount('did-finish-load'), listenersBefore + 1)
  chrome.loading = false
  chrome.emit('did-finish-load')
  assert.deepEqual(chrome.messages, [
    { channel: 'first', data: { order: 1 } },
    { channel: 'second', data: { order: 2 } },
    { channel: 'third', data: { order: 3 } }
  ])
})
