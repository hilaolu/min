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
      this.webContents.mainFrame = {}
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

function createPort () {
  const port = new EventEmitter()
  port.closeCount = 0
  port.close = function () {
    assert.equal(this.listenerCount('close'), 0)
    this.closeCount++
    this.emit('close')
  }
  return port
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
    value: { generation: 1 }
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

test('Places Manager releases provisional listeners before each of 100 transfers', function () {
  const harness = createHarness()
  const places = createPlacesManager({
    BrowserWindow: harness.BrowserWindow,
    pageURL: 'file:///places.html'
  })
  const sender = new EventEmitter()
  const placesWindow = places.initialize()
  const postMessage = placesWindow.webContents.postMessage
  placesWindow.webContents.postMessage = function (channel, value, ports) {
    assert.equal(sender.listenerCount('destroyed'), 0)
    assert.equal(ports[0].listenerCount('close'), 0)
    postMessage(channel, value, ports)
  }
  const ports = []
  for (let i = 0; i < 100; i++) {
    const port = createPort()
    ports.push(port)
    assert.equal(places.connect(sender, port), true)
    if (i === 0) placesWindow.webContents.emit('did-finish-load')
    assert.equal(sender.listenerCount('destroyed'), 0)
    assert.equal(port.listenerCount('close'), 0)
    assert.equal(placesWindow.messages.length, i + 1)
    assert.deepEqual(placesWindow.messages[i].ports, [port])
    assert.deepEqual(placesWindow.messages[i].value, { generation: i + 1 })
  }

  sender.emit('destroyed')
  places.destroy()
  for (const port of ports) {
    assert.equal(port.closeCount, 0)
    assert.equal(port.listenerCount('close'), 0)
  }
})

for (const event of ['destroyed', 'close']) {
  test(`Places Manager detaches pending listeners on ${event} without duplicate close`, function () {
    const harness = createHarness()
    const places = createPlacesManager({
      BrowserWindow: harness.BrowserWindow,
      pageURL: 'file:///places.html'
    })
    const sender = new EventEmitter()
    const port = createPort()
    places.connect(sender, port)
    assert.equal(sender.listenerCount('destroyed'), 1)
    assert.equal(port.listenerCount('close'), 1)

    const target = event === 'destroyed' ? sender : port
    target.emit(event)
    assert.equal(sender.listenerCount('destroyed'), 0)
    assert.equal(port.listenerCount('close'), 0)
    assert.equal(port.closeCount, event === 'destroyed' ? 1 : 0)

    const placesWindow = places.getWindow()
    placesWindow.webContents.emit('did-finish-load')
    assert.deepEqual(placesWindow.messages, [])
    places.destroy()
    assert.equal(port.closeCount, event === 'destroyed' ? 1 : 0)
  })
}

for (const failure of ['load', 'transfer', 'destroy', 'closed', 'crash']) {
  test(`Places Manager clears all provisional listeners on ${failure}`, function () {
    const harness = createHarness()
    const places = createPlacesManager({
      BrowserWindow: harness.BrowserWindow,
      pageURL: 'file:///places.html'
    })
    const placesWindow = places.initialize()
    const sender = new EventEmitter()
    const ports = [createPort(), createPort(), createPort()]
    for (const port of ports) places.connect(sender, port)
    assert.equal(sender.listenerCount('destroyed'), ports.length)
    for (const port of ports) assert.equal(port.listenerCount('close'), 1)

    let transferAttempts = 0
    if (failure === 'transfer') {
      placesWindow.webContents.postMessage = function (channel, value, transferredPorts) {
        transferAttempts++
        assert.equal(sender.listenerCount('destroyed'), ports.length - 1)
        assert.equal(transferredPorts[0].listenerCount('close'), 0)
        throw new Error('transfer failed')
      }
      placesWindow.webContents.emit('did-finish-load')
      assert.equal(transferAttempts, 1)
    } else if (failure === 'destroy') {
      places.destroy()
    } else if (failure === 'closed') {
      placesWindow.destroy()
    } else {
      placesWindow.webContents.emit(failure === 'load' ? 'did-fail-load' : 'render-process-gone')
    }

    assert.equal(sender.listenerCount('destroyed'), 0)
    for (const port of ports) {
      assert.equal(port.listenerCount('close'), 0)
      assert.equal(port.closeCount, 1)
    }
    assert.equal(places.isReady(), false)
    assert.equal(places.getWindow(), null)
    assert.equal(placesWindow.destroyed, true)
    placesWindow.webContents.emit('did-finish-load')
    sender.emit('destroyed')
    places.destroy()
    for (const port of ports) assert.equal(port.closeCount, 1)
  })
}

test('Places Manager supports plain-object senders and ports without listener methods', function () {
  const harness = createHarness()
  const places = createPlacesManager({
    BrowserWindow: harness.BrowserWindow,
    pageURL: 'file:///places.html'
  })
  const port = { closeCount: 0, close: function () { this.closeCount++ } }
  assert.equal(places.connect({}, port), true)
  const placesWindow = places.getWindow()
  placesWindow.webContents.emit('did-finish-load')
  assert.deepEqual(placesWindow.messages[0].ports, [port])
  places.destroy()
  assert.equal(port.closeCount, 0)

  assert.equal(places.connect({}, port), true)
  places.destroy()
  assert.equal(port.closeCount, 1)
})

test('Places Manager accepts idle only when ready, from its main frame, with the current generation', function (t) {
  const harness = createHarness()
  const places = createPlacesManager({ BrowserWindow: harness.BrowserWindow, pageURL: 'file:///places.html' })
  t.after(() => places.destroy())
  const target = places.initialize()
  const event = { senderFrame: target.webContents.mainFrame }
  target.webContents.emit('ipc-message', event, 'places-idle', { generation: 0 })
  assert.equal(places.getWindow(), target)
  assert.equal(target.destroyed, false)
  target.webContents.emit('did-finish-load')

  const unavailableFrame = { get senderFrame () { throw new Error('frame destroyed') } }
  for (const [source, channel, data] of [
    [{ senderFrame: {} }, 'places-idle', { generation: 0 }],
    [{}, 'places-idle', { generation: 0 }],
    [unavailableFrame, 'places-idle', { generation: 0 }],
    [event, 'other-channel', { generation: 0 }],
    [event, 'places-idle', undefined],
    [event, 'places-idle', { generation: 1 }],
    [event, 'places-idle', { generation: '0' }]
  ]) {
    assert.doesNotThrow(() => target.webContents.emit('ipc-message', source, channel, data))
    assert.equal(places.getWindow(), target)
    assert.equal(places.isReady(), true)
    assert.equal(target.destroyed, false)
  }

  target.webContents.emit('ipc-message', event, 'places-idle', { generation: 0 })
  assert.equal(target.destroyed, true)
  assert.equal(places.getWindow(), null)
  assert.equal(places.isReady(), false)
  assert.equal(harness.windows.length, 1)
})

test('Places Manager refuses matching idle while ready connections are still being transferred', function (t) {
  const harness = createHarness()
  const places = createPlacesManager({ BrowserWindow: harness.BrowserWindow, pageURL: 'file:///places.html' })
  t.after(() => places.destroy())
  const sender = new EventEmitter()
  const ports = [createPort(), createPort()]
  for (const port of ports) places.connect(sender, port)
  const target = places.getWindow()
  const event = { senderFrame: target.webContents.mainFrame }
  target.webContents.emit('ipc-message', event, 'places-idle', { generation: 0 })
  assert.equal(places.getWindow(), target)
  assert.equal(sender.listenerCount('destroyed'), 2)
  const postMessage = target.webContents.postMessage
  target.webContents.postMessage = function (channel, value, transferredPorts) {
    postMessage(channel, value, transferredPorts)
    if (value.generation === 1) {
      assert.equal(places.isReady(), true)
      target.webContents.emit('ipc-message', event, 'places-idle', value)
      assert.equal(target.destroyed, false)
      assert.equal(places.getWindow(), target)
    }
  }
  target.webContents.emit('did-finish-load')
  assert.deepEqual(target.messages.map(message => message.value), [{ generation: 1 }, { generation: 2 }])
  assert.equal(sender.listenerCount('destroyed'), 0)
  for (const port of ports) {
    assert.equal(port.listenerCount('close'), 0)
    assert.equal(port.closeCount, 0)
  }
  target.webContents.emit('ipc-message', event, 'places-idle', { generation: 2 })
  assert.equal(target.destroyed, true)
  assert.equal(places.getWindow(), null)
})

test('Places Manager rejects stale idle after a newer transfer or service replacement', function (t) {
  const harness = createHarness()
  const places = createPlacesManager({ BrowserWindow: harness.BrowserWindow, pageURL: 'file:///places.html' })
  t.after(() => places.destroy())
  const sender = new EventEmitter()
  const first = createPort()
  places.connect(sender, first)
  const oldWindow = places.getWindow()
  const oldEvent = { senderFrame: oldWindow.webContents.mainFrame }
  oldWindow.webContents.emit('did-finish-load')
  const second = createPort()
  places.connect(sender, second)
  assert.deepEqual(oldWindow.messages.map(message => message.value), [{ generation: 1 }, { generation: 2 }])
  oldWindow.webContents.emit('ipc-message', oldEvent, 'places-idle', { generation: 1 })
  assert.equal(oldWindow.destroyed, false)
  assert.equal(places.getWindow(), oldWindow)

  oldWindow.webContents.emit('ipc-message', oldEvent, 'places-idle', { generation: 2 })
  assert.equal(oldWindow.destroyed, true)
  assert.equal(places.getWindow(), null)
  assert.equal(places.isReady(), false)
  assert.equal(harness.windows.length, 1)

  const third = createPort()
  assert.equal(places.connect(sender, third), true)
  const replacement = places.getWindow()
  assert.notEqual(replacement, oldWindow)
  assert.equal(harness.windows.length, 2)
  assert.equal(places.isReady(), false)
  assert.deepEqual(replacement.messages, [])
  replacement.webContents.emit('did-finish-load')
  assert.deepEqual(replacement.messages, [{ channel: 'places-connect', ports: [third], value: { generation: 1 } }])

  // Even a generation matching the replacement cannot authorize an old window.
  oldWindow.webContents.emit('ipc-message', oldEvent, 'places-idle', { generation: 1 })
  oldWindow.webContents.emit('ipc-message', oldEvent, 'places-idle', { generation: 2 })
  replacement.webContents.emit('ipc-message', oldEvent, 'places-idle', { generation: 1 })
  assert.equal(places.getWindow(), replacement)
  assert.equal(places.isReady(), true)
  assert.equal(replacement.destroyed, false)
  assert.equal(sender.listenerCount('destroyed'), 0)
  for (const port of [first, second, third]) {
    assert.equal(port.listenerCount('close'), 0)
    assert.equal(port.closeCount, 0)
  }

  replacement.webContents.emit('ipc-message', { senderFrame: replacement.webContents.mainFrame }, 'places-idle', { generation: 1 })
  assert.equal(replacement.destroyed, true)
  assert.equal(places.getWindow(), null)
  assert.equal(harness.windows.length, 2)
})
