function createCommandPalettePresentation ({ WebContentsView, getWindowWebContents, pageURL, preloadPath, schedule = setTimeout, windows }) {
  const overlayId = 'command-palette'
  const preferredSize = { width: 600, height: 450 }
  let view = null
  let owner = null
  let loaded = false
  let latestState = normalizeState({})
  let focusTimer = null

  function errorResult (code, message) {
    return { ok: false, error: { code, message } }
  }

  function safeClone (value) {
    const seen = new WeakSet()
    try {
      return JSON.parse(JSON.stringify(value, function (key, item) {
        if (typeof item === 'bigint') return item.toString()
        if (typeof item === 'function' || typeof item === 'symbol') return undefined
        if (item && typeof item === 'object') {
          if (seen.has(item)) return '[Circular]'
          seen.add(item)
        }
        return item
      }))
    } catch (error) {
      return {}
    }
  }

  function normalizeState (state) {
    state = state && typeof state === 'object' ? state : {}
    const candidates = Array.isArray(state.candidates)
      ? state.candidates.filter(candidate => candidate && typeof candidate === 'object').map(function (candidate) {
        return {
          id: candidate.id === undefined ? undefined : String(candidate.id),
          title: typeof candidate.title === 'string' ? candidate.title : '',
          description: typeof candidate.description === 'string' ? candidate.description : '',
          icon: typeof candidate.icon === 'string' ? candidate.icon : 'carbon:search',
          shortcut: typeof candidate.shortcut === 'string' ? candidate.shortcut : '',
          displayData: safeClone(candidate.displayData) || {}
        }
      })
      : []
    const maximumIndex = Math.max(0, candidates.length - 1)
    const requestedIndex = Number.isInteger(state.selectedIndex) ? state.selectedIndex : 0

    return {
      visible: state.visible === true,
      open: state.open === true,
      input: typeof state.input === 'string' ? state.input : '',
      candidates,
      selectedIndex: Math.min(Math.max(requestedIndex, 0), maximumIndex)
    }
  }

  function deliver () {
    if (loaded && view && !view.webContents.isDestroyed()) {
      view.webContents.send('command-palette:state', latestState)
    }
  }

  function ensureView () {
    if (view) return
    view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        focusable: false,
        nodeIntegration: false,
        preload: preloadPath,
        sandbox: true
      }
    })
    view.webContents.setIgnoreMenuShortcuts(true)
    view.webContents.on('did-finish-load', function () {
      loaded = true
      deliver()
    })
    view.webContents.loadURL(pageURL)
  }

  function setBounds (window) {
    const windowBounds = window.getContentBounds()
    const width = Math.min(preferredSize.width, Math.max(0, windowBounds.width))
    const availableHeight = Math.max(0, windowBounds.height - 40)
    const desiredHeight = Math.max(preferredSize.height, Math.floor(windowBounds.height * 0.8))
    const height = Math.min(desiredHeight, availableHeight)
    view.setBounds({
      x: Math.max(0, Math.floor((windowBounds.width - width) / 2)),
      y: Math.max(0, Math.floor((windowBounds.height - height) / 2)),
      width,
      height
    })
  }

  function focusBrowserChrome (window) {
    focusTimer = schedule(function () {
      focusTimer = null
      if (owner !== window || window.isDestroyed()) return
      const chromeContents = getWindowWebContents(window)
      chromeContents.focus()
      if (window.isVisible() && !window.isDestroyed()) window.focus()
      chromeContents.send('command-palette:focus-input')
    }, 150)
  }

  function present (senderContents, state) {
    const source = windows.windowFromContents(senderContents)
    if (!source || !source.win || source.win.isDestroyed()) {
      return errorResult('BROWSER_WINDOW_NOT_FOUND', 'Command palette source Browser Window is unavailable')
    }

    const nextState = normalizeState(state)
    if (!nextState.visible) {
      if (owner && owner !== source.win) {
        return errorResult('COMMAND_PALETTE_NOT_OWNER', 'Command palette belongs to another Browser Window')
      }
      latestState = nextState
      deliver()
      if (owner && view && windows.isOverlayAttached(overlayId, view)) {
        windows.detachOverlay(overlayId, view)
      }
      owner = null
      return { ok: true }
    }

    const previousState = latestState
    if (owner && owner !== source.win && !nextState.open) {
      return errorResult('COMMAND_PALETTE_NOT_OWNER', 'Command palette belongs to another Browser Window')
    }
    latestState = nextState
    ensureView()
    const wasAttached = windows.isOverlayAttached(overlayId, view) && owner === source.win
    setBounds(source.win)
    if (!wasAttached && !windows.attachOverlay(overlayId, view, source.win)) {
      latestState = previousState
      return errorResult('COMMAND_PALETTE_ATTACH_FAILED', 'Command palette could not be attached')
    }
    owner = source.win
    deliver()
    if (!wasAttached) focusBrowserChrome(source.win)
    return { ok: true }
  }

  function recenter (window) {
    if (!view || !owner || (window && window !== owner)) return false
    setBounds(owner)
    return true
  }

  function destroy () {
    if (!view) return
    if (focusTimer) clearTimeout(focusTimer)
    if (windows.isOverlayAttached(overlayId, view)) {
      windows.detachOverlay(overlayId, view)
    }
    if (!view.webContents.isDestroyed()) view.webContents.destroy()
    view = null
    owner = null
    loaded = false
  }

  return { destroy, present, recenter }
}

module.exports = createCommandPalettePresentation
