const assert = require('node:assert/strict')
const test = require('node:test')

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
