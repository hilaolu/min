const assert = require('node:assert/strict')
const test = require('node:test')

const createShortcutAvailability = require('../js/keybindings/shortcutAvailability.js')

function createHarness (options = {}) {
  const warnings = []
  const calls = []
  const browserSession = {
    tabs: {
      get: () => ({ url: options.url === undefined ? 'https://example.com' : options.url }),
      getSelected: () => 'tab-1'
    }
  }
  const canRunShortcut = createShortcutAvailability({
    browserSession,
    document: { activeElement: { tagName: options.activeTag || 'BODY' } },
    logger: { warn: error => warnings.push(error) },
    webviews: {
      isFocused: function (tabId, callback) {
        calls.push(['is-focused', tabId])
        callback(options.focusError || null, options.focused !== false)
      },
      isInputFocused: function (tabId, callback) {
        calls.push(['is-input-focused', tabId])
        callback(options.inputError || null, options.inputFocused === true)
      }
    }
  })
  function decide (combo) {
    return new Promise(resolve => canRunShortcut(combo, resolve))
  }
  return { calls, canRunShortcut, decide, warnings }
}

test('shortcut availability preserves Browser Chrome and Tab Content focus rules', async function () {
  const ordinary = createHarness()
  let ordinaryDecision = null
  ordinary.canRunShortcut('mod+shift+p', decision => { ordinaryDecision = decision })
  assert.equal(ordinaryDecision, true)
  assert.deepEqual(ordinary.calls, [])

  assert.equal(await createHarness({ activeTag: 'INPUT', focused: false }).decide('x'), false)
  assert.equal(await createHarness({ activeTag: 'BODY', focused: false }).decide('x'), true)
  assert.equal(await createHarness({ inputFocused: true }).decide('x'), false)
  assert.equal(await createHarness({ inputFocused: false }).decide('x'), true)
})

test('shortcut availability contains focus-query failures', async function () {
  const focusFailure = createHarness({ activeTag: 'BODY', focusError: new Error('focus failed') })
  assert.equal(await focusFailure.decide('mod+left'), true)

  const inputFailureError = new Error('input focus failed')
  const inputFailure = createHarness({ inputError: inputFailureError })
  assert.equal(await inputFailure.decide('mod+right'), false)
  assert.deepEqual(inputFailure.warnings, [inputFailureError])
})
