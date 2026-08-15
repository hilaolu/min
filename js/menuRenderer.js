const browserSession = require('tabState.js')
const rendererHost = require('rendererHost.js')
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
    rendererHost.onBrowserCommand(function (command) {
      if (command.type === 'zoom-in') {
        webviewGestures.zoomWebviewIn(browserSession.tabs.getSelected())
      } else if (command.type === 'zoom-out') {
        webviewGestures.zoomWebviewOut(browserSession.tabs.getSelected())
      } else if (command.type === 'zoom-reset') {
        webviewGestures.resetWebviewZoom(browserSession.tabs.getSelected())
      } else if (command.type === 'print') {
        if (PDFViewer.isPDFViewer(browserSession.tabs.getSelected())) {
          PDFViewer.printPDF(browserSession.tabs.getSelected())
        } else if (readerView.isReader(browserSession.tabs.getSelected())) {
          readerView.printArticle(browserSession.tabs.getSelected())
        } else if (webviews.placeholderRequests.length === 0) {
          // work around #1281 - calling print() when the view is hidden crashes on Linux in Electron 12
          // TODO figure out why webContents.print() doesn't work in Electron 4
          webviews.print(browserSession.tabs.getSelected())
        }
      } else if (command.type === 'find-in-page') {
        findinpage.start()
      } else if (command.type === 'inspect-page') {
        webviews.toggleDeveloperTools(browserSession.tabs.getSelected())
      } else if (command.type === 'open-editor') {
        tabEditor.show(browserSession.tabs.getSelected())
      } else if (command.type === 'show-bookmarks') {
        tabEditor.show(browserSession.tabs.getSelected(), '!bookmarks ')
      } else if (command.type === 'show-history') {
        tabEditor.show(browserSession.tabs.getSelected(), '!history ')
      } else if (command.type === 'add-tab') {
        /* new tabs can't be created in focus mode */
        if (focusMode.enabled()) {
          focusMode.warn()
          return
        }

        browserUI.addTab({
          url: command.url || ''
        }, {
          enterEditMode: !command.url // only enter edit mode if the new tab is empty
        })
      } else if (command.type === 'save-current-page') {
        const currentTab = browserSession.tabs.get(browserSession.tabs.getSelected())

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
          rendererHost.savePage(browserSession.tabs.getSelected(), currentTab.title).catch(function (error) {
            console.warn('failed to save page', error)
          })
        }
      } else if (command.type === 'add-private-tab') {
        /* new tabs can't be created in focus mode */
        if (focusMode.enabled()) {
          focusMode.warn()
          return
        }

        browserUI.addTab({
          private: true
        })
      } else if (command.type === 'toggle-task-overlay') {
        taskOverlay.toggle()
      } else if (command.type === 'go-back') {
        webviews.goBack(browserSession.tabs.getSelected())
      } else if (command.type === 'go-forward') {
        webviews.goForward(browserSession.tabs.getSelected())
      }
    })
  }
}
