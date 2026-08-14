const browserSession = require('tabState.js')
var webviews = require('webviews.js')
var keybindings = require('keybindings.js')
var PDFViewer = require('pdfViewer.js')

var findinpage = {
  container: document.getElementById('findinpage-bar'),
  input: document.getElementById('findinpage-input'),
  counter: document.getElementById('findinpage-count'),
  previous: document.getElementById('findinpage-previous-match'),
  next: document.getElementById('findinpage-next-match'),
  endButton: document.getElementById('findinpage-end'),
  activeTab: null,
  start: function (options) {
    webviews.releaseFocus()

    findinpage.input.placeholder = 'Search in Page'

    findinpage.activeTab = browserSession.tabs.getSelected()

    /* special case for PDF viewer */

    if (PDFViewer.isPDFViewer(findinpage.activeTab)) {
      PDFViewer.startFindInPage(findinpage.activeTab)
    }

    findinpage.counter.textContent = ''
    findinpage.container.hidden = false
    findinpage.input.focus()
    findinpage.input.select()

    if (findinpage.input.value) {
      webviews.find(findinpage.activeTab, findinpage.input.value)
    }
  },
  end: function (options) {
    options = options || {}
    var action = options.action || 'keepSelection'

    findinpage.container.hidden = true

    if (findinpage.activeTab) {
      webviews.stopFind(findinpage.activeTab, action)

      /* special case for PDF viewer */
      if (browserSession.tabs.get(findinpage.activeTab) && PDFViewer.isPDFViewer(findinpage.activeTab)) {
        PDFViewer.endFindInPage(findinpage.activeTab)
      }

      webviews.focus()
    }

    findinpage.activeTab = null
  }
}

findinpage.input.addEventListener('click', function () {
  webviews.releaseFocus()
})

findinpage.endButton.addEventListener('click', function () {
  findinpage.end()
})

findinpage.input.addEventListener('input', function (e) {
  if (this.value) {
    webviews.find(findinpage.activeTab, findinpage.input.value)
  } else {
    webviews.stopFind(findinpage.activeTab, 'clearSelection')
    findinpage.counter.textContent = ''
  }
})

findinpage.input.addEventListener('keypress', function (e) {
  if (e.keyCode === 13) { // Return/Enter key
    webviews.find(findinpage.activeTab, findinpage.input.value, {
      forward: !e.shiftKey, // find previous if Shift is pressed
      findNext: false
    })
  }
})

findinpage.previous.addEventListener('click', function (e) {
  webviews.find(findinpage.activeTab, findinpage.input.value, {
    forward: false,
    findNext: false
  })
  findinpage.input.focus()
})

findinpage.next.addEventListener('click', function (e) {
  webviews.find(findinpage.activeTab, findinpage.input.value, {
    forward: true,
    findNext: false
  })
  findinpage.input.focus()
})

webviews.bindEvent('content-hidden', function (tabId) {
  if (tabId === findinpage.activeTab) {
    findinpage.end()
  }
})

browserSession.tasks.on('tab-selected', function (tabId) {
  if (tabId !== findinpage.activeTab) {
    findinpage.end()
  }
})

webviews.bindEvent('navigation-started', function (tabId, event) {
  if (event.isMainFrame && !event.isInPlace && tabId === findinpage.activeTab) {
    findinpage.end()
  }
})

webviews.bindEvent('find-result', function (tabId, event) {
  const data = event.result
  if (data.matches !== undefined) {
    var matchLabel = data.matches === 1 ? 'match' : 'matches'
    findinpage.counter.textContent = `${data.activeMatchOrdinal} of ${data.matches} ${matchLabel}`
  }
})

keybindings.defineShortcut('followLink', function () {
  findinpage.end({ action: 'activateSelection' })
})

keybindings.defineShortcut({ keys: 'esc' }, function (e) {
  findinpage.end()
})

module.exports = findinpage
