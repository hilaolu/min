const assert = require('node:assert/strict')
const test = require('node:test')

const BrowserSession = require('../js/tabState/browserSession.js')

function createSession (windowId = 'window-1') {
  let id = 0
  let now = 1000
  return new BrowserSession({
    windowId,
    createId: () => `${windowId}-${++id}`,
    now: () => ++now
  })
}

function createReadySession () {
  const session = createSession()
  const taskId = session.createTask({}, { select: true })
  const tabId = session.openTab({}, { taskId }).tabId
  return { session, tabId, taskId }
}

test('closing the selected Tab selects its left neighbor', function () {
  const { session, taskId } = createReadySession()
  const first = session.openTab({ url: 'https://first.example' }, { taskId }).tabId
  const second = session.openTab({ url: 'https://second.example' }, { taskId }).tabId

  const result = session.closeTab(second)

  assert.equal(result.selectedTabId, first)
  assert.equal(session.tabs.getSelected(), first)
})

test('closing the final Tab preserves one selected blank Tab', function () {
  const { session, tabId, taskId } = createReadySession()

  const result = session.closeTab(tabId)

  assert.ok(result.createdTabId)
  assert.equal(session.tasks.get(taskId).tabs.count(), 1)
  assert.equal(session.tasks.get(taskId).tabs.getSelected(), result.createdTabId)
  assert.equal(session.getTab(result.createdTabId).url, '')
})

test('moving a Tab between Tasks updates both Tasks atomically', function () {
  const { session, tabId, taskId } = createReadySession()
  session.updateTab(tabId, { url: 'https://move.example' })
  const targetTaskId = session.createTask()
  session.openTab({ url: 'https://target.example' }, { taskId: targetTaskId })

  const result = session.moveTabToTask(tabId, targetTaskId)

  assert.equal(session.tasks.getTaskContainingTab(tabId).id, targetTaskId)
  assert.equal(session.tasks.get(taskId).tabs.count(), 1)
  assert.equal(session.tasks.get(taskId).tabs.getSelected(), result.sourceReplacement.id)
  assert.equal(session.tasks.get(targetTaskId).tabs.count(), 2)
})

test('selecting a Task maintains one selected Task per Browser Window', function () {
  const { session, taskId } = createReadySession()
  const otherTaskId = session.createTask()

  session.selectTask(otherTaskId)

  assert.equal(session.tasks.getSelected().id, otherTaskId)
  assert.equal(session.tasks.get(taskId).selectedInWindow, null)
  assert.equal(session.tasks.filter(task => task.selectedInWindow === session.windowId).length, 1)
})

test('persisted snapshots exclude private Tabs and are deep copies', function () {
  const { session, taskId } = createReadySession()
  session.openTab({ private: true, url: 'https://private.example' }, { taskId })

  const snapshot = session.getPersistedSnapshot()
  snapshot.tasks[0].name = 'mutated snapshot'

  assert.equal(snapshot.tasks[0].tabs.some(tab => tab.private), false)
  assert.equal(session.tasks.get(taskId).name, null)
})

test('restoring a Task that contained only private Tabs creates a blank Tab', function () {
  const source = createSession('source')
  const taskId = source.createTask({}, { select: true })
  source.openTab({ private: true, url: 'https://private.example' }, { taskId })
  const persisted = source.getPersistedSnapshot()
  const restored = createSession('restored')

  restored.restoreSnapshot(persisted)

  const restoredTask = restored.tasks.get(taskId)
  assert.equal(restoredTask.tabs.count(), 1)
  assert.equal(restoredTask.tabs.getAtIndex(0).url, '')
})

test('semantic replay is idempotent, does not echo, and rejects unknown versions', function () {
  const source = createSession('source')
  const target = createSession('target')
  const changes = []
  const echoedChanges = []
  source.onChange(change => changes.push(change))
  target.onChange(change => echoedChanges.push(change))
  source.createTask({ name: 'Shared Task' })

  assert.equal(target.applyChange(changes[0]), true)
  assert.equal(target.applyChange(changes[0]), false)
  assert.equal(target.tasks.getLength(), 1)
  assert.deepEqual(echoedChanges, [])

  const before = target.getCopyableSnapshot()
  assert.throws(() => target.applyChange({ ...changes[0], id: 'bad', version: 99 }), /Unsupported/)
  assert.deepEqual(target.getCopyableSnapshot(), before)
})
