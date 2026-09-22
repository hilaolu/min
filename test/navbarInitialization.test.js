const assert = require('node:assert/strict')
const EventEmitter = require('node:events')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

function harness () {
  const elements = new Map()
  const lookups = []
  const bindings = []
  const tasks = new EventEmitter()
  const updates = []
  let menu
  let draggers = 0
  function element () {
    const node = new EventEmitter()
    node.addEventListener = node.on
    node.children = []
    node.appendChild = child => node.children.push(child)
    node.setAttribute = function () {}
    node.classList = { add: function () {}, remove: function () {} }
    return node
  }
  const document = {
    createElement: element,
    getElementById: id => {
      lookups.push(id)
      if (!elements.has(id)) elements.set(id, element())
      return elements.get(id)
    }
  }
  const window = element()
  const tabEditor = { isShown: false, hide: function () {} }
  const dependencies = {
    events: EventEmitter,
    'tabState.js': { tasks, tabs: { getSelected: () => 'selected', get: () => ({ private: true, url: 'https://example.com' }), isEmpty: () => false } },
    'rendererHost.js': { getDroppedFileURL: () => 'file:///dropped.html' },
    'webviews.js': { bindEvent: (...args) => bindings.push(args), update: (...args) => updates.push(args) },
    'focusMode.js': {},
    'readerView.js': {},
    'tabAudio.js': {},
    dragula: () => { draggers++; return new EventEmitter() },
    'util/settings/settings.js': { get: () => true, listen: (key, listener) => listener(false) },
    'util/urlParser.js': {},
    'navbar/tabEditor.js': tabEditor,
    'navbar/progressBar.js': {},
    'navbar/permissionRequests.js': { onChange: function () {} },
    'navbar/tabBarProjection.js': {},
    'searchbar/searchbar.js': {},
    'util/keyboardNavigationHelper.js': { addToGroup: function () {} },
    'navbar/bookmarkStar.js': { create: element },
    'navbar/contentBlockingToggle.js': { create: element },
    'remoteMenuRenderer.js': { open: value => { menu = value } }
  }
  function load (name) {
    const module = { exports: {} }
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../js/navbar', name), 'utf8'), {
      module,
      document,
      window,
      require: name => {
        assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`)
        return dependencies[name]
      }
    })
    return module.exports
  }
  return { load, lookups, bindings, tasks, window, elements, tabEditor, updates, getMenu: () => menu, getDraggers: () => draggers }
}

test('navbar components defer DOM setup until explicit, idempotent initialization', function () {
  for (const name of ['tabBar.js', 'tabEditor.js']) {
    const a = harness()
    const b = harness()
    const first = a.load(name)
    const second = b.load(name)
    assert.equal(first.container, null)
    assert.equal(second.container, null)
    assert.deepEqual(a.lookups, [])
    assert.deepEqual(a.bindings, [])
    first.initialize()
    const lookups = a.lookups.length
    first.initialize()
    assert.equal(a.lookups.length, lookups)
    assert.equal(second.container, null)
    second.initialize()
    assert.notEqual(first.container, second.container)
    if (name === 'tabBar.js') {
      assert.equal(a.getDraggers(), 1)
      assert.equal(a.window.listenerCount('resize'), 1)
      assert.equal(a.tasks.listenerCount('tab-updated'), 1)
      assert.equal(first.container.listenerCount('drop'), 1)
    } else {
      assert.equal(first.input.listenerCount('input'), 1)
      assert.equal(first.container.children.length, 2)
    }
  }
})

test('tab drop requests tab creation without importing Browser UI', function () {
  const h = harness()
  const bar = h.load('tabBar.js')
  bar.initialize()
  const requests = []
  bar.events.on('tab-add-requested', (tab, options) => requests.push({ tab: { ...tab }, options: { ...options } }))
  const drop = files => bar.container.emit('drop', { preventDefault () {}, dataTransfer: { files, getData: () => 'https://example.com/drop' } })
  drop([])
  drop([{}])
  assert.deepEqual(requests, [
    { tab: { url: 'https://example.com/drop', private: true }, options: { enterEditMode: false, openInBackground: false } },
    { tab: { url: 'file:///dropped.html', private: true }, options: { enterEditMode: false, openInBackground: false } }
  ])
  h.tabEditor.isShown = true
  drop([])
  assert.equal(requests.length, 2)
  assert.deepEqual(h.updates, [['selected', 'https://example.com/drop']])
})

test('content blocking reports request a tab without importing Browser UI', function () {
  const h = harness()
  const toggle = h.load('contentBlockingToggle.js')
  const requests = []
  toggle.events.on('tab-add-requested', (tab, options) => requests.push({ tab: { ...tab }, options: { ...options } }))
  toggle.showMenu({})
  h.getMenu()[1][0].click()
  assert.equal(requests.length, 1)
  assert.match(requests[0].tab.url, /issues\/new\?title=.*https%3A%2F%2Fexample.com/)
  assert.deepEqual(requests[0].options, { enterEditMode: false })
})
