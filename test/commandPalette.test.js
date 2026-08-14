const assert = require('node:assert/strict')
const test = require('node:test')
const Module = require('node:module')

function loadCommandPalette () {
  const originalLoad = Module._load

  Module._load = function (request, parent, isMain) {
    if (request === 'keybindings.js') {
      return { defineShortcut: function () {} }
    }
    return originalLoad.call(this, request, parent, isMain)
  }

  try {
    const modulePath = require.resolve('../js/commandPalette.js')
    delete require.cache[modulePath]
    return require(modulePath)
  } finally {
    Module._load = originalLoad
  }
}

function createInput () {
  return {
    _value: '',
    focusCount: 0,
    selectionStart: 0,
    selectionEnd: 0,

    get value () {
      return this._value
    },

    set value (value) {
      this._value = value
      this.selectionStart = value.length
      this.selectionEnd = value.length
    },

    focus: function () {
      this.focusCount++
    },

    setSelectionRange: function (start, end) {
      this.selectionStart = start
      this.selectionEnd = end
    }
  }
}

function insertText (input, text) {
  const start = input.selectionStart
  const end = input.selectionEnd

  input.value = input.value.slice(0, start) + text + input.value.slice(end)
  input.selectionStart = start + text.length
  input.selectionEnd = input.selectionStart
}

function openPaletteWithControlledTimers (prefix) {
  const timers = []
  const originalSetTimeout = global.setTimeout
  const commandPalette = loadCommandPalette()
  const input = createInput()

  global.setTimeout = function (callback, delay) {
    timers.push({ callback, delay })
    return timers.length
  }

  commandPalette.input = input
  commandPalette.isVisible = false
  commandPalette.handleInput = function () {}
  commandPalette.showOverlay = function () {}
  commandPalette.updateOverlayInput = function () {}

  try {
    commandPalette.showWithPrefix(prefix)
  } finally {
    global.setTimeout = originalSetTimeout
  }

  return {
    input,
    runTimer: function (delay) {
      const timer = timers.find(item => item.delay === delay)
      assert.ok(timer, `expected a ${delay} ms timer`)
      timer.callback()
    }
  }
}

test('prefix focus retry does not move the caret after the user types', function () {
  const { input, runTimer } = openPaletteWithControlledTimers('>')

  runTimer(50)
  insertText(input, 'o')
  runTimer(220)
  insertText(input, ' ')

  assert.equal(input.value, '>o ')
  assert.equal(input.selectionStart, 3)
  assert.equal(input.focusCount, 2)
})
