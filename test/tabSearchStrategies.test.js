const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

const { CommandStateStrategy } = require('../js/commandPalette/CommandStateStrategy.js')

function loadStrategies (tabs, { loadError, switchError } = {}) {
  const browserSession = { tabs: { get: () => tabs.slice() } }
  const errors = []
  const switches = []
  const loadedModules = []

  function load (file) {
    const filename = path.resolve(__dirname, '../js/commandPalette', file)
    const module = { exports: {} }
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
      console: { error: (...args) => errors.push(args) },
      module,
      require: function (name) {
        if (name === '../../tabState.js') return browserSession
        if (name === '../CommandStateStrategy.js') return { CommandStateStrategy }
        if (name === '../tabCandidate.js') return load('tabCandidate.js')
        if (name === 'browserUI.js') {
          loadedModules.push(name)
          if (loadError) throw loadError
          return {
            switchToTab: function (id) {
              if (switchError) throw switchError
              switches.push(id)
            }
          }
        }
        throw new Error('Unexpected dependency: ' + name)
      }
    }, { filename })
    return module.exports
  }

  const EmptyStrategy = load('strategies/EmptyStrategy.js')
  const TabSearchStrategy = load('strategies/TabSearchStrategy.js')
  return { browserSession, empty: new EmptyStrategy(), search: new TabSearchStrategy(), errors, switches, loadedModules }
}

test('empty and unfiltered tab searches share display defaults and switch only on selection', async () => {
  const harness = loadStrategies([
    { id: 'article', title: 'Article', url: 'https://example.com' },
    { id: 'blank', title: '', url: '' }
  ])
  const expected = [
    { id: 'tab-article', title: 'Article', description: 'https://example.com', icon: 'carbon:document' },
    { id: 'tab-blank', title: 'New Tab', description: 'min://newtab', icon: 'carbon:document' }
  ]
  const rows = []
  for (const strategy of [harness.empty, harness.search]) {
    const candidates = await strategy.updateUI('', { query: '' })
    assert.deepEqual(Array.from(candidates, ({ action, ...display }) => display), expected)
    rows.push(candidates)
  }
  assert.deepEqual(harness.loadedModules, [])
  assert.deepEqual(harness.switches, [])

  rows[0][0].action()
  rows[1][1].action()
  assert.deepEqual(harness.loadedModules, ['browserUI.js', 'browserUI.js'])
  assert.deepEqual(harness.switches, ['article', 'blank'])
  assert.deepEqual(harness.errors, [])
})

test('tab strategies preserve input matching and case-insensitive title or URL filtering', async () => {
  const harness = loadStrategies([
    { id: 'title', title: 'EXAMPLE article', url: 'https://other.test' },
    { id: 'url', title: 'Other', url: 'https://example.com' },
    { id: 'blank' }
  ])
  assert.equal(harness.empty.matches('  ').matches, true)
  assert.equal(harness.empty.matches('example').matches, false)
  assert.equal(harness.search.matches('  ').matches, false)
  assert.equal(harness.search.matches('>open').matches, false)

  const input = '  eXaMpLe  '
  const match = harness.search.matches(input)
  assert.equal(match.matches, true)
  const candidates = await harness.search.updateUI(input, match.data)
  assert.deepEqual(Array.from(candidates, candidate => candidate.id), ['tab-title', 'tab-url'])
  assert.equal((await harness.search.updateUI('missing', { query: 'missing' })).length, 0)
  assert.deepEqual(harness.loadedModules, [])
})

test('both tab strategies handle lazy-load and tab-switch failures on selection', async () => {
  for (const failure of ['loadError', 'switchError']) {
    const error = new Error(failure)
    const harness = loadStrategies([{ id: 'closed' }], { [failure]: error })
    for (const strategy of [harness.empty, harness.search]) {
      const candidates = await strategy.updateUI('', { query: '' })
      assert.equal(candidates.length, 1)
      assert.doesNotThrow(() => candidates[0].action())
    }
    assert.deepEqual(harness.errors, [
      ['Error switching to tab:', error],
      ['Error switching to tab:', error]
    ])
    assert.deepEqual(harness.loadedModules, ['browserUI.js', 'browserUI.js'])
    assert.deepEqual(harness.switches, [])
  }
})

test('tab strategies return no candidates when there is no selected task', async () => {
  const harness = loadStrategies([])
  harness.browserSession.tabs = null
  for (const strategy of [harness.empty, harness.search]) {
    assert.equal((await strategy.updateUI('', { query: '' })).length, 0)
  }
  assert.equal(harness.errors.length, 2)
  assert.deepEqual(harness.loadedModules, [])
})
