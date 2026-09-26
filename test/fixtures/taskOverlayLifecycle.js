const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

// Real DOM, item builders and Sortable with stubbed browser dependencies/session.
// No web pages or external favicon requests are created for the synthetic tabs.
module.exports = function createTaskOverlayLifecycleFixture (tabCount = 2000, overlaySource) {
  document.body.innerHTML = `
    <button id="switch-task-button"></button>
    <div id="task-overlay" hidden>
      <div id="task-overlay-navbar"></div>
      <input id="task-search-input">
      <div id="task-area"></div>
      <button id="add-task"><span></span></button>
    </div>`
  const tasks = Array.from({ length: 10 }, (_, id) => {
    const tabs = Array.from({ length: tabCount / 10 }, (_, index) => ({
      id: `${id}-${index}`,
      title: `Page ${id}-${index}`,
      url: `https://example.com/${id}/${index}`,
      lastActivity: index
    }))
    return {
      id,
      tabs: {
        get: () => tabs.slice(),
        count: () => tabs.length,
        getAtIndex: index => tabs[index],
        getSelected: () => tabs[0].id
      }
    }
  })
  tasks.getSelected = () => tasks[0]
  tasks.getLastActivity = () => Date.now()
  tasks.isCollapsed = () => false
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
  const dependencies = {
    'tabState.js': { tasks, tabs: { getSelected: () => tasks[0].tabs.getSelected() } },
    'rendererHost.js': { getRuntimeConfiguration: () => ({ platform: process.platform }) },
    'webviews.js': { requestPlaceholder () {}, hidePlaceholder () {} },
    'browserUI.js': { switchToTask () {}, switchToTab () {} },
    'keybindings.js': {},
    'navbar/tabBar.js': {},
    'navbar/tabEditor.js': { hide () {} },
    'focusMode.js': { enabled: () => false },
    'util/keyboardNavigationHelper.js': {},
    'util/urlParser.js': { getSourceURL: url => url, basicURL: url => url, isURL: () => false },
    'util/searchEngine.js': { getSearch: () => null },
    'util/dateFormat.js': () => '',
    sortablejs: require('sortablejs')
  }
  function load (name) {
    if (!Object.hasOwn(dependencies, name)) {
      const filename = path.join(__dirname, '../../js', name)
      const module = { exports: {} }
      const source = name === 'taskOverlay/taskOverlay.js' && overlaySource !== undefined ? overlaySource : fs.readFileSync(filename, 'utf8')
      const evaluate = vm.runInThisContext('(function (require, module, empty, setTimeout, clearTimeout) {\n' + source + '\n})', { filename })
      evaluate(load, module,
        node => { while (node.firstElementChild) node.removeChild(node.firstElementChild) },
        (callback, delay) => {
          const id = ++nextTimerId
          timers.set(id, { callback, time: now + delay })
          return id
        },
        id => timers.delete(id))
      dependencies[name] = module.exports
    }
    return dependencies[name]
  }
  const overlay = load('taskOverlay/taskOverlay.js')
  const Sortable = dependencies.sortablejs
  const flush = () => advance(250)
  function snapshot () {
    return {
      rows: document.querySelectorAll('.task-tab-item').length,
      sortables: overlay.sortableInstances.length,
      detachedRows: overlay.sortableInstances.reduce((count, instance) => count + (instance.el && !instance.el.isConnected ? instance.el.querySelectorAll('.task-tab-item').length : 0), 0)
    }
  }
  function assertClosed () {
    assert.deepEqual(snapshot(), { rows: 0, sortables: 0, detachedRows: 0 })
    assert.equal(timers.size, 0)
    assert.equal(Sortable.get(document.getElementById('task-area')), null)
    assert.equal(Sortable.get(document.getElementById('add-task')), null)
  }
  return {
    show () {
      overlay.show()
      assert.equal(document.querySelectorAll('.task-tab-item').length, tabCount)
      return snapshot()
    },
    hide () {
      overlay.hide()
      flush()
      return snapshot()
    },
    checkReopen () {
      overlay.show()
      overlay.hide()
      overlay.show()
      flush()
      assert.equal(snapshot().rows, tabCount)
      assert.equal(snapshot().sortables, 12)
      assert.ok(overlay.sortableInstances.every(instance => instance.el && Sortable.get(instance.el) === instance))
      overlay.hide()
      flush()
      assertClosed()
    },
    checkReclose () {
      overlay.show()
      overlay.hide()
      advance(100)
      overlay.show()
      overlay.hide()
      advance(150)
      assert.equal(snapshot().rows, tabCount)
      assert.equal(snapshot().sortables, 12)
      assert.equal(timers.size, 1)
      advance(99)
      assert.equal(snapshot().rows, tabCount)
      advance(1)
      assertClosed()
    }
  }
}
