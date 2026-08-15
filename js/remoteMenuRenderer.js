/*
Passes a context menu template to the main process (where the menu is created)
and listens for click events on it.
*/

var menuCallbacks = {}

var nextMenuId = 0
const rendererHost = require('rendererHost.js')

function open (menuTemplate, x, y) {
  nextMenuId++
  const menuId = nextMenuId
  menuCallbacks[menuId] = {}
  var nextItemId = 0
  function prepareToSend (menuPart) {
    if (menuPart instanceof Array) {
      return menuPart.map(item => prepareToSend(item))
    } else {
      if (menuPart.submenu) {
        menuPart.submenu = prepareToSend(menuPart.submenu)
      }
      if (typeof menuPart.click === 'function') {
        menuCallbacks[menuId][nextItemId] = menuPart.click
        menuPart.click = nextItemId
        nextItemId++
      }
      return menuPart
    }
  }

  rendererHost.showContextMenu({
    id: menuId,
    template: prepareToSend(menuTemplate),
    x,
    y
  }).then(function (itemId) {
    if (itemId !== null && menuCallbacks[menuId]?.[itemId]) {
      menuCallbacks[menuId][itemId]()
    }
    delete menuCallbacks[menuId]
  })
}

module.exports = { open }
