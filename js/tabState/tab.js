class TabList {
  constructor (tabs, parentTaskList, options = {}) {
    this.tabs = tabs || []
    this.parentTaskList = parentTaskList
    this.taskId = options.taskId
    this.now = options.now || Date.now
    this.createId = options.createId || (() => Math.round(Math.random() * 100000000000000000))
    this.tabById = new Map()
    this.selectedId = null
    this.rebuildIndex()
  }

  add (tab = {}, options = {}) {
    var tabId = String(tab.id || this.createId()) // you can pass an id that will be used, or a random one will be generated.

    var newTab = {
      url: tab.url || '',
      title: tab.title || '',
      id: tabId,
      lastActivity: tab.lastActivity || this.now(),
      secure: tab.secure,
      private: tab.private || false,
      readerable: tab.readerable || false,
      themeColor: tab.themeColor,
      backgroundColor: tab.backgroundColor,
      scrollPosition: tab.scrollPosition || 0,
      selected: tab.selected || false,
      muted: tab.muted || false,
      loaded: tab.loaded || false,
      hasAudio: false,
      isFileView: false,
      hasWebContents: false
    }

    if (options.atEnd) {
      this.tabs.push(newTab)
    } else {
      this.tabs.splice(this.getSelectedIndex() + 1, 0, newTab)
    }

    this.tabById.set(tabId, newTab)
    if (newTab.selected) this.selectedId = tabId
    this.parentTaskList.registerTab(this.taskId, newTab)

    this.parentTaskList.emit('tab-added', tabId, newTab, options, this.taskId)

    return tabId
  }

  update (id, data) {
    if (!this.has(id)) {
      throw new ReferenceError('Attempted to update a tab that does not exist.')
    }
    const tab = this.tabById.get(id)

    Object.keys(data).forEach(function (key) {
      if (key === 'id' || key === 'selected') {
        throw new ReferenceError(`Key ${key} must be changed through a Tab lifecycle workflow.`)
      }
      if (data[key] === undefined) {
        throw new ReferenceError('Key ' + key + ' is undefined.')
      }
    })

    for (var key in data) {
      tab[key] = data[key]
      this.parentTaskList.emit('tab-updated', id, key, data[key], this.taskId)
      // changing URL erases scroll position
      if (key === 'url') {
        tab.scrollPosition = 0
        this.parentTaskList.emit('tab-updated', id, 'scrollPosition', 0, this.taskId)
      }
    }
  }

  destroy (id) {
    const index = this.getIndex(id)
    if (index < 0) return false

    const containingTask = this.taskId

    this.parentTaskList.get(this.taskId).tabHistory.push(this.toPermanentState(this.tabs[index]))
    this.tabs.splice(index, 1)
    this.tabById.delete(id)
    this.parentTaskList.unregisterTab(id)
    if (this.selectedId === id) this.selectedId = null

    this.parentTaskList.emit('tab-destroyed', id, containingTask)

    return index
  }

  get (id) {
    if (!id) { // no id provided, return an array of all tabs
      // it is important to copy the tab objects when returning them. Otherwise, the original tab objects get modified when the returned tabs are modified (such as when processing a url).
      var tabsToReturn = []
      for (let i = 0; i < this.tabs.length; i++) {
        tabsToReturn.push(Object.assign({}, this.tabs[i]))
      }
      return tabsToReturn
    }
    const tab = this.tabById.get(id)
    return tab ? Object.assign({}, tab) : undefined
  }

  has (id) {
    return this.tabById.has(id)
  }

  getIndex (id) {
    for (var i = 0; i < this.tabs.length; i++) {
      if (this.tabs[i].id === id) {
        return i
      }
    }
    return -1
  }

  getSelected () {
    return this.selectedId
  }

  getSelectedIndex () {
    for (var i = 0; i < this.tabs.length; i++) {
      if (this.tabs[i].selected) {
        return i
      }
    }
    return null
  }

  getAtIndex (index) {
    return this.tabs[index] || undefined
  }

  setSelected (id, selectedAt = this.now()) {
    if (!this.has(id)) {
      throw new ReferenceError('Attempted to select a tab that does not exist.')
    }
    const previouslySelected = this.selectedId && this.tabById.get(this.selectedId)
    if (previouslySelected && previouslySelected.id !== id) {
      previouslySelected.selected = false
      previouslySelected.lastActivity = selectedAt
    }
    const selected = this.tabById.get(id)
    selected.selected = true
    selected.lastActivity = selectedAt
    this.selectedId = id
    this.parentTaskList.emit('tab-selected', id, this.taskId)
  }

  moveBy (id, offset) {
    var currentIndex = this.getIndex(id)
    var newIndex = currentIndex + offset
    var newIndexTab = this.getAtIndex(newIndex)
    if (newIndexTab) {
      var currentTab = this.getAtIndex(currentIndex)
      this.splice(currentIndex, 1, newIndexTab)
      this.splice(newIndex, 1, currentTab)
    }
    // This doesn't need to dispatch an event because splice will dispatch already
  }

  count () {
    return this.tabs.length
  }

  isEmpty () {
    if (!this.tabs || this.tabs.length === 0) {
      return true
    }

    if (this.tabs.length === 1 && !this.tabs[0].url) {
      return true
    }

    return false
  }

  forEach (fun) {
    return this.tabs.forEach(fun)
  }

  splice (...args) {
    const containingTask = this.taskId

    this.parentTaskList.emit('tab-splice', containingTask, ...args)
    const result = this.tabs.splice.apply(this.tabs, args)
    this.rebuildIndex()
    this.parentTaskList.reindexTaskTabs(this.taskId)
    return result
  }

  rebuildIndex () {
    this.tabById.clear()
    this.selectedId = null
    this.tabs.forEach(tab => {
      this.tabById.set(tab.id, tab)
      if (tab.selected) this.selectedId = tab.id
    })
  }

  toPermanentState (tab) {
    // removes temporary properties of the tab that are lost on page reload

    const result = {}
    Object.keys(tab)
      .filter(key => !TabList.temporaryProperties.includes(key))
      .forEach(key => { result[key] = tab[key] })

    return result
  }

  getStringifyableState () {
    return this.tabs.map(tab => this.toPermanentState(tab))
  }
}

// tab properties that shouldn't be saved to disk
TabList.temporaryProperties = ['hasAudio', 'loaded', 'hasWebContents']

module.exports = TabList
