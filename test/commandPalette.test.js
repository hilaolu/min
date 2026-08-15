const assert = require('node:assert/strict')
const test = require('node:test')
const Module = require('node:module')

function loadCommandPalette (rendererHost = {}) {
  const originalLoad = Module._load
  Module._load = function (request, parent, isMain) {
    if (request === 'keybindings.js') return { defineShortcut: function () {} }
    if (request === 'rendererHost.js') return rendererHost
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
    get value () { return this._value },
    set value (value) {
      this._value = value
      this.selectionStart = value.length
      this.selectionEnd = value.length
    },
    focus: function () { this.focusCount++ },
    setSelectionRange: function (start, end) {
      this.selectionStart = start
      this.selectionEnd = end
    }
  }
}

test('prefix presentation publishes complete state and focuses only on presentation handoff', function () {
  const originalWindow = global.window
  const calls = []
  global.window = {}
  const rendererHost = {
    presentCommandPalette: function (state) {
      calls.push(state)
      return Promise.resolve({ ok: true })
    }
  }
  try {
    const commandPalette = loadCommandPalette(rendererHost)
    const input = createInput()
    commandPalette.input = input
    commandPalette.isVisible = false
    commandPalette.handleInput = function () {}

    commandPalette.showWithPrefix('>')

    assert.equal(input.value, '>')
    assert.equal(input.selectionStart, 1)
    assert.equal(input.focusCount, 0)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].visible, true)
    assert.equal(calls[0].open, true)
    assert.equal(calls[0].input, '>')

    commandPalette.focusInput()
    assert.equal(input.focusCount, 1)
  } finally {
    global.window = originalWindow
  }
})
