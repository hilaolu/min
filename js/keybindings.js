const browserSession = require('tabState.js')
const rendererHost = require('rendererHost.js')
const runtimeConfiguration = rendererHost.getRuntimeConfiguration()
/*
There are three possible ways that keybindings can be handled.
 Shortcuts that appear in the menubar are registered in main.js, and send IPC messages to the window (which are handled by menuRenderer.js)
 - If the browser UI is focused, a before-input-event is generated in the main process and forwarded to here.
  - If a BrowserView is focused, a before-input-event is generated from the webContents and forwarded to here.
  */

const keyMapModule = require('util/keyMap.js')
const createShortcutAvailability = require('./keybindings/shortcutAvailability.js')

var webviews = require('webviews.js')
var settings = require('util/settings/settings.js')

var keyMap = keyMapModule.userKeyMap(settings.get('keyMap'))

var shortcutsList = []

/* Single-letter and text-editing shortcuts cannot run while an input is focused. */
const canRunShortcut = createShortcutAvailability({
  browserSession,
  document,
  webviews
})

function defineShortcut (keysOrKeyMapName, fn, options = {}) {
  let binding
  if (keysOrKeyMapName.keys) {
    binding = keysOrKeyMapName.keys
  } else {
    binding = keyMap[keysOrKeyMapName]
  }

  if (typeof binding === 'string') {
    binding = [binding]
  }

  var shortcutCallback = function (e, combo) {
    if (options.contexts && !options.contexts.includes(document.body.getAttribute('data-context') || 'default')) {
      return
    }

    canRunShortcut(combo, function (canRun) {
      if (canRun) {
        fn(e, combo)
      }
    })
  }

  const registeredShortcuts = binding.map(function (keys) {
    return {
      combo: keys,
      keys: keys.split('+'),
      fn: shortcutCallback,
      keyUp: options.keyUp || false
    }
  })
  shortcutsList.push(...registeredShortcuts)
  return function () {
    shortcutsList = shortcutsList.filter(shortcut => !registeredShortcuts.includes(shortcut))
  }
}

let keyboardMap

navigator.keyboard.getLayoutMap().then(map => {
  keyboardMap = map
})

function beforeInputEventHandler (input) {
  var expectedKeys = 1
  // account for additional keys that aren't in the input.key property
  if (input.alt && input.key !== 'Alt') {
    expectedKeys++
  }
  if (input.shift && input.key !== 'Shift') {
    expectedKeys++
  }
  if (input.control && input.key !== 'Control') {
    expectedKeys++
  }
  if (input.meta && input.key !== 'Meta') {
    expectedKeys++
  }

  shortcutsList.forEach(function (shortcut) {
    if ((shortcut.keyUp && input.type !== 'keyUp') || (!shortcut.keyUp && input.type !== 'keyDown')) {
      return
    }
    var matches = true
    var matchedKeys = 0
    shortcut.keys.forEach(function (key) {
      if (!(
        key === input.key.toLowerCase() ||
      // we need this check because the alt key can change the typed key, causing input.key to be a special character instead of the base key
      // but input.code isn't layout aware, so we need to map it to the correct key for the layout
      (keyboardMap && key === keyboardMap.get(input.code)) ||
      (key === 'esc' && input.key === 'Escape') ||
      (key === 'left' && input.key === 'ArrowLeft') ||
      (key === 'right' && input.key === 'ArrowRight') ||
      (key === 'up' && input.key === 'ArrowUp') ||
      (key === 'down' && input.key === 'ArrowDown') ||
      (key === 'period' && input.key === '.') ||
      (key === 'alt' && (input.alt || input.key === 'Alt')) ||
      (key === 'option' && (input.alt || input.key === 'Alt')) ||
      (key === 'shift' && (input.shift || input.key === 'Shift')) ||
      (key === 'ctrl' && (input.control || input.key === 'Control')) ||
      (key === 'mod' && runtimeConfiguration.platform === 'darwin' && (input.meta || input.key === 'Meta')) ||
      (key === 'mod' && runtimeConfiguration.platform !== 'darwin' && (input.control || input.key === 'Control')) ||
      (key === 'super' && (input.meta || input.key === 'Meta'))
      )
      ) {
        matches = false
      } else {
        matchedKeys++
      }
    })

    if (matches && matchedKeys === expectedKeys) {
      shortcut.fn(null, shortcut.combo)
    }
  })
}

function initialize () {
  webviews.bindEvent('input-received', function (tabId, event) {
    const input = event.input
    beforeInputEventHandler(input)
  })

  rendererHost.onBrowserChromeInput(beforeInputEventHandler)
}

initialize()

module.exports = { defineShortcut }
