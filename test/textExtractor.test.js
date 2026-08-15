const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

const { extractPageText, getPageData } = require('../js/preload/textExtractor.js')

function text (value) {
  return { nodeType: 3, textContent: value }
}

function element (children = [], options = {}) {
  return {
    childNodes: children,
    getClientRects: () => [],
    matches: () => options.ignored === true,
    nodeType: 1,
    offsetHeight: options.hidden ? 0 : 1,
    offsetWidth: 0
  }
}

function documentFixture (children, description) {
  return {
    body: { childNodes: children },
    head: {
      querySelector: () => description ? { content: description } : null
    },
    querySelectorAll: () => []
  }
}

test('text extraction preserves document order and ignore and visibility rules', function () {
  const doc = documentFixture([
    element([text('first')]),
    { childNodes: [], nodeType: 8, textContent: 'comment' },
    element([text('ignored')], { ignored: true }),
    element([text('hidden')], { hidden: true }),
    element([element([text('second\n\tvalue')])])
  ], 'description')

  assert.equal(extractPageText(doc, {}), 'first second value description')
})

test('text extraction stops visiting and enqueueing nodes when the character budget is met', function () {
  const metrics = {}
  const children = [text('0123456789')]
  for (let index = 0; index < 10000; index++) children.push(element([text(`unused ${index}`)]))

  const result = extractPageText(documentFixture(children), {}, 10, metrics)

  assert.equal(result, '0123456789')
  assert.equal(metrics.nodesVisited, 1)
  assert.equal(metrics.stackPushes, 1)
})

test('text extraction handles deep trees without recursion or front-of-array operations', function () {
  let root = text('deep result')
  for (let index = 0; index < 20000; index++) root = element([root])
  const metrics = {}

  assert.equal(extractPageText(documentFixture([root]), {}, 100, metrics), 'deep result')
  assert.equal(metrics.nodesVisited, 20001)
  assert.equal(metrics.stackPushes, 20001)
})

test('page data shares its character budget with same-origin frames and contains cross-origin failures', async function () {
  const originalDocument = global.document
  const originalRequestIdleCallback = global.requestIdleCallback
  const mainDocument = documentFixture([text('main text')])
  const frameDocument = documentFixture([text('frame text')])
  const crossOriginFrame = {}
  Object.defineProperty(crossOriginFrame, 'contentDocument', {
    get: () => { throw new Error('cross origin') }
  })
  mainDocument.querySelectorAll = () => [
    { contentDocument: frameDocument },
    crossOriginFrame
  ]
  global.document = mainDocument
  global.requestIdleCallback = work => work({ timeRemaining: () => 10 })

  try {
    const result = await getPageData()
    assert.equal(result.extractedText, 'main text. frame text')
  } finally {
    global.document = originalDocument
    global.requestIdleCallback = originalRequestIdleCallback
  }
})

function loadExtractionRuntime (argv) {
  const listeners = {}
  const ipcListeners = {}
  const messages = []
  const timers = []
  const cancelledTimers = new Set()
  const runtimeWindow = {
    addEventListener: (name, listener) => { listeners[name] = listener },
    location: { href: 'https://example.com' }
  }
  const context = vm.createContext({
    clearTimeout: id => cancelledTimers.add(id),
    document: documentFixture([text('page body')]),
    electron: { webFrame: { executeJavaScript: function () {} } },
    ipc: {
      on: (name, listener) => { ipcListeners[name] = listener },
      send: (name, data) => messages.push([name, data])
    },
    module: { exports: {} },
    process: { argv, isMainFrame: true },
    Promise,
    requestIdleCallback: work => work({ timeRemaining: () => 10 }),
    setTimeout: (work, delay) => {
      const id = timers.length
      timers.push({ delay, work })
      return id
    },
    window: runtimeWindow
  })
  const source = fs.readFileSync(path.resolve(__dirname, '../js/preload/textExtractor.js'), 'utf8')
  vm.runInContext(source, context, { filename: 'textExtractor.js' })
  return { cancelledTimers, ipcListeners, listeners, messages, timers }
}

test('rapid navigation extraction requests coalesce and private Tabs never start extraction', async function () {
  const runtime = loadExtractionRuntime([])
  runtime.listeners.load()
  runtime.listeners.load()
  runtime.listeners.load()
  for (let index = 0; index < runtime.timers.length; index++) {
    if (!runtime.cancelledTimers.has(index)) await runtime.timers[index].work()
  }
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(runtime.messages.filter(message => message[0] === 'pageData').length, 1)

  const privateRuntime = loadExtractionRuntime(['--min-indexing-disabled'])
  privateRuntime.listeners.load()
  assert.equal(privateRuntime.timers.filter(timer => timer.delay === 500).length, 0)
})

test('stale indexing configuration cannot roll back the active navigation generation', async function () {
  const runtime = loadExtractionRuntime([])
  runtime.ipcListeners['page-navigation-generation']({}, 2)
  runtime.ipcListeners['page-indexing-config']({}, { enabled: true, navigationGeneration: 1 })
  runtime.listeners.load()

  for (let index = 0; index < runtime.timers.length; index++) {
    if (!runtime.cancelledTimers.has(index)) await runtime.timers[index].work()
  }
  await Promise.resolve()

  const pageData = runtime.messages.find(message => message[0] === 'pageData')
  assert.equal(pageData[1].navigationGeneration, 2)
})
