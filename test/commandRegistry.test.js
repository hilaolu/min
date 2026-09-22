const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')
const { CommandStateStrategy } = require('../js/commandPalette/CommandStateStrategy.js')

function load (name, dependencies) {
  const module = { exports: {} }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../js', name), 'utf8'), {
    module,
    console,
    require: name => {
      assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`)
      return dependencies[name]
    }
  })
  return module.exports
}

test('Google commands use explicit queries without accessing the production palette', function () {
  const opened = []
  let focused = 0
  const commands = load('commandPaletteCommands.js', {
    'tabState.js': {},
    'searchbar/searchbar.js': { events: { emit: (event, data) => opened.push(data.url) } },
    'webviews.js': { focus: () => { focused++ } }
  })
  const google = commands.find(command => command.id === 'goo')
  assert.equal(google.prefix, '>goo ')
  google.action()
  google.action('  ')
  assert.equal(opened.length, 0)
  google.action('  scoped & explicit  ')
  assert.deepEqual(opened, ['https://www.google.com/search?q=scoped%20%26%20explicit'])
  assert.equal(focused, 1)
})

test('generic command candidates capture their own arguments', async function () {
  const queries = []
  const Strategy = load('commandPalette/strategies/VimCommandWithArgsStrategy.js', {
    '../../tabState.js': {},
    '../CommandStateStrategy.js': { CommandStateStrategy },
    '../../commandPaletteCommands.js': [{ id: 'example', action: query => queries.push(query) }]
  })
  const first = new Strategy().handleGenericCommand('example', 'first')[0]
  const second = new Strategy().handleGenericCommand('example', 'second')[0]
  await second.action()
  await first.action()
  assert.deepEqual(queries, ['second', 'first'])
})
