const assert = require('node:assert/strict')
const EventEmitter = require('node:events')
const path = require('node:path')
const test = require('node:test')

const createTabContent = require('../main/viewManager.js')

class RecordingIPC extends EventEmitter {
  constructor () {
    super()
    this.handlers = new Map()
  }

  handle (channel, handler) {
    this.handlers.set(channel, handler)
  }
}

class RecordingWebContents extends EventEmitter {
  constructor () {
    super()
    this.calls = []
    this.destroyed = false
    this.navigationHistory = {
      entries: [{ url: 'https://previous.example' }, { url: 'https://current.example' }],
      getActiveIndex: () => 1,
      getEntryAtIndex: index => this.navigationHistory.entries[index],
      length: () => this.navigationHistory.entries.length
    }
  }

  canGoBack () { return true }
  canGoForward () { return false }
  canGoToOffset () { return false }
  destroy () { this.destroyed = true }
  focus () { this.calls.push(['focus']) }
  getURL () { return 'https://current.example' }
  goBack () { this.calls.push(['goBack']) }
  goForward () { this.calls.push(['goForward']) }
  isDestroyed () { return this.destroyed }
  isFocused () { return true }
  isLoading () { return false }
  loadURL (url) { this.calls.push(['loadURL', url]) }
  reload () { this.calls.push(['reload']) }
  reloadIgnoringCache () { this.calls.push(['reloadIgnoringCache']) }
  send (channel, data) { this.calls.push(['send', channel, data]) }
  setVisualZoomLevelLimits (minimum, maximum) { this.calls.push(['zoomLimits', minimum, maximum]) }
  setWindowOpenHandler (handler) { this.windowOpenHandler = handler }
  stop () { this.calls.push(['stop']) }
}

class RecordingView {
  constructor (options) {
    this.options = options
    this.webContents = options?.webContents || new RecordingWebContents()
  }

  setBackgroundColor () {}
  setBounds (bounds) { this.bounds = bounds }
}

function createFixture () {
  const ipc = new RecordingIPC()
  const createdViews = []
  class FixtureView extends RecordingView {
    constructor (options) {
      super(options)
      createdViews.push(this)
    }
  }
  const chromeMessages = []
  const chrome = {
    focus: () => {},
    send: (channel, message) => chromeMessages.push({ channel, message })
  }
  const otherChrome = { send: () => {} }
  const window = { isFocused: () => true }
  const lifecycle = []
  const owners = new Map()
  const contentOwners = new Map([[chrome, window]])
  const views = new Map()
  const windows = {
    attachSelectedTabContent: () => {},
    getChromeContents: () => chrome,
    getWindowForTabContent: id => owners.get(id)?.window || null,
    hideSelectedTabContent: () => lifecycle.push(['hide']),
    ownsTabContent: (sender, id) => owners.get(id)?.sender === sender,
    presentTabContent: (sender, id, view) => {
      lifecycle.push(['present', id])
      owners.set(id, { sender, view, window })
      contentOwners.set(view.webContents, window)
    },
    registerTabContent: (sender, id, view) => {
      if (sender !== chrome && sender !== otherChrome) {
        const error = new Error('Browser Window not found')
        error.code = 'BROWSER_WINDOW_NOT_FOUND'
        throw error
      }
      owners.set(id, { sender, view, window })
      views.set(id, view)
      contentOwners.set(view.webContents, window)
    },
    removeTabContent: id => {
      lifecycle.push(['destroy', id])
      owners.delete(id)
    },
    windowFromContents: contents => {
      const ownerWindow = contentOwners.get(contents)
      return ownerWindow ? { id: 'window-1', win: ownerWindow } : undefined
    }
  }
  const manager = createTabContent({
    app: { getApplicationNameForProtocol: () => null },
    BrowserWindow: { fromWebContents: () => window },
    createPrompt: () => {},
    electron: { dialog: {}, shell: {} },
    filterPopups: () => true,
    getWindowWebContents: () => chrome,
    ipc,
    path,
    rootDir: '/tmp/min-test',
    settings: { get: () => null },
    WebContentsView: FixtureView,
    windows
  })

  return { chrome, chromeMessages, createdViews, ipc, lifecycle, manager, otherChrome }
}

async function createContent (fixture, id = 'tab-1') {
  await fixture.manager.executeTabContentCommand(fixture.chrome, {
    id,
    operation: 'lifecycle.create',
    payload: {
      bounds: { x: 0, y: 40, width: 800, height: 560 },
      private: false
    }
  })
  return fixture.createdViews.at(-1)
}

test('Tab Content commands expose browser behavior without reflective dispatch', async function () {
  const fixture = createFixture()
  const view = await createContent(fixture)

  const state = await fixture.manager.executeTabContentCommand(fixture.chrome, {
    id: 'tab-1',
    operation: 'navigation.state'
  })
  await fixture.manager.executeTabContentCommand(fixture.chrome, {
    id: 'tab-1',
    operation: 'navigation.back'
  })
  await fixture.manager.executeTabContentCommand(fixture.chrome, {
    id: 'tab-1',
    operation: 'navigation.reload',
    payload: { ignoreCache: true }
  })

  assert.deepEqual(state, { canGoBack: true, canGoForward: false })
  assert.deepEqual(view.webContents.calls.slice(-2), [['goBack'], ['reloadIgnoringCache']])
  await assert.rejects(
    fixture.manager.executeTabContentCommand(fixture.chrome, {
      id: 'tab-1',
      operation: 'web-contents.call',
      payload: { method: 'destroy' }
    }),
    error => error.code === 'UNSUPPORTED_OPERATION'
  )
})

test('every behavior command crosses the Browser Window ownership guard', async function () {
  const fixture = createFixture()
  await createContent(fixture)
  const protectedOperations = [
    ['navigation.back', null],
    ['focus.state', null],
    ['find.stop', { action: 'clearSelection' }],
    ['zoom.set', { factor: 1 }],
    ['download.url', { url: 'https://example.com/file' }],
    ['audio.set-muted', { muted: true }],
    ['development.toggle-tools', null],
    ['indexing.configure', { enabled: false, navigationGeneration: 1 }]
  ]

  for (const [operation, payload] of protectedOperations) {
    await assert.rejects(
      fixture.manager.executeTabContentCommand(fixture.otherChrome, { id: 'tab-1', operation, payload }),
      error => error.code === 'TAB_CONTENT_NOT_OWNER',
      operation
    )
  }
})

test('Electron events are installed in the main process and emitted as named semantic payloads', async function () {
  const fixture = createFixture()
  const view = await createContent(fixture)

  view.webContents.emit('did-navigate', {}, 'https://example.com', 200, 'OK')

  assert.deepEqual(fixture.chromeMessages.at(-1), {
    channel: 'tab-content-event',
    message: {
      tabId: 'tab-1',
      type: 'navigation-committed',
      payload: {
        url: 'https://example.com',
        statusCode: 200,
        statusText: 'OK'
      }
    }
  })
  assert.deepEqual(view.webContents.calls.at(-1), ['zoomLimits', 1, 3])
})

test('main-frame navigation generations reach both Tab Content and Browser Chrome', async function () {
  const fixture = createFixture()
  const view = await createContent(fixture)

  view.webContents.emit('did-start-navigation', {}, 'https://next.example', false, true)

  assert.deepEqual(view.webContents.calls.at(-1), ['send', 'page-navigation-generation', 1])
  assert.deepEqual(fixture.chromeMessages.at(-1), {
    channel: 'tab-content-event',
    message: {
      tabId: 'tab-1',
      type: 'navigation-started',
      payload: {
        url: 'https://next.example',
        isInPlace: false,
        isMainFrame: true,
        navigationGeneration: 1
      }
    }
  })

  await fixture.manager.executeTabContentCommand(fixture.chrome, {
    id: 'tab-1',
    operation: 'indexing.configure',
    payload: { enabled: false, navigationGeneration: 1 }
  })
  assert.deepEqual(view.webContents.calls.at(-1), [
    'send',
    'page-indexing-config',
    { enabled: false, navigationGeneration: 1 }
  ])
})

test('preview capture resizes before encoding, enforces byte bounds, and rejects private Tabs', async function () {
  const fixture = createFixture()
  const view = await createContent(fixture)
  const resizeCalls = []
  view.webContents.capturePage = async function () {
    return {
      getSize: () => ({ width: 1200, height: 800 }),
      resize: options => {
        resizeCalls.push(options)
        return { toDataURL: () => 'data:image/png;base64,small' }
      }
    }
  }

  const preview = await fixture.manager.executeTabContentCommand(fixture.chrome, {
    id: 'tab-1',
    operation: 'capture.preview',
    payload: { width: 2000, height: 2000, maxBytes: 1024 }
  })
  assert.equal(preview, 'data:image/png;base64,small')
  assert.deepEqual(resizeCalls, [{ width: 480, height: 320, quality: 'good' }])

  await fixture.manager.executeTabContentCommand(fixture.chrome, {
    id: 'private-preview',
    operation: 'lifecycle.create',
    payload: { bounds: { x: 0, y: 0, width: 100, height: 100 }, private: true }
  })
  const privatePreview = await fixture.manager.executeTabContentCommand(fixture.chrome, {
    id: 'private-preview',
    operation: 'capture.preview',
    payload: { width: 100, height: 100 }
  })
  assert.equal(privatePreview, null)
})

test('the IPC Adapter returns defined errors for missing ownership and unsupported behavior', async function () {
  const fixture = createFixture()
  await createContent(fixture)
  const handler = fixture.ipc.handlers.get('tab-content-command')

  const notOwner = await handler({ sender: fixture.otherChrome }, {
    id: 'tab-1',
    operation: 'navigation.back'
  })
  const unsupported = await handler({ sender: fixture.chrome }, {
    id: 'tab-1',
    operation: 'unknown'
  })

  assert.equal(notOwner.ok, false)
  assert.equal(notOwner.error.code, 'TAB_CONTENT_NOT_OWNER')
  assert.equal(unsupported.ok, false)
  assert.equal(unsupported.error.code, 'UNSUPPORTED_OPERATION')
})

test('Tab Content lifecycle applies create, initial navigation, presentation, hide, and destruction in order', async function () {
  const fixture = createFixture()
  await fixture.manager.executeTabContentCommand(fixture.chrome, {
    id: 'private-tab',
    operation: 'lifecycle.create',
    payload: {
      bounds: { x: 0, y: 40, width: 800, height: 560 },
      initialURL: 'min://app/pages/newTab/index.html',
      private: true
    }
  })
  const view = fixture.createdViews.at(-1)

  await fixture.manager.executeTabContentCommand(fixture.chrome, {
    id: 'private-tab',
    operation: 'lifecycle.present',
    payload: { bounds: { x: 0, y: 40, width: 800, height: 560 }, focus: true }
  })
  await fixture.manager.executeTabContentCommand(fixture.chrome, {
    operation: 'lifecycle.hide'
  })
  await fixture.manager.executeTabContentCommand(fixture.chrome, {
    id: 'private-tab',
    operation: 'lifecycle.destroy'
  })

  assert.equal(view.options.webPreferences.partition, 'private-tab')
  assert.deepEqual(view.webContents.calls[0], ['loadURL', 'min://app/pages/newTab/index.html'])
  assert.deepEqual(fixture.lifecycle, [
    ['present', 'private-tab'],
    ['hide'],
    ['destroy', 'private-tab']
  ])
  assert.equal(view.webContents.destroyed, true)
})
