const TaskList = require('./task.js')

const CHANGE_VERSION = 2

function copy (value) {
  return JSON.parse(JSON.stringify(value))
}

function compareStamps (left, right) {
  if (!left && !right) return 0
  if (!left) return -1
  if (!right) return 1
  if (left.logicalTime !== right.logicalTime) {
    return left.logicalTime - right.logicalTime
  }
  const sourceOrder = left.sourceWindowId.localeCompare(right.sourceWindowId)
  if (sourceOrder !== 0) return sourceOrder
  return left.sequence - right.sequence
}

function getSelectionStamp (change) {
  return {
    logicalTime: change.logicalTime,
    sequence: change.sequence,
    sourceWindowId: change.sourceWindowId
  }
}

class BrowserSession {
  constructor (options = {}) {
    this.windowId = options.windowId || 'default'
    this.now = options.now || Date.now
    this.createId = options.createId || (() => Math.round(Math.random() * 100000000000000000))
    this.changeSequence = 0
    this.logicalTime = 0
    this.changeListeners = []
    this.changeCursors = new Map()
    this.pendingChanges = new Map()
    this.windowSelectionStamps = new Map()
    this.recordChanges = true
    this.taskList = new TaskList({
      windowId: this.windowId,
      now: this.now,
      createId: this.createId
    })
  }

  on (name, listener) {
    this.taskList.on(name, listener)
  }

  onChange (listener) {
    this.changeListeners.push(listener)
    return () => {
      this.changeListeners = this.changeListeners.filter(candidate => candidate !== listener)
    }
  }

  emit (name, ...data) {
    this.taskList.emit(name, ...data)
  }

  get tasks () {
    return this.taskList
  }

  get tabs () {
    const task = this.taskList.getSelected()
    return task ? task.tabs : null
  }

  prepareChange (type, data) {
    const sequence = ++this.changeSequence
    const logicalTime = ++this.logicalTime
    return {
      version: CHANGE_VERSION,
      id: `${this.windowId}:${sequence}`,
      sourceWindowId: this.windowId,
      sequence,
      logicalTime,
      type,
      ...copy(data)
    }
  }

  commitChange (change) {
    this.changeCursors.set(change.sourceWindowId, change.sequence)
    this.changeListeners.forEach(listener => listener(change))
    return change
  }

  createChange (type, data) {
    return this.commitChange(this.prepareChange(type, data))
  }

  withoutRecording (callback) {
    const recordChanges = this.recordChanges
    this.recordChanges = false
    try {
      return callback()
    } finally {
      this.recordChanges = recordChanges
    }
  }

  copyTask (task) {
    return {
      id: task.id,
      name: task.name,
      collapsed: task.collapsed,
      selectedInWindow: task.selectedInWindow,
      selectionStamp: task.selectionStamp ? copy(task.selectionStamp) : null,
      tabHistory: copy(task.tabHistory),
      tabs: task.tabs.get().map(tab => copy(tab))
    }
  }

  addTaskState (task = {}, index) {
    return this.taskList.add(copy(task), index)
  }

  createTask (task = {}, options = {}) {
    const taskState = copy(task)
    if (this.recordChanges) {
      delete taskState.selectedInWindow
      delete taskState.selectionStamp
    }
    const id = this.addTaskState(taskState, options.index)
    const createdTask = this.taskList.get(id)

    if (this.recordChanges) {
      this.createChange('task-created', {
        task: this.copyTask(createdTask),
        index: options.index
      })
    }
    if (options.select) {
      this.selectTask(id)
    }
    return id
  }

  updateTask (taskId, data) {
    this.validateData(data)
    if (Object.hasOwn(data, 'selectedInWindow') || Object.hasOwn(data, 'selectionStamp')) {
      throw new Error('Task ownership must be changed through Browser Session ownership workflows')
    }
    this.taskList.update(taskId, data)
    return this.recordChanges
      ? this.createChange('task-updated', { taskId, data })
      : null
  }

  selectTask (taskId) {
    if (!this.taskList.get(taskId)) {
      throw new ReferenceError('Attempted to select a task that does not exist.')
    }

    if (!this.recordChanges) {
      this.taskList.setSelected(taskId, this.windowId)
      return taskId
    }

    const change = this.prepareChange('task-selected', {
      taskId,
      windowId: this.windowId
    })
    this.applyTaskSelection(change)
    this.commitChange(change)
    return taskId
  }

  releaseTask () {
    const selectedTask = this.taskList.getSelected()
    if (!selectedTask) return null

    const change = this.prepareChange('task-released', {
      taskId: selectedTask.id,
      windowId: this.windowId
    })
    this.applyTaskRelease(change)
    return this.commitChange(change)
  }

  applyTaskSelection (change) {
    const task = this.taskList.get(change.taskId)
    if (!task) {
      throw new ReferenceError('Attempted to select a task that does not exist.')
    }

    const stamp = getSelectionStamp(change)
    const previousWindowStamp = this.windowSelectionStamps.get(change.windowId)
    if (compareStamps(stamp, previousWindowStamp) <= 0) {
      return { affectedTaskIds: [], closedTabIds: [], localOwnershipLost: false }
    }

    const previouslyOwnedTask = this.taskList.find(candidate => candidate.selectedInWindow === change.windowId)
    const previousOwner = task.selectedInWindow
    const previousTaskStamp = task.selectionStamp
    const affectedTaskIds = previouslyOwnedTask ? [previouslyOwnedTask.id] : []
    this.windowSelectionStamps.set(change.windowId, stamp)
    this.taskList.clearSelected(change.windowId)

    const claimWon = !previousOwner || previousOwner === change.windowId ||
      compareStamps(stamp, previousTaskStamp) > 0

    if (claimWon) {
      this.taskList.setSelected(change.taskId, change.windowId)
      task.selectionStamp = stamp
      affectedTaskIds.push(change.taskId)
    }

    return {
      affectedTaskIds,
      closedTabIds: [],
      localOwnershipLost: (previousOwner === this.windowId && previousOwner !== change.windowId && claimWon) ||
        (change.windowId === this.windowId && !claimWon)
    }
  }

  applyTaskRelease (change) {
    const stamp = getSelectionStamp(change)
    const previousWindowStamp = this.windowSelectionStamps.get(change.windowId)
    if (compareStamps(stamp, previousWindowStamp) <= 0) {
      return { affectedTaskIds: [], closedTabIds: [] }
    }

    const selectedTask = this.taskList.find(task => task.selectedInWindow === change.windowId)
    this.windowSelectionStamps.set(change.windowId, stamp)
    if (selectedTask && (!change.taskId || selectedTask.id === change.taskId)) {
      this.taskList.clearSelected(change.windowId)
      return { affectedTaskIds: [selectedTask.id], closedTabIds: [] }
    }
    return { affectedTaskIds: [], closedTabIds: [] }
  }

  findAvailableTask (options = {}) {
    return this.taskList
      .filter(task => !task.selectedInWindow && (!options.emptyOnly || (task.tabs.isEmpty() && !task.name)))
      .sort((left, right) => {
        const activityOrder = this.taskList.getLastActivity(right.id) - this.taskList.getLastActivity(left.id)
        return activityOrder || left.id.localeCompare(right.id)
      })[0] || null
  }

  acquireTask (options = {}) {
    let task = options.taskId ? this.taskList.get(options.taskId) : this.findAvailableTask({ emptyOnly: options.emptyOnly !== false })
    if (options.taskId && !task) {
      throw new ReferenceError('Attempted to acquire a task that does not exist.')
    }

    let createdTaskId = null
    let createdTabId = null
    if (!task) {
      createdTaskId = this.createTask({})
      task = this.taskList.get(createdTaskId)
      createdTabId = this.openTab({}, {
        taskId: createdTaskId
      }).tabId
    }
    this.selectTask(task.id)
    return {
      createdTabId,
      createdTaskId,
      selectedTaskId: task.id
    }
  }

  moveTask (taskId, index) {
    if (!this.taskList.get(taskId)) {
      throw new ReferenceError('Attempted to move a task that does not exist.')
    }
    const targetIndex = this.taskList.move(taskId, index)
    if (this.recordChanges) {
      this.createChange('task-moved', { taskId, index: targetIndex })
    }
    return targetIndex
  }

  removeTaskState (taskId) {
    const task = this.taskList.get(taskId)
    if (!task) return false
    const result = {
      closedTabIds: task.tabs.get().map(tab => tab.id),
      wasSelected: task.selectedInWindow === this.windowId
    }
    this.taskList.destroy(taskId)
    return result
  }

  closeTask (taskId) {
    const removed = this.removeTaskState(taskId)
    if (!removed) return false

    if (this.recordChanges) {
      this.createChange('task-closed', { taskId })
    }

    let selectedTaskId = this.taskList.getSelected()?.id || null
    let createdTaskId = null
    let createdTabId = null
    if (removed.wasSelected) {
      const acquired = this.acquireTask({ emptyOnly: false })
      selectedTaskId = acquired.selectedTaskId
      createdTaskId = acquired.createdTaskId
      createdTabId = acquired.createdTabId
    }

    return {
      closedTabIds: removed.closedTabIds,
      createdTaskId,
      createdTabId,
      selectedTaskId
    }
  }

  addTabState (taskId, tab = {}, options = {}) {
    const task = this.taskList.get(taskId)
    if (!task) {
      throw new ReferenceError('Attempted to add a tab to a task that does not exist.')
    }
    return task.tabs.add(copy(tab), { atEnd: options.atEnd })
  }

  openTab (tab = {}, options = {}) {
    let taskId = options.taskId || this.taskList.getSelected()?.id
    if (!taskId) {
      taskId = this.createTask({}, { select: true })
    }
    const task = this.taskList.get(taskId)
    if (!task) {
      throw new ReferenceError('Attempted to add a tab to a task that does not exist.')
    }

    const selectedTabId = task.tabs.getSelected()
    const selectedTab = selectedTabId ? task.tabs.get(selectedTabId) : null
    const tabId = this.addTabState(taskId, tab, options)
    if (this.recordChanges) {
      this.createChange('tab-created', {
        taskId,
        tab: task.tabs.get(tabId),
        options: { atEnd: Boolean(options.atEnd) }
      })
    }

    const shouldReplaceSelected = !options.openInBackground && selectedTab && !selectedTab.url &&
      ((!selectedTab.private && task.tabs.get(tabId).private) || task.tabs.get(tabId).url)
    const closedTabIds = []
    if (shouldReplaceSelected) {
      task.tabs.destroy(selectedTabId)
      closedTabIds.push(selectedTabId)
      if (this.recordChanges) {
        this.createChange('tab-closed', { taskId, tabId: selectedTabId })
      }
    }

    if (!options.openInBackground) {
      this.selectTab(tabId)
    }
    return { tabId, closedTabIds }
  }

  duplicateTab (tabId, options = {}) {
    const source = this.getTab(tabId)
    if (!source) {
      throw new ReferenceError('Attempted to duplicate a tab that does not exist.')
    }
    delete source.id
    return this.openTab(source, options)
  }

  restoreClosedTab (taskId, options = {}) {
    const task = this.taskList.get(taskId)
    if (!task) {
      throw new ReferenceError('Attempted to restore a tab into a task that does not exist.')
    }
    const tab = task.tabHistory.pop()
    return tab ? this.openTab(tab, { ...options, taskId }) : null
  }

  updateTab (tabId, data) {
    this.validateData(data)
    const task = this.taskList.getTaskContainingTab(tabId)
    if (!task) {
      throw new ReferenceError('Attempted to update a tab that does not exist.')
    }
    task.tabs.update(tabId, data)
    if (this.recordChanges) {
      this.createChange('tab-updated', { taskId: task.id, tabId, data })
    }
  }

  selectTabState (tabId, selectedAt) {
    const task = this.taskList.getTaskContainingTab(tabId)
    if (!task) {
      throw new ReferenceError('Attempted to select a tab that does not exist.')
    }
    task.tabs.setSelected(tabId, selectedAt)
    return task
  }

  selectTab (tabId) {
    const selectedAt = this.now()
    const task = this.selectTabState(tabId, selectedAt)
    if (this.recordChanges) {
      this.createChange('tab-selected', {
        taskId: task.id,
        tabId,
        selectedAt
      })
    }
    return tabId
  }

  applyTabClosure (task, tabId, options = {}) {
    if (!task.tabs.has(tabId)) return false
    task.tabs.destroy(tabId)
    if (options.replacementTab && !task.tabs.has(options.replacementTab.id)) {
      task.tabs.add(copy(options.replacementTab), {})
    }
    if (options.selectedTabId && task.tabs.has(options.selectedTabId)) {
      task.tabs.setSelected(options.selectedTabId, options.selectedAt)
    }
    return true
  }

  closeTab (tabId) {
    const task = this.taskList.getTaskContainingTab(tabId)
    if (!task) return false

    const index = task.tabs.getIndex(tabId)
    const wasSelected = task.tabs.getSelected() === tabId
    const nextTab = wasSelected
      ? task.tabs.getAtIndex(index - 1) || task.tabs.getAtIndex(index + 1)
      : null

    task.tabs.destroy(tabId)

    let selectedTabId = task.tabs.getSelected()
    let selectedAt = null
    let createdTabId = null
    if (task.tabs.count() === 0) {
      const result = this.withoutRecording(() => this.openTab({}, { taskId: task.id }))
      createdTabId = result.tabId
      selectedTabId = result.tabId
      selectedAt = task.tabs.get(selectedTabId).lastActivity
    } else if (wasSelected) {
      selectedTabId = nextTab.id
      selectedAt = this.now()
      this.selectTabState(selectedTabId, selectedAt)
    }

    if (this.recordChanges) {
      this.createChange('tab-closed', {
        replacementTab: createdTabId ? task.tabs.get(createdTabId) : null,
        selectedAt,
        selectedTabId,
        taskId: task.id,
        tabId
      })
    }

    return { createdTabId, selectedTabId, taskId: task.id }
  }

  moveTabBy (tabId, offset) {
    const task = this.taskList.getTaskContainingTab(tabId)
    if (!task) {
      throw new ReferenceError('Attempted to move a tab that does not exist.')
    }
    return this.moveTabToIndex(tabId, task.tabs.getIndex(tabId) + offset)
  }

  moveTabToIndex (tabId, index) {
    const task = this.taskList.getTaskContainingTab(tabId)
    if (!task) {
      throw new ReferenceError('Attempted to move a tab that does not exist.')
    }
    const currentIndex = task.tabs.getIndex(tabId)
    const targetIndex = Math.max(0, Math.min(index, task.tabs.count() - 1))
    if (currentIndex === targetIndex) return targetIndex
    const tab = task.tabs.tabs.splice(currentIndex, 1)[0]
    task.tabs.tabs.splice(targetIndex, 0, tab)
    this.taskList.emit('tab-reordered', tabId, task.id, targetIndex)
    if (this.recordChanges) {
      this.createChange('tab-reordered', { taskId: task.id, tabId, index: targetIndex })
    }
    return targetIndex
  }

  moveTabState (change) {
    const sourceTask = this.taskList.get(change.fromTaskId)
    const targetTask = this.taskList.get(change.toTaskId)
    if (!sourceTask || !targetTask || !sourceTask.tabs.has(change.tabId) || targetTask.tabs.has(change.tabId)) {
      throw new Error('Cannot apply invalid Browser Session tab move')
    }
    const sourceIndex = sourceTask.tabs.getIndex(change.tabId)
    const movedTab = sourceTask.tabs.tabs.splice(sourceIndex, 1)[0]
    movedTab.selected = false
    const targetIndex = Math.max(0, Math.min(change.index, targetTask.tabs.count()))
    targetTask.tabs.tabs.splice(targetIndex, 0, movedTab)
    sourceTask.tabs.rebuildIndex()
    targetTask.tabs.rebuildIndex()
    this.taskList.moveTabOwnership(change.tabId, targetTask.id)
    if (change.sourceReplacement && !sourceTask.tabs.has(change.sourceReplacement.id)) {
      sourceTask.tabs.add(copy(change.sourceReplacement), {})
    }
    if (change.sourceSelectedTabId && sourceTask.tabs.has(change.sourceSelectedTabId)) {
      sourceTask.tabs.setSelected(change.sourceSelectedTabId, change.sourceSelectedAt)
    }
    this.taskList.emit('tab-moved', change.tabId, sourceTask.id, targetTask.id, targetIndex)
    return { sourceTask, targetIndex, targetTask }
  }

  moveTabToTask (tabId, targetTaskId, options = {}) {
    const sourceTask = this.taskList.getTaskContainingTab(tabId)
    const targetTask = this.taskList.get(targetTaskId)
    if (!sourceTask || !targetTask) {
      throw new ReferenceError('Attempted to move a tab using a task or tab that does not exist.')
    }
    if (sourceTask.id === targetTask.id) {
      return this.moveTabToIndex(tabId, options.index ?? targetTask.tabs.count() - 1)
    }

    const sourceIndex = sourceTask.tabs.getIndex(tabId)
    const wasSelected = sourceTask.tabs.getSelected() === tabId
    const movedTab = sourceTask.tabs.get(tabId)
    let sourceReplacement = null
    let sourceSelectedTabId = sourceTask.tabs.getSelected()
    let sourceSelectedAt = null

    if (sourceTask.tabs.count() === 1) {
      sourceReplacement = {
        id: String(this.createId()),
        lastActivity: this.now()
      }
      sourceSelectedTabId = sourceReplacement.id
      sourceSelectedAt = sourceReplacement.lastActivity
    } else if (wasSelected) {
      const replacement = sourceTask.tabs.getAtIndex(sourceIndex - 1) || sourceTask.tabs.getAtIndex(sourceIndex + 1)
      sourceSelectedTabId = replacement.id
      sourceSelectedAt = this.now()
    }

    const changeData = {
      fromTaskId: sourceTask.id,
      index: Math.max(0, Math.min(options.index ?? targetTask.tabs.count(), targetTask.tabs.count())),
      sourceReplacement,
      sourceSelectedAt,
      sourceSelectedTabId,
      tab: copy(movedTab),
      tabId,
      toTaskId: targetTask.id
    }
    const result = this.moveTabState(changeData)
    if (this.recordChanges) {
      this.createChange('tab-moved', changeData)
    }
    if (options.select) {
      this.selectTask(targetTaskId)
      this.selectTab(tabId)
    }
    return {
      sourceReplacement,
      sourceSelectedTabId,
      targetIndex: result.targetIndex
    }
  }

  getTab (tabId) {
    const task = this.taskList.getTaskContainingTab(tabId)
    return task ? task.tabs.get(tabId) : null
  }

  getMostRecentTask () {
    return this.taskList.slice().sort((left, right) => {
      const activityOrder = this.taskList.getLastActivity(right.id) - this.taskList.getLastActivity(left.id)
      return activityOrder || left.id.localeCompare(right.id)
    })[0] || null
  }

  getPersistedSnapshot () {
    return {
      tasks: this.taskList.map(task => ({
        collapsed: task.collapsed,
        id: task.id,
        name: task.name,
        tabHistory: copy(task.tabHistory),
        tabs: task.tabs.getStringifyableState().filter(tab => !tab.private)
      }))
    }
  }

  getCopyableSnapshot () {
    return {
      tasks: this.taskList.map(task => this.copyTask(task)),
      replication: {
        changeCursors: Array.from(this.changeCursors.entries()).sort(([left], [right]) => left.localeCompare(right)),
        logicalTime: this.logicalTime,
        windowSelectionStamps: Array.from(this.windowSelectionStamps.entries())
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([windowId, stamp]) => [windowId, copy(stamp)])
      }
    }
  }

  restoreReplicationMetadata (replication = {}) {
    this.changeCursors = new Map(Array.isArray(replication.changeCursors) ? replication.changeCursors : [])
    this.changeSequence = this.changeCursors.get(this.windowId) || 0
    this.windowSelectionStamps = new Map(Array.isArray(replication.windowSelectionStamps) ? replication.windowSelectionStamps : [])
    this.logicalTime = Number.isInteger(replication.logicalTime) ? replication.logicalTime : 0
    this.pendingChanges = new Map()
  }

  restoreSnapshot (snapshot, options = {}) {
    this.taskList.withoutEvents(() => this.withoutRecording(() => {
      if (options.replace !== false) {
        this.taskList.replace([])
        this.restoreReplicationMetadata(snapshot?.replication)
      }
      const tasks = snapshot?.tasks || []
      tasks.forEach(taskData => {
        const data = copy(taskData)
        const tabs = data.tabs || []
        data.tabs = []
        const taskId = this.createTask(data)
        tabs.forEach(tab => {
          this.addTabState(taskId, tab, { atEnd: true })
        })
        if (tabs.length === 0) {
          this.openTab({}, { taskId })
        } else {
          const selectedTab = tabs.find(tab => tab.selected)
          if (selectedTab) {
            this.selectTabState(selectedTab.id, selectedTab.lastActivity)
          }
        }
      })

      if (this.taskList.getLength() === 0 && options.ensureNotEmpty !== false) {
        const taskId = this.createTask({}, { select: true })
        this.openTab({}, { taskId })
      }
    }))
    return this.getCopyableSnapshot()
  }

  validateChange (change, sourceWindowId) {
    if (!change || change.version !== CHANGE_VERSION) {
      throw new Error('Unsupported Browser Session change version')
    }
    if (change.sourceWindowId !== sourceWindowId) {
      throw new Error('Browser Session change source does not match its transport')
    }
    if (!Number.isInteger(change.sequence) || change.sequence < 1) {
      throw new Error('Browser Session change has an invalid sequence')
    }
    if (!Number.isInteger(change.logicalTime) || change.logicalTime < 1) {
      throw new Error('Browser Session change has an invalid logical time')
    }
    if (change.id !== `${sourceWindowId}:${change.sequence}`) {
      throw new Error('Browser Session change has an invalid id')
    }
    if (typeof change.type !== 'string') {
      throw new Error('Browser Session change is missing a type')
    }
    if ((change.type === 'task-selected' || change.type === 'task-released') && change.windowId !== sourceWindowId) {
      throw new Error('Browser Session Task ownership source does not match its transport')
    }
    if (change.type === 'task-created' && (change.task?.selectedInWindow || change.task?.selectionStamp)) {
      throw new Error('Browser Session Task creation cannot assign ownership')
    }
  }

  applyChangeState (change) {
    const result = { affectedTaskIds: [], closedTabIds: [], localOwnershipLost: false }
    switch (change.type) {
      case 'task-created':
        if (!this.taskList.get(change.task.id)) {
          this.createTask(change.task, { index: change.index })
          result.affectedTaskIds.push(change.task.id)
        }
        break
      case 'task-updated':
        this.updateTask(change.taskId, change.data)
        result.affectedTaskIds.push(change.taskId)
        break
      case 'task-selected':
        return this.applyTaskSelection(change)
      case 'task-released':
        return this.applyTaskRelease(change)
      case 'task-moved':
        this.moveTask(change.taskId, change.index)
        result.affectedTaskIds.push(change.taskId)
        break
      case 'task-closed': {
        const removed = this.removeTaskState(change.taskId)
        if (removed) {
          result.affectedTaskIds.push(change.taskId)
          result.closedTabIds.push(...removed.closedTabIds)
          result.closeWindow = removed.wasSelected
        }
        break
      }
      case 'tab-created': {
        const task = this.taskList.get(change.taskId)
        if (!task) throw new Error('Cannot create a Tab in a missing Task')
        if (!task.tabs.has(change.tab.id)) {
          this.addTabState(change.taskId, change.tab, change.options)
          result.affectedTaskIds.push(change.taskId)
        }
        break
      }
      case 'tab-updated':
        this.updateTab(change.tabId, change.data)
        result.affectedTaskIds.push(change.taskId)
        break
      case 'tab-selected':
        this.selectTabState(change.tabId, change.selectedAt)
        result.affectedTaskIds.push(change.taskId)
        break
      case 'tab-closed': {
        const task = this.taskList.get(change.taskId)
        if (!task) throw new Error('Cannot close a Tab in a missing Task')
        if (this.applyTabClosure(task, change.tabId, change)) {
          result.affectedTaskIds.push(change.taskId)
          result.closedTabIds.push(change.tabId)
        }
        break
      }
      case 'tab-reordered':
        this.moveTabToIndex(change.tabId, change.index)
        result.affectedTaskIds.push(change.taskId)
        break
      case 'tab-moved':
        this.moveTabState(change)
        result.affectedTaskIds.push(change.fromTaskId, change.toTaskId)
        break
      default:
        throw new Error(`Unknown Browser Session change type: ${change.type}`)
    }
    return result
  }

  applyChanges (envelope) {
    const sourceWindowId = envelope?.sourceWindowId
    const changes = envelope?.changes
    const outcome = {
      appliedChanges: [],
      bufferedChanges: [],
      closedTabIds: [],
      closeWindow: false,
      projectSelectedTask: false,
      reason: null,
      selectedTaskId: this.taskList.getSelected()?.id || null,
      showTaskOverlay: false,
      status: 'duplicate'
    }

    if (typeof sourceWindowId !== 'string' || !Array.isArray(changes)) {
      return { ...outcome, reason: 'invalid-envelope', status: 'rejected' }
    }
    try {
      changes.forEach(change => this.validateChange(change, sourceWindowId))
    } catch (error) {
      return { ...outcome, reason: error.message, status: 'rejected' }
    }

    const priorSelectedTaskId = this.taskList.getSelected()?.id || null
    const sourcePending = this.pendingChanges.get(sourceWindowId) || new Map()
    const cursor = this.changeCursors.get(sourceWindowId) || 0
    changes.forEach(change => {
      if (change.sequence > cursor && !sourcePending.has(change.sequence)) {
        sourcePending.set(change.sequence, change)
      }
    })
    this.pendingChanges.set(sourceWindowId, sourcePending)

    const affectedTaskIds = new Set()
    let nextSequence = (this.changeCursors.get(sourceWindowId) || 0) + 1
    while (sourcePending.has(nextSequence)) {
      const change = sourcePending.get(nextSequence)
      let transition
      try {
        transition = this.taskList.withoutEvents(() => this.withoutRecording(() => this.applyChangeState(change)))
      } catch (error) {
        sourcePending.delete(nextSequence)
        outcome.reason = error.message
        outcome.status = 'snapshot-required'
        break
      }

      sourcePending.delete(nextSequence)
      this.changeCursors.set(sourceWindowId, nextSequence)
      this.logicalTime = Math.max(this.logicalTime, change.logicalTime)
      outcome.appliedChanges.push(change.id)
      transition.affectedTaskIds.forEach(taskId => affectedTaskIds.add(taskId))
      outcome.closedTabIds.push(...transition.closedTabIds)
      outcome.closeWindow = outcome.closeWindow || transition.closeWindow === true

      if (transition.localOwnershipLost && !outcome.closeWindow) {
        const acquired = this.taskList.withoutEvents(() => this.acquireTask())
        affectedTaskIds.add(acquired.selectedTaskId)
        outcome.showTaskOverlay = true
      }
      nextSequence++
    }

    outcome.bufferedChanges = Array.from(sourcePending.values())
      .sort((left, right) => left.sequence - right.sequence)
      .map(change => change.id)
    const selectedTaskId = this.taskList.getSelected()?.id || null
    outcome.selectedTaskId = selectedTaskId
    outcome.projectSelectedTask = !outcome.closeWindow && outcome.appliedChanges.length > 0 && (
      priorSelectedTaskId !== selectedTaskId ||
      affectedTaskIds.has(priorSelectedTaskId) ||
      affectedTaskIds.has(selectedTaskId)
    )

    if (outcome.status !== 'snapshot-required') {
      if (outcome.bufferedChanges.length > 0) {
        outcome.status = 'waiting-for-changes'
      } else if (outcome.appliedChanges.length > 0) {
        outcome.status = 'applied'
      }
    }
    if (outcome.appliedChanges.length > 0) {
      this.taskList.emit('state-sync-change', outcome)
    }
    return outcome
  }

  validateData (data) {
    Object.keys(data).forEach(key => {
      if (data[key] === undefined) {
        throw new ReferenceError(`Key ${key} is undefined.`)
      }
    })
  }
}

BrowserSession.CHANGE_VERSION = CHANGE_VERSION

module.exports = BrowserSession
