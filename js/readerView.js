const browserSession = require('tabState.js')
var webviews = require('webviews.js')
var keybindings = require('keybindings.js')
var urlParser = require('util/urlParser.js')

var readerDecision = require('readerDecision.js')

var readerView = {
  readerURL: 'min://app/reader/index.html',
  isReader: function (tabId) {
    return browserSession.tabs.get(tabId).url.indexOf(readerView.readerURL) === 0
  },
  getButton: function (tabId) {
    // TODO better icon
    var button = document.createElement('button')
    button.className = 'reader-button tab-icon i carbon:notebook'

    button.setAttribute('data-tab', tabId)
    button.setAttribute('role', 'button')

    button.addEventListener('click', function (e) {
      e.stopPropagation()

      if (readerView.isReader(tabId)) {
        readerView.exit(tabId)
      } else {
        readerView.enter(tabId)
      }
    })

    readerView.updateButton(tabId, button)

    return button
  },
  updateButton: function (tabId, button) {
    button = button || document.querySelector('.reader-button[data-tab="{id}"]'.replace('{id}', tabId))
    var tab = browserSession.tabs.get(tabId)

    if (readerView.isReader(tabId)) {
      button.classList.add('is-reader')
      button.setAttribute('title', 'Exit Reader View')
    } else {
      button.classList.remove('is-reader')
      button.setAttribute('title', 'Enter Reader View')

      if (tab.readerable) {
        button.classList.add('can-reader')
      } else {
        button.classList.remove('can-reader')
      }
    }
  },
  enter: function (tabId, url) {
    var newURL = readerView.readerURL + '?url=' + encodeURIComponent(url || browserSession.tabs.get(tabId).url)
    browserSession.updateTab(tabId, { url: newURL })
    webviews.update(tabId, newURL)
  },
  exit: function (tabId) {
    var src = urlParser.getSourceURL(browserSession.tabs.get(tabId).url)
    // this page should not be automatically readerable in the future
    readerDecision.setURLStatus(src, false)
    browserSession.updateTab(tabId, { url: src })
    webviews.update(tabId, src)
  },
  printArticle: function (tabId) {
    if (!readerView.isReader(tabId)) {
      throw new Error("attempting to print in a tab that isn't a reader page")
    }

    webviews.callAsync(browserSession.tabs.getSelected(), 'executeJavaScript', 'parentProcessActions.printArticle()')
  },
  initialize: function () {
    // update the reader button on page load

    webviews.bindEvent('did-start-navigation', function (tabId, url, isInPlace, isMainFrame, frameProcessId, frameRoutingId) {
      if (isInPlace) {
        return
      }
      if (readerDecision.shouldRedirect(url) === 1) {
        // if this URL has previously been marked as readerable, load reader view without waiting for the page to load
        readerView.enter(tabId, url)
      } else if (isMainFrame) {
        browserSession.updateTab(tabId, {
          readerable: false // assume the new page can't be readered, we'll get another message if it can
        })

        readerView.updateButton(tabId)
      }
    })

    webviews.bindIPC('canReader', function (tab) {
      if (readerDecision.shouldRedirect(browserSession.tabs.get(tab).url) >= 0) {
        // if automatic reader mode has been enabled for this domain, and the page is readerable, enter reader mode
        readerView.enter(tab)
      }

      browserSession.updateTab(tab, {
        readerable: true
      })
      readerView.updateButton(tab)
    })

    // add a keyboard shortcut to enter reader mode

    keybindings.defineShortcut('toggleReaderView', function () {
      if (readerView.isReader(browserSession.tabs.getSelected())) {
        readerView.exit(browserSession.tabs.getSelected())
      } else {
        readerView.enter(browserSession.tabs.getSelected())
      }
    })
  }
}

readerView.initialize()

module.exports = readerView
