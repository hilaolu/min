const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')
const filterTaskOverlay = require('../js/taskOverlay/taskOverlaySearch.js')

function element (id) {
  const classes = new Set(['collapsed'])
  return {
    getAttribute: () => String(id),
    hidden: false,
    classList: {
      contains: name => classes.has(name),
      remove: name => classes.delete(name),
      toggle: (name, value) => value ? classes.add(name) : classes.delete(name)
    }
  }
}

function fixture (count = 20) {
  const tasks = Array.from({ length: 2 }, (_, id) => ({
    id,
    name: id === 0 ? 'Work' : 'Personal',
    tabs: Array.from({ length: count }, (_, index) => ({ id: `${id}-${index}`, title: `Page ${index}`, url: `https://example.com/${index}` }))
  }))
  const taskElements = tasks.map(task => element(task.id))
  const tabElements = tasks.flatMap(task => task.tabs.map(tab => element(tab.id)))
  let queries = 0
  const container = {
    querySelectorAll: selector => {
      queries++
      if (selector === '.task-container') return taskElements
      if (selector === '.task-tab-item') return tabElements
      throw new Error(`Unexpected query ${selector}`)
    }
  }
  return { tasks, taskElements, tabElements, container, queries: () => queries }
}

test('overlay search matches all words across task names, titles and URLs with one visible focus', function () {
  const f = fixture()
  assert.equal(filterTaskOverlay(f.container, f.tasks, 'work page  2 example'), 2)
  assert.deepEqual(f.tabElements.filter(el => !el.hidden).map(el => el.getAttribute()), ['0-2', '0-12'])
  assert.equal(f.taskElements[0].hidden, false)
  assert.equal(f.taskElements[0].classList.contains('collapsed'), false)
  assert.equal(f.taskElements[1].hidden, true)
  assert.equal(f.taskElements[1].classList.contains('collapsed'), true)
  assert.deepEqual(f.tabElements.filter(el => !el.hidden && el.classList.contains('fakefocus')).map(el => el.getAttribute()), ['0-2'])
  assert.equal(filterTaskOverlay(f.container, f.tasks, 'not-found'), 0)
  assert.ok(f.taskElements.every(el => el.hidden))
  assert.equal(filterTaskOverlay(f.container, f.tasks, 'personal'), 20)
  assert.equal(f.taskElements[1].hidden, false)
})

test('overlay search uses two scoped queries regardless of tab count', function () {
  const f = fixture(1500)
  assert.equal(filterTaskOverlay(f.container, f.tasks, 'example'), 3000)
  assert.equal(f.queries(), 2)
  assert.deepEqual(f.tabElements.filter(el => el.classList.contains('fakefocus')), [f.tabElements[0]])
})

test('overlay search uses fresh elements after rendering, moving and deleting tabs', function () {
  const f = fixture(2)
  filterTaskOverlay(f.container, f.tasks, 'work')
  const detached = f.tabElements[0]
  f.tabElements[0] = element('0-0')
  f.tasks[1].tabs.push(f.tasks[0].tabs.shift())
  f.tabElements.splice(1, 1) // deletion can remove DOM before the model notification
  assert.equal(filterTaskOverlay(f.container, f.tasks, 'personal'), 3)
  assert.equal(f.tabElements[0].hidden, false)
  assert.equal(detached.hidden, false)
  f.taskElements.shift() // a removed task is ignored rather than dereferenced
  assert.equal(filterTaskOverlay(f.container, f.tasks, 'work'), 0)
})

test('overlay input delegates normalized searches and retains the empty-query reset path', function () {
  const nodes = new Map()
  const getNode = id => {
    if (!nodes.has(id)) {
      nodes.set(id, {
        listeners: {},
        addEventListener (name, fn) { this.listeners[name] = fn },
        querySelector: () => ({}),
        focus () { this.focused = true }
      })
    }
    return nodes.get(id)
  }
  const calls = []
  const tasks = {}
  const context = {
    module: { exports: {} },
    document: { getElementById: getNode, querySelector: getNode },
    require: name => {
      if (name === 'tabState.js') return { tasks }
      if (name === 'rendererHost.js') return { getRuntimeConfiguration: () => ({}) }
      if (name === 'taskOverlay/taskOverlaySearch.js') return (...args) => calls.push(args)
      return {}
    }
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../js/taskOverlay/taskOverlay.js'), 'utf8'), context)
  const overlay = context.module.exports
  let renders = 0
  overlay.render = () => { renders++ }
  overlay.initializeSearch()
  const input = getNode('task-search-input')
  input.value = '  WORK Page  '
  input.listeners.input()
  assert.deepEqual(calls, [[getNode('task-area'), tasks, 'work page']])
  input.value = '  '
  input.listeners.input()
  assert.equal(renders, 1)
  assert.equal(input.focused, true)
  assert.equal(calls.length, 1)
})
