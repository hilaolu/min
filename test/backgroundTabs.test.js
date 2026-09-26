const assert = require('node:assert/strict')
const EventEmitter = require('node:events')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

const BrowserSession = require('../js/tabState/browserSession.js')
const shouldDeferBackgroundTab = require('../js/tabLoadingPolicy.js')

const policyCases = [
  { name: 'default setting', enabled: undefined, deferred: false },
  { name: 'disabled setting', enabled: false, deferred: false },
  { name: 'string setting', enabled: 'true', deferred: false },
  { name: 'numeric setting', enabled: 1, deferred: false },
  { name: 'HTTPS background', deferred: true },
  { name: 'HTTP background', tab: { url: 'http://example.com' }, deferred: true },
  { name: 'uppercase scheme', tab: { url: 'HTTPS://example.com' }, deferred: true },
  { name: 'download URL', tab: { url: 'https://example.com/download.zip' }, deferred: true },
  { name: 'foreground', options: { openInBackground: false }, deferred: false },
  { name: 'default options', options: {}, deferred: false },
  { name: 'string background option', options: { openInBackground: 'true' }, deferred: false },
  { name: 'private', tab: { private: true }, deferred: false },
  { name: 'popup adoption', options: { openInBackground: true, existingViewId: 'popup-1' }, deferred: false },
  ...['', 'example.com', '//example.com', 'http:example.com', 'https://',
    'min://newtab', 'min://app/pages/settings/index.html', 'file:///tmp/example.html',
    'vault://note/example', 'about:blank', 'data:text/html,hello', 'chrome://version',
    'ftp://example.com', 'javascript:void(0)'].map(url => ({
    name: `excluded URL ${JSON.stringify(url)}`, tab: { url }, deferred: false
  }))
].map(item => ({
  enabled: true,
  options: { openInBackground: true },
  ...item,
  tab: { url: 'https://example.com', ...item.tab }
}))

test('deferral policy requires strict opt-in and explicit eligible background content', function () {
  assert.equal(shouldDeferBackgroundTab({ url: 'https://example.com' }), false)
  for (const item of policyCases) {
    assert.equal(shouldDeferBackgroundTab(item.tab, item.options, item.enabled), item.deferred, item.name)
  }
})

// This harness runs production Browser UI and webviews, including setSelected.
// Only the DOM, peripheral UI services and content transport are stubbed. No
// Electron contents or network requests are made; counts do not measure memory.
function createHarness (enabled) {
  let nextId = 0
  const session = new BrowserSession({
    windowId: 'background-test',
    createId: () => `id-${++nextId}`,
    now: () => 1000 + nextId
  })
  const rendered = new Map()
  const contents = new Map()
  const calls = []
  const addCalls = []
  const selectionCalls = []
  const settings = {
    get: key => {
      if (key === 'deferBackgroundTabs') return enabled
      assert.ok(['useSeparateTitlebar', 'openTabsInForeground'].includes(key), key)
      return false
    }
  }
  const rendererHost = {
    getRuntimeConfiguration: () => ({ platform: 'linux' }),
    onFileViewChanged () {},
    onWindowStateChanged () {},
    onTabContentEvent () {},
    onTabContentMessage () {},
    onDownloadNavigation () {},
    onBrowserChromeActivated () {},
    invokeTabContent: (id, operation, payload) => {
      assert.ok(calls.length < 256, 'transport call bound exceeded')
      calls.push({ id, operation, payload })
      switch (operation) {
        case 'lifecycle.create':
          assert.ok(session.tabs.get(id), 'model must exist before content')
          assert.ok(rendered.has(id), 'tab must be rendered before content')
          assert.equal(contents.has(id), false, 'content must be created only once')
          assert.ok(contents.size < 64, 'content bound exceeded')
          contents.set(id, payload)
          break
        case 'lifecycle.present':
        case 'lifecycle.prepare':
          assert.ok(contents.has(id), `${operation} requires contents`)
          break
        case 'lifecycle.destroy':
          contents.delete(id)
          break
        default:
          assert.fail(`Unexpected transport operation: ${operation}`)
      }
      return Promise.resolve(true)
    }
  }
  const tabBar = {
    events: new EventEmitter(),
    addTab: id => {
      const tab = session.tabs.get(id)
      assert.ok(tab)
      assert.equal(rendered.has(id), false)
      rendered.set(id, {
        id,
        url: tab.url,
        title: tab.title,
        scrolled: false,
        scrollIntoView () { this.scrolled = true }
      })
    },
    removeTab: id => rendered.delete(id),
    getTab: id => rendered.get(id),
    setActiveTab: id => { assert.ok(rendered.has(id)) },
    reconcileOrder () {}
  }
  const dependencies = {
    'tabState.js': session,
    'tabLoadingPolicy.js': shouldDeferBackgroundTab,
    'util/settings/settings.js': settings,
    'rendererHost.js': rendererHost,
    'previewImageManager.js': () => ({}),
    'places/historyPolicy.js': { canExtractHistory: () => false },
    'util/urlParser.js': { parse: url => url },
    'js/util/urlParser.js': { parse: url => url },
    'js/statistics.js': {},
    'js/util/searchEngine.js': {},
    'focusMode.js': { enabled: () => false },
    'navbar/tabBar.js': tabBar,
    'navbar/tabEditor.js': { show () {}, hide () {} },
    'searchbar/searchbar.js': { events: new EventEmitter() },
    'navbar/contentBlockingToggle.js': { events: new EventEmitter() }
  }
  function load (name) {
    const filename = path.join(__dirname, '../js', name)
    const context = {
      module: { exports: {} },
      require: name => {
        assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`)
        return dependencies[name]
      },
      document: {
        getElementById: () => ({}),
        body: { classList: { add () {}, remove () {} } }
      },
      window: { innerWidth: 1000, innerHeight: 800, addEventListener () {} },
      throttle: callback => callback,
      console,
      URL
    }
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename, timeout: 1000 })
    return context.module.exports
  }
  const webviews = load('webviews.js')
  for (const [method, recorded] of [['add', addCalls], ['setSelected', selectionCalls]]) {
    const original = webviews[method]
    webviews[method] = function (...args) {
      recorded.push(args)
      return original.apply(this, args)
    }
  }
  dependencies['webviews.js'] = webviews
  const ui = load('browserUI.js')
  const foreground = ui.addTab({ url: 'https://selected.example' }, { enterEditMode: false })
  return {
    ui,
    session,
    rendered,
    contents,
    calls,
    addCalls,
    selectionCalls,
    tabBar,
    foreground,
    setEnabled: value => { enabled = value }
  }
}

test('Browser UI preserves model and rendered tabs, and eagerly adds every excluded case', function () {
  for (const item of policyCases) {
    const h = createHarness(item.enabled)
    const id = h.ui.addTab(item.tab, item.options)
    assert.equal(h.session.tabs.get().length, 2, item.name)
    assert.equal(h.rendered.size, 2, item.name)
    assert.equal(h.rendered.get(id).url, item.tab.url, item.name)
    assert.equal(h.session.tabs.get(id).hasWebContents, !item.deferred, item.name)
    assert.equal(h.contents.has(id), !item.deferred, item.name)
    assert.equal(h.addCalls.filter(([tabId]) => tabId === id).length, item.deferred ? 0 : 1, item.name)
    const background = Boolean(item.options.openInBackground)
    assert.equal(h.session.tabs.getSelected(), background ? h.foreground : id, item.name)
    assert.equal(h.rendered.get(id).scrolled, background, item.name)
    if (item.options.existingViewId) {
      assert.equal(h.contents.get(id).existingTabContentId, item.options.existingViewId)
      assert.equal(h.contents.get(id).initialURL, null)
    }
  }
})

test('selecting a deferred tab uses existing setSelected and creates content exactly once', function () {
  const h = createHarness(true)
  const id = h.ui.addTab({ url: 'https://deferred.example', title: 'Deferred' }, { openInBackground: true })
  assert.equal(h.rendered.get(id).title, 'Deferred')
  assert.equal(h.session.tabs.get(id).hasWebContents, false)
  assert.equal(h.contents.size, 1)

  h.tabBar.events.emit('tab-selected', id)
  assert.equal(h.selectionCalls.at(-1)[0], id)
  assert.equal(h.session.tabs.getSelected(), id)
  assert.equal(h.session.tabs.get(id).hasWebContents, true)
  assert.equal(h.contents.get(id).initialURL, 'https://deferred.example')
  h.ui.switchToTab(h.foreground)
  h.tabBar.events.emit('tab-selected', id)
  assert.equal(h.selectionCalls.filter(([tabId]) => tabId === id).length, 2)
  assert.equal(h.addCalls.filter(([tabId]) => tabId === id).length, 1)
  assert.equal(h.calls.filter(call => call.id === id && call.operation === 'lifecycle.create').length, 1)
  assert.equal(h.contents.size, 2)
})

test('closing before selection never creates or prepares deferred contents', async function () {
  const h = createHarness(true)
  const id = h.ui.addTab({ url: 'https://never-selected.example' }, { openInBackground: true })
  const createsBefore = h.addCalls.length
  assert.ok(await h.ui.closeTab(id))
  assert.equal(h.rendered.has(id), false)
  assert.equal(h.session.tabs.get().some(tab => tab.id === id), false)
  assert.equal(h.contents.has(id), false)
  assert.equal(h.addCalls.length, createsBefore)
  assert.deepEqual(h.calls.filter(call => call.id === id).map(call => call.operation), ['lifecycle.destroy'])
  assert.equal(h.session.tabs.getSelected(), h.foreground)
})

test('setting changes affect only future additions, without destroying or loading existing tabs', function () {
  const h = createHarness(false)
  const loaded = h.ui.addTab({ url: 'https://loaded.example' }, { openInBackground: true })
  const callsBefore = h.calls.length
  h.setEnabled(true)
  assert.equal(h.calls.length, callsBefore)
  const deferred = h.ui.addTab({ url: 'https://deferred.example' }, { openInBackground: true })
  h.setEnabled(false)
  assert.equal(h.calls.length, callsBefore)
  assert.equal(h.session.tabs.get(loaded).hasWebContents, true)
  assert.equal(h.session.tabs.get(deferred).hasWebContents, false)
  const eager = h.ui.addTab({ url: 'https://eager.example' }, { openInBackground: true })
  assert.equal(h.session.tabs.get(eager).hasWebContents, true)
  h.ui.switchToTab(loaded)
  assert.equal(h.addCalls.filter(([id]) => id === loaded).length, 1)
  h.ui.switchToTab(deferred)
  assert.equal(h.session.tabs.get(deferred).hasWebContents, true)
  assert.equal(h.calls.some(call => call.operation === 'lifecycle.destroy'), false)
})

test('duplicate and restore use stored tab data and preserve private exclusions', async function () {
  const h = createHarness(true)
  const duplicate = h.ui.duplicateTab(h.foreground, { openInBackground: true })
  assert.equal(h.session.tabs.get(duplicate).url, 'https://selected.example')
  assert.equal(h.session.tabs.get(duplicate).hasWebContents, false)
  await h.ui.closeTab(duplicate)
  const restored = h.ui.restoreTab(h.session.tasks.getSelected().id, { openInBackground: true })
  assert.equal(h.session.tabs.get(restored).url, 'https://selected.example')
  assert.equal(h.session.tabs.get(restored).hasWebContents, false)
  assert.ok(h.rendered.has(restored))

  const privateTab = h.ui.addTab({ url: 'https://private.example', private: true })
  const privateDuplicate = h.ui.duplicateTab(privateTab, { openInBackground: true })
  assert.equal(h.session.tabs.get(privateDuplicate).private, true)
  assert.equal(h.session.tabs.get(privateDuplicate).hasWebContents, true)
  assert.equal(h.contents.get(privateDuplicate).private, true)
})
