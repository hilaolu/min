const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

const createPreviewImageManager = require('../js/previewImageManager.js')

test('preview images stay presentation-local and concurrent captures share one request', async function () {
  let completeCapture
  let captureCount = 0
  const available = []
  const tabs = new Map([['tab-1', { id: 'tab-1', private: false }]])
  const manager = createPreviewImageManager({
    canCapture: () => true,
    capture: () => {
      captureCount++
      return new Promise(resolve => { completeCapture = resolve })
    },
    captureOptions: () => ({ width: 100, height: 80 }),
    getTab: id => tabs.get(id),
    onAvailable: (id, dataURL) => available.push([id, dataURL]),
    onError: error => { throw error }
  })

  const first = manager.capture('tab-1')
  const second = manager.capture('tab-1')
  assert.equal(first, second)
  assert.equal(captureCount, 1)

  completeCapture('data:image/png;base64,small')
  await first
  assert.equal(manager.get('tab-1'), 'data:image/png;base64,small')
  assert.deepEqual(available, [['tab-1', 'data:image/png;base64,small']])
})

test('navigation invalidation rejects stale captures and private Tabs never capture', async function () {
  let completeCapture
  let captureCount = 0
  const tabs = new Map([
    ['normal', { private: false }],
    ['private', { private: true }]
  ])
  const manager = createPreviewImageManager({
    canCapture: () => true,
    capture: () => {
      captureCount++
      return new Promise(resolve => { completeCapture = resolve })
    },
    captureOptions: () => ({}),
    getTab: id => tabs.get(id),
    onAvailable: function () {},
    onError: error => { throw error }
  })

  const pending = manager.capture('normal')
  manager.invalidate('normal')
  completeCapture('data:image/png;base64,stale')
  assert.equal(await pending, null)
  assert.equal(manager.get('normal'), null)
  assert.equal(await manager.capture('private'), null)
  assert.equal(captureCount, 1)
})

function createHarness (create = createPreviewImageManager, overrides = {}) {
  const tabs = new Map([['tab', { private: false }]])
  const pending = []
  const available = []
  const errors = []
  let now = 0
  const manager = create({
    canCapture: () => true,
    capture: () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
    captureOptions: () => ({}),
    getTab: id => tabs.get(id),
    now: () => now,
    onAvailable: (id, image) => available.push([id, image]),
    onError: error => errors.push(error),
    ...overrides
  })
  return { manager, tabs, pending, available, errors, advance: delay => { now += delay } }
}

function createTrackedHarness () {
  const maps = []
  const context = {
    module: { exports: {} },
    Map: class extends Map {
      constructor () { super(); maps.push(this) }
    }
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../js/previewImageManager.js'), 'utf8'), context)
  return { ...createHarness(context.module.exports), maps }
}

test('preview bookkeeping retains no closed-tab tombstones after thousands of invalidations', function () {
  const { manager, maps } = createTrackedHarness()
  for (let i = 0; i < 10000; i++) {
    manager.invalidate('closed-' + i)
    manager.clear('closed-' + i)
  }
  assert.equal(maps.reduce((count, map) => count + map.size, 0), 0)
})

test('preview dispatch registers the request before synchronous invalidation or clear', async function () {
  for (const operation of ['invalidate', 'clear']) {
    let coalesced
    let captures = 0
    const h = createHarness(createPreviewImageManager, {
      capture: () => {
        captures++
        h.manager[operation]('tab')
        // Invalidation keeps the pending request available for deduplication.
        if (operation === 'invalidate' && captures === 1) coalesced = h.manager.capture('tab')
        return 'stale'
      }
    })
    const pending = h.manager.capture('tab')
    if (operation === 'invalidate') assert.equal(coalesced, pending)
    assert.equal(await pending, null)
    assert.equal(captures, 1)
    assert.deepEqual(h.available, [])
  }
})

test('synchronous capture and options failures use the error path and permit retries', async function () {
  for (const stage of ['capture', 'captureOptions']) {
    let fail = true
    const error = new Error(stage + ' failed')
    const operation = () => {
      if (fail) throw error
      return stage === 'capture' ? 'fresh' : {}
    }
    const h = createHarness(createPreviewImageManager, { [stage]: operation })
    assert.equal(await h.manager.capture('tab'), null)
    assert.deepEqual(h.errors, [error])
    fail = false
    const retry = h.manager.capture('tab')
    if (stage === 'captureOptions') h.pending[0].resolve('fresh')
    assert.equal(await retry, 'fresh')
    assert.deepEqual(h.available, [['tab', 'fresh']])
  }
})

test('captures never publish after their tab disappears or becomes private', async function () {
  for (const change of [tabs => tabs.delete('tab'), tabs => { tabs.get('tab').private = true }]) {
    const h = createHarness()
    const pending = h.manager.capture('tab')
    change(h.tabs)
    h.pending[0].resolve('discard')
    assert.equal(await pending, null)
    assert.deepEqual(h.available, [])
    assert.equal(h.manager.get('tab'), null)
  }
})

test('looking up an expired, removed or private tab releases its retained image', async function () {
  for (const change of [h => h.advance(30000), h => h.tabs.delete('tab'), h => { h.tabs.get('tab').private = true }]) {
    const h = createTrackedHarness()
    const pending = h.manager.capture('tab')
    h.pending[0].resolve('image')
    await pending
    assert.equal(h.maps.reduce((count, map) => count + map.size, 0), 1)
    change(h)
    assert.equal(h.manager.get('tab'), null)
    assert.equal(h.maps.reduce((count, map) => count + map.size, 0), 0)
  }
})

test('cleared captures cannot overwrite a replacement or remove its in-flight entry', async function () {
  for (const oldFinishesFirst of [true, false]) {
    const h = createHarness()
    const old = h.manager.capture('tab')
    h.manager.clear('tab')
    h.tabs.set('tab', { private: false }) // Reusing a closed tab ID.
    const replacement = h.manager.capture('tab')
    if (oldFinishesFirst) {
      h.pending[0].resolve('old')
      assert.equal(await old, null)
      assert.equal(h.manager.capture('tab'), replacement)
    }
    h.pending[1].resolve('new')
    assert.equal(await replacement, 'new')
    if (!oldFinishesFirst) {
      h.pending[0].resolve('old')
      assert.equal(await old, null)
    }
    assert.equal(h.manager.get('tab'), 'new')
    assert.deepEqual(h.available, [['tab', 'new']])
  }
})

test('navigation keeps one pending capture until it settles, then allows a fresh request', async function () {
  const h = createHarness()
  const old = h.manager.capture('tab')
  h.manager.invalidate('tab')
  h.manager.invalidate('tab')
  assert.equal(h.manager.capture('tab'), old)
  h.pending[0].resolve('stale')
  assert.equal(await old, null)
  const fresh = h.manager.capture('tab')
  h.pending[1].resolve('fresh')
  assert.equal(await fresh, 'fresh')
})

test('preview images remain capped at three, expire, clear immediately and recover after rejection', async function () {
  const h = createHarness()
  for (let i = 0; i < 4; i++) {
    h.tabs.set(i, { private: false })
    const capture = h.manager.capture(i)
    h.pending[i].resolve('image-' + i)
    await capture
  }
  assert.equal(h.manager.get(0), null)
  assert.equal(h.manager.get(1), 'image-1')
  h.manager.clear(1)
  assert.equal(h.manager.get(1), null)
  h.advance(30000)
  assert.equal(h.manager.get(2), null)
  const failed = h.manager.capture('tab')
  h.pending[4].reject(new Error('capture failed'))
  assert.equal(await failed, null)
  assert.equal(h.errors.length, 1)
  const retry = h.manager.capture('tab')
  h.pending[5].resolve('retry')
  assert.equal(await retry, 'retry')
})
