const { ipcRenderer: ipc } = require('electron')
const fs = require('fs')
const path = require('path')
const writeFileAtomic = require('write-file-atomic')

const browserSession = require('tabState.js')
const browserUI = require('browserUI.js')
const settings = require('util/settings/settings.js')
const statistics = require('js/statistics.js')
const tabEditor = require('navbar/tabEditor.js')
const taskOverlay = require('taskOverlay/taskOverlay.js')

const sessionRestore = {
  savePath: path.join(window.globalArgs['user-data-path'], 'sessionRestore.json'),
  previousState: null,

  save: function (forceSave, sync) {
    // Only one window (the focused one) should write the shared snapshot.
    if (!document.body.classList.contains('focused')) return

    const state = browserSession.getPersistedSnapshot()

    // If startupTabOption is "open a new blank task", don't save the current Task's Tabs.
    if (settings.get('startupTabOption') === 3) {
      state.tasks.forEach(function (task) {
        if (browserSession.tasks.get(task.id).selectedInWindow) {
          task.tabs = []
        }
      })
    }

    const stateString = JSON.stringify(state)
    if (forceSave !== true && stateString === sessionRestore.previousState) return

    const data = JSON.stringify({
      version: 2,
      state,
      saveTime: Date.now()
    })
    if (sync === true) {
      writeFileAtomic.sync(sessionRestore.savePath, data, {})
    } else {
      writeFileAtomic(sessionRestore.savePath, data, {}, function (err) {
        if (err) {
          console.warn(err)
          statistics.incrementValue('sessionRestoreSaveAsyncWriteErrors')
        }
      })
    }
    sessionRestore.previousState = stateString
  },

  createInitialSession: function (url = '') {
    const taskId = browserSession.createTask({}, { select: true })
    return browserUI.addTab({ url }, {
      enterEditMode: !url,
      taskId
    })
  },

  restoreFromFile: function () {
    let savedStringData
    try {
      savedStringData = fs.readFileSync(sessionRestore.savePath, 'utf-8')
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn('failed to read session restore data', error)
      }
    }

    const startupConfigOption = settings.get('startupTabOption')
    if (!savedStringData) {
      sessionRestore.createInitialSession('https://minbrowser.github.io/min/tour')
      return
    }

    try {
      const data = JSON.parse(savedStringData)
      if ((data.version && data.version !== 2) || !data.state?.tasks?.length) {
        sessionRestore.createInitialSession()
        return
      }

      browserSession.restoreSnapshot(data.state)

      const mostRecentTasks = browserSession.tasks.slice().sort((a, b) => {
        return browserSession.tasks.getLastActivity(b.id) - browserSession.tasks.getLastActivity(a.id)
      })
      const mostRecentTask = mostRecentTasks[0]

      if (mostRecentTask.tabs.isEmpty() || startupConfigOption === 1) {
        browserUI.switchToTask(mostRecentTask.id)
        if (browserSession.tabs.isEmpty()) {
          tabEditor.show(browserSession.tabs.getSelected())
        }
      } else {
        window.createdNewTaskOnStartup = true
        const lastTask = browserSession.tasks.byIndex(browserSession.tasks.getLength() - 1)
        if (lastTask && lastTask.tabs.isEmpty() && !lastTask.name) {
          browserUI.switchToTask(lastTask.id)
          tabEditor.show(lastTask.tabs.getSelected())
        } else {
          browserUI.addTask()
        }
      }
    } catch (error) {
      console.error('restoring session failed: ', error)

      const backupSavePath = path.join(window.globalArgs['user-data-path'], 'sessionRestoreBackup-' + Date.now() + '.json')
      writeFileAtomic.sync(backupSavePath, savedStringData, {})

      browserSession.initialize()
      const taskId = browserSession.createTask({}, { select: true })
      browserUI.addTab({
        url: 'min://app/pages/sessionRestoreError/index.html?backupLoc=' + encodeURIComponent(backupSavePath)
      }, {
        enterEditMode: false,
        taskId
      })
      statistics.incrementValue('sessionRestorationErrors')
    }
  },

  syncWithWindow: function () {
    const snapshot = ipc.sendSync('request-tab-state')
    browserSession.restoreSnapshot(snapshot)

    if (Object.hasOwn(window.globalArgs, 'initial-task')) {
      browserUI.switchToTask(window.globalArgs['initial-task'])
      return
    }

    const newTaskCandidates = browserSession.tasks
      .filter(task => task.tabs.isEmpty() && !task.selectedInWindow && !task.name)
      .sort((a, b) => browserSession.tasks.getLastActivity(b.id) - browserSession.tasks.getLastActivity(a.id))
    if (newTaskCandidates.length > 0) {
      browserUI.switchToTask(newTaskCandidates[0].id)
      tabEditor.show(browserSession.tabs.getSelected())
    } else {
      browserUI.addTask()
    }
  },

  restore: function () {
    if (Object.hasOwn(window.globalArgs, 'initial-window')) {
      sessionRestore.restoreFromFile()
    } else {
      sessionRestore.syncWithWindow()
    }
    if (settings.get('newWindowOption') === 2 && !Object.hasOwn(window.globalArgs, 'launch-window') && !Object.hasOwn(window.globalArgs, 'initial-task')) {
      taskOverlay.show()
    }
  },

  initialize: function () {
    setInterval(sessionRestore.save, 30000)

    window.onbeforeunload = function () {
      sessionRestore.save(true, true)
      const selectedTask = browserSession.tasks.getSelected()
      if (selectedTask) {
        const change = browserSession.updateTask(selectedTask.id, { selectedInWindow: null })
        ipc.send('tab-state-change', [change])
      }
    }

    ipc.on('read-tab-state', function () {
      ipc.send('return-tab-state', browserSession.getCopyableSnapshot())
    })
  }
}

module.exports = sessionRestore
