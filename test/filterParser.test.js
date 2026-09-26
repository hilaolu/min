const assert = require('node:assert/strict')
const fs = require('node:fs')
const test = require('node:test')
const vm = require('node:vm')

function harness () {
  const timers = []
  const context = vm.createContext({
    exports: {},
    setTimeout: callback => timers.push(callback)
  })
  vm.runInContext(fs.readFileSync(require.resolve('../ext/abp-filter-parser-modified/abp-filter-parser.js'), 'utf8'), context)
  return { context, parser: context.exports, timers }
}

const options = { domain: 'page.example', elementType: 'script' }

test('list-local separator caches preserve hosts, wildcards, anchors and exceptions', function () {
  const { parser } = harness()
  const data = {}
  parser.parse([
    '||tracker.example^',
    '@@||tracker.example/allowed^',
    '/collect^pixel',
    '/wild^first*last^end',
    '|https://asset.example/start',
    '/finish.js|',
    '|https://asset.example/exact|'
  ].join('\n'), data, null, { async: false })

  const cases = [
    ['https://tracker.example/resource', true],
    ['https://sub.tracker.example/resource', true],
    ['https://nottracker.example/resource', false],
    ['https://tracker.example/allowed/resource', false],
    ['https://tracker.example/allowedness/resource', true],
    ['https://asset.example/collect/pixel', true],
    ['https://asset.example/collectXpixel', false],
    ['https://asset.example/wild/first-middle-last/end', true],
    ['https://asset.example/wildXfirst-middle-last/end', false],
    ['https://asset.example/wild/first-middle-lastXend', false],
    ['https://asset.example/start/more', true],
    ['https://asset.example/finish.js', true],
    ['https://asset.example/finish.js/more', false],
    ['https://asset.example/exact', true],
    ['https://asset.example/exact/more', false]
  ]
  for (let pass = 0; pass < 2; pass++) {
    for (const [url, expected] of cases) assert.equal(parser.matches(data, url, options), expected, url)
  }
})

test('separator caches belong weakly to each list, not to process-wide strings', function () {
  const { context, parser } = harness()
  const first = {}
  const second = {}
  parser.parse('||tracker.example^\n@@||tracker.example/allowed^', first, null, { async: false })
  parser.parse('||other.example^', second, null, { async: false })
  assert.equal(parser.matches(first, 'https://tracker.example/allowed/resource', options), false)
  assert.equal(parser.matches(second, 'https://other.example/resource', options), true)

  assert.equal(vm.runInContext('filterArrCache instanceof WeakMap', context), true)
  const firstCache = context.filterArrCache.get(first)
  const exceptionCache = context.filterArrCache.get(first.exceptionFilters)
  const secondCache = context.filterArrCache.get(second)
  assert.deepEqual(Array.from(firstCache.keys()), ['tracker.example^'])
  assert.deepEqual(Array.from(exceptionCache.keys()), ['tracker.example/allowed^'])
  assert.deepEqual(Array.from(secondCache.keys()), ['other.example^'])
  assert.notEqual(firstCache, secondCache)
  const parts = firstCache.get('tracker.example^')
  parser.matches(first, 'https://tracker.example/blocked', options)
  assert.equal(firstCache.get('tracker.example^'), parts)
})

function largeList () {
  return Array.from({ length: 2000 }, (_, index) => `||tracker-${index}.example^`).join('\n')
}

function hostRuleCount (data) {
  return Object.values(data.hostAnchored).reduce((count, rules) => count + rules.length, 0)
}

test('cancelled chunked parsing stops allocating rules and settles exactly once', function () {
  const { parser, timers } = harness()
  const data = {}
  let cancelled = false
  let completions = 0
  parser.parse(largeList(), data, () => { completions++ }, { shouldCancel: () => cancelled })
  assert.equal(hostRuleCount(data), 1500)
  assert.equal(timers.length, 1)
  cancelled = true
  timers.shift()()
  assert.equal(hostRuleCount(data), 1500)
  assert.equal(data.initialized, undefined)
  assert.equal(completions, 1)
  assert.equal(timers.length, 0)
})

test('cancellation before parsing skips both synchronous and asynchronous work', function () {
  const { parser, timers } = harness()
  for (const async of [false, true]) {
    const data = {}
    let completions = 0
    parser.parse(largeList(), data, () => { completions++ }, { async, shouldCancel: () => true })
    assert.equal(hostRuleCount(data), 0)
    assert.equal(data.initialized, undefined)
    // The existing synchronous API does not invoke callbacks.
    assert.equal(completions, async ? 1 : 0)
  }
  assert.equal(timers.length, 0)
})

test('uncancelled chunked parsing publishes all rules before its callback', function () {
  const { parser, timers } = harness()
  const data = {}
  let completions = 0
  parser.parse(largeList(), data, () => {
    completions++
    assert.equal(data.initialized, true)
    assert.equal(hostRuleCount(data), 2000)
  }, { shouldCancel: () => false })
  while (timers.length) timers.shift()()
  assert.equal(completions, 1)
  assert.equal(parser.matches(data, 'https://tracker-1999.example/resource', options), true)
})
