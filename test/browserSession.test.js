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

function captureChanges (session) {
  const changes = []
  session.onChange(change => changes.push(change))
  return changes
}

function changesFrom (sourceWindowId, changes) {
  return { sourceWindowId, changes }
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

test('semantic replay is idempotent, does not echo, and rejects an invalid batch before mutation', function () {
  const source = createSession('source')
  const target = createSession('target')
  const changes = captureChanges(source)
  const echoedChanges = captureChanges(target)
  source.createTask({ name: 'Shared Task' })

  const applied = target.applyChanges(changesFrom('source', changes))
  const duplicate = target.applyChanges(changesFrom('source', changes))

  assert.equal(applied.status, 'applied')
  assert.equal(duplicate.status, 'duplicate')
  assert.equal(target.tasks.getLength(), 1)
  assert.deepEqual(echoedChanges, [])

  const before = target.getCopyableSnapshot()
  const rejected = target.applyChanges(changesFrom('source', [
    { ...changes[0], id: 'source:2', sequence: 2 },
    { ...changes[0], id: 'source:3', sequence: 3, version: 99 }
  ]))

  assert.equal(rejected.status, 'rejected')
  assert.match(rejected.reason, /Unsupported/)
  assert.deepEqual(target.getCopyableSnapshot(), before)
})

test('reversed delivery is drained in source order and converges', function () {
  const source = createSession('source')
  const changes = captureChanges(source)
  const firstTaskId = source.createTask({ name: 'First' }, { select: true })
  const firstTabId = source.openTab({ url: 'https://first.example' }, { taskId: firstTaskId }).tabId
  const secondTaskId = source.createTask({ name: 'Second' })
  const secondTabId = source.openTab({ url: 'https://second.example' }, { taskId: secondTaskId }).tabId
  source.updateTab(firstTabId, { title: 'Updated' })
  source.moveTabToTask(firstTabId, secondTaskId)
  source.moveTabToIndex(firstTabId, 0)
  source.closeTab(secondTabId)
  source.moveTask(secondTaskId, 0)

  const firstTarget = createSession('target-1')
  const secondTarget = createSession('target-2')
  const reversed = [...changes].reverse()

  assert.equal(firstTarget.applyChanges(changesFrom('source', reversed)).status, 'applied')
  assert.equal(secondTarget.applyChanges(changesFrom('source', changes)).status, 'applied')
  assert.deepEqual(firstTarget.getCopyableSnapshot(), source.getCopyableSnapshot())
  assert.deepEqual(secondTarget.getCopyableSnapshot(), source.getCopyableSnapshot())
})

test('a sequence gap buffers later changes until the missing change arrives', function () {
  const source = createSession('source')
  const changes = captureChanges(source)
  source.createTask({ name: 'Delayed Task' }, { select: true })
  const target = createSession('target')

  const waiting = target.applyChanges(changesFrom('source', [changes[1]]))

  assert.equal(waiting.status, 'waiting-for-changes')
  assert.deepEqual(waiting.bufferedChanges, ['source:2'])
  assert.equal(target.tasks.getLength(), 0)

  const drained = target.applyChanges(changesFrom('source', [changes[0]]))

  assert.equal(drained.status, 'applied')
  assert.deepEqual(drained.appliedChanges, ['source:1', 'source:2'])
  assert.equal(target.tasks.get('source-1').selectedInWindow, 'source')
})

test('a snapshot cursor makes delayed delivery represented by the snapshot harmless', function () {
  const source = createSession('source')
  const changes = captureChanges(source)
  const taskId = source.createTask({}, { select: true })
  source.openTab({ url: 'https://snapshot.example' }, { taskId })
  const target = createSession('target')
  target.restoreSnapshot(source.getCopyableSnapshot())
  const echoedChanges = captureChanges(target)

  const outcome = target.applyChanges(changesFrom('source', changes))

  assert.equal(outcome.status, 'duplicate')
  assert.deepEqual(echoedChanges, [])
  assert.deepEqual(target.getCopyableSnapshot(), source.getCopyableSnapshot())
})

test('losing ownership selects the most recent unclaimed empty Task inside Browser Session', function () {
  const owner = createSession('owner')
  const ownedTaskId = owner.createTask({}, { select: true })
  owner.openTab({ url: 'https://owned.example' }, { taskId: ownedTaskId })
  const fallbackTaskId = owner.createTask()
  owner.openTab({}, { taskId: fallbackTaskId })
  const challenger = createSession('challenger')
  challenger.restoreSnapshot(owner.getCopyableSnapshot())
  const challengerChanges = captureChanges(challenger)
  challenger.selectTask(ownedTaskId)
  const ownershipResponse = captureChanges(owner)

  const outcome = owner.applyChanges(changesFrom('challenger', challengerChanges))

  assert.equal(outcome.closeWindow, false)
  assert.equal(outcome.projectSelectedTask, true)
  assert.equal(outcome.showTaskOverlay, true)
  assert.equal(outcome.selectedTaskId, fallbackTaskId)
  assert.equal(owner.tasks.get(ownedTaskId).selectedInWindow, 'challenger')
  assert.equal(owner.tasks.getSelected().id, fallbackTaskId)
  assert.deepEqual(ownershipResponse.map(change => change.type), ['task-selected'])
})

test('losing ownership creates one selected blank fallback when no empty Task exists', function () {
  const owner = createSession('owner')
  const ownedTaskId = owner.createTask({}, { select: true })
  owner.openTab({ url: 'https://owned.example' }, { taskId: ownedTaskId })
  const challenger = createSession('challenger')
  challenger.restoreSnapshot(owner.getCopyableSnapshot())
  const challengerChanges = captureChanges(challenger)
  challenger.selectTask(ownedTaskId)
  const ownershipResponse = captureChanges(owner)

  const outcome = owner.applyChanges(changesFrom('challenger', challengerChanges))

  const fallbackTask = owner.tasks.get(outcome.selectedTaskId)
  assert.ok(fallbackTask)
  assert.notEqual(fallbackTask.id, ownedTaskId)
  assert.equal(fallbackTask.tabs.count(), 1)
  assert.equal(fallbackTask.tabs.getSelected(), fallbackTask.tabs.getAtIndex(0).id)
  assert.equal(fallbackTask.tabs.getAtIndex(0).url, '')
  assert.deepEqual(ownershipResponse.map(change => change.type), [
    'task-created',
    'tab-created',
    'tab-selected',
    'task-selected'
  ])
})

test('simultaneous Task claims resolve to one owner and replicas converge', function () {
  const seed = createSession('seed')
  const taskId = seed.createTask()
  seed.openTab({}, { taskId })
  const first = createSession('a')
  const second = createSession('b')
  first.restoreSnapshot(seed.getCopyableSnapshot())
  second.restoreSnapshot(seed.getCopyableSnapshot())
  const firstChanges = captureChanges(first)
  const secondChanges = captureChanges(second)

  first.selectTask(taskId)
  second.selectTask(taskId)
  first.applyChanges(changesFrom('b', [...secondChanges]))
  second.applyChanges(changesFrom('a', [...firstChanges]))

  assert.equal(first.tasks.get(taskId).selectedInWindow, 'b')
  assert.equal(second.tasks.get(taskId).selectedInWindow, 'b')
  assert.notEqual(first.tasks.getSelected().id, taskId)
  assert.equal(second.tasks.getSelected().id, taskId)
  assert.deepEqual(first.getCopyableSnapshot(), second.getCopyableSnapshot())
})

test('remote closure of the locally owned Task returns one close-window effect', function () {
  const owner = createSession('owner')
  const taskId = owner.createTask({}, { select: true })
  const tabId = owner.openTab({ url: 'https://close.example' }, { taskId }).tabId
  const closer = createSession('closer')
  closer.restoreSnapshot(owner.getCopyableSnapshot())
  const closeChanges = captureChanges(closer)
  closer.closeTask(taskId)

  const outcome = owner.applyChanges(changesFrom('closer', closeChanges))

  assert.equal(outcome.status, 'applied')
  assert.equal(outcome.closeWindow, true)
  assert.deepEqual(outcome.closedTabIds, [tabId])
  assert.equal(outcome.projectSelectedTask, false)
  assert.equal(owner.tasks.get(taskId), null)
  assert.equal(owner.tasks.getSelected(), undefined)
})

test('releasing Task ownership emits exactly one semantic change', function () {
  const owner = createSession('owner')
  const taskId = owner.createTask({}, { select: true })
  owner.openTab({}, { taskId })
  const changes = captureChanges(owner)

  const release = owner.releaseTask()

  assert.equal(release.type, 'task-released')
  assert.equal(owner.tasks.getSelected(), undefined)
  assert.deepEqual(changes, [release])
})

test('an invalid dependency requests a snapshot without applying the batch suffix', function () {
  const target = createSession('target')
  const outcome = target.applyChanges(changesFrom('source', [
    {
      version: BrowserSession.CHANGE_VERSION,
      id: 'source:1',
      sourceWindowId: 'source',
      sequence: 1,
      logicalTime: 1,
      type: 'task-updated',
      taskId: 'missing',
      data: { name: 'Missing' }
    },
    {
      version: BrowserSession.CHANGE_VERSION,
      id: 'source:2',
      sourceWindowId: 'source',
      sequence: 2,
      logicalTime: 2,
      type: 'task-created',
      task: { id: 'must-not-apply', tabs: [] }
    }
  ]))

  assert.equal(outcome.status, 'snapshot-required')
  assert.match(outcome.reason, /does not exist/)
  assert.equal(target.tasks.getLength(), 0)
  assert.deepEqual(outcome.bufferedChanges, ['source:2'])
})

test('Task ownership changes cannot impersonate another Browser Window', function () {
  const source = createSession('source')
  const taskId = source.createTask()
  const target = createSession('target')
  target.restoreSnapshot(source.getCopyableSnapshot())
  const forged = {
    version: BrowserSession.CHANGE_VERSION,
    id: 'source:2',
    sourceWindowId: 'source',
    sequence: 2,
    logicalTime: 2,
    type: 'task-selected',
    taskId,
    windowId: 'another-window'
  }

  const outcome = target.applyChanges(changesFrom('source', [forged]))

  assert.equal(outcome.status, 'rejected')
  assert.match(outcome.reason, /ownership source/)
  assert.equal(target.tasks.get(taskId).selectedInWindow, null)
})
