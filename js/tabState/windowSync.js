const browserSession = require('tabState.js')
const browserUI = require('browserUI.js')
const rendererHost = require('rendererHost.js')
const taskOverlay = require('taskOverlay/taskOverlay.js')

const windowSync = {
  closed: false,
  pendingChanges: [],
  pendingReceivedChanges: [],
  ready: false,
  syncTimeout: null,
  unsubscribe: null,

  flush: function () {
    if (windowSync.pendingChanges.length > 0) {
      rendererHost.publishBrowserSessionChanges(windowSync.pendingChanges)
      windowSync.pendingChanges = []
    }
    if (windowSync.syncTimeout) {
      clearTimeout(windowSync.syncTimeout)
      windowSync.syncTimeout = null
    }
  },

  receive: function (data) {
    if (windowSync.closed) return
    const outcome = browserSession.applyChanges(data)
    if (outcome.status === 'rejected' || outcome.status === 'snapshot-required') {
      console.warn('Browser Session replication requires a fresh snapshot:', outcome.reason)
    }
    browserUI.discardClosedTabs(outcome.closedTabIds)
    if (outcome.closeWindow) {
      windowSync.closed = true
      rendererHost.closeWindow()
      windowSync.unsubscribe()
      return
    }
    if (outcome.showTaskOverlay) {
      taskOverlay.show()
    }
    if (outcome.projectSelectedTask && outcome.selectedTaskId) {
      browserUI.switchToTask(outcome.selectedTaskId, { stateAlreadySelected: true })
    }
  },

  finishHydration: function () {
    windowSync.ready = true
    const pendingReceivedChanges = windowSync.pendingReceivedChanges
    windowSync.pendingReceivedChanges = []
    pendingReceivedChanges.forEach(windowSync.receive)
  },

  initialize: function () {
    windowSync.closed = false
    browserSession.onChange(function (change) {
      windowSync.pendingChanges.push(change)
      if (!windowSync.syncTimeout) {
        windowSync.syncTimeout = setTimeout(windowSync.flush, 0)
      }
    })

    windowSync.unsubscribe = rendererHost.onBrowserSessionChanges(function receiveChanges (data) {
      if (!windowSync.ready) {
        windowSync.pendingReceivedChanges.push(data)
      } else {
        windowSync.receive(data)
      }
    })
  }
}

module.exports = windowSync
