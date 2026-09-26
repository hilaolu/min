const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

function createHarness () {
  const nodes = new Map()
  function getNode (id) {
    if (!nodes.has(id)) {
      nodes.set(id, {
        children: [],
        classList: { add () {}, remove () {} },
        setAttribute () {},
        removeAttribute () {},
        appendChild (child) { this.children.push(child) },
        querySelector: () => ({}),
        querySelectorAll: () => []
      })
    }
    return nodes.get(id)
  }

  const events = []
  const instances = []
  const timers = new Map()
  let nextTimerId = 0
  let now = 0
  function advance (milliseconds) {
    now += milliseconds
    for (const [id, timer] of Array.from(timers)) {
      if (timer.time <= now) {
        timers.delete(id)
        timer.callback()
      }
    }
  }
  const placeholders = []
  class Sortable {
    constructor (el) {
      this.el = el
      this.destroyed = 0
      instances.push(this)
    }

    destroy () {
      assert.equal(this.destroyed, 0, 'each Sortable must be destroyed only once')
      this.destroyed++
      this.el = null
      events.push('destroy')
    }
  }
  const tasks = Array.from({ length: 10 }, (_, id) => ({ id, tabs: { getSelected: () => 'tab' } }))
  tasks.getSelected = () => tasks[0]
  const dependencies = {
    'tabState.js': { tasks, tabs: { getSelected: () => 'tab' } },
    'rendererHost.js': { getRuntimeConfiguration: () => ({ platform: 'linux' }) },
    'webviews.js': {
      requestPlaceholder: reason => placeholders.push(['show', reason]),
      hidePlaceholder: reason => placeholders.push(['hide', reason])
    },
    'browserUI.js': { switchToTask () {}, switchToTab () {} },
    'keybindings.js': {},
    'navbar/tabBar.js': {},
    'navbar/tabEditor.js': { hide () {} },
    'focusMode.js': { enabled: () => false },
    'util/keyboardNavigationHelper.js': {},
    sortablejs: Sortable,
    'taskOverlay/taskOverlayBuilder.js': () => ({ querySelector: () => ({}) }),
    'taskOverlay/taskOverlaySearch.js': () => {}
  }
  const context = {
    module: { exports: {} },
    require: name => {
      assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency ${name}`)
      return dependencies[name]
    },
    document: { body: getNode('body'), getElementById: getNode, querySelector: () => null },
    empty: node => { events.push('empty'); node.children.length = 0 },
    setTimeout: (callback, delay) => {
      assert.equal(delay, 250)
      const id = ++nextTimerId
      timers.set(id, { callback, time: now + delay })
      return id
    },
    clearTimeout: id => timers.delete(id)
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../js/taskOverlay/taskOverlay.js'), 'utf8'), context)
  return {
    overlay: context.module.exports,
    container: getNode('task-area'),
    events,
    instances,
    placeholders,
    advance,
    pendingTimers: () => timers.size,
    flush: () => advance(250)
  }
}

test('overlay rerender destroys old Sortables before removing their elements', function () {
  const f = createHarness()
  f.overlay.show()
  assert.equal(f.overlay.sortableInstances.length, 12)
  const old = f.instances.slice()
  f.events.length = 0
  f.overlay.render()
  assert.deepEqual(f.events, [...Array(12).fill('destroy'), 'empty'])
  assert.ok(old.every(instance => instance.destroyed === 1 && instance.el === null))
  assert.equal(f.overlay.sortableInstances.length, 12)
  assert.equal(f.container.children.length, 10)
})

test('closing the overlay releases every Sortable and detached row after the transition', function () {
  const f = createHarness()
  for (let cycle = 0; cycle < 5; cycle++) {
    f.overlay.show()
    f.overlay.hide()
    assert.equal(f.overlay.isShown, false)
    assert.equal(f.overlay.sortableInstances.length, 12, 'keep rows until the animation completes')
    assert.equal(f.container.children.length, 10)
    f.events.length = 0
    f.flush()
    assert.deepEqual(f.events, [...Array(12).fill('destroy'), 'empty'])
    assert.equal(f.overlay.sortableInstances.length, 0)
    assert.equal(f.container.children.length, 0)
    assert.ok(f.instances.every(instance => instance.destroyed === 1 && instance.el === null))
    assert.equal(f.placeholders.filter(([action]) => action === 'hide').length, cycle + 1)
    f.overlay.hide()
    f.flush() // repeated hides must not destroy an instance twice
  }
})

test('a pending hide does not destroy the newly reopened overlay', function () {
  const f = createHarness()
  f.overlay.show()
  f.overlay.hide()
  f.overlay.show()
  assert.equal(f.pendingTimers(), 0)
  const current = Array.from(f.overlay.sortableInstances)
  f.flush()
  assert.equal(f.overlay.isShown, true)
  assert.equal(f.container.children.length, 10)
  assert.deepEqual(Array.from(f.overlay.sortableInstances), current)
  assert.ok(current.every(instance => instance.destroyed === 0 && instance.el !== null))
  assert.equal(f.placeholders.filter(([action]) => action === 'hide').length, 0)
  f.overlay.hide()
  f.flush()
  assert.equal(f.overlay.sortableInstances.length, 0)
  assert.ok(f.instances.every(instance => instance.destroyed === 1))
})

test('reclosing the overlay waits for the latest transition instead of an earlier hide', function () {
  const f = createHarness()
  f.overlay.show()
  f.overlay.hide()
  f.advance(100)
  f.overlay.show()
  f.overlay.hide()
  f.advance(150) // the first close timer would have fired here
  assert.equal(f.container.children.length, 10)
  assert.equal(f.overlay.sortableInstances.length, 12)
  assert.equal(f.pendingTimers(), 1)
  assert.equal(f.placeholders.filter(([action]) => action === 'hide').length, 0)
  f.advance(99)
  assert.equal(f.container.children.length, 10)
  f.advance(1)
  assert.equal(f.container.children.length, 0)
  assert.equal(f.overlay.sortableInstances.length, 0)
  assert.equal(f.pendingTimers(), 0)
  assert.equal(f.placeholders.filter(([action]) => action === 'hide').length, 1)
  assert.ok(f.instances.every(instance => instance.destroyed === 1))
})
