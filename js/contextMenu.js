const remoteMenu = require('remoteMenuRenderer.js')
const rendererHost = require('rendererHost.js')
const searchbar = require('searchbar/searchbar.js')

module.exports = {
  initialize: function () {
    document.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      e.stopPropagation()

      var inputMenu = [
        [
          {
            label: 'Undo',
            role: 'undo'
          },
          {
            label: 'Redo',
            role: 'redo'
          }
        ],
        [
          {
            label: 'Cut',
            role: 'cut'
          },
          {
            label: 'Copy',
            role: 'copy'
          },
          {
            label: 'Paste',
            role: 'paste'
          }
        ],
        [
          {
            label: 'Select All',
            role: 'selectall'
          }
        ]
      ]

      let node = e.target

      while (node) {
        if (node.nodeName.match(/^(input|textarea)$/i) || node.isContentEditable) {
          if (node.id === 'tab-editor-input') {
            inputMenu[1].push({
              label: 'Paste and Go',
              click: function () {
                searchbar.openURL(rendererHost.readClipboardText())
              }
            })
          }
          remoteMenu.open(inputMenu)
          break
        }
        node = node.parentNode
      }
    })
  }
}
