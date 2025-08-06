var urlParser = require('util/urlParser.js')
var settings = require('util/settings/settings.js')

/* implements selecting webviews, switching between them, and creating new ones. */

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
    var tab = tabs.get(tabId)
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
      ipc.send('getCapture', {
        id: tabId,
        width: Math.round(window.innerWidth / 10),
        height: Math.round(window.innerHeight / 10)
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
    var tab = tabs.get(tabId)
    if (tab) {
      tabs.update(tabId, { previewImage: null })
    }
  },
  
  // Clear status for tab (used when tab is destroyed)
  clear: function (tabId) {
    delete this.status[tabId]
    // Also clear the actual image data
    var tab = tabs.get(tabId)
    if (tab) {
      tabs.update(tabId, { previewImage: null })
    }
  }
}

function captureCurrentTab (options) {
  if (tabs.get(tabs.getSelected()).private) {
    // don't capture placeholders for private tabs
    return
  }

  if (webviews.placeholderRequests.length > 0 && !(options && options.forceCapture === true)) {
    // capturePage doesn't work while the view is hidden
    return
  }

  previewImageManager.capture(webviews.selectedId)
}



// called whenever a new page starts loading, or an in-page navigation occurs
function onPageURLChange (tab, url) {
  if (url.indexOf('https://') === 0 || url.indexOf('about:') === 0 || url.indexOf('chrome:') === 0 || url.indexOf('file://') === 0 || url.indexOf('min://') === 0) {
    tabs.update(tab, {
      secure: true,
      url: url
    })
  } else {
    tabs.update(tab, {
      secure: false,
      url: url
    })
  }

  webviews.callAsync(tab, 'setVisualZoomLevelLimits', [1, 3])
}

// called whenever a navigation finishes
function onNavigate (tabId, url, isInPlace, isMainFrame, frameProcessId, frameRoutingId) {
  if (isMainFrame) {
    onPageURLChange(tabId, url)
  }
}

// called whenever the page finishes loading
function onPageLoad (tabId) {
  // Invalidate screenshot when page loads (don't capture automatically)
  previewImageManager.invalidate(tabId)
}

// called when navigation starts (including reloads)
function onNavigationStart (tabId, url, isInPlace, isMainFrame, frameProcessId, frameRoutingId) {
  if (isMainFrame) {
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
            webviews.callAsync(tabId, 'executeJavaScript', `
            (function() {
              window.scrollTo(0, ${scrollPosition})
              return window.scrollY === ${scrollPosition}
            })()
            `, function (err, completed) {
              if (!err && completed) {
                done = true
              }
            })
          }
        }, 750 * i)
      }
      webviews.unbindEvent('did-finish-load', listener)
    }
  }
  webviews.bindEvent('did-finish-load', listener)
}

function setAudioMutedOnCreate (tabId, muted) {
  const listener = function () {
    webviews.callAsync(tabId, 'setAudioMuted', muted)
    webviews.unbindEvent('did-navigate', listener)
  }
  webviews.bindEvent('did-navigate', listener)
}

const webviews = {
  viewFullscreenMap: {}, // tabId, isFullscreen
  selectedId: null,
  placeholderRequests: [],
  asyncCallbacks: {},
  internalPages: {
    error: 'min://app/pages/error/index.html'
  },
  events: [],
  IPCEvents: [],
  hasViewForTab: function(tabId) {
    return tabId && tasks.getTaskContainingTab(tabId) && tasks.getTaskContainingTab(tabId).tabs.get(tabId).hasWebContents
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
  emitEvent: function (event, tabId, args) {
    if (!webviews.hasViewForTab(tabId)) {
      // the view could have been destroyed between when the event was occured and when it was recieved in the UI process, see https://github.com/minbrowser/min/issues/604#issuecomment-419653437
      return
    }
    webviews.events.forEach(function (ev) {
      if (ev.event === event) {
        ev.fn.apply(this, [tabId].concat(args))
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
      if (!hasSeparateTitlebar && (window.platformType === 'linux' || window.platformType === 'windows') && !windowIsMaximized && !windowIsFullscreen) {
        var navbarHeight = 48
      } else {
        var navbarHeight = 36
      }

      const viewMargins = webviews.viewMargins

      let position = {
        x: 0 + Math.round(viewMargins[3]),
        y: 0 + Math.round(viewMargins[0]) + navbarHeight,
        width: window.innerWidth - Math.round(viewMargins[1] + viewMargins[3]),
        height: window.innerHeight - Math.round(viewMargins[0] + viewMargins[2]) - navbarHeight
      }

      return position
    }
  },
  add: function (tabId, existingViewId) {
    var tabData = tabs.get(tabId)

    // needs to be called before the view is created to that its listeners can be registered
    if (tabData.scrollPosition) {
      scrollOnLoad(tabId, tabData.scrollPosition)
    }

    if (tabData.muted) {
      setAudioMutedOnCreate(tabId, tabData.muted)
    }

    // if the tab is private, we want to partition it. See http://electron.atom.io/docs/v0.34.0/api/web-view-tag/#partition
    // since tab IDs are unique, we can use them as partition names
    if (tabData.private === true) {
      var partition = tabId.toString() // options.tabId is a number, which remote.session.fromPartition won't accept. It must be converted to a string first
    }

    ipc.send('createView', {
      existingViewId,
      id: tabId,
      webPreferences: {
        partition: partition || 'persist:webcontent'
      },
      boundsString: JSON.stringify(webviews.getViewBounds()),
      events: webviews.events.map(e => e.event).filter((i, idx, arr) => arr.indexOf(i) === idx)
    })

    if (!existingViewId) {
      if (tabData.url) {
        ipc.send('loadURLInView', { id: tabData.id, url: urlParser.parse(tabData.url) })
      } else if (tabData.private) {
        // workaround for https://github.com/minbrowser/min/issues/872
        ipc.send('loadURLInView', { id: tabData.id, url: urlParser.parse('min://newtab') })
      }
    }

    tasks.getTaskContainingTab(tabId).tabs.update(tabId, {
      hasWebContents: true
    })
  },
  setSelected: function (id, options) { // options.focus - whether to focus the view. Defaults to true.
    webviews.emitEvent('view-hidden', webviews.selectedId)

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

    ipc.send('setView', {
      id: id,
      bounds: webviews.getViewBounds(),
      focus: !options || options.focus !== false
    })
    webviews.emitEvent('view-shown', id)
  },
  update: function (id, url) {
    ipc.send('loadURLInView', { id: id, url: urlParser.parse(url) })
  },
  destroy: function (id) {
    webviews.emitEvent('view-hidden', id)

    if (webviews.hasViewForTab(id)) {
      tasks.getTaskContainingTab(id).tabs.update(id, {
        hasWebContents: false
      })
    }
    //we may be destroying a view for which the tab object no longer exists, so this message should be sent unconditionally
    ipc.send('destroyView', id)

    delete webviews.viewFullscreenMap[id]
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

      var associatedTab = tasks.getTaskContainingTab(webviews.selectedId).tabs.get(webviews.selectedId)
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
        ipc.send('hideCurrentView')
        webviews.emitEvent('view-hidden', webviews.selectedId)
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
        ipc.send('setView', {
          id: webviews.selectedId,
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
    ipc.send('focusMainWebContents')
  },
  focus: function () {
    if (webviews.selectedId) {
      ipc.send('focusView', webviews.selectedId)
    }
  },
  resize: function () {
    ipc.send('setBounds', { id: webviews.selectedId, bounds: webviews.getViewBounds() })
  },
  goBackIgnoringRedirects: async function (id) {
    const navHistory = await webviews.getNavigationHistory(id)
    // If the current page is an internal page resulting from a redirect (error pages or reader mode), go back two pages

    var url = navHistory.entries[navHistory.activeIndex].url

    if (urlParser.isInternalURL(url) && navHistory.activeIndex > 1 && navHistory.entries[navHistory.activeIndex - 1].url === urlParser.getSourceURL(url)) {
      webviews.callAsync(id, 'canGoToOffset', -2, function (err, result) {
        if (!err && result === true) {
          webviews.callAsync(id, 'goToOffset', -2)
        } else {
          webviews.callAsync(id, 'goBack')
        }
      })
    } else {
      webviews.callAsync(id, 'goBack')
    }
  },
  /*
  Can be called as
  callAsync(id, method, args, callback) -> invokes method with args, runs callback with (err, result)
  callAsync(id, method, callback) -> invokes method with no args, runs callback with (err, result)
  callAsync(id, property, value, callback) -> sets property to value
  callAsync(id, property, callback) -> reads property, runs callback with (err, result)
   */
  callAsync: function (id, method, argsOrCallback, callback) {
    var args = argsOrCallback
    var cb = callback
    if (argsOrCallback instanceof Function && !cb) {
      args = []
      cb = argsOrCallback
    }
    if (!(args instanceof Array)) {
      args = [args]
    }
    if (cb) {
      var callId = Math.random()
      webviews.asyncCallbacks[callId] = cb
    }
    ipc.send('callViewMethod', { id: id, callId: callId, method: method, args: args })
  },
  getNavigationHistory: function (id) {
    return ipc.invoke('getNavigationHistory', id)
  }
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

// leave HTML fullscreen when leaving window fullscreen
ipc.on('leave-full-screen', function () {
  // electron normally does this automatically (https://github.com/electron/electron/pull/13090/files), but it doesn't work for BrowserViews
  for (var view in webviews.viewFullscreenMap) {
    if (webviews.viewFullscreenMap[view]) {
      webviews.callAsync(view, 'executeJavaScript', 'document.exitFullscreen()')
    }
  }
})

webviews.bindEvent('enter-html-full-screen', function (tabId) {
  webviews.viewFullscreenMap[tabId] = true
  webviews.resize()
})

webviews.bindEvent('leave-html-full-screen', function (tabId) {
  webviews.viewFullscreenMap[tabId] = false
  webviews.resize()
})

ipc.on('maximize', function () {
  windowIsMaximized = true
  webviews.resize()
})

ipc.on('unmaximize', function () {
  windowIsMaximized = false
  webviews.resize()
})

ipc.on('enter-full-screen', function () {
  windowIsFullscreen = true
  webviews.resize()
})

ipc.on('leave-full-screen', function () {
  windowIsFullscreen = false
  webviews.resize()
})

webviews.bindEvent('did-start-navigation', onNavigationStart)
webviews.bindEvent('will-redirect', onNavigate)
webviews.bindEvent('did-navigate', function (tabId, url, httpResponseCode, httpStatusText) {
  onPageURLChange(tabId, url)
})

webviews.bindEvent('did-finish-load', onPageLoad)

// Additional events to handle reloads and navigation more robustly
webviews.bindEvent('did-start-loading', function (tabId) {
  // Invalidate screenshot when page starts loading
  previewImageManager.invalidate(tabId)
})

webviews.bindEvent('did-stop-loading', function (tabId) {
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

webviews.bindEvent('page-title-updated', function (tabId, title, explicitSet) {
  tabs.update(tabId, {
    title: title
  })
})

webviews.bindEvent('did-fail-load', function (tabId, errorCode, errorDesc, validatedURL, isMainFrame) {
  if (errorCode && errorCode !== -3 && isMainFrame && validatedURL) {
    webviews.update(tabId, webviews.internalPages.error + '?ec=' + encodeURIComponent(errorCode) + '&url=' + encodeURIComponent(validatedURL))
  }
})

webviews.bindEvent('crashed', function (tabId, isKilled) {
  var url = tabs.get(tabId).url

  tabs.update(tabId, {
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

webviews.bindIPC('getSettingsData', function (tabId, args) {
  if (!urlParser.isInternalURL(tabs.get(tabId).url)) {
    throw new Error()
  }
  webviews.callAsync(tabId, 'send', ['receiveSettingsData', settings.list])
})
webviews.bindIPC('setSetting', function (tabId, args) {
  if (!urlParser.isInternalURL(tabs.get(tabId).url)) {
    throw new Error()
  }
  settings.set(args[0].key, args[0].value)
})

settings.listen(function () {
  tasks.forEach(function (task) {
    task.tabs.forEach(function (tab) {
      if (tab.url.startsWith('min://')) {
        try {
          webviews.callAsync(tab.id, 'send', ['receiveSettingsData', settings.list])
        } catch (e) {
          // webview might not actually exist
        }
      }
    })
  })
})

webviews.bindIPC('scroll-position-change', function (tabId, args) {
  tabs.update(tabId, {
    scrollPosition: args[0]
  })
})

webviews.bindIPC('downloadFile', function (tabId, args) {
  if (tabs.get(tabId).url.startsWith('min://')) {
    webviews.callAsync(tabId, 'downloadURL', [args[0]])
  }
})

ipc.on('view-event', function (e, args) {
  webviews.emitEvent(args.event, args.tabId, args.args)
})

ipc.on('async-call-result', function (e, args) {
  webviews.asyncCallbacks[args.callId](args.error, args.result)
  delete webviews.asyncCallbacks[args.callId]
})

ipc.on('view-ipc', function (e, args) {
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



ipc.on('captureData', function (e, data) {
  tabs.update(data.id, { previewImage: data.url })
  previewImageManager.markCaptured(data.id)
  if (data.id === webviews.selectedId && webviews.placeholderRequests.length > 0) {
    placeholderImg.src = data.url
    placeholderImg.hidden = false
  }
})

/* focus the view when the window is focused */

ipc.on('windowFocus', function () {
  if (webviews.placeholderRequests.length === 0 && document.activeElement.tagName !== 'INPUT') {
    webviews.focus()
  }
})

module.exports = webviews
