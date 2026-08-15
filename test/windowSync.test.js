const assert = require('node:assert/strict')
const test = require('node:test')
const Module = require('node:module')

function loadWindowSync (modules) {
  const originalLoad = Module._load
  Module._load = function (request, parent, isMain) {
    if (Object.hasOwn(modules, request)) return modules[request]
    return originalLoad.call(this, request, parent, isMain)
  }
  try {
    const modulePath = require.resolve('../js/tabState/windowSync.js')
    delete require.cache[modulePath]
    return require(modulePath)
  } finally {
    Module._load = originalLoad
  }
}

test('window sync holds live batches until hydration and projects Browser Session outcomes', function () {
  let localChangeListener
  let remoteChangeListener
  let unsubscribeCount = 0
  const applied = []
  const published = []
  const projected = []
  const browserSession = {
    applyChanges: function (data) {
      applied.push(data)
      return {
        closedTabIds: ['closed-tab'],
        closeWindow: false,
        projectSelectedTask: true,
        selectedTaskId: 'fallback',
        showTaskOverlay: true,
        status: 'applied'
      }
    },
    onChange: function (listener) {
      localChangeListener = listener
    }
  }
  const rendererHost = {
    closeWindow: function () {},
    onBrowserSessionChanges: function (listener) {
      remoteChangeListener = listener
      return function () { unsubscribeCount++ }
    },
    publishBrowserSessionChanges: changes => published.push(changes)
  }
  const taskOverlay = {
    show: () => projected.push('overlay')
  }
  const browserUI = {
    discardClosedTabs: tabIds => projected.push({ discarded: tabIds }),
    switchToTask: (taskId, options) => projected.push({ options, taskId })
  }
  const windowSync = loadWindowSync({
    'browserUI.js': browserUI,
    'rendererHost.js': rendererHost,
    'tabState.js': browserSession,
    'taskOverlay/taskOverlay.js': taskOverlay
  })
  windowSync.initialize()
  const envelope = { sourceWindowId: 'source', changes: [{ id: 'source:1' }] }

  remoteChangeListener(envelope)
  assert.deepEqual(applied, [])

  windowSync.finishHydration()
  assert.deepEqual(applied, [envelope])
  assert.deepEqual(projected, [
    { discarded: ['closed-tab'] },
    'overlay',
    { taskId: 'fallback', options: { stateAlreadySelected: true } }
  ])

  const localChange = { id: 'local:1' }
  localChangeListener(localChange)
  windowSync.flush()
  assert.deepEqual(published, [[localChange]])
  assert.equal(unsubscribeCount, 0)
})
