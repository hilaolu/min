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

function deferred () {
  const task = {}
  task.promise = new Promise((resolve, reject) => {
    task.resolve = resolve
    task.reject = reject
  })
  return task
}

function createClock () {
  let now = 0
  let nextId = 0
  const timers = new Map()
  return {
    timers,
    schedule: (work, delay) => {
      const id = ++nextId
      timers.set(id, { at: now + delay, work })
      return id
    },
    cancelSchedule: id => timers.delete(id),
    advance: function (duration) {
      const end = now + duration
      while (true) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0]
        if (!next || next[1].at > end) break
        now = next[1].at
        timers.delete(next[0])
        next[1].work()
      }
      now = end
    }
  }
}

function idleHarness (t, options = {}) {
  const clock = createClock()
  const ipc = new EventEmitter()
  const idle = []
  const connection = createPlacesServiceConnection({
    handleRequest: () => {},
    ready: Promise.resolve(),
    ...options,
    ipc,
    onIdle: generation => idle.push(generation),
    schedule: clock.schedule,
    cancelSchedule: clock.cancelSchedule
  })
  t.after(() => connection.destroy())
  return { clock, connection, idle, ipc }
}

async function flushPromises () {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
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

for (const outcome of ['resolve', 'reject']) {
  test(`Places idle waits for readiness to ${outcome}, then fires once after the default 30 seconds`, async function (t) {
    const ready = deferred()
    const { clock, idle } = idleHarness(t, { ready: ready.promise })
    clock.advance(60000)
    assert.equal(clock.timers.size, 0)
    assert.deepEqual(idle, [])

    ready[outcome](new Error('initialization failed'))
    await flushPromises()
    assert.equal(clock.timers.size, 1)
    clock.advance(29999)
    assert.deepEqual(idle, [])
    clock.advance(1)
    assert.deepEqual(idle, [0])
    clock.advance(60000)
    assert.deepEqual(idle, [0])
    assert.equal(clock.timers.size, 0)
  })
}

test('Places connections cancel idle and report the latest main generation only after all ports close', async function (t) {
  const { clock, idle, ipc } = idleHarness(t)
  await flushPromises()
  clock.advance(29999)
  const first = createPort()
  const second = createPort()
  ipc.emit('places-connect', { ports: [first] }, { generation: 7 })
  assert.equal(clock.timers.size, 0)
  ipc.emit('places-connect', { ports: [second] }, { generation: 8 })
  await flushPromises()
  first.listeners.get('close')()
  clock.advance(60000)
  assert.deepEqual(idle, [])
  assert.equal(clock.timers.size, 0)

  second.listeners.get('close')()
  // Duplicate close events must not create duplicate idle timers.
  second.listeners.get('close')()
  assert.equal(clock.timers.size, 1)
  clock.advance(29999)
  assert.deepEqual(idle, [])
  clock.advance(1)
  clock.advance(60000)
  assert.deepEqual(idle, [8])
})

test('Places background tasks cancel idle and every overlapping task must drain before a fresh delay', async function (t) {
  const { clock, connection, idle } = idleHarness(t)
  await flushPromises()
  clock.advance(29999)
  const first = deferred()
  const second = deferred()
  const firstTask = connection.runTask(() => first.promise)
  const secondTask = connection.runTask(() => second.promise)
  assert.equal(clock.timers.size, 0)
  clock.advance(60000)
  assert.deepEqual(idle, [])

  first.resolve('first result')
  assert.equal(await firstTask, 'first result')
  clock.advance(60000)
  assert.deepEqual(idle, [])
  assert.equal(clock.timers.size, 0)
  second.resolve('second result')
  assert.equal(await secondTask, 'second result')
  assert.equal(clock.timers.size, 1)
  clock.advance(29999)
  assert.deepEqual(idle, [])
  assert.equal(await connection.runTask(() => 42), 42)
  clock.advance(29999)
  assert.deepEqual(idle, [])
  clock.advance(1)
  clock.advance(60000)
  assert.deepEqual(idle, [0])
})

for (const failure of ['rejection', 'synchronous throw']) {
  test(`Places runTask settles counters exactly once on ${failure}`, async function (t) {
    const { clock, connection, idle } = idleHarness(t)
    await flushPromises()
    const pending = deferred()
    const remainingTask = connection.runTask(() => pending.promise)
    const error = new Error('work failed')
    if (failure === 'rejection') {
      const failed = deferred()
      const task = connection.runTask(() => failed.promise)
      const rejection = assert.rejects(task, candidate => candidate === error)
      failed.reject(error)
      await rejection
    } else {
      assert.throws(() => connection.runTask(() => { throw error }), candidate => candidate === error)
    }
    clock.advance(60000)
    assert.equal(clock.timers.size, 0)
    assert.deepEqual(idle, [])
    pending.resolve()
    await remainingTask
    assert.equal(clock.timers.size, 1)
    clock.advance(30000)
    clock.advance(60000)
    assert.deepEqual(idle, [0])
  })
}

for (const outcome of ['response', 'rejection']) {
  test(`Places tracks in-flight requests after the last port closes, including a late ${outcome}`, async function (t) {
    const work = deferred()
    let respond
    const { clock, idle, ipc } = idleHarness(t, {
      handleRequest: (data, reply) => {
        respond = reply
        return work.promise
      }
    })
    const port = createPort()
    ipc.emit('places-connect', { ports: [port] }, { generation: 11 })
    await flushPromises()
    port.listeners.get('message')({ data: { callbackId: 1 } })
    port.listeners.get('close')()
    clock.advance(60000)
    assert.equal(clock.timers.size, 0)
    assert.deepEqual(idle, [])

    if (outcome === 'response') {
      respond({ callbackId: 1, result: 'finished response, unfinished work' })
      clock.advance(60000)
      assert.deepEqual(idle, [])
      assert.equal(clock.timers.size, 0)
      work.resolve()
    } else {
      work.reject(new Error('late failure'))
    }
    await flushPromises()
    assert.deepEqual(port.messages, [{ ok: true, type: 'ready' }])
    assert.equal(clock.timers.size, 1)
    clock.advance(29999)
    assert.deepEqual(idle, [])
    clock.advance(1)
    clock.advance(60000)
    assert.deepEqual(idle, [11])
  })
}

test('Places queued requests cancel a pending idle timer even after port close', async function (t) {
  const work = deferred()
  const { clock, idle, ipc } = idleHarness(t, { handleRequest: () => work.promise })
  const port = createPort()
  ipc.emit('places-connect', { ports: [port] }, { generation: 12 })
  await flushPromises()
  port.listeners.get('close')()
  clock.advance(29999)
  assert.equal(clock.timers.size, 1)
  port.listeners.get('message')({ data: { callbackId: 2 } })
  assert.equal(clock.timers.size, 0)
  clock.advance(60000)
  assert.deepEqual(idle, [])
  work.resolve()
  await flushPromises()
  clock.advance(29999)
  assert.deepEqual(idle, [])
  clock.advance(1)
  clock.advance(60000)
  assert.deepEqual(idle, [12])
})

for (const outcome of ['response', 'error']) {
  test(`Places failed ${outcome} delivery closes the port without losing other work`, async function (t) {
    const request = deferred()
    const background = deferred()
    let respond
    const { clock, connection, idle, ipc } = idleHarness(t, {
      handleRequest: (data, reply) => {
        respond = reply
        return request.promise
      }
    })
    const port = createPort()
    ipc.emit('places-connect', { ports: [port] }, { generation: 13 })
    await flushPromises()
    const task = connection.runTask(() => background.promise)
    port.listeners.get('message')({ data: { callbackId: 3 } })
    let posts = 0
    port.postMessage = () => { posts++; throw new Error('port closed') }
    if (outcome === 'response') respond({ callbackId: 3, result: null })
    else request.reject(new Error('request failed'))
    await flushPromises()
    assert.equal(port.closed, true)
    assert.equal(posts, 1)
    clock.advance(60000)
    assert.equal(clock.timers.size, 0)
    assert.deepEqual(idle, [])

    background.resolve()
    await task
    if (outcome === 'response') {
      clock.advance(60000)
      assert.equal(clock.timers.size, 0)
      assert.deepEqual(idle, [])
      request.resolve()
      await flushPromises()
    }
    assert.equal(clock.timers.size, 1)
    clock.advance(30000)
    clock.advance(60000)
    assert.deepEqual(idle, [13])
  })
}

for (const state of ['timer', 'ready', 'work']) {
  test(`Places destroy cancels idle and prevents rescheduling with pending ${state}`, async function (t) {
    const ready = deferred()
    const work = deferred()
    const { clock, connection, idle, ipc } = idleHarness(t, {
      ready: state === 'ready' ? ready.promise : Promise.resolve(),
      idleDelay: 10
    })
    await flushPromises()
    const port = createPort()
    let task
    if (state === 'work') {
      ipc.emit('places-connect', { ports: [port] }, { generation: 14 })
      task = connection.runTask(() => work.promise)
    }
    assert.equal(clock.timers.size, state === 'timer' ? 1 : 0)
    connection.destroy()
    assert.equal(clock.timers.size, 0)
    assert.equal(ipc.listenerCount('places-connect'), 0)
    if (state === 'work') assert.equal(port.closed, true)
    ready.resolve()
    work.resolve()
    await task
    await flushPromises()
    let called = false
    await connection.runTask(() => { called = true })
    assert.equal(called, false)
    const latePort = createPort()
    assert.equal(ipc.emit('places-connect', { ports: [latePort] }, { generation: 15 }), false)
    assert.equal(latePort.listeners.size, 0)
    connection.destroy()
    clock.advance(60000)
    assert.equal(clock.timers.size, 0)
    assert.deepEqual(idle, [])
  })
}
test('new connections and work wake a quiescent service, but teardown never resumes maintenance', async function (t) {
  let activeCalls = 0
  const { clock, connection, idle, ipc } = idleHarness(t, { onActive: () => { activeCalls++ } })
  await flushPromises()
  clock.advance(30000)
  assert.deepEqual(idle, [0])
  ipc.emit('places-connect', { ports: [] })
  assert.equal(activeCalls, 0)
  ipc.emit('places-connect', { ports: [createPort()] }, { generation: 1 })
  assert.equal(activeCalls, 1)
  await connection.runTask(() => {})
  assert.equal(activeCalls, 2)
  connection.destroy()
  await connection.runTask(() => assert.fail('destroyed service ran work'))
  assert.equal(activeCalls, 2)
})
