const browserSession = require('tabState.js')
const rendererHost = require('rendererHost.js')
const runtimeConfiguration = rendererHost.getRuntimeConfiguration()
var urlParser = require('util/urlParser.js')
var settings = require('util/settings/settings.js')

/* implements selecting webviews, switching between them, and creating new ones. */

function invokeTabContent (id, operation, payload) {
  return rendererHost.invokeTabContent(id, operation, payload)
}

function runTabContent (id, operation, payload) {
  return invokeTabContent(id, operation, payload).catch(function (error) {
    console.warn(`Tab Content operation ${operation} failed:`, error)
  })
}

function queryTabContent (id, operation, payload, callback) {
  const promise = invokeTabContent(id, operation, payload)
  if (callback) {
    promise.then(result => callback(null, result), error => callback(error))
  }
  return promise
}

var placeholderImg = document.getElementById('webview-placeholder')

var hasSeparateTitlebar = settings.get('useSeparateTitlebar')
var windowIsMaximized = false // affects navbar height on Windows
var windowIsFullscreen = false

// Simple lazy capture system for webview placeholders
var previewImageManager = {
  // Track screenshot status per tab: { timestamp, valid }
  status: {},

  // Maximum age for a screenshot to be considered valid (30 seconds)
  maxAge: 30000,

  // Get preview image, return null if not available (truly lazy)
  get: function (tabId) {
    var tab = browserSession.tabs.get(tabId)
    if (!tab || tab.private) {
      return null
    }

    var status = this.status[tabId]
    if (!status || !status.valid || !tab.previewImage) {
      return null
    }

    // Check if screenshot is still fresh
    if ((Date.now() - status.timestamp) < this.maxAge) {
      return tab.previewImage
    }

    // Screenshot is too old
    return null
  },

  // Capture screenshot for tab (asynchronous)
  capture: function (tabId) {
    if (tabId === webviews.selectedId) {
      queryTabContent(tabId, 'capture.preview', { scaleFactor: 0.1 }).then(function (dataURL) {
        if (!dataURL || !browserSession.tabs.get(tabId)) {
          return
        }
        browserSession.updateTab(tabId, { previewImage: dataURL })
        previewImageManager.markCaptured(tabId)
        if (tabId === webviews.selectedId && webviews.placeholderRequests.length > 0) {
          placeholderImg.src = dataURL
          placeholderImg.hidden = false
        }
      }).catch(function (error) {
        console.warn('Failed to capture Tab Content preview:', error)
      })
    }
  },

  // Mark screenshot as captured (called when captureData arrives)
  markCaptured: function (tabId) {
    this.status[tabId] = {
      timestamp: Date.now(),
      valid: true
    }
  },

  // Invalidate screenshot (clear both status and image data)
  invalidate: function (tabId) {
    if (this.status[tabId]) {
      this.status[tabId].valid = false
    }
    // Also clear the actual image data to prevent stale content
    var tab = browserSession.tabs.get(tabId)
    if (tab) {
      browserSession.updateTab(tabId, { previewImage: null })
    }
  },

  // Clear status for tab (used when tab is destroyed)
  clear: function (tabId) {
    delete this.status[tabId]
    // Also clear the actual image data
    var tab = browserSession.tabs.get(tabId)
    if (tab) {
      browserSession.updateTab(tabId, { previewImage: null })
    }
  }
}

// called whenever a new page starts loading, or an in-page navigation occurs
function onPageURLChange (tab, url) {
  if (url.indexOf('https://') === 0 || url.indexOf('about:') === 0 || url.indexOf('chrome:') === 0 || url.indexOf('file://') === 0 || url.indexOf('min://') === 0) {
    browserSession.updateTab(tab, {
      secure: true,
      url: url
    })
  } else {
    browserSession.updateTab(tab, {
      secure: false,
      url: url
    })
  }
}

// called whenever a navigation finishes
function onNavigate (tabId, event) {
  if (event.isMainFrame) {
    onPageURLChange(tabId, event.url)
  }
}

// called whenever the page finishes loading
function onPageLoad (tabId) {
  // Invalidate screenshot when page loads (don't capture automatically)
  previewImageManager.invalidate(tabId)
}

// called when navigation starts (including reloads)
function onNavigationStart (tabId, event) {
  delete webviews.downloadNavigationViews[tabId]

  if (event.isMainFrame) {
    // Invalidate screenshot when navigation starts
    previewImageManager.invalidate(tabId)
  }
}

function scrollOnLoad (tabId, scrollPosition) {
  const listener = function (eTabId) {
    if (eTabId === tabId) {
      // the scrollable content may not be available until some time after the load event, so attempt scrolling several times
      // but stop once we've successfully scrolled once so we don't overwrite user scroll attempts that happen later
      for (let i = 0; i < 3; i++) {
        var done = false
        setTimeout(function () {
          if (!done) {
            webviews.scrollTo(tabId, scrollPosition, function (err, completed) {
              if (!err && completed) {
                done = true
              }
            })
          }
        }, 750 * i)
      }
      webviews.unbindEvent('load-finished', listener)
    }
  }
  webviews.bindEvent('load-finished', listener)
}

function setAudioMutedOnCreate (tabId, muted) {
  const listener = function () {
    webviews.setAudioMuted(tabId, muted)
    webviews.unbindEvent('navigation-committed', listener)
  }
  webviews.bindEvent('navigation-committed', listener)
}

const webviews = {
  viewFullscreenMap: {}, // tabId, isFullscreen
  downloadNavigationViews: {}, // tabIds whose main-frame navigation turned into a download
  selectedId: null,
  placeholderRequests: [],
  internalPages: {
    error: 'min://app/pages/error/index.html'
  },
  events: [],
  IPCEvents: [],
  hasViewForTab: function (tabId) {
    return tabId && browserSession.tasks.getTaskContainingTab(tabId) && browserSession.tasks.getTaskContainingTab(tabId).tabs.get(tabId).hasWebContents
  },
  bindEvent: function (event, fn) {
    webviews.events.push({
      event: event,
      fn: fn
    })
  },
  unbindEvent: function (event, fn) {
    for (var i = 0; i < webviews.events.length; i++) {
      if (webviews.events[i].event === event && webviews.events[i].fn === fn) {
        webviews.events.splice(i, 1)
        i--
      }
    }
  },
  emitEvent: function (event, tabId, payload = {}) {
    if (!webviews.hasViewForTab(tabId)) {
      // the view could have been destroyed between when the event was occured and when it was recieved in the UI process, see https://github.com/minbrowser/min/issues/604#issuecomment-419653437
      return
    }
    webviews.events.forEach(function (ev) {
      if (ev.event === event) {
        ev.fn(tabId, payload)
      }
    })
  },
  bindIPC: function (name, fn) {
    webviews.IPCEvents.push({
      name: name,
      fn: fn
    })
  },
  viewMargins: [0, 0, 0, 0], // top, right, bottom, left
  adjustMargin: function (margins) {
    for (var i = 0; i < margins.length; i++) {
      webviews.viewMargins[i] += margins[i]
    }
    webviews.resize()
  },
  getViewBounds: function () {
    if (webviews.viewFullscreenMap[webviews.selectedId]) {
      return {
        x: 0,
        y: 0,
        width: window.innerWidth,
        height: window.innerHeight
      }
    } else {
      const navbarHeight = !hasSeparateTitlebar &&
        (runtimeConfiguration.platform === 'linux' || runtimeConfiguration.platform === 'win32') &&
        !windowIsMaximized &&
        !windowIsFullscreen
        ? 48
        : 36

      const viewMargins = webviews.viewMargins

      const position = {
        x: 0 + Math.round(viewMargins[3]),
        y: 0 + Math.round(viewMargins[0]) + navbarHeight,
        width: window.innerWidth - Math.round(viewMargins[1] + viewMargins[3]),
        height: window.innerHeight - Math.round(viewMargins[0] + viewMargins[2]) - navbarHeight
      }

      return position
    }
  },
  add: function (tabId, existingViewId) {
    var tabData = browserSession.tabs.get(tabId)

    // needs to be called before the view is created to that its listeners can be registered
    if (tabData.scrollPosition) {
      scrollOnLoad(tabId, tabData.scrollPosition)
    }

    if (tabData.muted) {
      setAudioMutedOnCreate(tabId, tabData.muted)
    }

    let initialURL = null
    if (!existingViewId && tabData.url) {
      initialURL = urlParser.parse(tabData.url)
    } else if (!existingViewId && tabData.private) {
      // workaround for https://github.com/minbrowser/min/issues/872
      initialURL = urlParser.parse('min://newtab')
    }
    runTabContent(tabId, 'lifecycle.create', {
      bounds: webviews.getViewBounds(),
      existingTabContentId: existingViewId,
      initialURL,
      private: tabData.private === true
    })

    browserSession.updateTab(tabId, {
      hasWebContents: true
    })
  },
  setSelected: function (id, options) { // options.focus - whether to focus the view. Defaults to true.
    webviews.emitEvent('content-hidden', webviews.selectedId)

    webviews.selectedId = id

    // create the view if it doesn't already exist
    if (!webviews.hasViewForTab(id)) {
      webviews.add(id)
    }

    if (webviews.placeholderRequests.length > 0) {
      // update the placeholder instead of showing the actual view
      webviews.requestPlaceholder()
      return
    }

    runTabContent(id, 'lifecycle.present', {
      bounds: webviews.getViewBounds(),
      focus: !options || options.focus !== false
    })
    webviews.emitEvent('content-shown', id)
  },
  update: function (id, url) {
    runTabContent(id, 'navigation.load', { url: urlParser.parse(url) })
  },
  destroy: function (id) {
    webviews.emitEvent('content-hidden', id)

    if (webviews.hasViewForTab(id)) {
      browserSession.updateTab(id, {
        hasWebContents: false
      })
    }
    // we may be destroying a view for which the tab object no longer exists, so this message should be sent unconditionally
    runTabContent(id, 'lifecycle.destroy')

    delete webviews.viewFullscreenMap[id]
    delete webviews.downloadNavigationViews[id]
    if (webviews.selectedId === id) {
      webviews.selectedId = null
    }
  },
  requestPlaceholder: function (reason) {
    if (reason && !webviews.placeholderRequests.includes(reason)) {
      webviews.placeholderRequests.push(reason)
    }
    if (webviews.placeholderRequests.length >= 1) {
      // create a new placeholder

      var associatedTab = browserSession.tasks.getTaskContainingTab(webviews.selectedId).tabs.get(webviews.selectedId)
      var img = previewImageManager.get(webviews.selectedId)
      if (img) {
        placeholderImg.src = img
        placeholderImg.hidden = false
      } else if (associatedTab && associatedTab.url) {
        // No valid screenshot available, initiate capture
        previewImageManager.capture(webviews.selectedId)
        placeholderImg.hidden = true // Hide until capture completes
      } else {
        placeholderImg.hidden = true
      }
    }
    setTimeout(function () {
      // wait to make sure the image is visible before the view is hidden
      // make sure the placeholder was not removed between when the timeout was created and when it occurs
      if (webviews.placeholderRequests.length > 0) {
        runTabContent(null, 'lifecycle.hide')
        webviews.emitEvent('content-hidden', webviews.selectedId)
      }
    }, 0)
  },
  hidePlaceholder: function (reason) {
    if (webviews.placeholderRequests.includes(reason)) {
      webviews.placeholderRequests.splice(webviews.placeholderRequests.indexOf(reason), 1)
    }

    if (webviews.placeholderRequests.length === 0) {
      // multiple things can request a placeholder at the same time, but we should only show the view again if nothing requires a placeholder anymore
      if (webviews.hasViewForTab(webviews.selectedId)) {
        runTabContent(webviews.selectedId, 'lifecycle.present', {
          bounds: webviews.getViewBounds(),
          focus: true
        })
        webviews.emitEvent('view-shown', webviews.selectedId)
      }
      // wait for the view to be visible before removing the placeholder
      setTimeout(function () {
        if (webviews.placeholderRequests.length === 0) { // make sure the placeholder hasn't been re-enabled
          placeholderImg.hidden = true
        }
      }, 400)
    }
  },
  releaseFocus: function () {
    rendererHost.focusBrowserChrome()
  },
  focus: function () {
    if (webviews.selectedId) {
      runTabContent(webviews.selectedId, 'focus.content')
    }
  },
  focusActiveContent: function () {
    if (webviews.downloadNavigationViews[webviews.selectedId]) {
      webviews.releaseFocus()
    } else {
      webviews.focus()
    }
  },
  resize: function () {
    if (webviews.selectedId) {
      runTabContent(webviews.selectedId, 'lifecycle.set-bounds', { bounds: webviews.getViewBounds() })
    }
  },
  goBackIgnoringRedirects: function (id) {
    return runTabContent(id, 'navigation.back-skipping-internal')
  },
  goBack: id => runTabContent(id, 'navigation.back'),
  goForward: id => runTabContent(id, 'navigation.forward'),
  stopLoading: id => runTabContent(id, 'navigation.stop'),
  reload: (id, ignoreCache = false) => runTabContent(id, 'navigation.reload', { ignoreCache }),
  getNavigationState: (id, callback) => queryTabContent(id, 'navigation.state', null, callback),
  isFocused: (id, callback) => queryTabContent(id, 'focus.state', null, callback),
  isInputFocused: (id, callback) => queryTabContent(id, 'focus.input-state', null, callback),
  exitFullscreen: id => runTabContent(id, 'fullscreen.exit'),
  find: (id, text, options) => runTabContent(id, 'find.start', { text, options }),
  stopFind: (id, action) => runTabContent(id, 'find.stop', { action }),
  getZoom: (id, callback) => queryTabContent(id, 'zoom.get', null, callback),
  setZoom: (id, factor) => runTabContent(id, 'zoom.set', { factor }),
  adjustZoom: (id, amount, minimum, maximum) => runTabContent(id, 'zoom.adjust', { amount, minimum, maximum }),
  getScrollState: (id, x, y, callback) => queryTabContent(id, 'interaction.scroll-state', { x, y }, callback),
  scrollTo: (id, position, callback) => queryTabContent(id, 'interaction.scroll-to', { position }, callback),
  runUserScript: (id, code) => runTabContent(id, 'page.run-user-script', { code, userGesture: false }),
  evaluateForRepl: (id, code, callback) => queryTabContent(id, 'page.evaluate-repl', { code }, callback),
  print: id => runTabContent(id, 'page.print'),
  runInternalPageAction: (id, action) => runTabContent(id, 'internal-page.action', { action }),
  sendToInternalPage: (id, channel, data) => runTabContent(id, 'internal-page.message', { channel, data }),
  download: (id, url) => runTabContent(id, 'download.url', { url }),
  downloadCapture: id => runTabContent(id, 'capture.download'),
  setAudioMuted: (id, muted) => runTabContent(id, 'audio.set-muted', { muted }),
  copy: id => runTabContent(id, 'edit.copy'),
  copyImage: (id, x, y) => runTabContent(id, 'edit.copy-image', { x, y }),
  paste: id => runTabContent(id, 'edit.paste'),
  pasteAndMatchStyle: id => runTabContent(id, 'edit.paste-match-style'),
  replaceMisspelling: (id, suggestion) => runTabContent(id, 'edit.replace-misspelling', { suggestion }),
  inspect: (id, x, y) => runTabContent(id, 'development.inspect', { x, y }),
  toggleDeveloperTools: id => runTabContent(id, 'development.toggle-tools')
}

window.addEventListener('resize', throttle(function () {
  if (webviews.placeholderRequests.length > 0) {
    // can't set view bounds if the view is hidden
    return
  }
  webviews.resize()

  // Invalidate screenshot on resize since dimensions changed
  if (webviews.selectedId) {
    previewImageManager.invalidate(webviews.selectedId)
  }
}, 75))

rendererHost.onWindowStateChanged(function (state) {
  // electron normally leaves HTML fullscreen with native fullscreen, but that doesn't work for Tab Content.
  if (windowIsFullscreen && !state.fullScreen) {
    for (var view in webviews.viewFullscreenMap) {
      if (webviews.viewFullscreenMap[view]) {
        webviews.exitFullscreen(view)
      }
    }
  }

  windowIsMaximized = state.maximized
  windowIsFullscreen = state.fullScreen
  webviews.resize()
})

webviews.bindEvent('fullscreen-entered', function (tabId) {
  webviews.viewFullscreenMap[tabId] = true
  webviews.resize()
})

webviews.bindEvent('fullscreen-left', function (tabId) {
  webviews.viewFullscreenMap[tabId] = false
  webviews.resize()
})

webviews.bindEvent('navigation-started', onNavigationStart)
webviews.bindEvent('navigation-redirected', onNavigate)
webviews.bindEvent('navigation-committed', function (tabId, event) {
  onPageURLChange(tabId, event.url)
})

webviews.bindEvent('load-finished', onPageLoad)

// Additional events to handle reloads and navigation more robustly
webviews.bindEvent('loading-started', function (tabId) {
  // Invalidate screenshot when page starts loading
  previewImageManager.invalidate(tabId)
})

webviews.bindEvent('loading-stopped', function (tabId) {
  // Invalidate screenshot when loading stops (don't capture automatically)
  previewImageManager.invalidate(tabId)
})

// Handle zoom level changes which affect the effective content size
webviews.bindEvent('zoom-changed', function (tabId, zoomDirection) {
  if (tabId === webviews.selectedId) {
    // Invalidate screenshot after zoom change
    previewImageManager.invalidate(tabId)
  }
})

webviews.bindEvent('title-updated', function (tabId, event) {
  browserSession.updateTab(tabId, {
    title: event.title
  })
})

webviews.bindEvent('load-failed', function (tabId, event) {
  if (event.errorCode && event.errorCode !== -3 && event.isMainFrame && event.url) {
    webviews.update(tabId, webviews.internalPages.error + '?ec=' + encodeURIComponent(event.errorCode) + '&url=' + encodeURIComponent(event.url))
  }
})

webviews.bindEvent('content-crashed', function (tabId) {
  var url = browserSession.tabs.get(tabId).url

  browserSession.updateTab(tabId, {
    url: webviews.internalPages.error + '?ec=crash&url=' + encodeURIComponent(url)
  })

  // Clear screenshot data for crashed tab
  previewImageManager.clear(tabId)

  // the existing process has crashed, so we can't reuse it
  webviews.destroy(tabId)
  webviews.add(tabId)

  if (tabId === webviews.selectedId) {
    webviews.setSelected(tabId)
  }
})

webviews.bindIPC('scroll-position-change', function (tabId, args) {
  browserSession.updateTab(tabId, {
    scrollPosition: args[0]
  })
})

webviews.bindIPC('downloadFile', function (tabId, args) {
  if (browserSession.tabs.get(tabId).url.startsWith('min://')) {
    webviews.download(tabId, args[0])
  }
})

rendererHost.onTabContentEvent(function (event) {
  webviews.emitEvent(event.type, event.tabId, event.payload)
})

rendererHost.onTabContentMessage(function (args) {
  if (!webviews.hasViewForTab(args.id)) {
    // the view could have been destroyed between when the event was occured and when it was recieved in the UI process, see https://github.com/minbrowser/min/issues/604#issuecomment-419653437
    return
  }
  webviews.IPCEvents.forEach(function (item) {
    if (item.name === args.name) {
      item.fn(args.id, [args.data], args.frameId, args.frameURL)
    }
  })
})

rendererHost.onDownloadNavigation(function (data) {
  if (!data.tabId) {
    return
  }

  webviews.downloadNavigationViews[data.tabId] = true

  if (data.tabId === webviews.selectedId && document.activeElement.tagName !== 'INPUT') {
    webviews.focusActiveContent()
  }
})

/* focus the view when the window is focused */

rendererHost.onBrowserChromeActivated(function () {
  if (webviews.placeholderRequests.length === 0 && document.activeElement.tagName !== 'INPUT') {
    webviews.focusActiveContent()
  }
})

module.exports = webviews
