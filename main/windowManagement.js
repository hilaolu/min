function createBrowserWindows ({ app, BaseWindow, browserChromePreloadPath, browserPage, buildTouchBar, createBrowserChromeRuntimeArgument, fs, getSetting, isDevelopmentMode, onAllWindowsClosed, onRecenterOverlay, path, platform = process.platform, rootDir, screen, setTimeout: schedule = setTimeout, userDataPath, WebContentsView }) {
  const records = []
  const contentOwners = new Map()
  const tabOwners = new Map()
  const overlayOwners = new Map()
  let hasEverCreatedWindow = false
  let nextId = 1
  let finalCleanupComplete = false

  function getContentView (window) {
    return typeof window.getContentView === 'function' ? window.getContentView() : window.contentView
  }

  function getRecord (window) {
    return records.find(record => record.win === window)
  }

  function getRecordForChromeContents (contents) {
    const record = contentOwners.get(contents)
    return record && record.chrome.webContents === contents ? record : null
  }

  function requireChromeOwner (contents) {
    const record = getRecordForChromeContents(contents)
    if (!record || record.closing) {
      const error = new Error('Browser Window not found for Browser Chrome')
      error.code = 'BROWSER_WINDOW_NOT_FOUND'
      throw error
    }
    return record
  }

  function addChild (record, view) {
    const contentView = getContentView(record.win)
    if (!contentView.children.includes(view)) {
      contentView.addChildView(view)
    }
  }

  function removeChild (record, view) {
    if (!view) {
      return
    }
    const contentView = getContentView(record.win)
    if (contentView.children.includes(view)) {
      contentView.removeChildView(view)
    }
  }

  function getChromeContents (window) {
    return getRecord(window)?.chrome.webContents || null
  }

  function getAll () {
    return records.filter(record => !record.closing).map(record => record.win)
  }

  function getCurrent () {
    const current = records
      .filter(record => !record.closing)
      .sort((a, b) => b.lastFocused - a.lastFocused)[0]
    return current ? current.win : null
  }

  function windowFromContents (contents) {
    const record = contentOwners.get(contents)
    return record && !record.closed ? { id: record.id, win: record.win } : undefined
  }

  function send (window, action, data) {
    if (!window) {
      const newWindow = create()
      send(newWindow, action, data)
      return
    }

    const record = getRecord(window)
    const contents = getChromeContents(window)
    if (!record || !contents || window.isDestroyed()) {
      return
    }

    if (contents.isLoadingMainFrame()) {
      schedule(function () {
        if (contents.isLoadingMainFrame()) {
          record.pendingMessages.push({ action, data: data || {} })
          if (!record.waitingForLoad) {
            record.waitingForLoad = true
            contents.once('did-finish-load', function () {
              record.waitingForLoad = false
              record.pendingMessages.splice(0).forEach(function (message) {
                contents.send(message.action, message.data)
              })
            })
          }
        } else {
          contents.send(action, data || {})
        }
      }, 0)
    } else {
      contents.send(action, data || {})
    }
  }

  function clamp (number, minimum, maximum) {
    return Math.max(Math.min(number, maximum), minimum)
  }

  function readWindowBounds () {
    let bounds
    try {
      bounds = JSON.parse(fs.readFileSync(path.join(userDataPath, 'windowBounds.json'), 'utf-8'))
    } catch (error) {}

    if (!bounds) {
      const size = screen.getPrimaryDisplay().workAreaSize
      bounds = {
        x: 0,
        y: 0,
        width: size.width,
        height: size.height,
        maximized: true
      }
    }

    const containingRect = screen.getDisplayMatching(bounds).workArea
    return {
      x: clamp(bounds.x, containingRect.x, containingRect.x + containingRect.width - bounds.width),
      y: clamp(bounds.y, containingRect.y, containingRect.y + containingRect.height - bounds.height),
      width: clamp(bounds.width, 0, containingRect.width),
      height: clamp(bounds.height, 0, containingRect.height),
      maximized: bounds.maximized
    }
  }

  function persistBounds (record) {
    const bounds = Object.assign(record.win.getBounds(), {
      maximized: record.win.isMaximized()
    })
    try {
      fs.writeFileSync(path.join(userDataPath, 'windowBounds.json'), JSON.stringify(bounds))
    } catch (error) {
      console.warn('Failed to persist Browser Window bounds:', error.message)
    }
  }

  function resizeChrome (record) {
    const bounds = record.win.getContentBounds()
    record.chrome.setBounds({ x: 0, y: 0, width: bounds.width, height: bounds.height })
  }

  function detachSelectedTabContent (record) {
    if (!record.selectedTabContent) {
      return
    }
    removeChild(record, record.selectedTabContent.view)
    record.selectedTabContent = null
  }

  function releaseOwnedContents (record) {
    record.tabContents.forEach(function (view, tabId) {
      if (tabOwners.get(tabId)?.record === record) {
        tabOwners.delete(tabId)
      }
      if (contentOwners.get(view.webContents) === record) {
        contentOwners.delete(view.webContents)
      }
    })
    record.tabContents.clear()

    record.overlays.forEach(function (view, overlayId) {
      if (overlayOwners.get(overlayId)?.record === record) {
        overlayOwners.delete(overlayId)
      }
      if (contentOwners.get(view.webContents) === record) {
        contentOwners.delete(view.webContents)
      }
    })
    record.overlays.clear()
  }

  function beginClose (record) {
    if (record.closing) {
      return
    }
    record.closing = true
    persistBounds(record)
    detachSelectedTabContent(record)
    record.overlays.forEach(view => removeChild(record, view))
  }

  function finishClose (record) {
    if (record.closed) {
      return
    }
    record.closed = true
    releaseOwnedContents(record)
    contentOwners.delete(record.chrome.webContents)

    const index = records.indexOf(record)
    if (index !== -1) {
      records.splice(index, 1)
    }

    if (records.length === 0 && !finalCleanupComplete) {
      finalCleanupComplete = true
      onAllWindowsClosed()
    }
    if (records.length === 0 && platform !== 'darwin') {
      app.quit()
    }
  }

  function create (customArgs = {}) {
    return createWithBounds(readWindowBounds(), customArgs)
  }

  function createWithBounds (bounds, customArgs = {}) {
    const id = String(nextId++)
    const isInitialWindow = getAll().length === 0
    const isLaunchWindow = !hasEverCreatedWindow
    const window = new BaseWindow({
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      minWidth: platform === 'win32' ? 400 : 320,
      minHeight: 350,
      titleBarStyle: getSetting('useSeparateTitlebar') ? 'default' : 'hidden',
      trafficLightPosition: { x: 12, y: 10 },
      icon: path.join(rootDir, 'icons/icon256.png'),
      frame: getSetting('useSeparateTitlebar'),
      alwaysOnTop: getSetting('windowAlwaysOnTop'),
      backgroundColor: '#fff'
    })
    const chrome = new WebContentsView({
      webPreferences: {
        preload: browserChromePreloadPath,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: false,
        additionalArguments: [
          createBrowserChromeRuntimeArgument({
            appName: app.getName(),
            appVersion: app.getVersion(),
            developmentMode: isDevelopmentMode,
            initialTask: customArgs.initialTask || null,
            initialWindow: isInitialWindow,
            launchWindow: isLaunchWindow,
            platform,
            windowId: id
          }),
          ...(getSetting('smoothScrolling') ? ['--smooth-scrolling=' + getSetting('smoothScrolling')] : [])
        ]
      }
    })
    const record = {
      chrome,
      closed: false,
      closing: false,
      id,
      lastFocused: 0,
      overlays: new Map(),
      pendingMessages: [],
      selectedTabContent: null,
      tabContents: new Map(),
      waitingForLoad: false,
      win: window
    }

    records.push(record)
    contentOwners.set(chrome.webContents, record)
    hasEverCreatedWindow = true
    finalCleanupComplete = false

    if (platform !== 'darwin') {
      window.setMenuBarVisibility(false)
    }

    getContentView(window).addChildView(chrome)
    resizeChrome(record)

    chrome.webContents.once('did-finish-load', function () {
      resizeChrome(record)
    })
    window.on('resize', function () {
      schedule(function () {
        resizeChrome(record)
        onRecenterOverlay(window)
      }, 0)
    })
    window.on('focus', function () {
      record.lastFocused = Date.now()
      if (!window.isMinimized()) {
        send(window, 'windowFocus')
      }
      send(window, 'focus')
    })
    window.on('restore', function () {
      if (!window.isMinimized()) {
        send(window, 'windowFocus')
      }
    })
    window.on('maximize', function () {
      send(window, 'maximize')
      onRecenterOverlay(window)
    })
    window.on('unmaximize', function () {
      send(window, 'unmaximize')
      onRecenterOverlay(window)
    })
    window.on('blur', function () {
      if (BaseWindow.getFocusedWindow() !== window) {
        send(window, 'blur')
      }
    })
    window.on('enter-full-screen', function () {
      send(window, 'enter-full-screen')
      onRecenterOverlay(window)
    })
    window.on('leave-full-screen', function () {
      send(window, 'leave-full-screen')
      window.setMenuBarVisibility(false)
      onRecenterOverlay(window)
    })
    window.on('leave-html-full-screen', function () {
      window.setMenuBarVisibility(false)
    })
    if (platform === 'win32') {
      window.on('app-command', function (event, command) {
        if (command === 'browser-backward') {
          send(window, 'goBack')
        } else if (command === 'browser-forward') {
          send(window, 'goForward')
        }
      })
    }
    window.on('close', function () {
      beginClose(record)
    })
    window.on('closed', function () {
      finishClose(record)
    })

    chrome.webContents.on('will-navigate', function (event, url) {
      if (url !== browserPage) {
        event.preventDefault()
      }
    })
    chrome.webContents.on('before-input-event', function (event, input) {
      send(window, 'before-input-event', input)
    })

    window.setTouchBar(buildTouchBar())
    chrome.webContents.loadURL(browserPage)

    if (bounds.maximized) {
      window.maximize()
      chrome.webContents.once('did-finish-load', function () {
        send(window, 'maximize')
      })
    }

    return window
  }

  function registerTabContent (senderContents, tabId, view) {
    const record = requireChromeOwner(senderContents)
    const existing = tabOwners.get(tabId)
    if (existing && existing.view !== view) {
      const error = new Error(`Tab Content already exists for ${tabId}`)
      error.code = 'TAB_CONTENT_ALREADY_EXISTS'
      throw error
    }
    if (existing && existing.record !== record) {
      existing.record.tabContents.delete(tabId)
    }
    tabOwners.set(tabId, { record, view })
    record.tabContents.set(tabId, view)
    contentOwners.set(view.webContents, record)
  }

  function ownsTabContent (senderContents, tabId) {
    const record = getRecordForChromeContents(senderContents)
    return Boolean(record && tabOwners.get(tabId)?.record === record)
  }

  function presentTabContent (senderContents, tabId, view, attach) {
    const record = requireChromeOwner(senderContents)
    const existingOwner = tabOwners.get(tabId)
    if (!existingOwner || existingOwner.view !== view) {
      registerTabContent(senderContents, tabId, view)
    } else if (existingOwner.record !== record) {
      if (existingOwner.record.selectedTabContent?.id === tabId) {
        detachSelectedTabContent(existingOwner.record)
      }
      existingOwner.record.tabContents.delete(tabId)
      existingOwner.record = record
      record.tabContents.set(tabId, view)
      contentOwners.set(view.webContents, record)
    }

    if (record.selectedTabContent?.id === tabId && record.selectedTabContent.view === view) {
      if (attach) {
        addChild(record, view)
      }
      return false
    }

    detachSelectedTabContent(record)
    record.selectedTabContent = { id: tabId, view }
    if (attach) {
      addChild(record, view)
    }
    return true
  }

  function attachSelectedTabContent (tabId, view) {
    const owner = tabOwners.get(tabId)
    if (owner && owner.view === view && owner.record.selectedTabContent?.id === tabId) {
      addChild(owner.record, view)
    }
  }

  function hideSelectedTabContent (senderContents) {
    const record = requireChromeOwner(senderContents)
    detachSelectedTabContent(record)
    if (record.win.isFocused()) {
      record.chrome.webContents.focus()
    }
  }

  function removeTabContent (tabId, view) {
    const owner = tabOwners.get(tabId)
    if (!owner || (view && owner.view !== view)) {
      return
    }
    if (owner.record.selectedTabContent?.id === tabId) {
      detachSelectedTabContent(owner.record)
    }
    owner.record.tabContents.delete(tabId)
    tabOwners.delete(tabId)
    contentOwners.delete(owner.view.webContents)
  }

  function getWindowForTabContent (tabId) {
    return tabOwners.get(tabId)?.record.win || null
  }

  function attachOverlay (overlayId, view, window = getCurrent()) {
    const record = getRecord(window)
    if (!record || record.closing) {
      return false
    }
    const existing = overlayOwners.get(overlayId)
    if (existing && existing.record !== record) {
      removeChild(existing.record, existing.view)
      existing.record.overlays.delete(overlayId)
    }
    record.overlays.set(overlayId, view)
    overlayOwners.set(overlayId, { record, view })
    contentOwners.set(view.webContents, record)
    addChild(record, view)
    return true
  }

  function detachOverlay (overlayId, view) {
    const owner = overlayOwners.get(overlayId)
    if (!owner || (view && owner.view !== view)) {
      return false
    }
    removeChild(owner.record, owner.view)
    owner.record.overlays.delete(overlayId)
    overlayOwners.delete(overlayId)
    contentOwners.delete(owner.view.webContents)
    return true
  }

  function isOverlayAttached (overlayId, view) {
    const owner = overlayOwners.get(overlayId)
    return Boolean(owner && (!view || owner.view === view) && !owner.record.closing)
  }

  return {
    attachOverlay,
    attachSelectedTabContent,
    create,
    detachOverlay,
    getAll,
    getChromeContents,
    getCurrent,
    getWindowForTabContent,
    hideSelectedTabContent,
    isOverlayAttached,
    ownsTabContent,
    presentTabContent,
    registerTabContent,
    removeTabContent,
    send,
    windowFromContents
  }
}

module.exports = createBrowserWindows
