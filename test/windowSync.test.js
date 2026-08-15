const assert = require('node:assert/strict')
const test = require('node:test')

const { createInMemoryRendererHost } = require('../js/rendererHost.js')
const { createWindowSync } = require('../js/tabState/windowSync.js')

const runtimeConfiguration = {
  appName: 'Min',
  appVersion: '1.39.11',
  developmentMode: true,
  initialTask: null,
  initialWindow: true,
  launchWindow: true,
  platform: 'linux',
  windowId: 'window-sync-test'
}

function outcome (overrides = {}) {
  return {
    closedTabIds: [],
    closeWindow: false,
    projectSelectedTask: false,
    selectedTaskId: null,
    showTaskOverlay: false,
    status: 'applied',
    ...overrides
  }
}

function createWindowSyncHarness (applyChanges) {
  let localChangeListener
  let remoteChangeListener
  let localUnsubscribeCount = 0
  let transportUnsubscribeCount = 0
  let closeWindowCount = 0
  const applied = []
  const cancellations = []
  const projected = []
  const published = []
  const scheduled = []
  const warnings = []
  const browserSession = {
    applyChanges: function (data) {
      applied.push(data)
      return applyChanges(data)
    },
    onChange: function (listener) {
      localChangeListener = listener
      return function () { localUnsubscribeCount++ }
    }
  }
  const rendererHost = createInMemoryRendererHost(runtimeConfiguration, {
    closeWindow: function () { closeWindowCount++ },
    onBrowserSessionChanges: function (listener) {
      remoteChangeListener = listener
      return function () { transportUnsubscribeCount++ }
    },
    publishBrowserSessionChanges: changes => published.push(changes)
  })
  const windowSync = createWindowSync({
    browserSession,
    browserUI: {
      discardClosedTabs: tabIds => projected.push({ discarded: tabIds }),
      switchToTask: (taskId, options) => projected.push({ options, taskId })
    },
    cancelSchedule: timer => cancellations.push(timer),
    logger: { warn: (...args) => warnings.push(args) },
    rendererHost,
    schedule: function (callback, delay) {
      const timer = { callback, delay }
      scheduled.push(timer)
      return timer
    },
    taskOverlay: { show: () => projected.push('overlay') }
  })
  windowSync.initialize()
  return {
    applied,
    cancellations,
    closeWindowCount: () => closeWindowCount,
    emitLocal: change => localChangeListener(change),
    emitRemote: envelope => remoteChangeListener(envelope),
    localUnsubscribeCount: () => localUnsubscribeCount,
    projected,
    published,
    scheduled,
    transportUnsubscribeCount: () => transportUnsubscribeCount,
    warnings,
    windowSync
  }
}

test('window sync gates hydration, batches local changes, and projects Browser Session outcomes', function () {
  const firstEnvelope = { sourceWindowId: 'source', changes: [{ id: 'source:1' }] }
  const secondEnvelope = { sourceWindowId: 'source', changes: [{ id: 'source:2' }] }
  const rejectedEnvelope = { sourceWindowId: 'source', changes: [{ id: 'rejected' }] }
  const snapshotEnvelope = { sourceWindowId: 'source', changes: [{ id: 'snapshot' }] }
  const harness = createWindowSyncHarness(function (data) {
    const id = data.changes[0].id
    if (id === 'source:1') {
      return outcome({
        closedTabIds: ['closed-tab'],
        projectSelectedTask: true,
        selectedTaskId: 'fallback',
        showTaskOverlay: true
      })
    }
    if (id === 'rejected') return outcome({ reason: 'invalid envelope', status: 'rejected' })
    if (id === 'snapshot') return outcome({ reason: 'missing dependency', status: 'snapshot-required' })
    return outcome()
  })

  harness.emitRemote(firstEnvelope)
  harness.emitRemote(secondEnvelope)
  assert.deepEqual(harness.applied, [])

  harness.windowSync.finishHydration()
  assert.deepEqual(harness.applied, [firstEnvelope, secondEnvelope])
  assert.deepEqual(harness.projected, [
    { discarded: ['closed-tab'] },
    'overlay',
    { taskId: 'fallback', options: { stateAlreadySelected: true } },
    { discarded: [] }
  ])

  const localChanges = [{ id: 'local:1' }, { id: 'local:2' }]
  localChanges.forEach(harness.emitLocal)
  assert.equal(harness.scheduled.length, 1)
  harness.scheduled[0].callback()
  assert.deepEqual(harness.published, [localChanges])

  harness.emitRemote(rejectedEnvelope)
  harness.emitRemote(snapshotEnvelope)
  assert.deepEqual(harness.warnings.map(args => args[1]), ['invalid envelope', 'missing dependency'])

  harness.windowSync.destroy()
  harness.windowSync.destroy()
  assert.equal(harness.localUnsubscribeCount(), 1)
  assert.equal(harness.transportUnsubscribeCount(), 1)
})

test('remote Browser Window closure tears down subscriptions and timers exactly once', function () {
  const closeEnvelope = { sourceWindowId: 'source', changes: [{ id: 'close' }] }
  const harness = createWindowSyncHarness(() => outcome({ closeWindow: true }))
  harness.windowSync.finishHydration()
  harness.emitLocal({ id: 'local:pending' })
  assert.equal(harness.scheduled.length, 1)

  harness.emitRemote(closeEnvelope)
  harness.emitRemote(closeEnvelope)

  assert.equal(harness.closeWindowCount(), 1)
  assert.equal(harness.localUnsubscribeCount(), 1)
  assert.equal(harness.transportUnsubscribeCount(), 1)
  assert.deepEqual(harness.cancellations, [harness.scheduled[0]])
  assert.deepEqual(harness.published, [])
})
