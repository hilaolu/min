const browserSession = require('tabState.js')
var statistics = require('js/statistics.js')
var searchEngine = require('js/util/searchEngine.js')
var urlParser = require('js/util/urlParser.js')

/* common actions that affect different parts of the UI (webviews, tabstrip, etc) */

var settings = require('util/settings/settings.js')
var webviews = require('webviews.js')
var focusMode = require('focusMode.js')
var tabBar = require('navbar/tabBar.js')
var tabEditor = require('navbar/tabEditor.js')
var searchbar = require('searchbar/searchbar.js')

/* creates a new task */

function addTask () {
  // insert after current task
  let index
  if (browserSession.tasks.getSelected()) {
    index = browserSession.tasks.getIndex(browserSession.tasks.getSelected().id) + 1
  }
  const taskId = browserSession.createTask({}, { index, select: true })

  tabBar.updateAll()
  addTab({}, { taskId })
  return taskId
}

/* creates a new tab */

/*
options
  options.enterEditMode - whether to enter editing mode when the tab is created. Defaults to true.
  options.openInBackground - whether to open the tab without switching to it. Defaults to false.
*/
function addTab (tab = {}, options = {}) {
  return presentOpenedTab(browserSession.openTab(tab, options), options)
}

function duplicateTab (tabId, options = {}) {
  return presentOpenedTab(browserSession.duplicateTab(tabId, options), options)
}

function restoreTab (taskId, options = {}) {
  const result = browserSession.restoreClosedTab(taskId, options)
  return result ? presentOpenedTab(result, options) : null
}

function presentOpenedTab (result, options) {
  const tabId = result.tabId

  result.closedTabIds.forEach(function (closedTabId) {
    tabBar.removeTab(closedTabId)
    webviews.destroy(closedTabId)
  })

  tabBar.addTab(tabId)
  webviews.add(tabId, options.existingViewId)

  if (!options.openInBackground) {
    switchToTab(tabId, {
      focusWebview: options.enterEditMode === false,
      stateAlreadySelected: true
    })
    if (options.enterEditMode !== false) {
      tabEditor.show(tabId)
    }
  } else {
    tabBar.getTab(tabId).scrollIntoView()
  }
  return tabId
}

function moveTabLeft (tabId = browserSession.tabs.getSelected()) {
  browserSession.moveTabBy(tabId, -1)
  tabBar.reconcileOrder()
}

function moveTabRight (tabId = browserSession.tabs.getSelected()) {
  browserSession.moveTabBy(tabId, 1)
  tabBar.reconcileOrder()
}

/* destroys a task object and the associated webviews */

function destroyTask (id) {
  return closeTask(id)
}

/* destroys the webview and tab element for a tab */
function destroyTab (id) {
  const result = browserSession.closeTab(id)
  if (!result) return false
  tabBar.removeTab(id)
  webviews.destroy(id)
  tabBar.reconcileOrder()
  if (result.selectedTabId && browserSession.tasks.getSelected()?.id === result.taskId) {
    switchToTab(result.selectedTabId, { stateAlreadySelected: true })
  }
  return result
}

function discardClosedTabs (tabIds) {
  tabIds.forEach(function (tabId) {
    tabBar.removeTab(tabId)
    webviews.destroy(tabId)
  })
}

/* destroys a task, and either switches to the next most-recent task or creates a new one */

function closeTask (taskId) {
  const result = browserSession.closeTask(taskId)
  if (!result) return false
  result.closedTabIds.forEach(function (tabId) {
    webviews.destroy(tabId)
  })
  tabBar.updateAll()
  if (result.selectedTaskId) {
    switchToTask(result.selectedTaskId, { stateAlreadySelected: true })
  }
  return result
}

/* destroys a tab, and either switches to the next tab or creates a new one */

function closeTab (tabId) {
  /* disabled in focus mode */
  if (focusMode.enabled()) {
    focusMode.warn()
    return
  }

  return destroyTab(tabId)
}

/* changes the currently-selected task and updates the UI */

function setWindowTitle (taskData) {
  if (taskData.name) {
    document.title = (taskData.name.length > 100 ? taskData.name.substring(0, 100) + '...' : taskData.name)
  } else {
    document.title = 'Min'
  }
}

function switchToTask (id, options = {}) {
  if (!options.stateAlreadySelected) {
    browserSession.selectTask(id)
  }

  tabBar.updateAll()

  var taskData = browserSession.tasks.get(id)

  if (taskData.tabs.count() > 0) {
    var selectedTab = taskData.tabs.getSelected()

    // if the task has no tab that is selected, switch to the most recent one

    if (!selectedTab) {
      selectedTab = taskData.tabs.get().sort(function (a, b) {
        return b.lastActivity - a.lastActivity
      })[0].id
    }

    switchToTab(selectedTab, { stateAlreadySelected: options.stateAlreadySelected })
  } else {
    addTab({}, { taskId: id })
  }

  setWindowTitle(taskData)
}

browserSession.tasks.on('task-updated', function (id, key) {
  if (key === 'name' && id === browserSession.tasks.getSelected().id) {
    setWindowTitle(browserSession.tasks.get(id))
  }
})

/* switches to a tab - update the webview, state, tabstrip, etc. */

function switchToTab (id, options) {
  options = options || {}

  if (!options.stateAlreadySelected) {
    browserSession.selectTab(id)
  }
  tabBar.setActiveTab(id)
  webviews.setSelected(id, {
    focus: options.focusWebview !== false
  })

  tabEditor.hide()

  if (!browserSession.tabs.get(id).url) {
    document.body.classList.add('is-ntp')
  } else {
    document.body.classList.remove('is-ntp')
  }
}

browserSession.tasks.on('tab-updated', function (id, key) {
  if (key === 'url' && id === browserSession.tabs.getSelected()) {
    document.body.classList.remove('is-ntp')
  }
})

webviews.bindEvent('popup-created', function (tabId, event) {
  addTab({
    // in most cases, initialURL will be overwritten once the popup loads, but if the URL is a downloaded file, it will remain the same
    url: event.initialURL,
    private: browserSession.tabs.get(tabId).private
  }, { enterEditMode: false, existingViewId: event.popupId })
})

webviews.bindEvent('new-tab-requested', function (tabId, event) {
  addTab({
    url: event.url,
    private: browserSession.tabs.get(tabId).private // inherit private status from the current tab
  }, {
    enterEditMode: false,
    openInBackground: !settings.get('openTabsInForeground') && !event.openInForeground
  })
})

webviews.bindIPC('close-window', function (tabId, args) {
  closeTab(tabId)
})

require('rendererHost.js').onFileViewChanged(function (data) {
  browserSession.tabs.get().forEach(function (tab) {
    if (tab.url === data.url) {
      browserSession.updateTab(tab.id, { isFileView: data.isFileView })
    }
  })
})

searchbar.events.on('url-selected', function (data) {
  var searchbarQuery = searchEngine.getSearch(urlParser.parse(data.url))
  if (searchbarQuery) {
    statistics.incrementValue('searchCounts.' + searchbarQuery.engine)
  }

  if (data.background) {
    addTab({
      url: data.url,
      private: browserSession.tabs.get(browserSession.tabs.getSelected()).private
    }, {
      enterEditMode: false,
      openInBackground: !data.openInForeground
    })
  } else {
    webviews.update(browserSession.tabs.getSelected(), data.url)
    tabEditor.hide()
  }
})

tabBar.events.on('tab-selected', function (id) {
  switchToTab(id)
})

tabBar.events.on('tab-closed', function (id) {
  closeTab(id)
})

module.exports = {
  addTask,
  addTab,
  duplicateTab,
  discardClosedTabs,
  destroyTask,
  destroyTab,
  closeTask,
  closeTab,
  switchToTask,
  switchToTab,
  moveTabLeft,
  moveTabRight,
  restoreTab
}
