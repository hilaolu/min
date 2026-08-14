const browserSession = require('tabState.js')
/* Handles messages that get sent from the menu bar in the main process */

var webviews = require('webviews.js')
var webviewGestures = require('webviewGestures.js')
var browserUI = require('browserUI.js')
var focusMode = require('focusMode.js')
var findinpage = require('findinpage.js')
var PDFViewer = require('pdfViewer.js')
var tabEditor = require('navbar/tabEditor.js')
var readerView = require('readerView.js')
var taskOverlay = require('taskOverlay/taskOverlay.js')

module.exports = {
  initialize: function () {
    ipc.on('zoomIn', function () {
      webviewGestures.zoomWebviewIn(browserSession.tabs.getSelected())
    })

    ipc.on('zoomOut', function () {
      webviewGestures.zoomWebviewOut(browserSession.tabs.getSelected())
    })

    ipc.on('zoomReset', function () {
      webviewGestures.resetWebviewZoom(browserSession.tabs.getSelected())
    })

    ipc.on('print', function () {
      if (PDFViewer.isPDFViewer(browserSession.tabs.getSelected())) {
        PDFViewer.printPDF(browserSession.tabs.getSelected())
      } else if (readerView.isReader(browserSession.tabs.getSelected())) {
        readerView.printArticle(browserSession.tabs.getSelected())
      } else if (webviews.placeholderRequests.length === 0) {
        // work around #1281 - calling print() when the view is hidden crashes on Linux in Electron 12
        // TODO figure out why webContents.print() doesn't work in Electron 4
        webviews.print(browserSession.tabs.getSelected())
      }
    })

    ipc.on('findInPage', function () {
      findinpage.start()
    })

    ipc.on('inspectPage', function () {
      webviews.toggleDeveloperTools(browserSession.tabs.getSelected())
    })

    ipc.on('openEditor', function () {
      tabEditor.show(browserSession.tabs.getSelected())
    })

    ipc.on('showBookmarks', function () {
      tabEditor.show(browserSession.tabs.getSelected(), '!bookmarks ')
    })

    ipc.on('showHistory', function () {
      tabEditor.show(browserSession.tabs.getSelected(), '!history ')
    })

    ipc.on('addTab', function (e, data) {
      /* new tabs can't be created in focus mode */
      if (focusMode.enabled()) {
        focusMode.warn()
        return
      }

      browserUI.addTab({
        url: data.url || ''
      }, {
        enterEditMode: !data.url // only enter edit mode if the new tab is empty
      })
    })

    ipc.on('saveCurrentPage', async function () {
      var currentTab = browserSession.tabs.get(browserSession.tabs.getSelected())

      // new tabs cannot be saved
      if (!currentTab.url) {
        return
      }

      // if the current tab is a PDF, let the PDF viewer handle saving the document
      if (PDFViewer.isPDFViewer(browserSession.tabs.getSelected())) {
        PDFViewer.savePDF(browserSession.tabs.getSelected())
        return
      }

      if (browserSession.tabs.get(browserSession.tabs.getSelected()).isFileView) {
        webviews.download(browserSession.tabs.getSelected(), browserSession.tabs.get(browserSession.tabs.getSelected()).url)
      } else {
        var savePath = await ipc.invoke('showSaveDialog', {
          defaultPath: currentTab.title.replace(/[/\\]/g, '_')
        })

        // savePath will be undefined if the save dialog is canceled
        if (savePath) {
          if (!savePath.endsWith('.html')) {
            savePath = savePath + '.html'
          }
          webviews.savePage(browserSession.tabs.getSelected(), savePath)
        }
      }
    })

    ipc.on('addPrivateTab', function () {
      /* new tabs can't be created in focus mode */
      if (focusMode.enabled()) {
        focusMode.warn()
        return
      }

      browserUI.addTab({
        private: true
      })
    })

    ipc.on('toggleTaskOverlay', function () {
      taskOverlay.toggle()
    })

    ipc.on('goBack', function () {
      webviews.goBack(browserSession.tabs.getSelected())
    })

    ipc.on('goForward', function () {
      webviews.goForward(browserSession.tabs.getSelected())
    })
  }
}
