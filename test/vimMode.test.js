const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const source = fs.readFileSync(path.join(__dirname, '../js/preload/vimMode.js'), 'utf8')

function eventTarget () {
  const listeners = {}
  return {
    listeners,
    addEventListener: function (name, handler, options) {
      if (!listeners[name]) listeners[name] = []
      listeners[name].push({ handler, options })
    },
    emit: function (name, event = {}) {
      for (const { handler } of listeners[name] || []) {
        if (event.stopped) break
        handler(event)
      }
    }
  }
}

function createHarness ({ url = 'https://example.com/', readyState = 'complete' } = {}) {
  const scrolls = []
  const navigation = []
  const selectionChanges = []
  const copies = []
  const timers = new Map()
  let nextTimerID = 0
  const document = { ...eventTarget(), readyState }
  function createElement (tag) {
    return {
      tagName: tag.toUpperCase(),
      style: {},
      children: [],
      setAttribute: function () {},
      getAttribute: () => null,
      addEventListener: function () {},
      appendChild: function (element) { this.children.push(element); element.parentNode = this },
      removeChild: function (element) { this.children.splice(this.children.indexOf(element), 1); element.parentNode = null },
      focus: function () { document.activeElement = this; document.emit('focusin') },
      blur: function () {
        if (document.activeElement !== this) return
        document.activeElement = document.body
        document.emit('focusout')
      },
      select: function () { this.focus() },
      getBoundingClientRect: () => ({ top: 10, left: 10 }),
      click: function () {}
    }
  }
  document.body = createElement('body')
  document.body.scrollHeight = 2000
  document.activeElement = document.body
  document.createElement = createElement
  document.querySelectorAll = () => []
  document.createTreeWalker = () => ({ nextNode: () => null })
  document.queryCommandEnabled = () => false
  const selection = {
    isCollapsed: true,
    toString: () => 'selected text',
    modify: (...args) => selectionChanges.push(args)
  }
  const window = {
    ...eventTarget(),
    location: new URL(url),
    innerHeight: 600,
    innerWidth: 800,
    scrollX: 0,
    scrollY: 0,
    scrollBy: (x, y) => scrolls.push([x, y]),
    scrollTo: (x, y) => scrolls.push([x, y]),
    history: { back: () => navigation.push('back'), forward: () => navigation.push('forward') },
    getSelection: () => selection,
    NodeFilter: { SHOW_TEXT: 4 }
  }
  const context = vm.createContext({
    window,
    document,
    process: { argv: [] },
    setTimeout: (callback, delay) => { timers.set(++nextTimerID, { callback, delay }); return nextTimerID },
    clearTimeout: id => timers.delete(id),
    navigator: { clipboard: { writeText: text => { copies.push(text); return Promise.resolve() } } }
  })
  vm.runInContext(source, context)
  return {
    window,
    document,
    scrolls,
    navigation,
    selection,
    selectionChanges,
    copies,
    runTimers: function (delay = 0) {
      for (const [id, timer] of Array.from(timers)) {
        if (timer.delay === delay) { timers.delete(id); timer.callback() }
      }
    },
    evaluate: script => vm.runInContext(script, context),
    key: function (type, key, options = {}) {
      const event = {
        key,
        code: key,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        defaultPrevented: false,
        stopped: false,
        preventDefault: function () { this.defaultPrevented = true },
        stopImmediatePropagation: function () { this.stopped = true },
        ...options
      }
      window.emit(type, event)
      document.emit(type, event)
      return event
    }
  }
}

function assertConsumed (event, consumed = true) {
  assert.equal(event.defaultPrevented, consumed)
  assert.equal(event.stopped, consumed)
}

for (const readyState of ['loading', 'complete']) {
  for (const [url, external] of [
    ['https://example.com/', true],
    ['http://example.com/', true],
    ['file:///tmp/example.html', true],
    ['https://example.com/?url=min://app/pages/settings/index.html', true],
    ['min://app/index.html', false],
    ['min://app/pages/settings/index.html', false],
    ['min://app/pages/markdown/index.html?file=note.md', false],
    ['min://app/pages/pdfViewer/index.html?url=https://example.com/file.pdf', false],
    ['min://app/reader/index.html', false],
    ['min://app/pages/future-page/index.html', false],
    ['vault://', false],
    ['vault://notes/example.md', false]
  ]) {
    test(`vim mode eligibility: ${url} (${readyState})`, () => {
      const harness = createHarness({ url, readyState })
      const { window, document, scrolls } = harness
      for (const type of ['keydown', 'keypress', 'keyup']) {
        assert.equal(window.listeners[type]?.length || 0, external ? 1 : 0)
        if (external) assert.equal(window.listeners[type][0].options, true)
        assert.equal(document.listeners[type], undefined)
      }
      if (readyState === 'loading') {
        assert.equal(document.body.children.length, 0)
        document.emit('DOMContentLoaded')
      }
      assert.equal(document.body.children.length, external ? 1 : 0)
      for (const type of ['keydown', 'keypress', 'keyup']) {
        assertConsumed(harness.key(type, 'k'), external)
      }
      assert.deepEqual(scrolls, external ? [[0, -60]] : [])
    })
  }
}

test('Vim reserves window capture before DOM ready and blocks later website listeners', () => {
  const harness = createHarness({ readyState: 'loading' })
  const pageEvents = []
  for (const target of [harness.window, harness.document]) {
    for (const type of ['keydown', 'keypress', 'keyup']) {
      target.addEventListener(type, event => { pageEvents.push(type); event.stopImmediatePropagation() }, true)
    }
  }
  // Usable even while a slow page is still loading, without double initialization.
  assertConsumed(harness.key('keydown', 'k'))
  harness.document.emit('DOMContentLoaded')
  assert.equal(harness.document.body.children.length, 1)
  assertConsumed(harness.key('keydown', 'k', { repeat: true }))
  assertConsumed(harness.key('keypress', 'k'))
  assertConsumed(harness.key('keyup', 'k'))
  assert.deepEqual(harness.scrolls, [[0, -60], [0, -60]])
  assert.deepEqual(pageEvents, [])
})

test('normal-mode scroll and history commands consume their complete keystrokes', () => {
  const harness = createHarness()
  for (const [key, options] of [
    ['l', {}], ['k', { ctrlKey: true }], ['l', { ctrlKey: true }],
    ['j', { ctrlKey: true }], [';', { ctrlKey: true }], ['G', { shiftKey: true }]
  ]) {
    for (const type of ['keydown', 'keypress', 'keyup']) assertConsumed(harness.key(type, key, options))
  }
  assert.deepEqual(harness.scrolls, [[0, 60], [0, -400], [0, 400], [0, 2000]])
  assert.deepEqual(harness.navigation, ['back', 'forward'])
})

test('unbound keys remain available to websites', () => {
  const harness = createHarness()
  for (const key of ['z', 'Tab', 'ArrowDown']) {
    for (const type of ['keydown', 'keypress', 'keyup']) assertConsumed(harness.key(type, key), false)
  }
})

test('modified shortcuts are not mistaken for Vim commands', () => {
  const harness = createHarness()
  for (const options of [{ altKey: true }, { metaKey: true }, { ctrlKey: true, altKey: true }, { ctrlKey: true, metaKey: true }]) {
    for (const key of ['k', 'l', 'G', 'j', ';', 'c', 'p', 'f']) {
      for (const type of ['keydown', 'keypress', 'keyup']) assertConsumed(harness.key(type, key, options), false)
    }
  }
  assert.deepEqual(harness.scrolls, [])
  assert.deepEqual(harness.navigation, [])
  assert.equal(harness.evaluate('vimManager.current.getName()'), 'NORMAL')
  assertConsumed(harness.key('keydown', 'f'))
  for (const options of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }]) {
    for (const type of ['keydown', 'keypress', 'keyup']) assertConsumed(harness.key(type, 'a', options), false)
  }
  assert.equal(harness.evaluate('vimManager.current.getName()'), 'LINK_HINT')
})

test('IME composition does not execute Vim commands or submit a search', () => {
  const harness = createHarness()
  for (const options of [{ isComposing: true }, { keyCode: 229 }]) {
    for (const key of ['k', '/']) {
      for (const type of ['keydown', 'keypress', 'keyup']) assertConsumed(harness.key(type, key, options), false)
    }
    assertConsumed(harness.key('keydown', 'p', { ...options, ctrlKey: true }), false)
    assert.equal(harness.evaluate('vimManager.current.getName()'), 'NORMAL')
  }
  assertConsumed(harness.key('keydown', '/'))
  assertConsumed(harness.key('keyup', '/'))
  for (const type of ['keydown', 'keypress', 'keyup']) assertConsumed(harness.key(type, 'Enter', { isComposing: true }), false)
  assert.equal(harness.evaluate('vimManager.current.getName()'), 'SEARCH')
  assert.deepEqual(harness.scrolls, [])
})

test('search consumes typing, Backspace and Enter release after returning to normal', () => {
  const harness = createHarness()
  assertConsumed(harness.key('keydown', '/'))
  assert.equal(harness.evaluate('vimManager.current.getName()'), 'SEARCH')
  assertConsumed(harness.key('keyup', '/'))
  assertConsumed(harness.key('keydown', 'x', { code: 'KeyX' }))
  assertConsumed(harness.key('keypress', 'x', { code: 'KeyX' }))
  assertConsumed(harness.key('keyup', 'X', { code: 'KeyX', shiftKey: true }))
  assert.equal(harness.evaluate('searchBuffer'), 'x')
  assertConsumed(harness.key('keydown', 'Backspace'))
  assertConsumed(harness.key('keyup', 'Backspace'))
  assert.equal(harness.evaluate('searchBuffer'), '')
  assertConsumed(harness.key('keydown', 'Enter'))
  assert.equal(harness.evaluate('vimManager.current.getName()'), 'NORMAL')
  assertConsumed(harness.key('keypress', 'Enter'))
  assertConsumed(harness.key('keyup', 'Enter'))
})

test('visual commands and global exit take priority over page shortcuts', () => {
  const harness = createHarness()
  harness.selection.isCollapsed = false
  for (const key of ['v', 'w', 'b', 'y']) {
    for (const type of ['keydown', 'keypress', 'keyup']) assertConsumed(harness.key(type, key))
  }
  assert.equal(harness.evaluate('vimManager.current.getName()'), 'VISUAL')
  assert.deepEqual(harness.selectionChanges, [['extend', 'forward', 'word'], ['extend', 'backward', 'word']])
  assert.deepEqual(harness.copies, ['selected text'])
  for (const type of ['keydown', 'keypress', 'keyup']) assertConsumed(harness.key(type, 'c', { ctrlKey: true }))
  assert.equal(harness.evaluate('vimManager.current.getName()'), 'NORMAL')
})

test('link hints suppress the selecting key release after a mode change', () => {
  const harness = createHarness()
  const button = harness.document.createElement('button')
  let clicks = 0
  button.click = () => clicks++
  harness.document.querySelectorAll = () => [button]
  assertConsumed(harness.key('keydown', 'f'))
  assert.equal(harness.evaluate('vimManager.current.getName()'), 'LINK_HINT')
  assertConsumed(harness.key('keyup', 'f'))
  assertConsumed(harness.key('keydown', 'a'))
  assert.equal(clicks, 1)
  assert.equal(harness.evaluate('vimManager.current.getName()'), 'NORMAL')
  assertConsumed(harness.key('keypress', 'a'))
  assertConsumed(harness.key('keyup', 'a'))
  assertConsumed(harness.key('keydown', 'a'), false)
  assertConsumed(harness.key('keyup', 'a'), false)
})

test('a mode change does not swallow releases of keys the page already received', () => {
  const harness = createHarness()
  assertConsumed(harness.key('keydown', 'a'), false)
  assertConsumed(harness.key('keydown', 'f'))
  assert.equal(harness.evaluate('vimManager.current.getName()'), 'LINK_HINT')
  assertConsumed(harness.key('keyup', 'a'), false)
  assertConsumed(harness.key('keyup', 'f'))
})

test('editable fields keep normal typing and global Vim controls', () => {
  for (const tag of ['input', 'textarea', 'select', 'div']) {
    const harness = createHarness()
    const input = harness.document.createElement(tag)
    if (tag === 'div') input.isContentEditable = true
    // Simulate autofocus before initialization or a page swallowing focusin.
    harness.document.activeElement = input
    for (const key of ['/', 'f', 'k', 'Backspace']) {
      for (const type of ['keydown', 'keypress', 'keyup']) assertConsumed(harness.key(type, key), false)
    }
    assert.equal(harness.evaluate('vimManager.current.getName()'), 'INPUT_FOCUS')
    for (const type of ['keydown', 'keypress', 'keyup']) assertConsumed(harness.key(type, 'c', { ctrlKey: true }))
    assert.equal(harness.document.activeElement, harness.document.body)
    assert.equal(harness.evaluate('vimManager.current.getName()'), 'NORMAL')
    assertConsumed(harness.key('keydown', 'k'))
  }
})

test('normal mode resumes even if the website hides focusout', () => {
  const harness = createHarness()
  harness.document.createElement('input').focus()
  assert.equal(harness.evaluate('vimManager.current.getName()'), 'INPUT_FOCUS')
  harness.document.activeElement = harness.document.body
  assertConsumed(harness.key('keydown', 'k'))
  assert.equal(harness.evaluate('vimManager.current.getName()'), 'NORMAL')
})

test('a delayed focusout callback does not cancel a newer mode', () => {
  for (const [key, options, mode] of [['/', {}, 'SEARCH'], ['p', { ctrlKey: true }, 'PASSTHROUGH']]) {
    const harness = createHarness()
    const input = harness.document.createElement('input')
    input.focus()
    input.blur()
    assertConsumed(harness.key('keydown', key, options))
    harness.runTimers()
    assert.equal(harness.evaluate('vimManager.current.getName()'), mode)
  }
})

test('shadow editor hosts preserve typing when Chromium reports editability', () => {
  const harness = createHarness()
  harness.document.activeElement = harness.document.createElement('div')
  harness.document.queryCommandEnabled = command => command === 'insertText'
  for (const type of ['keydown', 'keypress', 'keyup']) assertConsumed(harness.key(type, '/'), false)
  assert.equal(harness.evaluate('vimManager.current.getName()'), 'INPUT_FOCUS')
  harness.document.activeElement = harness.document.body
  assertConsumed(harness.key('keydown', 'k'))
  assert.equal(harness.evaluate('vimManager.current.getName()'), 'NORMAL')
})

test('passthrough gives website shortcuts back, except the toggle keystroke', () => {
  const harness = createHarness()
  for (const type of ['keydown', 'keypress', 'keyup']) assertConsumed(harness.key(type, 'p', { ctrlKey: true }))
  assert.equal(harness.evaluate('vimManager.current.getName()'), 'PASSTHROUGH')
  for (const [key, options] of [['k', {}], ['c', { ctrlKey: true }]]) {
    for (const type of ['keydown', 'keypress', 'keyup']) assertConsumed(harness.key(type, key, options), false)
  }
  assert.deepEqual(harness.scrolls, [])
  for (const type of ['keydown', 'keypress', 'keyup']) assertConsumed(harness.key(type, 'p', { ctrlKey: true }))
  assert.equal(harness.evaluate('vimManager.current.getName()'), 'NORMAL')
  assertConsumed(harness.key('keydown', 'k'))
})

test('holding Ctrl+P toggles passthrough only once per press', () => {
  const harness = createHarness()
  for (const mode of ['PASSTHROUGH', 'NORMAL']) {
    assertConsumed(harness.key('keydown', 'p', { ctrlKey: true }))
    for (let i = 0; i < 3; i++) {
      assertConsumed(harness.key('keydown', 'p', { ctrlKey: true, repeat: true }))
      assert.equal(harness.evaluate('vimManager.current.getName()'), mode)
    }
    assertConsumed(harness.key('keyup', 'p', { ctrlKey: true }))
  }
})

test('losing window focus clears keystrokes whose releases were missed', () => {
  const harness = createHarness()
  assertConsumed(harness.key('keydown', 'k'))
  assertConsumed(harness.key('keydown', 'p', { ctrlKey: true }))
  harness.window.emit('blur')
  for (const type of ['keydown', 'keypress', 'keyup']) assertConsumed(harness.key(type, 'k'), false)
})
