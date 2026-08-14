const TaskList = require('./task.js')

const CHANGE_VERSION = 1

function copy (value) {
  return JSON.parse(JSON.stringify(value))
}

class BrowserSession {
  constructor (options = {}) {
    this.windowId = options.windowId || 'default'
    this.now = options.now || Date.now
    this.createId = options.createId || (() => Math.round(Math.random() * 100000000000000000))
    this.changeSequence = 0
    this.changeListeners = []
    this.appliedChanges = new Set()
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

  createChange (type, data) {
    const change = {
      version: CHANGE_VERSION,
      id: `${this.windowId}:${++this.changeSequence}`,
      type,
      ...copy(data)
    }
    this.appliedChanges.add(change.id)
    this.changeListeners.forEach(listener => listener(change))
    return change
  }

  copyTask (task) {
    return {
      id: task.id,
      name: task.name,
      collapsed: task.collapsed,
      selectedInWindow: task.selectedInWindow,
      tabHistory: copy(task.tabHistory),
      tabs: task.tabs.get().map(tab => copy(tab))
    }
  }

  createTask (task = {}, options = {}) {
    const id = this.taskList.add(task, options.index, options.emitLegacy !== false)
    const createdTask = this.taskList.get(id)

    if (options.record !== false) {
      this.createChange('task-created', {
        task: this.copyTask(createdTask),
        index: options.index
      })
    }
    if (options.select) {
      this.selectTask(id, options)
    }
    return id
  }

  updateTask (taskId, data, options = {}) {
    this.validateData(data)
    this.taskList.update(taskId, data, options.emitLegacy !== false)
    return options.record !== false
      ? this.createChange('task-updated', { taskId, data })
      : null
  }

  selectTask (taskId, options = {}) {
    if (!this.taskList.get(taskId)) {
      throw new ReferenceError('Attempted to select a task that does not exist.')
    }
    const selectedInWindow = options.windowId || this.windowId
    this.taskList.setSelected(taskId, options.emitLegacy !== false, selectedInWindow)
    if (options.record !== false) {
      this.createChange('task-selected', { taskId, windowId: selectedInWindow })
    }
    return taskId
  }

  moveTask (taskId, index, options = {}) {
    const currentIndex = this.taskList.getIndex(taskId)
    if (currentIndex < 0) {
      throw new ReferenceError('Attempted to move a task that does not exist.')
    }
    const task = this.taskList.tasks.splice(currentIndex, 1)[0]
    const targetIndex = Math.max(0, Math.min(index, this.taskList.tasks.length))
    this.taskList.tasks.splice(targetIndex, 0, task)
    if (options.record !== false) {
      this.createChange('task-moved', { taskId, index: targetIndex })
    }
    return targetIndex
  }

  closeTask (taskId, options = {}) {
    const task = this.taskList.get(taskId)
    if (!task) return false

    const wasSelected = task.selectedInWindow === this.windowId
    const closedTabIds = task.tabs.get().map(tab => tab.id)
    this.taskList.destroy(taskId, options.emitLegacy !== false)
    if (options.record !== false) {
      this.createChange('task-closed', { taskId })
    }

    let selectedTaskId = this.taskList.getSelected()?.id || null
    let createdTabId = null
    if (wasSelected) {
      if (this.taskList.getLength() === 0) {
        selectedTaskId = this.createTask({}, {
          emitLegacy: options.emitLegacy,
          record: options.record,
          select: true
        })
        createdTabId = this.openTab({}, {
          emitLegacy: options.emitLegacy,
          record: options.record,
          taskId: selectedTaskId
        }).tabId
      } else {
        selectedTaskId = this.getMostRecentTask().id
        this.selectTask(selectedTaskId, options)
      }
    }

    return { closedTabIds, createdTabId, selectedTaskId }
  }

  openTab (tab = {}, options = {}) {
    let taskId = options.taskId || this.taskList.getSelected()?.id
    if (!taskId) {
      taskId = this.createTask({}, {
        emitLegacy: options.emitLegacy,
        record: options.record,
        select: true
      })
    }
    const task = this.taskList.get(taskId)
    if (!task) {
      throw new ReferenceError('Attempted to add a tab to a task that does not exist.')
    }

    const selectedTabId = task.tabs.getSelected()
    const selectedTab = selectedTabId ? task.tabs.get(selectedTabId) : null
    const tabId = task.tabs.add(tab, { atEnd: options.atEnd }, options.emitLegacy !== false)
    if (options.record !== false) {
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
      task.tabs.destroy(selectedTabId, options.emitLegacy !== false)
      closedTabIds.push(selectedTabId)
      if (options.record !== false) {
        this.createChange('tab-closed', { taskId, tabId: selectedTabId })
      }
    }

    if (!options.openInBackground) {
      this.selectTab(tabId, options)
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

  updateTab (tabId, data, options = {}) {
    this.validateData(data)
    const task = this.taskList.getTaskContainingTab(tabId)
    if (!task) {
      throw new ReferenceError('Attempted to update a tab that does not exist.')
    }
    task.tabs.update(tabId, data, options.emitLegacy !== false)
    if (options.record !== false) {
      this.createChange('tab-updated', { taskId: task.id, tabId, data })
    }
  }

  selectTab (tabId, options = {}) {
    const task = this.taskList.getTaskContainingTab(tabId)
    if (!task) {
      throw new ReferenceError('Attempted to select a tab that does not exist.')
    }
    task.tabs.setSelected(tabId, options.emitLegacy !== false)
    if (options.record !== false) {
      this.createChange('tab-selected', { taskId: task.id, tabId })
    }
    return tabId
  }

  closeTab (tabId, options = {}) {
    const task = this.taskList.getTaskContainingTab(tabId)
    if (!task) return false

    const index = task.tabs.getIndex(tabId)
    const wasSelected = task.tabs.getSelected() === tabId
    const nextTab = wasSelected
      ? task.tabs.getAtIndex(index - 1) || task.tabs.getAtIndex(index + 1)
      : null

    task.tabs.destroy(tabId, options.emitLegacy !== false)

    let selectedTabId = task.tabs.getSelected()
    let createdTabId = null
    if (task.tabs.count() === 0) {
      const result = this.openTab({}, {
        emitLegacy: options.emitLegacy,
        record: false,
        taskId: task.id
      })
      createdTabId = result.tabId
      selectedTabId = result.tabId
    } else if (wasSelected) {
      selectedTabId = nextTab.id
      this.selectTab(selectedTabId, { ...options, record: false })
    }

    if (options.record !== false) {
      this.createChange('tab-closed', {
        replacementTab: createdTabId ? task.tabs.get(createdTabId) : null,
        selectedTabId,
        taskId: task.id,
        tabId
      })
    }

    return { createdTabId, selectedTabId, taskId: task.id }
  }

  moveTabBy (tabId, offset, options = {}) {
    const task = this.taskList.getTaskContainingTab(tabId)
    if (!task) {
      throw new ReferenceError('Attempted to move a tab that does not exist.')
    }
    return this.moveTabToIndex(tabId, task.tabs.getIndex(tabId) + offset, options)
  }

  moveTabToIndex (tabId, index, options = {}) {
    const task = this.taskList.getTaskContainingTab(tabId)
    if (!task) {
      throw new ReferenceError('Attempted to move a tab that does not exist.')
    }
    const currentIndex = task.tabs.getIndex(tabId)
    const targetIndex = Math.max(0, Math.min(index, task.tabs.count() - 1))
    if (currentIndex === targetIndex) return targetIndex
    const tab = task.tabs.tabs.splice(currentIndex, 1)[0]
    task.tabs.tabs.splice(targetIndex, 0, tab)
    if (options.emitLegacy !== false) {
      this.taskList.emit('tab-reordered', tabId, task.id, targetIndex)
    }
    if (options.record !== false) {
      this.createChange('tab-reordered', { taskId: task.id, tabId, index: targetIndex })
    }
    return targetIndex
  }

  moveTabToTask (tabId, targetTaskId, options = {}) {
    const sourceTask = this.taskList.getTaskContainingTab(tabId)
    const targetTask = this.taskList.get(targetTaskId)
    if (!sourceTask || !targetTask) {
      throw new ReferenceError('Attempted to move a tab using a task or tab that does not exist.')
    }
    if (sourceTask.id === targetTask.id) {
      return this.moveTabToIndex(tabId, options.index ?? targetTask.tabs.count() - 1, options)
    }

    const sourceIndex = sourceTask.tabs.getIndex(tabId)
    const wasSelected = sourceTask.tabs.getSelected() === tabId
    const movedTab = sourceTask.tabs.tabs.splice(sourceIndex, 1)[0]
    movedTab.selected = false
    const targetIndex = Math.max(0, Math.min(options.index ?? targetTask.tabs.count(), targetTask.tabs.count()))
    targetTask.tabs.tabs.splice(targetIndex, 0, movedTab)

    let sourceSelectedTabId = sourceTask.tabs.getSelected()
    let sourceReplacement = null
    if (sourceTask.tabs.count() === 0) {
      const replacementId = sourceTask.tabs.add({}, {}, options.emitLegacy !== false)
      sourceTask.tabs.setSelected(replacementId, options.emitLegacy !== false)
      sourceSelectedTabId = replacementId
      sourceReplacement = sourceTask.tabs.get(replacementId)
    } else if (wasSelected) {
      const replacement = sourceTask.tabs.getAtIndex(sourceIndex - 1) || sourceTask.tabs.getAtIndex(sourceIndex)
      sourceTask.tabs.setSelected(replacement.id, options.emitLegacy !== false)
      sourceSelectedTabId = replacement.id
    }

    if (options.select) {
      this.selectTask(targetTaskId, { ...options, record: false })
      this.selectTab(tabId, { ...options, record: false })
    }
    if (options.emitLegacy !== false) {
      this.taskList.emit('tab-moved', tabId, sourceTask.id, targetTaskId, targetIndex)
    }
    if (options.record !== false) {
      this.createChange('tab-moved', {
        fromTaskId: sourceTask.id,
        index: targetIndex,
        select: Boolean(options.select),
        sourceReplacement,
        sourceSelectedTabId,
        tab: copy(movedTab),
        tabId,
        toTaskId: targetTaskId
      })
    }
    return { sourceReplacement, sourceSelectedTabId, targetIndex }
  }

  getTab (tabId) {
    const task = this.taskList.getTaskContainingTab(tabId)
    return task ? task.tabs.get(tabId) : null
  }

  getMostRecentTask () {
    return this.taskList.slice().sort((a, b) => this.taskList.getLastActivity(b.id) - this.taskList.getLastActivity(a.id))[0] || null
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
      tasks: this.taskList.map(task => this.copyTask(task))
    }
  }

  restoreSnapshot (snapshot, options = {}) {
    const restoreOptions = { emitLegacy: false, record: false }
    if (options.replace !== false) {
      this.taskList.tasks = []
    }
    const tasks = snapshot?.tasks || []
    tasks.forEach(taskData => {
      const data = copy(taskData)
      const tabs = data.tabs || []
      data.tabs = []
      const taskId = this.createTask(data, {
        ...restoreOptions,
        select: false
      })
      tabs.forEach(tab => {
        this.openTab(tab, {
          ...restoreOptions,
          atEnd: true,
          openInBackground: true,
          taskId
        })
      })
      if (tabs.length === 0) {
        this.openTab({}, {
          ...restoreOptions,
          taskId
        })
      } else {
        const selectedTab = tabs.find(tab => tab.selected)
        if (selectedTab) {
          this.selectTab(selectedTab.id, restoreOptions)
        }
      }
    })

    if (this.taskList.getLength() === 0 && options.ensureNotEmpty !== false) {
      const taskId = this.createTask({}, {
        ...restoreOptions,
        select: true
      })
      this.openTab({}, {
        ...restoreOptions,
        taskId
      })
    }
    return this.getCopyableSnapshot()
  }

  applyChange (change) {
    if (!change || change.version !== CHANGE_VERSION) {
      throw new Error('Unsupported Browser Session change version')
    }
    if (!change.id) {
      throw new Error('Browser Session change is missing an id')
    }
    if (this.appliedChanges.has(change.id)) return false

    const options = { emitLegacy: false, record: false }
    switch (change.type) {
      case 'task-created':
        if (this.taskList.get(change.task.id)) return false
        this.createTask(change.task, { ...options, index: change.index })
        break
      case 'task-updated':
        this.updateTask(change.taskId, change.data, options)
        break
      case 'task-selected':
        this.selectTask(change.taskId, { ...options, windowId: change.windowId })
        break
      case 'task-moved':
        this.moveTask(change.taskId, change.index, options)
        break
      case 'task-closed':
        if (!this.taskList.get(change.taskId)) return false
        this.taskList.destroy(change.taskId, false)
        break
      case 'tab-created': {
        const task = this.taskList.get(change.taskId)
        if (!task || task.tabs.has(change.tab.id)) return false
        task.tabs.add(change.tab, change.options, false)
        break
      }
      case 'tab-updated':
        this.updateTab(change.tabId, change.data, options)
        break
      case 'tab-selected':
        this.selectTab(change.tabId, options)
        break
      case 'tab-closed': {
        const task = this.taskList.get(change.taskId)
        if (!task || !task.tabs.has(change.tabId)) return false
        task.tabs.destroy(change.tabId, false)
        if (change.replacementTab && !task.tabs.has(change.replacementTab.id)) {
          task.tabs.add(change.replacementTab, {}, false)
        }
        if (change.selectedTabId && task.tabs.has(change.selectedTabId)) {
          task.tabs.setSelected(change.selectedTabId, false)
        }
        break
      }
      case 'tab-reordered':
        this.moveTabToIndex(change.tabId, change.index, options)
        break
      case 'tab-moved':
        this.applyTabMove(change)
        break
      default:
        throw new Error(`Unknown Browser Session change type: ${change.type}`)
    }

    this.appliedChanges.add(change.id)
    this.taskList.emit('state-sync-change')
    return true
  }

  applyTabMove (change) {
    const sourceTask = this.taskList.get(change.fromTaskId)
    const targetTask = this.taskList.get(change.toTaskId)
    if (!sourceTask || !targetTask || !sourceTask.tabs.has(change.tabId) || targetTask.tabs.has(change.tabId)) {
      throw new Error('Cannot apply invalid Browser Session tab move')
    }
    const sourceIndex = sourceTask.tabs.getIndex(change.tabId)
    const movedTab = sourceTask.tabs.tabs.splice(sourceIndex, 1)[0]
    targetTask.tabs.tabs.splice(change.index, 0, movedTab)
    if (change.sourceReplacement) {
      sourceTask.tabs.add(change.sourceReplacement, {}, false)
    }
    if (change.sourceSelectedTabId && sourceTask.tabs.has(change.sourceSelectedTabId)) {
      sourceTask.tabs.setSelected(change.sourceSelectedTabId, false)
    }
    if (change.select) {
      this.taskList.setSelected(change.toTaskId, false, this.windowId)
      targetTask.tabs.setSelected(change.tabId, false)
    }
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
