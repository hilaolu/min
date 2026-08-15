const TabList = require('./tab.js')
const TabStack = require('../tabRestore.js')

class TaskList {
  constructor (options = {}) {
    this.tasks = [] // each task is {id, name, tabs: [], tabHistory: TabStack}
    this.events = []
    this.pendingCallbacks = []
    this.pendingCallbackTimeout = null
    this.windowId = options.windowId
    this.now = options.now || Date.now
    this.createId = options.createId || TaskList.getRandomId
    this.eventsEnabled = true
  }

  on (name, fn) {
    this.events.push({ name, fn })
  }

  emit (name, ...data) {
    if (!this.eventsEnabled) return

    this.events.forEach(listener => {
      if (listener.name === name || listener.name === '*') {
        this.pendingCallbacks.push([listener.fn, (listener.name === '*' ? [name] : []).concat(data)])

        // run multiple events in one timeout, since calls to setTimeout() appear to be slow (at least based on timeline data)
        if (!this.pendingCallbackTimeout) {
          this.pendingCallbackTimeout = setTimeout(() => {
            this.pendingCallbacks.forEach(t => t[0].apply(this, t[1]))
            this.pendingCallbacks = []
            this.pendingCallbackTimeout = null
          }, 0)
        }
      }
    })
  }

  add (task = {}, index) {
    const newTask = {
      name: task.name || null,
      tabs: new TabList(task.tabs, this, { now: this.now, createId: this.createId }),
      tabHistory: new TabStack(task.tabHistory),
      collapsed: task.collapsed, // this property must stay undefined if it is already (since there is a difference between "explicitly uncollapsed" and "never collapsed")
      id: task.id || String(this.createId()),
      selectedInWindow: task.selectedInWindow || null,
      selectionStamp: task.selectionStamp || null
    }

    if (index !== undefined) {
      this.tasks.splice(index, 0, newTask)
    } else {
      this.tasks.push(newTask)
    }

    this.emit('task-added', newTask.id, Object.assign({}, newTask, { tabHistory: task.tabHistory, tabs: task.tabs }), index)

    return newTask.id
  }

  update (id, data) {
    const task = this.get(id)

    if (!task) {
      throw new ReferenceError('Attempted to update a task that does not exist.')
    }

    for (var key in data) {
      if (data[key] === undefined) {
        throw new ReferenceError('Key ' + key + ' is undefined.')
      }
      task[key] = data[key]
      this.emit('task-updated', id, key, data[key])
    }
  }

  getStringifyableState () {
    return {
      tasks: this.tasks.map(task => Object.assign({}, task, { tabs: task.tabs.getStringifyableState() })).map(function (task) {
        // remove temporary properties from task
        const result = {}
        Object.keys(task)
          .filter(key => !TaskList.temporaryProperties.includes(key))
          .forEach(key => { result[key] = task[key] })
        return result
      })
    }
  }

  getCopyableState () {
    return {
      tasks: this.tasks.map(task => Object.assign({}, task, { tabs: task.tabs.tabs }))
    }
  }

  get (id) {
    return this.find(task => task.id === id) || null
  }

  getSelected () {
    return this.find(task => task.selectedInWindow === this.windowId)
  }

  byIndex (index) {
    return this.tasks[index]
  }

  getTaskContainingTab (tabId) {
    return this.find(task => task.tabs.has(tabId)) || null
  }

  getIndex (id) {
    return this.tasks.findIndex(task => task.id === id)
  }

  setSelected (id, onWindow = this.windowId) {
    for (var i = 0; i < this.tasks.length; i++) {
      if (this.tasks[i].selectedInWindow === onWindow) {
        this.tasks[i].selectedInWindow = null
      }
      if (this.tasks[i].id === id) {
        this.tasks[i].selectedInWindow = onWindow
      }
    }
    if (onWindow === this.windowId) {
      this.emit('task-selected', id)
      if (this.get(id).tabs.getSelected()) {
        this.emit('tab-selected', this.get(id).tabs.getSelected(), id)
      }
    }
  }

  clearSelected (onWindow = this.windowId) {
    this.tasks.forEach(task => {
      if (task.selectedInWindow === onWindow) {
        task.selectedInWindow = null
        task.selectionStamp = null
      }
    })
  }

  destroy (id) {
    const index = this.getIndex(id)

    if (index >= 0) {
      // emit the tab-destroyed event for all tabs in this task
      this.get(id).tabs.forEach(tab => this.emit('tab-destroyed', tab.id, id))

      this.emit('task-destroyed', id)
    }

    if (index < 0) return false

    this.tasks.splice(index, 1)

    return index
  }

  move (id, index) {
    const currentIndex = this.getIndex(id)
    if (currentIndex < 0) return false
    const task = this.tasks.splice(currentIndex, 1)[0]
    const targetIndex = Math.max(0, Math.min(index, this.tasks.length))
    this.tasks.splice(targetIndex, 0, task)
    return targetIndex
  }

  replace (tasks = []) {
    this.tasks = tasks
  }

  withoutEvents (callback) {
    const eventsEnabled = this.eventsEnabled
    this.eventsEnabled = false
    try {
      return callback()
    } finally {
      this.eventsEnabled = eventsEnabled
    }
  }

  getLastActivity (id) {
    var tabs = this.get(id).tabs
    var lastActivity = 0

    for (var i = 0; i < tabs.count(); i++) {
      if (tabs.getAtIndex(i).lastActivity > lastActivity) {
        lastActivity = tabs.getAtIndex(i).lastActivity
      }
    }

    return lastActivity
  }

  isCollapsed (id) {
    var task = this.get(id)
    return task.collapsed || (task.collapsed === undefined && this.now() - this.getLastActivity(task.id) > (7 * 24 * 60 * 60 * 1000))
  }

  getLength () {
    return this.tasks.length
  }

  map (fun) { return this.tasks.map(fun) }

  forEach (fun) { return this.tasks.forEach(fun) }

  indexOf (task) { return this.tasks.indexOf(task) }

  slice (...args) { return this.tasks.slice.apply(this.tasks, args) }

  splice (...args) { return this.tasks.splice.apply(this.tasks, args) }

  filter (...args) { return this.tasks.filter.apply(this.tasks, args) }

  find (filter) {
    for (var i = 0, len = this.tasks.length; i < len; i++) {
      if (filter(this.tasks[i], i, this.tasks)) {
        return this.tasks[i]
      }
    }
  }

  static getRandomId () {
    return Math.round(Math.random() * 100000000000000000)
  }
}

TaskList.temporaryProperties = ['selectedInWindow', 'selectionStamp']

module.exports = TaskList
