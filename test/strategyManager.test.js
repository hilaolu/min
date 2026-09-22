const assert = require('node:assert/strict')
const test = require('node:test')

const { CommandStateStrategy } = require('../js/commandPalette/CommandStateStrategy.js')
const StrategyManager = require('../js/commandPalette/StrategyManager.js')

function createStrategy (name, overrides = {}) {
  return Object.assign(new CommandStateStrategy(name), {
    matches: input => ({ matches: input === name }),
    updateUI: async () => [{ id: name }]
  }, overrides)
}

test('strategy transitions retain enter/exit hooks and publish candidates in order', async () => {
  const manager = new StrategyManager()
  const context = { input: { value: '' } }
  const data = { query: 'example' }
  const calls = []
  const first = createStrategy('EMPTY', {
    onEnter: receivedContext => {
      assert.equal(receivedContext, context)
      calls.push('enter-first')
    },
    onExit: receivedContext => {
      assert.equal(receivedContext, context)
      calls.push('exit-first')
    }
  })
  const second = createStrategy('SEARCH', {
    onEnter: (receivedContext, receivedData) => {
      assert.equal(receivedContext, context)
      assert.equal(receivedData, data)
      calls.push('enter-second')
    },
    updateUI: async () => {
      calls.push('update-second')
      return [{ id: 'result' }]
    }
  })
  manager.on('state-changed', event => calls.push(event.candidates[0].id))

  await manager.transitionTo(first, {}, context)
  await manager.transitionTo(second, data, context)

  assert.equal(manager.currentStrategy, second)
  assert.deepEqual(calls, ['enter-first', 'EMPTY', 'exit-first', 'enter-second', 'update-second', 'result'])
})

test('a failed strategy transition restores the previous strategy or registered fallback', async t => {
  const log = t.mock.method(console, 'error', () => {})
  const error = new Error('Unable to load candidates')
  for (const usePrevious of [false, true]) {
    const manager = new StrategyManager()
    const context = { input: { value: '' } }
    const fallback = createStrategy('EMPTY')
    const previous = createStrategy('PREVIOUS')
    const failed = createStrategy('FAILED', { updateUI: async () => { throw error } })
    manager.registerStrategy(fallback)
    manager.registerStrategy(previous)
    manager.registerStrategy(failed)
    if (usePrevious) await manager.transitionTo(previous, {}, context)

    await manager.transitionTo(failed, {}, context)

    const restored = usePrevious ? previous : fallback
    assert.equal(manager.currentStrategy, restored)
    const updates = []
    manager.on('candidates-updated', event => updates.push(event.candidates))
    await manager.processInput(restored.stateName, context)
    assert.deepEqual(updates, [[{ id: restored.stateName }]])
  }
  assert.equal(log.mock.calls.length, 2)
  assert.equal(log.mock.calls[0].arguments[1], error)
})
