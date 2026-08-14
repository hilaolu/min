const { ipcRenderer: ipc } = require('electron')

const browserSession = require('tabState.js')
const browserUI = require('browserUI.js')
const taskOverlay = require('taskOverlay/taskOverlay.js')

const windowSync = {
  pendingChanges: [],
  syncTimeout: null,

  flush: function () {
    if (windowSync.pendingChanges.length > 0) {
      ipc.send('tab-state-change', windowSync.pendingChanges)
      windowSync.pendingChanges = []
    }
    if (windowSync.syncTimeout) {
      clearTimeout(windowSync.syncTimeout)
      windowSync.syncTimeout = null
    }
  },

  initialize: function () {
    browserSession.onChange(function (change) {
      windowSync.pendingChanges.push(change)
      if (!windowSync.syncTimeout) {
        windowSync.syncTimeout = setTimeout(windowSync.flush, 0)
      }
    })

    ipc.on('tab-state-change-receive', function receiveChanges (event, data) {
      const priorSelectedTaskId = browserSession.tasks.getSelected()?.id
      let shouldProjectCurrentTask = false

      for (const change of data.changes) {
        if (change.type === 'task-closed' && change.taskId === priorSelectedTaskId) {
          ipc.invoke('close')
          ipc.removeListener('tab-state-change-receive', receiveChanges)
          return
        }

        browserSession.applyChange(change)

        if (change.type === 'task-selected' && change.taskId === priorSelectedTaskId && change.windowId !== browserSession.windowId) {
          const candidates = browserSession.tasks
            .filter(task => task.tabs.isEmpty() && !task.selectedInWindow && !task.name)
            .sort((a, b) => browserSession.tasks.getLastActivity(b.id) - browserSession.tasks.getLastActivity(a.id))
          if (candidates.length > 0) {
            browserUI.switchToTask(candidates[0].id)
          } else {
            browserUI.addTask()
          }
          taskOverlay.show()
        }

        if (
          change.taskId === priorSelectedTaskId ||
          change.fromTaskId === priorSelectedTaskId ||
          change.toTaskId === priorSelectedTaskId
        ) {
          shouldProjectCurrentTask = true
        }
      }

      const selectedTask = browserSession.tasks.getSelected()
      if (shouldProjectCurrentTask && selectedTask) {
        browserUI.switchToTask(selectedTask.id, { stateAlreadySelected: true })
      }
    })
  }
}

module.exports = windowSync
