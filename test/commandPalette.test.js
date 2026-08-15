const assert = require('node:assert/strict')
const test = require('node:test')

const { createCommandPalette } = require('../js/commandPalette.js')
const { createInMemoryRendererHost } = require('../js/rendererHost.js')

const runtimeConfiguration = {
  appName: 'Min',
  appVersion: '1.39.11',
  developmentMode: true,
  initialTask: null,
  initialWindow: true,
  launchWindow: true,
  platform: 'linux',
  windowId: 'window-command-palette-test'
}

function createInput () {
  const listeners = new Map()
  return {
    _value: '',
    focusCount: 0,
    selectionStart: 0,
    selectionEnd: 0,
    addEventListener: (name, listener) => listeners.set(name, listener),
    blur: function () {},
    emit: (name, event) => listeners.get(name)(event),
    focus: function () { this.focusCount++ },
    listenerCount: () => listeners.size,
    removeEventListener: function (name, listener) {
      if (listeners.get(name) === listener) listeners.delete(name)
    },
    get value () { return this._value },
    set value (value) {
      this._value = value
      this.selectionStart = value.length
      this.selectionEnd = value.length
    }
  }
}

function createStrategyManager () {
  return {
    executeAction: async function () {},
    handleKeydown: () => false,
    on: function () {},
    processInput: async () => true,
    registerStrategy: function () {},
    resetToFallback: async function () {}
  }
}

function createPaletteHarness (presentCommandPalette) {
  const cancellations = []
  const errors = []
  const input = createInput()
  const scheduled = []
  const snapshots = []
  let focusRequested
  let focusUnsubscribeCount = 0
  let shortcutUnsubscribeCount = 0
  const rendererHost = createInMemoryRendererHost(runtimeConfiguration, {
    onCommandPaletteFocusRequested: function (listener) {
      focusRequested = listener
      return function () { focusUnsubscribeCount++ }
    },
    presentCommandPalette: function (state) {
      snapshots.push(state)
      return presentCommandPalette ? presentCommandPalette(state) : Promise.resolve({ ok: true })
    }
  })
  const palette = createCommandPalette({
    cancelSchedule: timer => cancellations.push(timer),
    createStrategies: () => [],
    createStrategyManager,
    document: { getElementById: () => input },
    keybindings: {
      defineShortcut: function () {
        return function () { shortcutUnsubscribeCount++ }
      }
    },
    logger: {
      error: (...args) => errors.push(args),
      log: function () {}
    },
    rendererHost,
    schedule: function (callback, delay) {
      const timer = { callback, delay }
      scheduled.push(timer)
      return timer
    },
    webviews: { focus: function () {} }
  })
  palette.initialize()
  return {
    cancellations,
    errors,
    focus: () => focusRequested(),
    focusUnsubscribeCount: () => focusUnsubscribeCount,
    input,
    palette,
    scheduled,
    shortcutUnsubscribeCount: () => shortcutUnsubscribeCount,
    snapshots
  }
}

test('prefix presentation publishes complete state and focuses only on presentation handoff', function () {
  const harness = createPaletteHarness()

  harness.palette.showWithPrefix('>')

  assert.equal(harness.input.value, '>')
  assert.equal(harness.input.selectionStart, 1)
  assert.equal(harness.input.selectionEnd, 1)
  assert.equal(harness.input.focusCount, 0)
  assert.deepEqual(harness.snapshots, [{
    candidates: [],
    input: '>',
    open: true,
    selectedIndex: 0,
    visible: true
  }])

  harness.focus()
  assert.equal(harness.input.focusCount, 1)

  harness.input.emit('input')
  assert.equal(harness.scheduled.length, 2)
  assert.deepEqual(harness.cancellations, [harness.scheduled[0]])

  harness.palette.destroy()
  assert.equal(harness.focusUnsubscribeCount(), 1)
  assert.equal(harness.shortcutUnsubscribeCount(), 1)
  assert.equal(harness.input.listenerCount(), 0)
  assert.deepEqual(harness.cancellations, [harness.scheduled[0], harness.scheduled[1]])
})

test('presentation failures are reported through the constructed lifetime', async function () {
  const rejectedResult = createPaletteHarness(() => Promise.resolve({
    error: { code: 'PRESENTATION_REJECTED' },
    ok: false
  }))
  rejectedResult.palette.showWithPrefix('>')
  await Promise.resolve()
  assert.equal(rejectedResult.errors.length, 1)
  assert.equal(rejectedResult.errors[0][0], 'Command palette presentation failed:')
  assert.deepEqual(rejectedResult.errors[0][1], { code: 'PRESENTATION_REJECTED' })

  const transportFailure = new Error('presentation transport failed')
  const rejectedPromise = createPaletteHarness(() => Promise.reject(transportFailure))
  rejectedPromise.palette.showWithPrefix('>')
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(rejectedPromise.errors.length, 1)
  assert.equal(rejectedPromise.errors[0][1], transportFailure)
})
