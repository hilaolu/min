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
  const listeners = new Map()
  const manager = {
    executeActionCalls: [],
    executeAction: async function (candidate) {
      manager.executeActionCalls.push(candidate)
    },
    handleKeydown: () => false,
    on: function (name, listener) {
      const eventListeners = listeners.get(name) || []
      eventListeners.push(listener)
      listeners.set(name, eventListeners)
      return function () {
        listeners.set(name, (listeners.get(name) || []).filter(candidate => candidate !== listener))
      }
    },
    emit: function (name, event) {
      for (const listener of listeners.get(name) || []) listener(event)
    },
    processInput: async () => true,
    cancelPending: function () {},
    registerStrategy: function () {},
    resetToFallback: async function () {}
  }
  return manager
}

function createPaletteHarness (presentCommandPalette, strategyManager = createStrategyManager()) {
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
    createStrategyManager: () => strategyManager,
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
    strategyManager,
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

function candidate (id) {
  return { id, title: id, action: function () {} }
}

function keydown (input, key, ctrlKey = false) {
  let prevented = false
  const handling = input.emit('keydown', {
    ctrlKey,
    key,
    preventDefault: () => { prevented = true }
  })
  assert.equal(prevented, true)
  return handling
}

test('fast >, w, Enter waits for the command results instead of selecting the > prefix', async function () {
  const StrategyManager = require('../js/commandPalette/StrategyManager.js')
  const VimCommandStrategy = require('../js/commandPalette/strategies/VimCommandStrategy.js')
  const VimCommandWithArgsStrategy = require('../js/commandPalette/strategies/VimCommandWithArgsStrategy.js')
  for (const cancel of [null, 'input', 'hide', 'destroy']) {
    const manager = new StrategyManager()
    const commands = new VimCommandStrategy()
    commands.updateUI = async () => [{ id: 'open', prefix: '>o ' }]
    const args = new VimCommandWithArgsStrategy()
    let finish
    args.updateUI = () => new Promise(resolve => { finish = resolve })
    manager.registerStrategy(commands)
    manager.registerStrategy(args)
    const harness = createPaletteHarness(null, manager)
    harness.palette.showWithPrefix('>')
    await new Promise(resolve => setImmediate(resolve))

    harness.input.value = '>w'
    const processing = harness.input.emit('input')
    const activation = keydown(harness.input, 'Enter')
    await keydown(harness.input, 'Enter') // key repeat must not queue a second action
    assert.equal(harness.input.value, '>w')
    let executions = 0
    if (cancel === 'input') {
      harness.input.value = '>'
      await harness.input.emit('input')
    } else if (cancel) {
      harness.palette[cancel]()
    }
    finish([{ id: 'close-tab', action: () => { executions++ } }])
    await processing
    await activation
    assert.equal(executions, cancel ? 0 : 1)
    assert.deepEqual(harness.errors, [])
  }
})

test('a newer input can queue activation while an older input is still pending', async function () {
  const harness = createPaletteHarness()
  harness.palette.showWithPrefix('>')
  await Promise.resolve()
  const pending = []
  harness.strategyManager.processInput = () => new Promise(resolve => pending.push(resolve))
  harness.strategyManager.emit('state-changed', { candidates: [candidate('stale')] })

  harness.input.value = '>o old'
  const oldInput = harness.input.emit('input')
  const oldActivation = keydown(harness.input, 'Enter')
  harness.input.value = '>o new'
  const newInput = harness.input.emit('input')
  const newActivation = keydown(harness.input, '1', true)
  pending[0]()
  await oldInput
  await oldActivation
  assert.deepEqual(harness.strategyManager.executeActionCalls, [])

  const candidates = [candidate('first'), candidate('new')]
  harness.strategyManager.emit('candidates-updated', { candidates })
  pending[1]()
  await newInput
  await newActivation
  assert.deepEqual(harness.strategyManager.executeActionCalls, [candidates[1]])
  assert.deepEqual(harness.errors, [])
})

test('failed input processing does not activate stale candidates', async function () {
  const harness = createPaletteHarness()
  harness.palette.showWithPrefix('>')
  await Promise.resolve()
  harness.strategyManager.emit('state-changed', { candidates: [candidate('stale')] })
  let fail
  harness.strategyManager.processInput = () => new Promise((resolve, reject) => { fail = reject })
  harness.input.value = '>w'
  const processing = harness.input.emit('input')
  const activation = keydown(harness.input, 'Enter')
  fail(new Error('processing failed'))
  await processing
  await activation
  assert.deepEqual(harness.strategyManager.executeActionCalls, [])
  assert.equal(harness.errors.length, 1)
})

test('pending candidates stay presented and keyboard activation is blocked', function () {
  const harness = createPaletteHarness()
  const candidates = [candidate('first'), candidate('second')]
  harness.strategyManager.emit('state-changed', { candidates })
  harness.snapshots.length = 0

  harness.strategyManager.emit('candidates-pending', {})

  assert.deepEqual(harness.snapshots, [])
  keydown(harness.input, 'Enter')
  keydown(harness.input, '0', true)
  assert.deepEqual(harness.strategyManager.executeActionCalls, [])
})

test('async candidate swaps preserve the selected id without a late input reset', async function () {
  const harness = createPaletteHarness()
  harness.strategyManager.emit('state-changed', {
    candidates: [candidate('first'), candidate('selected'), candidate('last')]
  })
  keydown(harness.input, 'ArrowDown')

  let finishSearch
  harness.strategyManager.processInput = async function () {
    harness.strategyManager.emit('candidates-pending', {})
    await new Promise(resolve => { finishSearch = resolve })
    harness.strategyManager.emit('candidates-updated', {
      candidates: [candidate('last'), candidate('first'), candidate('selected')],
      preserveSelection: true
    })
    return false
  }
  harness.snapshots.length = 0
  harness.input.value = '>m refined'
  const processing = harness.input.emit('input')

  assert.deepEqual(harness.snapshots, [])
  finishSearch()
  await processing

  assert.equal(harness.snapshots.length, 1)
  assert.deepEqual(harness.snapshots[0].candidates.map(result => result.id), ['last', 'first', 'selected'])
  assert.equal(harness.snapshots[0].selectedIndex, 2)
})

test('candidate updates fall back to the first row when selection is removed or preservation is not requested', function () {
  const harness = createPaletteHarness()
  harness.strategyManager.emit('state-changed', {
    candidates: [candidate('first'), candidate('selected')]
  })
  keydown(harness.input, 'ArrowDown')

  harness.strategyManager.emit('candidates-updated', {
    candidates: [candidate('replacement'), candidate('first')],
    preserveSelection: true
  })
  assert.equal(harness.snapshots.at(-1).selectedIndex, 0)

  harness.strategyManager.emit('state-changed', {
    candidates: [candidate('first'), candidate('selected')]
  })
  keydown(harness.input, 'ArrowDown')
  harness.strategyManager.emit('candidates-updated', {
    candidates: [candidate('first'), candidate('selected')]
  })
  assert.equal(harness.snapshots.at(-1).selectedIndex, 0)
})

test('error and empty final updates clear pending activation state', function () {
  for (const finalCandidates of [[candidate('vault-error')], []]) {
    const harness = createPaletteHarness()
    harness.strategyManager.emit('state-changed', { candidates: [candidate('stale')] })
    harness.strategyManager.emit('candidates-pending', {})
    harness.strategyManager.emit('candidates-updated', {
      candidates: finalCandidates,
      preserveSelection: true
    })
    assert.equal(harness.snapshots.at(-1).candidates.length, finalCandidates.length)

    // Keep the final update observably empty, then mutate the same candidate
    // collection so activation tests the pending flag without another event.
    if (finalCandidates.length === 0) finalCandidates.push(candidate('after-empty'))
    keydown(harness.input, 'Enter')
    assert.equal(harness.strategyManager.executeActionCalls.length, 1)
  }
})
