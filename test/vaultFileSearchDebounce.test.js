const assert = require('node:assert/strict')
const test = require('node:test')
const VaultFileStrategy = require('../js/commandPalette/strategies/VaultFileStrategy.js')
const StrategyManager = require('../js/commandPalette/StrategyManager.js')

function delay (milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

function deferred () {
  let resolvePromise
  const promise = new Promise(resolve => { resolvePromise = resolve })
  return { promise, resolve: resolvePromise }
}

function result (name) {
  return {
    ok: true,
    entries: [{ url: `vault://${name}.md`, relativePath: `${name}.md` }],
    truncated: false
  }
}

test('manager cancellation settles debounce without publishing stale rows and allows reopening', async () => {
  const calls = []
  const strategy = new VaultFileStrategy(async (command, query) => {
    calls.push(query)
    return result(query)
  }, () => {})
  const manager = new StrategyManager()
  manager.registerStrategy(strategy)
  const published = []
  manager.on('state-changed', event => published.push(event))
  manager.on('candidates-updated', event => published.push(event))
  const pending = manager.processInput('>m old', { input: { value: '>m old' } })
  manager.cancelPending()
  const count = published.length
  await pending
  assert.equal(published.length, count)
  assert.deepEqual(calls, [])
  await manager.processInput('>m new', { input: { value: '>m new' } })
  assert.deepEqual(calls, ['new'])
  assert.equal(published.at(-1).candidates[0].id, 'vault://new.md')
})

test('a stale rejected transition cannot restore an obsolete strategy', async () => {
  const manager = new StrategyManager()
  const old = new VaultFileStrategy(() => {}, () => {})
  const latest = new VaultFileStrategy(() => {}, () => {})
  manager.currentStrategy = new VaultFileStrategy(() => {}, () => {})
  let rejectOld
  old.updateUI = () => new Promise((resolve, reject) => { rejectOld = reject })
  latest.updateUI = async () => []
  const pending = manager.transitionTo(old, {}, { input: { value: '' } })
  await manager.transitionTo(latest, {}, { input: { value: '' } })
  rejectOld(new Error('obsolete failure'))
  await pending
  assert.equal(manager.currentStrategy, latest)
})

test('rapid Markdown updates debounce to the latest search and settle every promise', { timeout: 2000 }, async () => {
  const calls = []
  const strategy = new VaultFileStrategy(async (command, query) => {
    calls.push([command, query])
    return result(query)
  }, () => {})

  const first = strategy.updateUI('>m first', { command: 'm', query: 'first' })
  const second = strategy.updateUI('>m second', { command: 'm', query: 'second' })
  const latest = strategy.updateUI('>m latest', { command: 'm', query: 'latest' })

  await delay(80)
  assert.deepEqual(calls, [])

  const rows = await Promise.all([first, second, latest])
  assert.deepEqual(calls, [['m', 'latest']])
  assert.deepEqual(rows[0], [])
  assert.deepEqual(rows[1], [])
  assert.deepEqual(rows[2].map(row => row.id), ['vault://latest.md'])
})

test('exiting cancels and settles a pending Markdown search', { timeout: 2000 }, async () => {
  const calls = []
  const strategy = new VaultFileStrategy(async (command, query) => {
    calls.push([command, query])
    return result(query)
  }, () => {})

  const pending = strategy.updateUI('>m pending', { command: 'm', query: 'pending' })
  strategy.onExit()

  assert.deepEqual(await pending, [])
  await delay(150)
  assert.deepEqual(calls, [])
})

test('an obsolete in-flight result is discarded when a newer search starts', { timeout: 2000 }, async () => {
  const calls = []
  const oldStarted = deferred()
  const oldResult = deferred()
  const strategy = new VaultFileStrategy((command, query) => {
    calls.push([command, query])
    if (query === 'old') {
      oldStarted.resolve()
      return oldResult.promise
    }
    return Promise.resolve(result(query))
  }, () => {})

  const old = strategy.updateUI('>m old', { command: 'm', query: 'old' })
  await oldStarted.promise
  const latest = strategy.updateUI('>m latest', { command: 'm', query: 'latest' })
  oldResult.resolve(result('old'))

  assert.deepEqual(await old, [])
  const latestRows = await latest
  assert.deepEqual(calls, [['m', 'old'], ['m', 'latest']])
  assert.deepEqual(latestRows.map(row => row.id), ['vault://latest.md'])
  assert.equal(latestRows.some(row => row.id === 'vault://old.md'), false)
})
