function createAppRuntime ({ buildAppMenu, commandPalette, createDockMenu, electron, fs, installSessionPolicies, installThemePolicy, path, registryInstaller, rootDir, settings, windows }) {
  const {
    app, // Module to control application life.
    BrowserWindow,
    session,
    ipcMain: ipc,
    Menu,
    crashReporter
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

  // Disable QUIC if setting is disabled
  if (settings.get('enableQUIC') === false) {
    app.commandLine.appendSwitch('disable-quic')
  }

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

  function sendIPCToWindow (window, action, data) {
    windows.send(window, action, data)
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
    return windows.create(customArgs)
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

  ipc.on('focusMainWebContents', function (event) {
    const window = windows.windowFromContents(event.sender)?.win || windows.getCurrent()
    if (window) {
      getWindowWebContents(window).focus()
    }
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

  const getWindowWebContents = windows.getChromeContents

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
