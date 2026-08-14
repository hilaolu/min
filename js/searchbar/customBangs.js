const browserSession = require('tabState.js')
/* list of the available custom commands */

const { ipcRenderer: ipc } = require('electron')
const fs = require('fs')
const quickScore = require('quick-score').quickScore

const bangsPlugin = require('searchbar/bangsPlugin.js')

const webviews = require('webviews.js')
const browserUI = require('browserUI.js')
const focusMode = require('focusMode.js')
const places = require('places/places.js')
const contentBlockingToggle = require('navbar/contentBlockingToggle.js')
const taskOverlay = require('taskOverlay/taskOverlay.js')
const bookmarkConverter = require('bookmarkConverter.js')
const searchbarPlugins = require('searchbar/searchbarPlugins.js')
const tabEditor = require('navbar/tabEditor.js')
const formatRelativeDate = require('util/relativeDate.js')

function moveToTaskCommand (taskId) {
  // remove the tab from the current task

  const currentTabId = browserSession.tabs.getSelected()
  const newTask = browserSession.tasks.get(taskId)
  browserSession.moveTabToTask(currentTabId, taskId, {
    index: newTask.tabs.count(),
    select: true
  })

  browserUI.switchToTask(newTask.id, { stateAlreadySelected: true })
  browserUI.switchToTab(currentTabId, { stateAlreadySelected: true })

  taskOverlay.show()

  setTimeout(function () {
    taskOverlay.hide()
  }, 600)
}

function switchToTaskCommand (taskId) {
  /* disabled in focus mode */
  if (focusMode.enabled()) {
    focusMode.warn()
    return
  }

  // no task was specified, show all of the tasks
  if (!taskId) {
    taskOverlay.show()
    return
  }

  browserUI.switchToTask(taskId)
}

// returns a task with the same name or index ("1" returns the first task, etc.)
function getTaskByNameOrNumber (text) {
  const textAsNumber = parseInt(text)

  return browserSession.tasks.find((task, index) => (task.name && task.name.toLowerCase() === text) || index + 1 === textAsNumber
  )
}

// return an array of tasks sorted by last activity
// if a search string is present, filter the results with a basic fuzzy search
function searchAndSortTasks (text) {
  let taskResults = browserSession.tasks
    .filter(t => t.id !== browserSession.tasks.getSelected().id)
    .map(t => Object.assign({}, { task: t }, { lastActivity: browserSession.tasks.getLastActivity(t.id) }))

  taskResults = taskResults.sort(function (a, b) {
    return b.lastActivity - a.lastActivity
  })

  if (text !== '') {
    // fuzzy search
    const searchText = text.toLowerCase()

    taskResults = taskResults.filter(function (t) {
      const task = t.task
      const taskName = (task.name || `Task ${browserSession.tasks.getIndex(task.id) + 1}`).toLowerCase()
      const exactMatch = taskName.indexOf(searchText) !== -1
      const fuzzyTitleScore = quickScore(taskName, searchText)

      return (exactMatch || fuzzyTitleScore > 0.4)
    })
  }

  return taskResults
}

function initialize () {
  bangsPlugin.registerCustomBang({
    phrase: '!settings',
    snippet: 'View Settings',
    icon: 'carbon:settings',
    isAction: true,
    fn: function (text) {
      webviews.update(browserSession.tabs.getSelected(), 'min://settings')
    }
  })

  bangsPlugin.registerCustomBang({
    phrase: '!back',
    snippet: 'Go Back',
    isAction: true,
    fn: function (text) {
      webviews.goBack(browserSession.tabs.getSelected())
    }
  })

  bangsPlugin.registerCustomBang({
    phrase: '!forward',
    snippet: 'Go Forward',
    isAction: true,
    fn: function (text) {
      webviews.goForward(browserSession.tabs.getSelected())
    }
  })

  bangsPlugin.registerCustomBang({
    phrase: '!screenshot',
    snippet: 'Take a Screenshot',
    icon: 'carbon:image',
    isAction: true,
    fn: function (text) {
      setTimeout(function () { // wait so that the view placeholder is hidden
        webviews.downloadCapture(browserSession.tabs.getSelected())
      }, 400)
    }
  })

  bangsPlugin.registerCustomBang({
    phrase: '!clearhistory',
    snippet: 'Clear All History',
    icon: 'carbon:trash-can',
    isAction: true,
    fn: function (text) {
      if (confirm('Clear all history and browsing data?')) {
        places.deleteAllHistory()
        ipc.invoke('clearStorageData')
      }
    }
  })

  bangsPlugin.registerCustomBang({
    phrase: '!enableblocking',
    snippet: 'Enable content blocking for this site',
    isAction: true,
    fn: function (text) {
      contentBlockingToggle.enableBlocking(browserSession.tabs.get(browserSession.tabs.getSelected()).url)
    }
  })

  bangsPlugin.registerCustomBang({
    phrase: '!disableblocking',
    snippet: 'Disable content blocking for this site',
    isAction: true,
    fn: function (text) {
      contentBlockingToggle.disableBlocking(browserSession.tabs.get(browserSession.tabs.getSelected()).url)
    }
  })

  bangsPlugin.registerCustomBang({
    phrase: '!movetotask',
    snippet: 'Move this tab to a task',
    icon: 'carbon:folder-move-to',
    isAction: false,
    showSuggestions: function (text, input, event) {
      searchbarPlugins.reset('bangs')

      const taskResults = searchAndSortTasks(text)

      taskResults.forEach(function (t, idx) {
        const task = t.task
        const lastActivity = t.lastActivity

        const taskName = task.name || `Task ${browserSession.tasks.getIndex(task.id) + 1}`

        const data = {
          title: taskName,
          secondaryText: formatRelativeDate(lastActivity),
          fakeFocus: text && idx === 0,
          click: function () {
            tabEditor.hide()

            /* disabled in focus mode */
            if (focusMode.enabled()) {
              focusMode.warn()
              return
            }

            moveToTaskCommand(task.id)
          }
        }

        searchbarPlugins.addResult('bangs', data)
      })
    },

    fn: function (text) {
      /* disabled in focus mode */
      if (focusMode.enabled()) {
        focusMode.warn()
        return
      }

      // use the first search result
      // if there is no search text or no result, need to create a new task
      let task = searchAndSortTasks(text)[0]?.task
      if (!text || !task) {
        task = browserSession.tasks.get(browserSession.createTask({
          name: text
        }, { index: browserSession.tasks.getIndex(browserSession.tasks.getSelected().id) + 1 }))
      }

      return moveToTaskCommand(task.id)
    }

  })

  bangsPlugin.registerCustomBang({
    phrase: '!task',
    snippet: 'Switch to Task',
    icon: 'carbon:folder',
    isAction: false,
    showSuggestions: function (text, input, event) {
      searchbarPlugins.reset('bangs')

      const taskResults = searchAndSortTasks(text)

      taskResults.forEach(function (t, idx) {
        const task = t.task
        const lastActivity = t.lastActivity

        const taskName = task.name || `Task ${browserSession.tasks.getIndex(task.id) + 1}`

        const data = {
          title: taskName,
          secondaryText: formatRelativeDate(lastActivity),
          fakeFocus: text && idx === 0,
          click: function () {
            tabEditor.hide()
            switchToTaskCommand(task.id)
          }
        }

        searchbarPlugins.addResult('bangs', data)
      })
    },
    fn: function (text) {
      if (text) {
      // switch to the first search result
        switchToTaskCommand(searchAndSortTasks(text)[0].task.id)
      } else {
        taskOverlay.show()
      }
    }
  })

  bangsPlugin.registerCustomBang({
    phrase: '!newtask',
    snippet: 'Create a Task',
    icon: 'carbon:folder-add',
    isAction: true,
    fn: function (text) {
      /* disabled in focus mode */
      if (focusMode.enabled()) {
        focusMode.warn()
        return
      }

      taskOverlay.show()

      setTimeout(function () {
        browserUI.addTask()
        if (text) {
          browserSession.updateTask(browserSession.tasks.getSelected().id, { name: text })
        }
      }, 600)
    }
  })

  bangsPlugin.registerCustomBang({
    phrase: '!closetask',
    snippet: 'Close a Task',
    icon: 'carbon:folder-off',
    isAction: false,
    fn: function (text) {
      const currentTask = browserSession.tasks.getSelected()
      let taskToClose

      if (text) {
        taskToClose = getTaskByNameOrNumber(text)
      } else {
        taskToClose = browserSession.tasks.getSelected()
      }

      if (taskToClose) {
        browserUI.closeTask(taskToClose.id)
        if (currentTask.id === taskToClose.id) {
          taskOverlay.show()
          setTimeout(function () {
            taskOverlay.hide()
          }, 600)
        }
      }
    }
  })

  bangsPlugin.registerCustomBang({
    phrase: '!nametask',
    snippet: 'Name this task',
    isAction: false,
    fn: function (text) {
      browserSession.updateTask(browserSession.tasks.getSelected().id, { name: text })
    }
  })

  bangsPlugin.registerCustomBang({
    phrase: '!importbookmarks',
    snippet: 'Import bookmarks from HTML file',
    icon: 'carbon:upload',
    isAction: true,
    fn: async function () {
      const filePath = await ipc.invoke('showOpenDialog', {
        filters: [
          { name: 'HTML files', extensions: ['htm', 'html'] }
        ]
      })

      if (!filePath) {
        return
      }
      fs.readFile(filePath[0], 'utf-8', function (err, data) {
        if (err || !data) {
          console.warn(err)
          return
        }
        bookmarkConverter.import(data)
      })
    }
  })

  bangsPlugin.registerCustomBang({
    phrase: '!exportbookmarks',
    snippet: 'Export bookmarks',
    icon: 'carbon:download',
    isAction: true,
    fn: async function () {
      const data = await bookmarkConverter.exportAll()
      // save the result
      const savePath = await ipc.invoke('showSaveDialog', { defaultPath: 'bookmarks.html' })
      require('fs').writeFileSync(savePath, data)
    }
  })

  bangsPlugin.registerCustomBang({
    phrase: '!addbookmark',
    snippet: 'Add bookmark',
    icon: 'carbon:star',
    fn: function (text) {
      const url = browserSession.tabs.get(browserSession.tabs.getSelected()).url
      if (url) {
        places.updateItem(url, {
          isBookmarked: true,
          tags: (text ? text.split(/\s/g).map(t => t.replace('#', '').trim()) : [])
        })
      }
    }
  })
}

module.exports = { initialize }
