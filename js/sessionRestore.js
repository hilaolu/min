const browserSession = require('tabState.js')
const browserUI = require('browserUI.js')
const rendererHost = require('rendererHost.js')
const runtimeConfiguration = rendererHost.getRuntimeConfiguration()
const settings = require('util/settings/settings.js')
const statistics = require('js/statistics.js')
const tabEditor = require('navbar/tabEditor.js')
const taskOverlay = require('taskOverlay/taskOverlay.js')
const windowSync = require('tabState/windowSync.js')

const sessionRestore = {
  previousPersistenceKey: null,
  previousState: null,

  save: function (forceSave, sync) {
    // Only one window (the focused one) should write the shared snapshot.
    if (!document.body.classList.contains('focused')) return

    const startupTabOption = settings.get('startupTabOption')
    const selectedTaskIds = startupTabOption === 3
      ? browserSession.tasks.getSelectedTaskIds().join(',')
      : ''
    const persistenceKey = [browserSession.getPersistenceRevision(), startupTabOption, selectedTaskIds].join(':')
    if (forceSave !== true && persistenceKey === sessionRestore.previousPersistenceKey) return

    const state = browserSession.getPersistedSnapshot()

    // If startupTabOption is "open a new blank task", don't save the current Task's Tabs.
    if (startupTabOption === 3) {
      state.tasks.forEach(function (task) {
        if (browserSession.tasks.get(task.id).selectedInWindow) {
          task.tabs = []
        }
      })
    }

    const stateString = JSON.stringify(state)
    if (forceSave !== true && stateString === sessionRestore.previousState) {
      sessionRestore.previousPersistenceKey = persistenceKey
      return
    }

    const data = JSON.stringify({
      version: 2,
      state,
      saveTime: Date.now()
    })
    if (sync === true) {
      try {
        rendererHost.saveBrowserSession(data, { sync: true })
        sessionRestore.previousPersistenceKey = persistenceKey
        sessionRestore.previousState = stateString
      } catch (error) {
        console.warn(error)
        statistics.incrementValue('sessionRestoreSaveSyncWriteErrors')
      }
    } else {
      rendererHost.saveBrowserSession(data).then(function () {
        sessionRestore.previousPersistenceKey = persistenceKey
        sessionRestore.previousState = stateString
      }).catch(function (error) {
        console.warn(error)
        statistics.incrementValue('sessionRestoreSaveAsyncWriteErrors')
      })
    }
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
      savedStringData = rendererHost.loadBrowserSession()
    } catch (error) {
      console.warn('failed to read session restore data', error)
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

      const backupName = rendererHost.backupCorruptBrowserSession(savedStringData)

      browserSession.restoreSnapshot({ tasks: [] }, { ensureNotEmpty: false })
      const taskId = browserSession.createTask({}, { select: true })
      browserUI.addTab({
        url: 'min://app/pages/sessionRestoreError/index.html?backupName=' + encodeURIComponent(backupName)
      }, {
        enterEditMode: false,
        taskId
      })
      statistics.incrementValue('sessionRestorationErrors')
    }
  },

  syncWithWindow: function () {
    const snapshot = rendererHost.requestBrowserSessionSnapshot()
    browserSession.restoreSnapshot(snapshot)

    if (runtimeConfiguration.initialTask !== null) {
      const acquired = browserSession.acquireTask({ taskId: runtimeConfiguration.initialTask })
      browserUI.switchToTask(acquired.selectedTaskId, { stateAlreadySelected: true })
      return
    }

    const acquired = browserSession.acquireTask()
    browserUI.switchToTask(acquired.selectedTaskId, { stateAlreadySelected: true })
    tabEditor.show(browserSession.tabs.getSelected())
  },

  restore: function () {
    if (runtimeConfiguration.initialWindow) {
      sessionRestore.restoreFromFile()
    } else {
      sessionRestore.syncWithWindow()
    }
    if (settings.get('newWindowOption') === 2 && !runtimeConfiguration.launchWindow && runtimeConfiguration.initialTask === null) {
      taskOverlay.show()
    }
    windowSync.finishHydration()
  },

  initialize: function () {
    setInterval(sessionRestore.save, 30000)

    window.onbeforeunload = function () {
      sessionRestore.save(true, true)
      if (browserSession.releaseTask()) {
        windowSync.flush()
      }
    }

    rendererHost.onBrowserSessionSnapshotRequested(function () {
      rendererHost.provideBrowserSessionSnapshot(browserSession.getCopyableSnapshot())
    })
  }
}

module.exports = sessionRestore
