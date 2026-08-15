const rendererHost = require('rendererHost.js')
const runtimeConfiguration = rendererHost.getRuntimeConfiguration()

if (runtimeConfiguration.platform === 'darwin') {
  document.body.classList.add('mac')
} else if (runtimeConfiguration.platform === 'win32') {
  document.body.classList.add('windows')
} else {
  document.body.classList.add('linux')
}

if (navigator.maxTouchPoints > 0) {
  document.body.classList.add('touch')
}

/* add classes so that the window state can be used in CSS */
rendererHost.onWindowStateChanged(function (state) {
  document.body.classList.toggle('fullscreen', state.fullScreen)
  document.body.classList.toggle('maximized', state.maximized)
  document.body.classList.toggle('focused', state.focused)
})

// https://remysharp.com/2010/07/21/throttling-function-calls

window.throttle = function (fn, threshhold, scope) {
  threshhold || (threshhold = 250)
  var last,
    deferTimer
  return function () {
    var context = scope || this

    var now = +new Date()
    var args = arguments
    if (last && now < last + threshhold) {
      // hold on to it
      clearTimeout(deferTimer)
      deferTimer = setTimeout(function () {
        last = now
        fn.apply(context, args)
      }, threshhold)
    } else {
      last = now
      fn.apply(context, args)
    }
  }
}

// https://remysharp.com/2010/07/21/throttling-function-calls

window.debounce = function (fn, delay) {
  var timer = null
  return function () {
    var context = this
    var args = arguments
    clearTimeout(timer)
    timer = setTimeout(function () {
      fn.apply(context, args)
    }, delay)
  }
}

window.empty = function (node) {
  var n
  while ((n = node.firstElementChild)) {
    node.removeChild(n)
  }
}

/* prevent a click event from firing after dragging the window */

window.addEventListener('load', function () {
  var isMouseDown = false
  var isDragging = false
  var distance = 0

  document.body.addEventListener('mousedown', function () {
    isMouseDown = true
    isDragging = false
    distance = 0
  })

  document.body.addEventListener('mouseup', function () {
    isMouseDown = false
  })

  var dragHandles = document.getElementsByClassName('windowDragHandle')

  for (var i = 0; i < dragHandles.length; i++) {
    dragHandles[i].addEventListener('mousemove', function (e) {
      if (isMouseDown) {
        isDragging = true
        distance += Math.abs(e.movementX) + Math.abs(e.movementY)
      }
    })
  }

  document.body.addEventListener('click', function (e) {
    if (isDragging && distance >= 10.0) {
      e.stopImmediatePropagation()
      isDragging = false
    }
  }, true)
})

const browserSession = require('tabState.js')
browserSession.initialize()
require('tabState/windowSync.js').initialize({
  browserSession,
  browserUI: require('browserUI.js'),
  cancelSchedule: clearTimeout,
  rendererHost,
  schedule: setTimeout,
  taskOverlay: require('taskOverlay/taskOverlay.js')
})
require('windowControls.js').initialize()
require('navbar/menuButton.js').initialize()
require('webviewGestures.js').initialize({
  browserSession,
  cancelSchedule: clearTimeout,
  navigator,
  schedule: setTimeout,
  webviews: require('webviews.js')
})

require('navbar/addTabButton.js').initialize()
require('navbar/tabContextMenu.js').initialize()
require('navbar/tabActivity.js').initialize()
require('navbar/tabColor.js').initialize()
require('navbar/navigationButtons.js').initialize()
require('downloadManager.js').initialize()
require('webviewMenu.js').initialize()
require('contextMenu.js').initialize()
require('menuRenderer.js').initialize()
require('defaultKeybindings.js').initialize()
require('pdfViewer.js').initialize()
require('util/theme.js').initialize()
require('userscripts.js').initialize()
require('statistics.js').initialize()
require('taskOverlay/taskOverlay.js').initialize()
require('sessionRestore.js').initialize()
require('bookmarkConverter.js').initialize()
require('newTabPage.js').initialize()
require('macHandoff.js').initialize()
require('commandPalette.js').initialize({
  cancelSchedule: clearTimeout,
  document,
  keybindings: require('keybindings.js'),
  rendererHost,
  schedule: setTimeout,
  webviews: require('webviews.js')
})

// default searchbar plugins

require('searchbar/placesPlugin.js').initialize()
require('searchbar/instantAnswerPlugin.js').initialize()
require('searchbar/bangsPlugin.js').initialize()
require('searchbar/customBangs.js').initialize()
require('searchbar/searchSuggestionsPlugin.js').initialize()
require('searchbar/placeSuggestionsPlugin.js').initialize()
require('searchbar/updateNotifications.js').initialize()
require('searchbar/restoreTaskPlugin.js').initialize()
require('searchbar/bookmarkManager.js').initialize()
require('searchbar/historyViewer.js').initialize()
require('searchbar/developmentModeNotification.js').initialize()
require('searchbar/shortcutButtons.js').initialize()
require('searchbar/calculatorPlugin.js').initialize()

// once everything's loaded, start the session
require('sessionRestore.js').restore()
