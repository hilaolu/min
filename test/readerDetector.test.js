const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

const source = fs.readFileSync(path.join(__dirname, '../js/preload/readerDetector.js'), 'utf8')

function loadDetector ({ mainFrame = true, paragraphCount = 5, textLength = 300 } = {}) {
  const listeners = {}
  const messages = []
  const metrics = { scans: 0, textReads: 0 }
  const parentNode = {}
  const paragraphs = Array.from({ length: paragraphCount }, () => ({
    parentNode,
    get textContent () { metrics.textReads++; return 'x'.repeat(textLength) }
  }))
  const document = {
    readyState: 'loading',
    addEventListener: (name, fn) => { listeners[name] = fn },
    querySelectorAll: () => { metrics.scans++; return paragraphs },
    querySelector: () => null
  }
  vm.runInNewContext(source, {
    document,
    window: { addEventListener: (name, fn) => { listeners[name] = fn } },
    process: { isMainFrame: mainFrame },
    ipc: { send: channel => messages.push(channel) }
  }, { filename: 'readerDetector.js' })
  return {
    document,
    listeners,
    messages,
    metrics,
    interactive: () => { document.readyState = 'interactive'; listeners.readystatechange() }
  }
}

test('positive reader detection scans a large document and notifies only once', function () {
  const detector = loadDetector({ paragraphCount: 25000 })
  detector.interactive()
  detector.listeners.load()
  assert.deepEqual(detector.messages, ['canReader'])
  assert.deepEqual(detector.metrics, { scans: 1, textReads: 25000 })
})

test('negative interactive detection is retried when deferred content arrives', function () {
  const detector = loadDetector()
  detector.document.querySelectorAll = () => []
  detector.interactive()
  assert.deepEqual(detector.messages, [])
  detector.document.querySelectorAll = () => [{ parentNode: {}, textContent: 'article '.repeat(200) }]
  detector.listeners.load()
  assert.deepEqual(detector.messages, ['canReader'])
})

test('negative pages retry at load, and new documents do not inherit positive status', function () {
  const positive = loadDetector()
  positive.interactive()
  const negative = loadDetector({ textLength: 10 })
  negative.interactive()
  negative.listeners.load()
  assert.deepEqual(negative.metrics, { scans: 2, textReads: 10 })
  assert.deepEqual(negative.messages, [])
  const next = loadDetector()
  next.interactive()
  next.listeners.load()
  assert.deepEqual(next.messages, ['canReader'])
})

test('reader detection ignores non-interactive ready states and subframes', function () {
  const detector = loadDetector()
  detector.listeners.readystatechange()
  detector.document.readyState = 'complete'
  detector.listeners.readystatechange()
  assert.equal(detector.metrics.scans, 0)
  assert.deepEqual(loadDetector({ mainFrame: false }).listeners, {})
})
