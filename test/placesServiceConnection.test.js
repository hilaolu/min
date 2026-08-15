const assert = require('node:assert/strict')
const EventEmitter = require('node:events')
const test = require('node:test')

const createPlacesServiceConnection = require('../js/places/placesServiceConnection.js')

function createPort () {
  const listeners = new Map()
  const messages = []
  return {
    closed: false,
    listeners,
    messages,
    addEventListener: (name, listener) => listeners.set(name, listener),
    close: function () { this.closed = true },
    postMessage: message => messages.push(message),
    start: function () {}
  }
}

test('Places connection acknowledges readiness and wraps successful responses', async function () {
  const ipc = new EventEmitter()
  let markReady
  let requestContext
  const ready = new Promise(resolve => { markReady = resolve })
  const connection = createPlacesServiceConnection({
    handleRequest: (request, respond, context) => {
      requestContext = context
      respond({ callbackId: request.callbackId, result: ['place'] })
    },
    ipc,
    ready
  })
  const port = createPort()

  ipc.emit('places-connect', { ports: [port] })
  assert.deepEqual(port.messages, [])
  markReady()
  await ready
  await Promise.resolve()
  assert.deepEqual(port.messages, [{ ok: true, type: 'ready' }])

  port.listeners.get('message')({ data: { action: 'getAllPlaces', callbackId: 3 } })
  assert.equal(requestContext, port)
  assert.deepEqual(port.messages[1], {
    callbackId: 3,
    ok: true,
    result: ['place'],
    type: 'response'
  })

  connection.destroy()
  assert.equal(port.closed, true)
})

test('Places connection reports initialization and request failures', async function () {
  const ipc = new EventEmitter()
  const connection = createPlacesServiceConnection({
    handleRequest: () => { throw new Error('bad request') },
    ipc,
    ready: Promise.reject(new Error('database unavailable'))
  })
  const port = createPort()

  ipc.emit('places-connect', { ports: [port] })
  await Promise.resolve()
  await Promise.resolve()
  assert.deepEqual(port.messages[0], {
    error: { code: 'PLACES_INITIALIZATION_FAILED', message: 'database unavailable' },
    ok: false,
    type: 'ready'
  })

  port.listeners.get('message')({ data: { action: 'unknown', callbackId: 4 } })
  assert.deepEqual(port.messages[1], {
    callbackId: 4,
    error: { code: 'PLACES_REQUEST_FAILED', message: 'bad request' },
    ok: false,
    type: 'response'
  })
  connection.destroy()
})

test('Places connection contains asynchronous handler and closed-port failures', async function () {
  const ipc = new EventEmitter()
  const connection = createPlacesServiceConnection({
    handleRequest: () => Promise.reject(new Error('async request failed')),
    ipc,
    ready: Promise.resolve()
  })
  const port = createPort()

  ipc.emit('places-connect', { ports: [port] })
  await Promise.resolve()
  port.listeners.get('message')({ data: { action: 'getAllPlaces', callbackId: 8 } })
  await Promise.resolve()
  await Promise.resolve()
  assert.deepEqual(port.messages[1], {
    callbackId: 8,
    error: { code: 'PLACES_REQUEST_FAILED', message: 'async request failed' },
    ok: false,
    type: 'response'
  })

  port.postMessage = function () { throw new Error('closed') }
  assert.doesNotThrow(function () {
    port.listeners.get('message')({ data: { action: 'getAllPlaces', callbackId: 9 } })
  })
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(port.closed, true)
  connection.destroy()
})
