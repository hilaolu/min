const browserSession = require('tabState.js')
const remoteMenu = require('remoteMenuRenderer.js')
const rendererHost = require('rendererHost.js')
const browserUI = require('browserUI.js')
const webviews = require('webviews.js')
const readerView = require('readerView.js')
const urlParser = require('util/urlParser.js')

const tabContextMenu = {
  show: function (tabId) {
    const tabMenu = [
      [
        {
          label: 'Duplicate Tab',
          click: function () {
            browserUI.duplicateTab(tabId, { enterEditMode: false })
          }
        },
        {
          label: 'Move Tab to New Window',
          click: function () {
            // insert after current task
            let index
            if (browserSession.tasks.getSelected()) {
              index = browserSession.tasks.getIndex(browserSession.tasks.getSelected().id) + 1
            }
            const currentTaskId = browserSession.tasks.getSelected().id
            const newTaskId = browserSession.createTask({}, { index })
            browserSession.moveTabToTask(tabId, newTaskId, { index: 0 })

            rendererHost.createWindow({ initialTask: newTaskId })

            browserUI.switchToTask(currentTaskId, { stateAlreadySelected: true })
          }
        }
      ]
    ]

    if (browserSession.tabs.get(tabId).url && (readerView.isReader(tabId) || !urlParser.isInternalURL(browserSession.tabs.get(tabId).url))) {
      if (!readerView.isReader(tabId)) {
        tabMenu[0].push({
          label: 'Enter Reader View',
          click: function () {
            readerView.enter(tabId, browserSession.tabs.get(tabId).url)
          }
        })
      } else {
        tabMenu[0].push({
          label: 'Exit Reader View',
          click: function () {
            readerView.exit(tabId)
          }
        })
      }
    }

    tabMenu[0].push({
      label: 'Reload',
      click: function () {
        if (browserSession.tabs.get(tabId).url.startsWith(webviews.internalPages.error)) {
          // reload the original page rather than show the error page again
          webviews.update(tabId, new URL(browserSession.tabs.get(tabId).url).searchParams.get('url'))
        } else {
          // this can't be an error page, use the normal reload method
          webviews.reload(tabId)
        }
      }
    })

    remoteMenu.open(tabMenu)
  },
  initialize: function () {
    const container = document.getElementById('tabs-inner')
    container.addEventListener('contextmenu', function (e) {
      let node = e.target

      while (node) {
        if (node.classList.contains('tab-item')) {
          tabContextMenu.show(node.getAttribute('data-tab'))
          e.stopPropagation()
          break
        }
        node = node.parentNode
      }
    })
  }
}

module.exports = tabContextMenu
