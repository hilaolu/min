const assert = require('node:assert/strict')
const EventEmitter = require('node:events')
const test = require('node:test')

const createPlacesManager = require('../main/placesManager.js')

function createHarness () {
  const windows = []
  class BrowserWindow extends EventEmitter {
    constructor (options) {
      super()
      this.options = options
      this.destroyed = false
      this.messages = []
      this.webContents = new EventEmitter()
      this.webContents.destroyed = false
      this.webContents.isDestroyed = () => this.webContents.destroyed
      this.webContents.postMessage = (channel, value, ports) => {
        this.messages.push({ channel, ports, value })
      }
      windows.push(this)
    }

    destroy () {
      this.destroyed = true
      this.emit('closed')
    }

    isDestroyed () {
      return this.destroyed
    }

    loadURL (url) {
      this.url = url
    }
  }
  return { BrowserWindow, windows }
}

test('Places Manager queues connections until its hidden window is ready', function () {
  const harness = createHarness()
  const places = createPlacesManager({
    BrowserWindow: harness.BrowserWindow,
    pageURL: 'file:///places.html'
  })
  const sender = new EventEmitter()
  sender.isDestroyed = () => false
  const port = { closeCount: 0, close: function () { this.closeCount++ } }

  const placesWindow = places.initialize()
  assert.equal(places.connect(sender, port), true)
  assert.deepEqual(placesWindow.messages, [])
  assert.equal(places.isReady(), false)

  placesWindow.webContents.emit('did-finish-load')

  assert.equal(places.isReady(), true)
  assert.deepEqual(placesWindow.messages, [{
    channel: 'places-connect',
    ports: [port],
    value: null
  }])
  assert.equal(places.initialize(), placesWindow)
})

test('Places Manager closes queued connections on sender teardown or load failure', function () {
  const harness = createHarness()
  const places = createPlacesManager({
    BrowserWindow: harness.BrowserWindow,
    pageURL: 'file:///places.html'
  })
  const placesWindow = places.initialize()
  const destroyedSender = new EventEmitter()
  destroyedSender.isDestroyed = () => true
  const destroyedPort = { closed: false, close: function () { this.closed = true } }
  const waitingSender = new EventEmitter()
  waitingSender.isDestroyed = () => false
  const waitingPort = { closed: false, close: function () { this.closed = true } }

  places.connect(destroyedSender, destroyedPort)
  places.connect(waitingSender, waitingPort)
  destroyedSender.emit('destroyed')
  placesWindow.webContents.emit('did-fail-load')

  assert.equal(destroyedPort.closed, true)
  assert.equal(waitingPort.closed, true)
  assert.equal(places.isReady(), false)
  assert.equal(placesWindow.destroyed, true)
  assert.equal(places.getWindow(), null)
})

test('Places Manager recreates its hidden window after a renderer crash', function () {
  const harness = createHarness()
  const places = createPlacesManager({
    BrowserWindow: harness.BrowserWindow,
    pageURL: 'file:///places.html'
  })
  const failedWindow = places.initialize()
  failedWindow.webContents.emit('render-process-gone')

  const sender = new EventEmitter()
  sender.isDestroyed = () => false
  const port = { closed: false, close: function () { this.closed = true } }
  assert.equal(places.connect(sender, port), true)

  const replacementWindow = places.getWindow()
  assert.notEqual(replacementWindow, failedWindow)
  assert.equal(failedWindow.destroyed, true)
  failedWindow.webContents.emit('did-finish-load')
  assert.equal(places.isReady(), false)

  replacementWindow.webContents.emit('did-finish-load')
  assert.equal(places.isReady(), true)
  assert.deepEqual(replacementWindow.messages[0].ports, [port])
})

test('Places Manager immediately closes connections from destroyed senders', function () {
  const harness = createHarness()
  const places = createPlacesManager({
    BrowserWindow: harness.BrowserWindow,
    pageURL: 'file:///places.html'
  })
  const sender = new EventEmitter()
  sender.isDestroyed = () => true
  const port = { closed: false, close: function () { this.closed = true } }

  assert.equal(places.connect(sender, port), false)
  assert.equal(port.closed, true)
  assert.equal(places.getWindow(), null)
})

test('Places Manager teardown closes pending connections and destroys its hidden window', function () {
  const harness = createHarness()
  const places = createPlacesManager({
    BrowserWindow: harness.BrowserWindow,
    pageURL: 'file:///places.html'
  })
  const placesWindow = places.initialize()
  const sender = new EventEmitter()
  sender.isDestroyed = () => false
  const port = { closed: false, close: function () { this.closed = true } }
  places.connect(sender, port)

  places.destroy()

  assert.equal(port.closed, true)
  assert.equal(placesWindow.destroyed, true)
  assert.equal(places.getWindow(), null)
})
