function createViewManager ({ app, BrowserWindow, createPrompt, electron, filterPopups, getWindowWebContents, ipc, path, rootDir, settings, WebContentsView, windows }) {
  var viewMap = {} // id: view
  var viewStateMap = {} // id: view state

  var temporaryPopupViews = {} // id: view

  const eventDefinitions = [
    ['before-input-event', 'input-received', args => ({ input: args[0] })],
    ['context-menu', 'context-menu-requested', args => ({ data: args[0] })],
    ['crashed', 'content-crashed', args => ({ killed: args[0] })],
    ['did-change-theme-color', 'theme-color-changed', args => ({ color: args[0] })],
    ['did-fail-load', 'load-failed', args => ({ errorCode: args[0], errorDescription: args[1], url: args[2], isMainFrame: args[3] })],
    ['did-finish-load', 'load-finished', () => ({})],
    ['did-navigate', 'navigation-committed', args => ({ url: args[0], statusCode: args[1], statusText: args[2] })],
    ['did-navigate-in-page', 'in-page-navigation-committed', args => ({ url: args[0], isMainFrame: args[1] })],
    ['did-start-loading', 'loading-started', () => ({})],
    ['did-start-navigation', 'navigation-started', args => ({ url: args[0], isInPlace: args[1], isMainFrame: args[2] })],
    ['did-stop-loading', 'loading-stopped', () => ({})],
    ['dom-ready', 'document-ready', () => ({})],
    ['enter-html-full-screen', 'fullscreen-entered', () => ({})],
    ['found-in-page', 'find-result', args => ({ result: args[0] })],
    ['leave-html-full-screen', 'fullscreen-left', () => ({})],
    ['media-paused', 'media-paused', () => ({})],
    ['media-started-playing', 'media-started', () => ({})],
    ['page-favicon-updated', 'favicon-updated', args => ({ favicons: args[0] })],
    ['page-title-updated', 'title-updated', args => ({ title: args[0], explicitlySet: args[1] })],
    ['will-redirect', 'navigation-redirected', args => ({ url: args[0], isInPlace: args[1], isMainFrame: args[2] })],
    ['zoom-changed', 'zoom-changed', args => ({ direction: args[0] })]
  ]

  // rate limit on "open in app" requests
  var globalLaunchRequests = 0

  function getDefaultViewWebPreferences () {
    return (
      {
        nodeIntegration: false,
        nodeIntegrationInSubFrames: true,
        scrollBounce: true,
        safeDialogs: true,
        safeDialogsMessage: 'Prevent this page from creating additional dialogs',
        preload: path.join(rootDir, 'dist/preload.js'),
        contextIsolation: true,
        sandbox: true,
        enableRemoteModule: false,
        allowPopups: false,
        // partition: partition || 'persist:webcontent',
        enableWebSQL: false,
        autoplayPolicy: (settings.get('enableAutoplay') ? 'no-user-gesture-required' : 'user-gesture-required'),
        // match Chrome's default for anti-fingerprinting purposes (Electron defaults to 0)
        minimumFontSize: 6,
        javascript: !(settings.get('filtering')?.contentTypes?.includes('script'))
      }
    )
  }

  function sendTabContentEvent (view, tabId, type, payload) {
    const eventTarget = getWindowFromViewContents(view)
    if (!eventTarget) {
      return
    }
    getWindowWebContents(eventTarget).send('tab-content-event', {
      tabId,
      type,
      payload
    })
  }

  function createView (ownerContents, existingViewId, id, webPreferences, bounds) {
    if (viewStateMap[id]) {
      const error = new Error(`Tab Content already exists for ${id}`)
      error.code = 'TAB_CONTENT_ALREADY_EXISTS'
      throw error
    }

    const viewPrefs = Object.assign({}, getDefaultViewWebPreferences(), webPreferences)

    viewStateMap[id] = {
      loadedInitialURL: false,
      hasJS: viewPrefs.javascript, // need this later to see if we should swap the view for a JS-enabled one
      navigationGeneration: 0,
      private: viewPrefs.partition !== 'persist:webcontent'
    }

    let view
    if (existingViewId) {
      view = temporaryPopupViews[existingViewId]
      delete temporaryPopupViews[existingViewId]

      if (!view) {
        delete viewStateMap[id]
        throw createError('TAB_CONTENT_NOT_FOUND', `Popup Tab Content not found for ${existingViewId}`)
      }

      // the initial URL has already been loaded, so set the background color
      view.setBackgroundColor('#fff')
      viewStateMap[id].loadedInitialURL = true
    } else {
      view = new WebContentsView({ webPreferences: viewPrefs })
    }

    eventDefinitions.forEach(function ([electronEvent, semanticEvent, createPayload]) {
      view.webContents.on(electronEvent, function () {
        const args = Array.prototype.slice.call(arguments).slice(1)
        if (electronEvent === 'did-start-navigation' && args[2]) {
          viewStateMap[id].navigationGeneration++
          view.webContents.send('page-navigation-generation', viewStateMap[id].navigationGeneration)
        }
        if (electronEvent === 'did-navigate' || electronEvent === 'will-redirect') {
          view.webContents.setVisualZoomLevelLimits(1, 3)
        }
        const payload = createPayload(args)
        if (electronEvent === 'did-start-navigation' && args[2]) {
          payload.navigationGeneration = viewStateMap[id].navigationGeneration
        }
        sendTabContentEvent(view, id, semanticEvent, payload)
      })
    })

    view.webContents.on('select-bluetooth-device', function (event, deviceList, selectDevice) {
      event.preventDefault()
      selectDevice('')
    })

    view.webContents.setWindowOpenHandler(function (details) {
      if (details.url && !filterPopups(details.url)) {
        return {
          action: 'deny'
        }
      }

      /*
      Opening a popup with window.open() generally requires features to be set
      So if there are no features, the event is most likely from clicking on a link, which should open a new tab.
      Clicking a link can still have a "new-window" or "foreground-tab" disposition depending on which keys are pressed
      when it is clicked.
      (https://github.com/minbrowser/min/issues/1835)
    */
      if (!details.features) {
        sendTabContentEvent(view, id, 'new-tab-requested', {
          url: details.url,
          openInForeground: details.disposition !== 'background-tab'
        })
        return {
          action: 'deny'
        }
      }

      return {
        action: 'allow',
        createWindow: function (options) {
          const popupView = new WebContentsView({ webPreferences: getDefaultViewWebPreferences(), webContents: options.webContents })

          var popupId = Math.random().toString()
          temporaryPopupViews[popupId] = popupView

          sendTabContentEvent(view, id, 'popup-created', {
            popupId,
            initialURL: details.url
          })

          return popupView.webContents
        }
      }
    })

    view.webContents.on('ipc-message', function (e, channel, data) {
      var senderURL
      try {
        senderURL = e.senderFrame.url
      } catch (err) {
      // https://github.com/minbrowser/min/issues/2052
        console.warn('dropping message because senderFrame is destroyed', channel, data, err)
        return
      }

      const eventTarget = getWindowFromViewContents(view)

      if (!eventTarget) {
      // this can happen during shutdown - windows can be destroyed before the corresponding views, and the view can emit an event during that time
        return
      }

      getWindowWebContents(eventTarget).send('tab-content-message', {
        id: id,
        name: channel,
        data: data,
        frameId: e.frameId,
        frameURL: senderURL
      })
    })

    // Open a login prompt when site asks for http authentication
    view.webContents.on('login', (event, authenticationResponseDetails, authInfo, callback) => {
      if (authInfo.scheme !== 'basic') { // Only for basic auth
        return
      }
      event.preventDefault()
      var title = `Sign in to ${authInfo.host}`
      createPrompt({
        text: title,
        values: [{ placeholder: 'Username', id: 'username', type: 'text' },
          { placeholder: 'Password', id: 'password', type: 'password' }],
        ok: 'Confirm',
        cancel: 'Cancel',
        width: 400,
        height: 200
      }, function (result) {
      // resend request with auth credentials
        callback(result.username, result.password)
      })
    })

    // show an "open in app" prompt for external protocols

    function handleExternalProtocol (e, url, isInPlace, isMainFrame, frameProcessId, frameRoutingId) {
      var knownProtocols = ['http', 'https', 'file', 'min', 'about', 'data', 'javascript', 'chrome'] // TODO anything else?
      if (!knownProtocols.includes(url.split(':')[0])) {
        var externalApp = app.getApplicationNameForProtocol(url)
        if (externalApp) {
          var sanitizedName = externalApp.replace(/[^a-zA-Z0-9.]/g, '')
          if (globalLaunchRequests < 2) {
            globalLaunchRequests++
            setTimeout(function () {
              globalLaunchRequests--
            }, 20000)
            var result = electron.dialog.showMessageBoxSync({
              type: 'question',
              buttons: ['OK', 'Cancel'],
              message: `Open in "${sanitizedName}"?`,
              detail: url.length > 160 ? url.substring(0, 160) + '...' : url
            })

            if (result === 0) {
              electron.shell.openExternal(url)
            }
          }
        }
      }
    }

    view.webContents.on('did-start-navigation', handleExternalProtocol)
    /*
  It's possible for an HTTP request to redirect to an external app link
  (primary use case for this is OAuth from desktop app > browser > back to app)
  and did-start-navigation isn't (always?) emitted for redirects, so we need this handler as well
  */
    view.webContents.on('will-redirect', handleExternalProtocol)

    /*
  the JS setting can only be set when the view is created, so swap the view on navigation if the setting value changed
  This can occur if the user manually changed the setting, or if we are navigating between an internal page (always gets JS)
  and an external one
  */
    view.webContents.on('did-start-navigation', function (event) {
      if (event.isMainFrame && !event.isSameDocument) {
        const hasJS = viewStateMap[id].hasJS
        const shouldHaveJS = (!(settings.get('filtering')?.contentTypes?.includes('script'))) || event.url.startsWith('min://')
        if (hasJS !== shouldHaveJS) {
          setTimeout(function () {
            view.webContents.stop()
            const currentWindow = getWindowFromViewContents(view)
            const currentOwnerContents = currentWindow && getWindowWebContents(currentWindow)
            destroyView(id)
            createView(currentOwnerContents, null, id, Object.assign({}, webPreferences, { javascript: shouldHaveJS }), bounds)
            loadURLInView(id, event.url, currentWindow)

            if (currentWindow) {
              setView(id, getWindowWebContents(currentWindow))
              focusView(id)
            }
          }, 0)
        }
      }
    })

    view.setBounds(bounds)

    viewMap[id] = view
    windows.registerTabContent(ownerContents, id, view)

    return view
  }

  function destroyView (id) {
    if (!viewMap[id]) {
      return
    }

    const view = viewMap[id]
    windows.removeTabContent(id, view)
    view.webContents.destroy()

    delete viewMap[id]
    delete viewStateMap[id]
  }

  function destroyAllViews () {
    for (const id in viewMap) {
      destroyView(id)
    }
  }

  function setView (id, senderContents) {
    windows.presentTabContent(senderContents, id, viewMap[id], viewStateMap[id].loadedInitialURL)
  }

  function setBounds (id, bounds) {
    if (viewMap[id]) {
      viewMap[id].setBounds(bounds)
    }
  }

  function focusView (id) {
  // empty views can't be focused because they won't propogate keyboard events correctly, see https://github.com/minbrowser/min/issues/616
  // also, make sure the view exists, since it might not if the app is shutting down
    if (viewMap[id] && (viewMap[id].webContents.getURL() !== '' || viewMap[id].webContents.isLoading())) {
      viewMap[id].webContents.focus()
      return true
    } else if (getWindowFromViewContents(viewMap[id])) {
      getWindowWebContents(getWindowFromViewContents(viewMap[id])).focus()
      return true
    }
  }

  function hideCurrentView (senderContents) {
    windows.hideSelectedTabContent(senderContents)
  }

  function getTabIDFromWebContents (contents) {
    for (var id in viewMap) {
      if (viewMap[id].webContents === contents) {
        return id
      }
    }
  }

  function getWindowFromViewContents (webContents) {
    const contents = webContents?.webContents || webContents
    return windows.windowFromContents(contents)?.win || null
  }

  function loadURLInView (id, url, win) {
  // wait until the first URL is loaded to set the background color so that new tabs can use a custom background
    if (!viewStateMap[id].loadedInitialURL) {
    // Give the site a chance to display something before setting the background, in case it has its own dark theme
      viewMap[id].webContents.once('dom-ready', function () {
        viewMap[id].setBackgroundColor('#fff')
      })
      // If the view has no URL, it won't be attached yet
      windows.attachSelectedTabContent(id, viewMap[id])
    }
    viewMap[id].webContents.loadURL(url)
    viewStateMap[id].loadedInitialURL = true
  }

  function createError (code, message) {
    const error = new Error(message)
    error.code = code
    return error
  }

  function requireTabContent (sender, id) {
    const view = viewMap[id]
    if (!view?.webContents) {
      throw createError('TAB_CONTENT_NOT_FOUND', `Tab Content not found for ${id}`)
    }
    if (!windows.ownsTabContent(sender, id)) {
      throw createError('TAB_CONTENT_NOT_OWNER', `Browser Window does not own Tab Content ${id}`)
    }
    if (typeof view.webContents.isDestroyed === 'function' && view.webContents.isDestroyed()) {
      throw createError('TAB_CONTENT_DESTROYED', `Tab Content ${id} is destroyed`)
    }
    return view
  }

  function getNavigationHistory (webContents) {
    const entries = []
    const activeIndex = webContents.navigationHistory.getActiveIndex()
    const size = webContents.navigationHistory.length()

    for (let i = 0; i < size; i++) {
      entries.push(webContents.navigationHistory.getEntryAtIndex(i))
    }

    return {
      activeIndex,
      entries
    }
  }

  function getSourceURL (url) {
    if (!url.startsWith('min://')) {
      return url
    }
    try {
      return new URL(url).searchParams.get('url') || url
    } catch (error) {
      return url
    }
  }

  async function executeTabContentCommand (sender, request) {
    const id = request.id
    const operation = request.operation
    const payload = request.payload || {}

    if (operation === 'lifecycle.create') {
      const webPreferences = {
        additionalArguments: payload.indexingEnabled === false ? ['--min-indexing-disabled'] : [],
        partition: payload.private ? id.toString() : 'persist:webcontent'
      }
      createView(sender, payload.existingTabContentId, id, webPreferences, payload.bounds)
      if (payload.initialURL) {
        loadURLInView(id, payload.initialURL, windows.windowFromContents(sender)?.win)
      }
      return true
    }
    if (operation === 'lifecycle.present') {
      if (!viewMap[id]) {
        throw createError('TAB_CONTENT_NOT_FOUND', `Tab Content not found for ${id}`)
      }
      setView(id, sender)
      setBounds(id, payload.bounds)
      if (payload.focus && BrowserWindow.fromWebContents(sender)?.isFocused()) {
        if (!focusView(id)) {
          sender.focus()
        }
      }
      return true
    }
    if (operation === 'lifecycle.hide') {
      hideCurrentView(sender)
      return true
    }

    const view = requireTabContent(sender, id)
    const webContents = view.webContents

    switch (operation) {
      case 'lifecycle.destroy':
        destroyView(id)
        return true
      case 'lifecycle.set-bounds':
        setBounds(id, payload.bounds)
        return true
      case 'navigation.load':
        loadURLInView(id, payload.url, windows.windowFromContents(sender)?.win)
        return true
      case 'indexing.configure':
        webContents.send('page-indexing-config', {
          enabled: payload.enabled === true,
          navigationGeneration: payload.navigationGeneration
        })
        return true
      case 'navigation.back':
        webContents.goBack()
        return true
      case 'navigation.forward':
        webContents.goForward()
        return true
      case 'navigation.back-skipping-internal': { // preserve Min's internal-page redirect behavior
        const history = getNavigationHistory(webContents)
        const currentURL = history.entries[history.activeIndex]?.url || ''
        const previousURL = history.entries[history.activeIndex - 1]?.url
        if (currentURL.startsWith('min://') && history.activeIndex > 1 && previousURL === getSourceURL(currentURL) && webContents.canGoToOffset(-2)) {
          webContents.goToOffset(-2)
        } else {
          webContents.goBack()
        }
        return true
      }
      case 'navigation.stop':
        webContents.stop()
        return true
      case 'navigation.reload':
        if (payload.ignoreCache) {
          webContents.reloadIgnoringCache()
        } else {
          webContents.reload()
        }
        return true
      case 'navigation.state':
        return { canGoBack: webContents.canGoBack(), canGoForward: webContents.canGoForward() }
      case 'focus.content':
        return focusView(id)
      case 'focus.state':
        return webContents.isFocused()
      case 'focus.input-state':
        return webContents.executeJavaScript(`
          document.activeElement.tagName === 'INPUT'
          || document.activeElement.tagName === 'TEXTAREA'
          || document.activeElement.tagName === 'IFRAME'
          || (function () {
            var node = document.activeElement
            while (node) {
              if (node.getAttribute && node.getAttribute('contenteditable')) return true
              node = node.parentElement
            }
            return false
          })()
        `)
      case 'fullscreen.exit':
        return webContents.executeJavaScript('if (document.webkitIsFullScreen) document.webkitExitFullscreen()')
      case 'find.start':
        return webContents.findInPage(payload.text, payload.options)
      case 'find.stop':
        webContents.stopFindInPage(payload.action)
        return true
      case 'zoom.get':
        return webContents.getZoomFactor()
      case 'zoom.set':
        webContents.zoomFactor = payload.factor
        return payload.factor
      case 'zoom.adjust':
        webContents.zoomFactor = Math.min(payload.maximum, Math.max(payload.minimum, webContents.zoomFactor + payload.amount))
        return webContents.zoomFactor
      case 'interaction.scroll-state': {
        const x = Number(payload.x) || 0
        const y = Number(payload.y) || 0
        return webContents.executeJavaScript(`
          (function () {
            var left = 0
            var right = 0
            var isInFrame = false
            var node = document.elementFromPoint(${x}, ${y})
            while (node) {
              if (node.tagName === 'IFRAME') isInFrame = true
              if (node.scrollLeft !== undefined) {
                left = Math.max(left, node.scrollLeft)
                right = Math.max(right, node.scrollWidth - node.clientWidth - node.scrollLeft)
              }
              node = node.parentElement
            }
            return { left: left, right: right, isInFrame: isInFrame }
          })()
        `)
      }
      case 'interaction.scroll-to': {
        const position = Number(payload.position) || 0
        return webContents.executeJavaScript(`
          (function () {
            window.scrollTo(0, ${position})
            return window.scrollY === ${position}
          })()
        `)
      }
      case 'page.run-user-script':
      case 'page.evaluate-repl':
        return webContents.executeJavaScript(payload.code, payload.userGesture)
      case 'page.print':
        return webContents.executeJavaScript('window.print()')
      case 'internal-page.action': {
        const allowedActions = ['printArticle', 'printPDF', 'downloadPDF', 'startFindInPage', 'endFindInPage']
        if (!allowedActions.includes(payload.action)) {
          throw createError('UNSUPPORTED_OPERATION', `Unsupported internal-page action: ${payload.action}`)
        }
        return webContents.executeJavaScript(`parentProcessActions.${payload.action}()`)
      }
      case 'internal-page.message': {
        const allowedChannels = ['enterPictureInPicture', 'getContextMenuData']
        if (!allowedChannels.includes(payload.channel)) {
          throw createError('UNSUPPORTED_OPERATION', `Unsupported internal-page message: ${payload.channel}`)
        }
        webContents.send(payload.channel, payload.data)
        return true
      }
      case 'download.url':
        webContents.downloadURL(payload.url)
        return true
      case 'download.save-page':
        return webContents.savePage(payload.path, 'HTMLComplete')
      case 'capture.preview': {
        if (viewStateMap[id].private) return null
        const sourceImage = await webContents.capturePage()
        const sourceSize = sourceImage.getSize()
        if (sourceSize.width === 0 || sourceSize.height === 0) return null
        const width = Math.min(480, Math.max(1, Math.round(Number(payload.width) || 1)))
        const height = Math.min(320, Math.max(1, Math.round(Number(payload.height) || 1)))
        const image = sourceImage.resize({ width, height, quality: 'good' })
        const dataURL = image.toDataURL()
        const maximumBytes = Math.min(256 * 1024, Math.max(1, Number(payload.maxBytes) || 256 * 1024))
        return Buffer.byteLength(dataURL, 'utf8') <= maximumBytes ? dataURL : null
      }
      case 'capture.download': {
        const image = await webContents.capturePage()
        webContents.downloadURL(image.toDataURL())
        return true
      }
      case 'audio.set-muted':
        webContents.setAudioMuted(payload.muted)
        return true
      case 'edit.copy':
        webContents.copy()
        return true
      case 'edit.copy-image':
        webContents.copyImageAt(payload.x, payload.y)
        return true
      case 'edit.paste':
        webContents.paste()
        return true
      case 'edit.paste-match-style':
        webContents.pasteAndMatchStyle()
        return true
      case 'edit.replace-misspelling':
        webContents.replaceMisspelling(payload.suggestion)
        return true
      case 'development.inspect':
        webContents.inspectElement(payload.x, payload.y)
        return true
      case 'development.toggle-tools':
        webContents.toggleDevTools()
        return true
      default:
        throw createError('UNSUPPORTED_OPERATION', `Unsupported Tab Content operation: ${operation}`)
    }
  }

  ipc.handle('tab-content-command', async function (event, request) {
    try {
      return { ok: true, value: await executeTabContentCommand(event.sender, request) }
    } catch (error) {
      return {
        ok: false,
        error: {
          code: error.code || 'TAB_CONTENT_OPERATION_FAILED',
          message: error.message
        }
      }
    }
  })

  return {
    destroyAllViews,
    getDefaultViewWebPreferences,
    getTabIDFromWebContents,
    executeTabContentCommand
  }
}

module.exports = createViewManager
