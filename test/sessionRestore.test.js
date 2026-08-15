const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

function loadSessionRestore () {
  let persistenceRevision = 1
  let selectedTaskIds = ['task-1']
  let startupTabOption = 2
  let snapshotCalls = 0
  const writes = []
  const tasks = [
    { id: 'task-1', selectedInWindow: 'window-1', tabs: [{ id: 'tab-1' }] },
    { id: 'task-2', selectedInWindow: null, tabs: [{ id: 'tab-2' }] }
  ]
  const browserSession = {
    getPersistedSnapshot: function () {
      snapshotCalls++
      return {
        revision: persistenceRevision,
        tasks: tasks.map(task => ({ id: task.id, tabs: task.tabs.slice() }))
      }
    },
    getPersistenceRevision: () => persistenceRevision,
    tasks: {
      get: id => tasks.find(task => task.id === id),
      getSelectedTaskIds: () => selectedTaskIds.slice()
    }
  }
  const rendererHost = {
    getRuntimeConfiguration: () => ({ initialTask: null, initialWindow: true, launchWindow: false }),
    saveBrowserSession: function (data, options) {
      writes.push({ data, options })
      return options?.sync ? undefined : Promise.resolve()
    }
  }
  const dependencies = {
    'browserUI.js': {},
    'js/statistics.js': { incrementValue: function () {} },
    'navbar/tabEditor.js': {},
    'rendererHost.js': rendererHost,
    'tabState.js': browserSession,
    'tabState/windowSync.js': {},
    'taskOverlay/taskOverlay.js': {},
    'util/settings/settings.js': { get: () => startupTabOption }
  }
  const context = vm.createContext({
    console,
    document: { body: { classList: { contains: () => true } } },
    module: { exports: {} },
    require: name => dependencies[name],
    setInterval: function () {},
    window: {}
  })
  const source = fs.readFileSync(path.resolve(__dirname, '../js/sessionRestore.js'), 'utf8')
  vm.runInContext(source, context, { filename: 'sessionRestore.js' })

  return {
    getSnapshotCalls: () => snapshotCalls,
    sessionRestore: context.module.exports,
    setPersistenceRevision: value => { persistenceRevision = value },
    setSelectedTaskIds: value => {
      selectedTaskIds = value
      tasks.forEach(task => { task.selectedInWindow = value.includes(task.id) ? 'selected' : null })
    },
    setStartupTabOption: value => { startupTabOption = value },
    writes
  }
}

function flushPromises () {
  return new Promise(resolve => setImmediate(resolve))
}

test('periodic Browser Session persistence skips unchanged snapshot construction', async function () {
  const harness = loadSessionRestore()

  harness.sessionRestore.save()
  await flushPromises()
  assert.equal(harness.getSnapshotCalls(), 1)
  assert.equal(harness.writes.length, 1)

  harness.sessionRestore.save()
  await flushPromises()
  assert.equal(harness.getSnapshotCalls(), 1)
  assert.equal(harness.writes.length, 1)

  harness.setPersistenceRevision(2)
  harness.sessionRestore.save()
  await flushPromises()
  assert.equal(harness.getSnapshotCalls(), 2)
  assert.equal(harness.writes.length, 2)

  harness.sessionRestore.save(true, true)
  assert.equal(harness.getSnapshotCalls(), 3)
  assert.equal(harness.writes.length, 3)
  assert.equal(harness.writes[2].options.sync, true)
})

test('blank-task startup persistence tracks selected Tasks without Browser Session snapshot changes', async function () {
  const harness = loadSessionRestore()
  harness.setStartupTabOption(3)

  harness.sessionRestore.save()
  await flushPromises()
  const firstState = JSON.parse(harness.writes[0].data).state
  assert.deepEqual(firstState.tasks.map(task => task.tabs.length), [0, 1])

  harness.setSelectedTaskIds(['task-2'])
  harness.sessionRestore.save()
  await flushPromises()
  const secondState = JSON.parse(harness.writes[1].data).state
  assert.deepEqual(secondState.tasks.map(task => task.tabs.length), [1, 0])
  assert.equal(harness.getSnapshotCalls(), 2)
})
