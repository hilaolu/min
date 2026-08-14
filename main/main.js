function createAppRuntime ({ buildAppMenu, buildTouchBar, commandPalette, createDockMenu, electron, fs, installSessionPolicies, installThemePolicy, overlayManager, path, registryInstaller, rootDir, settings, windows }) {
  const {
    app, // Module to control application life.
    BaseWindow, // Module to create native browser window.
    BrowserWindow,
    session,
    ipcMain: ipc,
    Menu,
    crashReporter,
    WebContentsView
  } = electron

  crashReporter.start({
    submitURL: 'https://minbrowser.org/',
    uploadToServer: false,
    compress: true
  })

  if (process.argv.some(arg => arg === '-v' || arg === '--version')) {
    console.log('Min: ' + app.getVersion())
    console.log('Chromium: ' + process.versions.chrome)
    process.exit()
  }

  let isInstallerRunning = false
  const isDevelopmentMode = process.argv.some(arg => arg === '--development-mode')

  function clamp (n, min, max) {
    return Math.max(Math.min(n, max), min)
  }

  function recenterOverlay (win) {
    try {
      const manager = overlayManager
      if (manager && typeof manager.recenter === 'function' && manager.isVisible()) {
        manager.recenter(win)
      }
    } catch (e) {}
  }

  if (process.platform === 'win32') {
    (async function () {
      var squirrelCommand = process.argv[1]
      if (squirrelCommand === '--squirrel-install' || squirrelCommand === '--squirrel-updated') {
        isInstallerRunning = true
        await registryInstaller.install()
      }
      if (squirrelCommand === '--squirrel-uninstall') {
        isInstallerRunning = true
        await registryInstaller.uninstall()
      }
      if (require('electron-squirrel-startup')) {
        app.quit()
      }
    })()
  }

  // workaround for flicker when focusing app (https://github.com/electron/electron/issues/17942)
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows', 'true')
  app.commandLine.appendSwitch('lang', 'en-US')

  var userDataPath = app.getPath('userData')

  // Disable QUIC if setting is disabled
  if (settings.get('enableQUIC') === false) {
    app.commandLine.appendSwitch('disable-quic')
  }

  const browserPage = 'min://app/index.html'

  var mainMenu = null
  var secondaryMenu = null
  var appIsReady = false
  var urlToOpen = null
  const placesPage = 'file://' + path.join(rootDir, 'js/places/placesService.html')
  let placesWindow = null

  function createPlacesWindow () {
    placesWindow = new BrowserWindow({
      width: 300,
      height: 300,
      show: false,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false
      }
    })

    placesWindow.loadURL(placesPage)
  }

  const isFirstInstance = app.requestSingleInstanceLock()

  if (!isFirstInstance) {
    app.quit()
    return
  }

  var saveWindowBounds = function () {
    if (windows.getCurrent()) {
      var bounds = Object.assign(windows.getCurrent().getBounds(), {
        maximized: windows.getCurrent().isMaximized()
      })
      fs.writeFileSync(path.join(userDataPath, 'windowBounds.json'), JSON.stringify(bounds))
    }
  }

  function sendIPCToWindow (window, action, data) {
    if (window && window.isDestroyed()) {
      return
    }

    if (window && getWindowWebContents(window).isLoadingMainFrame()) {
    // immediately after a did-finish-load event, isLoading can still be true,
    // so wait a bit to confirm that the page is really loading
      setTimeout(function () {
        if (getWindowWebContents(window).isLoadingMainFrame()) {
          getWindowWebContents(window).once('did-finish-load', function () {
            getWindowWebContents(window).send(action, data || {})
          })
        } else {
          getWindowWebContents(window).send(action, data || {})
        }
      }, 0)
    } else if (window) {
      getWindowWebContents(window).send(action, data || {})
    } else {
      const newWindow = createWindow()
      getWindowWebContents(newWindow).once('did-finish-load', function () {
        getWindowWebContents(newWindow).send(action, data || {})
      })
    }
  }

  function openTabInWindow (url) {
    sendIPCToWindow(windows.getCurrent(), 'addTab', {
      url: url
    })
  }

  function handleCommandLineArguments (argv) {
  // the "ready" event must occur before this function can be used
    if (argv) {
      argv.forEach(function (arg, idx) {
        if (arg && arg.toLowerCase() !== rootDir.toLowerCase()) {
        // URL
          if (arg.indexOf('://') !== -1) {
            sendIPCToWindow(windows.getCurrent(), 'addTab', {
              url: arg
            })
          } else if (idx > 0 && argv[idx - 1] === '-s') {
          // search
            sendIPCToWindow(windows.getCurrent(), 'addTab', {
              url: arg
            })
          } else if (/\.(m?ht(ml)?|pdf)$/.test(arg) && fs.existsSync(arg)) {
          // local files (.html, .mht, mhtml, .pdf)
            sendIPCToWindow(windows.getCurrent(), 'addTab', {
              url: 'file://' + path.resolve(arg)
            })
          }
        }
      })
    }
  }

  function createWindow (customArgs = {}) {
    var bounds

    try {
      var data = fs.readFileSync(path.join(userDataPath, 'windowBounds.json'), 'utf-8')
      bounds = JSON.parse(data)
    } catch (e) {}

    if (!bounds) { // there was an error, probably because the file doesn't exist
      var size = electron.screen.getPrimaryDisplay().workAreaSize
      bounds = {
        x: 0,
        y: 0,
        width: size.width,
        height: size.height,
        maximized: true
      }
    }

    // make the bounds fit inside a currently-active screen
    // (since the screen Min was previously open on could have been removed)
    // see: https://github.com/minbrowser/min/issues/904
    var containingRect = electron.screen.getDisplayMatching(bounds).workArea

    bounds = {
      x: clamp(bounds.x, containingRect.x, (containingRect.x + containingRect.width) - bounds.width),
      y: clamp(bounds.y, containingRect.y, (containingRect.y + containingRect.height) - bounds.height),
      width: clamp(bounds.width, 0, containingRect.width),
      height: clamp(bounds.height, 0, containingRect.height),
      maximized: bounds.maximized
    }

    return createWindowWithBounds(bounds, customArgs)
  }

  function createWindowWithBounds (bounds, customArgs) {
    const newWin = new BaseWindow({
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      minWidth: (process.platform === 'win32' ? 400 : 320), // controls take up more horizontal space on Windows
      minHeight: 350,
      titleBarStyle: settings.get('useSeparateTitlebar') ? 'default' : 'hidden',
      trafficLightPosition: { x: 12, y: 10 },
      icon: path.join(rootDir, 'icons/icon256.png'),
      frame: settings.get('useSeparateTitlebar'),
      alwaysOnTop: settings.get('windowAlwaysOnTop'),
      backgroundColor: '#fff' // the value of this is ignored, but setting it seems to work around https://github.com/electron/electron/issues/10559
    })

    // windows and linux always use a menu button in the upper-left corner instead
    // if frame: false is set, this won't have any effect, but it does apply on Linux if "use separate titlebar" is enabled
    if (process.platform !== 'darwin') {
      newWin.setMenuBarVisibility(false)
    }

    const mainView = new WebContentsView({
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        additionalArguments: [
          '--user-data-path=' + userDataPath,
          '--app-version=' + app.getVersion(),
          '--app-name=' + app.getName(),
          ...((isDevelopmentMode ? ['--development-mode'] : [])),
          '--window-id=' + windows.nextId,
          ...((windows.getAll().length === 0 ? ['--initial-window'] : [])),
          ...(windows.hasEverCreatedWindow ? [] : ['--launch-window']),
          ...(customArgs.initialTask ? ['--initial-task=' + customArgs.initialTask] : []),
          ...(settings.get('smoothScrolling') ? ['--smooth-scrolling=' + settings.get('smoothScrolling')] : [])
        ]
      }
    })
    mainView.webContents.loadURL(browserPage)

    if (bounds.maximized) {
      newWin.maximize()

      mainView.webContents.once('did-finish-load', function () {
        sendIPCToWindow(newWin, 'maximize')
      })
    }

    const winBounds = newWin.getContentBounds()

    mainView.setBounds({ x: 0, y: 0, width: winBounds.width, height: winBounds.height })
    newWin.contentView.addChildView(mainView)

    // sometimes getContentBounds doesn't provide correct bounds until after the window has finished loading
    mainView.webContents.once('did-finish-load', function () {
      const winBounds = newWin.getContentBounds()
      mainView.setBounds({ x: 0, y: 0, width: winBounds.width, height: winBounds.height })
    })

    newWin.on('resize', function () {
    // The result of getContentBounds doesn't update until the next tick
      setTimeout(function () {
        const winBounds = newWin.getContentBounds()
        mainView.setBounds({ x: 0, y: 0, width: winBounds.width, height: winBounds.height })
        recenterOverlay(newWin)
      }, 0)
    })

    newWin.on('close', function () {
    // save the window size for the next launch of the app
      saveWindowBounds()
    })

    function refocusBrowserContents () {
      const isMinimized = newWin.isMinimized()
      windows.getState(newWin).isMinimized = isMinimized
      if (!isMinimized) {
        sendIPCToWindow(newWin, 'windowFocus')
      }
    }

    newWin.on('focus', function () {
      refocusBrowserContents()
    })

    newWin.on('minimize', function () {
      sendIPCToWindow(newWin, 'minimize')
      windows.getState(newWin).isMinimized = true
    })

    newWin.on('restore', function () {
      refocusBrowserContents()
    })

    newWin.on('maximize', function () {
      sendIPCToWindow(newWin, 'maximize')
      recenterOverlay(newWin)
    })

    newWin.on('unmaximize', function () {
      sendIPCToWindow(newWin, 'unmaximize')
      recenterOverlay(newWin)
    })

    newWin.on('focus', function () {
      sendIPCToWindow(newWin, 'focus')
    })

    newWin.on('blur', function () {
    // if the devtools for this window are focused, this check will be false, and we keep the focused class on the window
      if (BaseWindow.getFocusedWindow() !== newWin) {
        sendIPCToWindow(newWin, 'blur')
      }
    })

    newWin.on('enter-full-screen', function () {
      sendIPCToWindow(newWin, 'enter-full-screen')
      recenterOverlay(newWin)
    })

    newWin.on('leave-full-screen', function () {
      sendIPCToWindow(newWin, 'leave-full-screen')
      // https://github.com/minbrowser/min/issues/1093
      newWin.setMenuBarVisibility(false)
      recenterOverlay(newWin)
    })

    newWin.on('enter-html-full-screen', function () {
      sendIPCToWindow(newWin, 'enter-html-full-screen')
    })

    newWin.on('leave-html-full-screen', function () {
      sendIPCToWindow(newWin, 'leave-html-full-screen')
      // https://github.com/minbrowser/min/issues/952
      newWin.setMenuBarVisibility(false)
    })

    /*
  Handles events from mouse buttons
  Unsupported on macOS, and on Linux, there is a default handler already,
  so registering a handler causes events to happen twice.
  See: https://github.com/electron/electron/issues/18322
  */
    if (process.platform === 'win32') {
      newWin.on('app-command', function (e, command) {
        if (command === 'browser-backward') {
          sendIPCToWindow(newWin, 'goBack')
        } else if (command === 'browser-forward') {
          sendIPCToWindow(newWin, 'goForward')
        }
      })
    }

    // prevent remote pages from being loaded using drag-and-drop, since they would have node access
    mainView.webContents.on('will-navigate', function (e, url) {
      if (url !== browserPage) {
        e.preventDefault()
      }
    })

    mainView.webContents.on('before-input-event', function (e, input) {
      sendIPCToWindow(newWin, 'before-input-event', input)
    })

    newWin.setTouchBar(buildTouchBar())

    windows.addWindow(newWin)

    return newWin
  }

  app.on('session-created', installSessionPolicies)

  // This method will be called when Electron has finished
  // initialization and is ready to create browser windows.
  app.on('ready', function () {
    installThemePolicy()
    settings.set('restartNow', false)
    appIsReady = true

    /* the installer launches the app to install registry items and shortcuts,
  but if that's happening, we shouldn't display anything */
    if (isInstallerRunning) {
      createPlacesWindow()
      return
    }

    installSessionPolicies(session.defaultSession)

    const newWin = createWindow()

    getWindowWebContents(newWin).on('did-finish-load', function () {
    // if a URL was passed as a command line argument (probably because Min is set as the default browser on Linux), open it.
      handleCommandLineArguments(process.argv)

      // there is a URL from an "open-url" event (on Mac)
      if (urlToOpen) {
      // if there is a previously set URL to open (probably from opening a link on macOS), open it
        sendIPCToWindow(newWin, 'addTab', {
          url: urlToOpen
        })
        urlToOpen = null
      }
    })

    mainMenu = buildAppMenu()
    Menu.setApplicationMenu(mainMenu)
    createDockMenu()
    createPlacesWindow()
  })

  app.on('open-url', function (e, url) {
    if (appIsReady) {
      sendIPCToWindow(windows.getCurrent(), 'addTab', {
        url: url
      })
    } else {
      urlToOpen = url // this will be handled later in the createWindow callback
    }
  })

  // handoff support for macOS
  app.on('continue-activity', function (e, type, userInfo, details) {
    if (type === 'NSUserActivityTypeBrowsingWeb' && details.webpageURL) {
      e.preventDefault()
      sendIPCToWindow(windows.getCurrent(), 'addTab', {
        url: details.webpageURL
      })
    }
  })

  app.on('second-instance', function (e, argv, workingDir) {
    if (windows.getCurrent()) {
      if (windows.getCurrent().isMinimized()) {
        windows.getCurrent().restore()
      }
      windows.getCurrent().focus()
      // add a tab with the new URL
      handleCommandLineArguments(argv)
    }
  })

  /**
 * Emitted when the application is activated, which usually happens when clicks on the applications's dock icon
 * https://github.com/electron/electron/blob/master/docs/api/app.md#event-activate-os-x
 *
 * Opens a new tab when all tabs are closed, and min is still open by clicking on the application dock icon
 */
  app.on('activate', function (/* e, hasVisibleWindows */) {
    if (!windows.getCurrent() && appIsReady) { // sometimes, the event will be triggered before the app is ready, and creating new windows will fail
      createWindow()
    }
  })

  ipc.on('focusMainWebContents', function () {
    getWindowWebContents(windows.getCurrent()).focus()
  })

  ipc.on('showSecondaryMenu', function (event, data) {
    if (!secondaryMenu) {
      secondaryMenu = buildAppMenu({ secondary: true })
    }
    secondaryMenu.popup({
      x: data.x,
      y: data.y
    })
  })

  ipc.on('handoffUpdate', function (e, data) {
    if (app.setUserActivity && data.url && data.url.startsWith('http')) {
      app.setUserActivity('NSUserActivityTypeBrowsingWeb', {}, data.url)
    } else if (app.invalidateCurrentActivity) {
      app.invalidateCurrentActivity()
    }
  })

  ipc.on('quit', function () {
    app.quit()
  })

  ipc.on('tab-state-change', function (e, changes) {
    const sourceWindowId = windows.windowFromContents(e.sender)?.id
    if (!sourceWindowId) {
      console.warn('warning: received tab state update from window after destruction, ignoring')
      return
    }
    windows.getAll().forEach(function (window) {
      if (getWindowWebContents(window).id !== e.sender.id) {
        getWindowWebContents(window).send('tab-state-change-receive', {
          sourceWindowId,
          changes
        })
      }
    })
  })

  ipc.on('request-tab-state', function (e) {
    const otherWindow = windows.getAll().find(w => getWindowWebContents(w).id !== e.sender.id)
    if (!otherWindow) {
      throw new Error('secondary window doesn\'t exist as source for tab state')
    }
    ipc.once('return-tab-state', function (e2, data) {
      e.returnValue = data
    })
    getWindowWebContents(otherWindow).send('read-tab-state')
  })

  /* places service */

  ipc.on('places-connect', function (e) {
    placesWindow.webContents.postMessage('places-connect', null, e.ports)
  })

  function getWindowWebContents (win) {
    return win.getContentView().children[0].webContents
  }

  /* command palette overlay */

  ipc.on('initCommandPaletteOverlay', function (e) {
    commandPalette.init()
  })

  ipc.on('showCommandPaletteOverlay', function (e) {
    commandPalette.show()
  })

  ipc.on('hideCommandPaletteOverlay', function (e) {
    commandPalette.hide()
  })

  // Unified command palette overlay UI update handler
  ipc.on('updateCommandPaletteOverlayUI', function (e, overlayState) {
    try {
      commandPalette.update(overlayState)
    } catch (error) {
    // Silent fail for production - overlay will continue to work
    }
  })

  ipc.on('destroyCommandPaletteOverlay', function (e) {
    commandPalette.destroy()
  })

  return {
    createWindow,
    getPlacesWindow: () => placesWindow,
    getWindowWebContents,
    handleCommandLineArguments,
    isPrimaryInstance: true,
    openTabInWindow,
    sendIPCToWindow
  }
}

module.exports = createAppRuntime
