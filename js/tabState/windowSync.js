function createWindowSync (options) {
  const {
    browserSession,
    browserUI,
    cancelSchedule = clearTimeout,
    logger = console,
    rendererHost,
    schedule = setTimeout,
    taskOverlay
  } = options

  let closed = false
  let initialized = false
  let pendingChanges = []
  let pendingReceivedChanges = []
  let ready = false
  let syncTimeout = null
  let unsubscribeLocal = null
  let unsubscribeTransport = null

  function flush () {
    if (closed) return
    if (pendingChanges.length > 0) {
      rendererHost.publishBrowserSessionChanges(pendingChanges)
      pendingChanges = []
    }
    if (syncTimeout) {
      cancelSchedule(syncTimeout)
      syncTimeout = null
    }
  }

  function destroy () {
    if (closed) return
    closed = true
    pendingChanges = []
    pendingReceivedChanges = []
    if (syncTimeout) {
      cancelSchedule(syncTimeout)
      syncTimeout = null
    }
    if (unsubscribeLocal) {
      unsubscribeLocal()
      unsubscribeLocal = null
    }
    if (unsubscribeTransport) {
      unsubscribeTransport()
      unsubscribeTransport = null
    }
  }

  function receive (data) {
    if (closed) return
    const outcome = browserSession.applyChanges(data)
    if (outcome.status === 'rejected' || outcome.status === 'snapshot-required') {
      logger.warn('Browser Session replication requires a fresh snapshot:', outcome.reason)
    }
    browserUI.discardClosedTabs(outcome.closedTabIds)
    if (outcome.closeWindow) {
      destroy()
      rendererHost.closeWindow()
      return
    }
    if (outcome.showTaskOverlay) {
      taskOverlay.show()
    }
    if (outcome.projectSelectedTask && outcome.selectedTaskId) {
      browserUI.switchToTask(outcome.selectedTaskId, { stateAlreadySelected: true })
    }
  }

  function finishHydration () {
    if (closed) return
    ready = true
    const queuedChanges = pendingReceivedChanges
    pendingReceivedChanges = []
    queuedChanges.forEach(receive)
  }

  function initialize () {
    if (initialized) return
    initialized = true
    closed = false
    unsubscribeLocal = browserSession.onChange(function (change) {
      pendingChanges.push(change)
      if (!syncTimeout) {
        syncTimeout = schedule(flush, 0)
      }
    })

    unsubscribeTransport = rendererHost.onBrowserSessionChanges(function receiveChanges (data) {
      if (!ready) {
        pendingReceivedChanges.push(data)
      } else {
        receive(data)
      }
    })
  }

  return {
    destroy,
    finishHydration,
    flush,
    initialize,
    receive
  }
}

let productionWindowSync = null

function getProductionWindowSync () {
  if (!productionWindowSync) {
    throw new Error('Browser Session window synchronization has not been initialized')
  }
  return productionWindowSync
}

module.exports = {
  createWindowSync,
  destroy: (...args) => getProductionWindowSync().destroy(...args),
  finishHydration: (...args) => getProductionWindowSync().finishHydration(...args),
  flush: (...args) => getProductionWindowSync().flush(...args),
  initialize: function (options) {
    if (!productionWindowSync) productionWindowSync = createWindowSync(options)
    return productionWindowSync.initialize()
  },
  receive: (...args) => getProductionWindowSync().receive(...args)
}
