const browserSession = require('tabState.js')
const keybindings = require('keybindings.js')
var webviews = require('webviews.js')
var browserUI = require('browserUI.js')
var focusMode = require('focusMode.js')
var tabEditor = require('navbar/tabEditor.js')
var urlParser = require('util/urlParser.js')

const defaultKeybindings = {
  initialize: function () {
    keybindings.defineShortcut('quitMin', function () {
      ipc.send('quit')
    })

    keybindings.defineShortcut('addTab', function () {
      /* new tabs can't be created in focus mode */
      if (focusMode.enabled()) {
        focusMode.warn()
        return
      }

      browserUI.addTab()
    })

    keybindings.defineShortcut('addPrivateTab', function () {
      /* new tabs can't be created in focus mode */
      if (focusMode.enabled()) {
        focusMode.warn()
        return
      }

      browserUI.addTab({
        private: true
      })
    })

    keybindings.defineShortcut('duplicateTab', function () {
      if (focusMode.enabled()) {
        focusMode.warn()
        return
      }

      browserUI.duplicateTab(browserSession.tabs.getSelected(), { enterEditMode: false })
    })

    keybindings.defineShortcut('enterEditMode', function (e) {
      tabEditor.show(browserSession.tabs.getSelected())
      return false
    })

    keybindings.defineShortcut('runShortcut', function (e) {
      tabEditor.show(browserSession.tabs.getSelected(), '!')
    })

    keybindings.defineShortcut('closeTab', function (e) {
      browserUI.closeTab(browserSession.tabs.getSelected())
    }, { contexts: ['default'] })

    keybindings.defineShortcut('moveTabLeft', function (e) {
      browserUI.moveTabLeft(browserSession.tabs.getSelected())
    })

    keybindings.defineShortcut('moveTabRight', function (e) {
      browserUI.moveTabRight(browserSession.tabs.getSelected())
    })

    keybindings.defineShortcut('restoreTab', function (e) {
      if (focusMode.enabled()) {
        focusMode.warn()
        return
      }

      browserUI.restoreTab(browserSession.tasks.getSelected().id, {
        enterEditMode: false
      })
    })

    keybindings.defineShortcut('addToFavorites', function (e) {
      tabEditor.show(browserSession.tabs.getSelected(), null, false) // we need to show the bookmarks button, which is only visible in edit mode
      tabEditor.container.querySelector('.bookmarks-button').click()
    })

    keybindings.defineShortcut('showBookmarks', function () {
      tabEditor.show(browserSession.tabs.getSelected(), '!bookmarks ')
    })

    // Removed mod+1 through mod+8 bindings to make way for Ctrl+0 to Ctrl+9 in command palette

    keybindings.defineShortcut('gotoLastTab', function (e) {
      browserUI.switchToTab(browserSession.tabs.getAtIndex(browserSession.tabs.count() - 1).id)
    })

    keybindings.defineShortcut('gotoFirstTab', function (e) {
      browserUI.switchToTab(browserSession.tabs.getAtIndex(0).id)
    })

    keybindings.defineShortcut({ keys: 'esc' }, function (e) {
      if (webviews.placeholderRequests.length === 0 && document.activeElement.tagName !== 'INPUT') {
        webviews.callAsync(browserSession.tabs.getSelected(), 'stop')
      }

      tabEditor.hide()

      // exit full screen mode
      webviews.callAsync(browserSession.tabs.getSelected(), 'executeJavaScript', 'if(document.webkitIsFullScreen){document.webkitExitFullscreen()}')

      webviews.callAsync(browserSession.tabs.getSelected(), 'focus')
    })

    keybindings.defineShortcut('goBack', function (d) {
      webviews.callAsync(browserSession.tabs.getSelected(), 'goBack')
    })

    keybindings.defineShortcut('goForward', function (d) {
      webviews.callAsync(browserSession.tabs.getSelected(), 'goForward')
    })

    keybindings.defineShortcut('switchToPreviousTab', function (d) {
      var currentIndex = browserSession.tabs.getIndex(browserSession.tabs.getSelected())
      var previousTab = browserSession.tabs.getAtIndex(currentIndex - 1)

      if (previousTab) {
        browserUI.switchToTab(previousTab.id)
      } else {
        browserUI.switchToTab(browserSession.tabs.getAtIndex(browserSession.tabs.count() - 1).id)
      }
    })

    keybindings.defineShortcut('switchToNextTab', function (d) {
      var currentIndex = browserSession.tabs.getIndex(browserSession.tabs.getSelected())
      var nextTab = browserSession.tabs.getAtIndex(currentIndex + 1)

      if (nextTab) {
        browserUI.switchToTab(nextTab.id)
      } else {
        browserUI.switchToTab(browserSession.tabs.getAtIndex(0).id)
      }
    })

    keybindings.defineShortcut('switchToNextTask', function (d) {
      if (focusMode.enabled()) {
        focusMode.warn()
        return
      }

      const taskSwitchList = browserSession.tasks.filter(t => !browserSession.tasks.isCollapsed(t.id))

      const currentTaskIdx = taskSwitchList.findIndex(t => t.id === browserSession.tasks.getSelected().id)

      const nextTask = taskSwitchList[currentTaskIdx + 1] || taskSwitchList[0]
      browserUI.switchToTask(nextTask.id)
    })

    keybindings.defineShortcut('switchToPreviousTask', function (d) {
      if (focusMode.enabled()) {
        focusMode.warn()
        return
      }

      const taskSwitchList = browserSession.tasks.filter(t => !browserSession.tasks.isCollapsed(t.id))

      const currentTaskIdx = taskSwitchList.findIndex(t => t.id === browserSession.tasks.getSelected().id)

      const previousTask = taskSwitchList[currentTaskIdx - 1] || taskSwitchList[taskSwitchList.length - 1]
      browserUI.switchToTask(previousTask.id)
    })

    // shift+option+cmd+x should switch to task x

    for (var i = 1; i < 10; i++) {
      (function (i) {
        keybindings.defineShortcut({ keys: 'shift+option+mod+' + i }, function (e) {
          if (focusMode.enabled()) {
            focusMode.warn()
            return
          }

          const taskSwitchList = browserSession.tasks.filter(t => !browserSession.tasks.isCollapsed(t.id))
          if (taskSwitchList[i - 1]) {
            browserUI.switchToTask(taskSwitchList[i - 1].id)
          }
        })
      })(i)
    }

    keybindings.defineShortcut('closeAllTabs', function (d) { // destroys all current tabs, and creates a new, empty tab. Kind of like creating a new window, except the old window disappears.
      if (focusMode.enabled()) {
        focusMode.warn()
        return
      }

      var tset = browserSession.tabs.get()
      for (var i = 0; i < tset.length; i++) {
        browserUI.destroyTab(tset[i].id)
      }

      browserUI.addTab() // create a new, blank tab
    })

    keybindings.defineShortcut('closeWindow', function () {
      ipc.invoke('close')
    })

    keybindings.defineShortcut('reload', function () {
      if (browserSession.tabs.get(browserSession.tabs.getSelected()).url.startsWith(webviews.internalPages.error)) {
        // reload the original page rather than show the error page again
        webviews.update(browserSession.tabs.getSelected(), new URL(browserSession.tabs.get(browserSession.tabs.getSelected()).url).searchParams.get('url'))
      } else {
        // this can't be an error page, use the normal reload method
        webviews.callAsync(browserSession.tabs.getSelected(), 'reload')
      }
    })

    keybindings.defineShortcut('reloadIgnoringCache', function () {
      webviews.callAsync(browserSession.tabs.getSelected(), 'reloadIgnoringCache')
    })

    keybindings.defineShortcut('showHistory', function () {
      tabEditor.show(browserSession.tabs.getSelected(), '!history ')
    })

    keybindings.defineShortcut('copyPageURL', function () {
      const tab = browserSession.tabs.get(browserSession.tabs.getSelected())
      const url = urlParser.getSourceURL(tab.url)
      if (url) {
        const anchorTag = document.createElement('a')
        anchorTag.href = url
        anchorTag.textContent = url

        electron.clipboard.write({
          text: url,
          bookmark: tab.title,
          html: anchorTag.outerHTML
        })
      }
    })

    // Command palette shortcuts
    keybindings.defineShortcut('showCommandPaletteBlank', function () {
      var commandPalette = require('commandPalette.js')
      commandPalette.show()
    })

    keybindings.defineShortcut('showCommandPaletteWithBang', function () {
      var commandPalette = require('commandPalette.js')
      commandPalette.showWithPrefix('>')
    })

    keybindings.defineShortcut('showCommandPaletteWithOpen', function () {
      var commandPalette = require('commandPalette.js')
      commandPalette.showWithPrefix('>o ')
    })

    keybindings.defineShortcut('showCommandPaletteRepl', function () {
      var commandPalette = require('commandPalette.js')
      commandPalette.showWithPrefix('>>>')
    })

    keybindings.defineShortcut('toggleOverlay', function () {
      ipc.send('toggleOverlay')
    })
  }
}

module.exports = defaultKeybindings
