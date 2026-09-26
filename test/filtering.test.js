const assert = require('node:assert/strict')
const fs = require('node:fs')
const test = require('node:test')
const vm = require('node:vm')

const createFilteringPolicy = require('../main/filtering.js')
const parser = require('../ext/abp-filter-parser-modified/abp-filter-parser.js')

function withParser (parser) {
  const context = vm.createContext({
    clearInterval,
    module: { exports: {} },
    performance,
    require: () => parser,
    setInterval
  })
  vm.runInContext(fs.readFileSync(require.resolve('../main/filtering.js'), 'utf8'), context)
  return context.module.exports
}

function deferredParser () {
  const loads = []
  return {
    loads,
    parser: {
      ...parser,
      parse: function (input, data, callback, options) {
        loads.push({
          shouldCancel: options.shouldCancel,
          finish: function () {
            // Even a completed obsolete build must never be published.
            parser.parse(input, data, null, { async: false })
            callback()
          }
        })
      }
    }
  }
}

function createPolicy (filteringSettings = {}, options = {}) {
  let requestHandler
  let settingsListener
  let timerCancelled = false
  const values = {
    filteringBlockedCount: 0
  }
  const create = options.parser ? withParser(options.parser) : createFilteringPolicy
  const policy = create({
    app: { getPath: () => '/profile' },
    cancelInterval: () => { timerCancelled = true },
    fs: {
      readFile: function (filePath, encoding, callback) {
        if (options.readFile) {
          options.readFile(filePath, callback)
          return
        }
        const error = null
        callback(error, filePath.includes('easylist+') ? 'blocked-resource' : '')
      }
    },
    observePerformance: true,
    path: require('node:path'),
    rootDir: '/application',
    scheduleInterval: () => ({ unref: function () {} }),
    settings: {
      get: key => values[key],
      listen: function (key, listener) {
        settingsListener = listener
        listener({
          blockingLevel: 2,
          contentTypes: [],
          exceptionDomains: [],
          ...filteringSettings
        })
      },
      set: function (key, value) {
        values[key] = value
      }
    },
    webContents: {
      fromId: () => ({ getURL: () => 'https://page.example/' })
    }
  })
  policy.install({
    webRequest: {
      onBeforeRequest: handler => { requestHandler = handler }
    }
  })
  return {
    destroy: function () {
      policy.destroy()
      assert.equal(timerCancelled, true)
    },
    policy,
    request: function (url, overrides = {}) {
      return new Promise(function (resolve) {
        requestHandler({
          requestHeaders: {},
          resourceType: 'xhr',
          url,
          webContentsId: 1,
          ...overrides
        }, resolve)
      })
    },
    setFiltering: settingsListener
  }
}

test('filtering waits for its complete list and reports aggregate request work', async function (t) {
  const runtime = createPolicy()
  t.after(runtime.destroy)
  await runtime.policy.whenReady()

  const ordinary = await runtime.request('https://asset.example/ordinary-resource')
  const tracked = await runtime.request('https://asset.example/resource?fbclid=private&keep=value')
  const blocked = await runtime.request('https://asset.example/blocked-resource')

  assert.equal(ordinary.cancel, false)
  assert.equal(ordinary.redirectURL, undefined)
  assert.equal(tracked.cancel, false)
  assert.equal(tracked.redirectURL, 'https://asset.example/resource?keep=value')
  assert.equal(blocked.cancel, true)

  assert.deepEqual(runtime.policy.getPerformanceSnapshot(), {
    filterChecks: 3,
    filterListLoadCount: 1,
    filterListReadyMs: runtime.policy.getPerformanceSnapshot().filterListReadyMs,
    filterMatches: 1,
    maximumRequestMs: runtime.policy.getPerformanceSnapshot().maximumRequestMs,
    requestCount: 3,
    totalRequestMs: runtime.policy.getPerformanceSnapshot().totalRequestMs,
    trackingParamAttempts: 3,
    trackingParamFastPaths: 2,
    trackingParamParses: 1,
    trackingRedirects: 1
  })
})

test('filtering exceptions bypass matching and tracking cleanup', async function (t) {
  const runtime = createPolicy({ exceptionDomains: ['www.page.example'] })
  t.after(runtime.destroy)
  await runtime.policy.whenReady()

  const result = await runtime.request('https://asset.example/blocked-resource?fbclid=private')

  assert.equal(result.cancel, false)
  assert.equal(result.redirectURL, undefined)
  assert.equal(runtime.policy.getPerformanceSnapshot().filterChecks, 0)
  assert.equal(runtime.policy.getPerformanceSnapshot().trackingParamAttempts, 0)
})

test('disabled filtering releases the old list and re-enabling waits for every source', async function (t) {
  let activeRule = 'first-resource'
  let deferredReads = null
  const runtime = createPolicy({}, {
    readFile: function (filePath, callback) {
      const complete = function () {
        const error = null
        callback(error, filePath.includes('easylist+') ? activeRule : '')
      }
      if (deferredReads) deferredReads.push(complete)
      else complete()
    }
  })
  t.after(runtime.destroy)
  await runtime.policy.whenReady()

  assert.equal((await runtime.request('https://asset.example/first-resource')).cancel, true)

  runtime.setFiltering({ blockingLevel: 0, contentTypes: [], exceptionDomains: [] })
  assert.equal((await runtime.request('https://asset.example/first-resource')).cancel, false)
  activeRule = 'replacement-resource'
  deferredReads = []
  runtime.setFiltering({ blockingLevel: 2, contentTypes: [], exceptionDomains: [] })
  const replacementReady = runtime.policy.whenReady()

  assert.equal((await runtime.request('https://asset.example/first-resource')).cancel, false)
  assert.equal((await runtime.request('https://asset.example/replacement-resource')).cancel, false)

  deferredReads[0]()
  deferredReads[1]()
  assert.equal((await runtime.request('https://asset.example/replacement-resource')).cancel, false)
  deferredReads[2]()
  await replacementReady

  assert.equal((await runtime.request('https://asset.example/first-resource')).cancel, false)
  assert.equal((await runtime.request('https://asset.example/replacement-resource')).cancel, true)
})

test('disabled tracker filtering needs no list but still blocks configured content types', async function (t) {
  const runtime = createPolicy({ blockingLevel: 0, contentTypes: ['image'] }, {
    readFile: () => assert.fail('disabled filtering read a list')
  })
  t.after(runtime.destroy)
  await runtime.policy.whenReady()

  assert.equal((await runtime.request('https://asset.example/image', { resourceType: 'image' })).cancel, true)
  const result = await runtime.request('https://asset.example/resource?fbclid=value')
  assert.equal(result.cancel, false)
  assert.equal(result.redirectURL, undefined)
  assert.equal(runtime.policy.filterPopups('https://asset.example/popup'), true)
})

test('disabling during reads skips parsing and keeps old waiters settleable', async function (t) {
  const reads = []
  const runtime = createPolicy({}, {
    parser: { ...parser, parse: () => assert.fail('obsolete reads were parsed') },
    readFile: (filename, callback) => reads.push(callback)
  })
  t.after(runtime.destroy)
  const pendingReady = runtime.policy.whenReady()
  runtime.setFiltering({ blockingLevel: 0, contentTypes: [], exceptionDomains: [] })
  await runtime.policy.whenReady()

  reads.forEach(callback => callback(null, 'obsolete-resource'))
  await pendingReady
  assert.equal((await runtime.request('https://asset.example/obsolete-resource')).cancel, false)
})

test('disable/re-enable cancels an in-flight parser and never publishes its late result', async function (t) {
  const deferred = deferredParser()
  let rule = 'obsolete-resource'
  const runtime = createPolicy({}, {
    parser: deferred.parser,
    readFile: (filename, callback) => callback(null, rule)
  })
  t.after(runtime.destroy)
  const obsoleteReady = runtime.policy.whenReady()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(deferred.loads.length, 1)
  assert.equal(deferred.loads[0].shouldCancel(), false)

  runtime.setFiltering({ blockingLevel: 0, contentTypes: [], exceptionDomains: [] })
  assert.equal(deferred.loads[0].shouldCancel(), true)
  rule = 'replacement-resource'
  runtime.setFiltering({ blockingLevel: 2, contentTypes: [], exceptionDomains: [] })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(deferred.loads.length, 2)
  assert.equal(deferred.loads[1].shouldCancel(), false)
  deferred.loads[1].finish()
  await runtime.policy.whenReady()
  deferred.loads[0].finish()
  await obsoleteReady

  assert.equal((await runtime.request('https://asset.example/obsolete-resource')).cancel, false)
  assert.equal((await runtime.request('https://asset.example/replacement-resource')).cancel, true)
})

test('destroy cancels parsing and ignores subsequent settings changes', async function () {
  const deferred = deferredParser()
  const runtime = createPolicy({}, { parser: deferred.parser })
  const pendingReady = runtime.policy.whenReady()
  await new Promise(resolve => setImmediate(resolve))
  runtime.destroy()
  assert.equal(deferred.loads[0].shouldCancel(), true)
  await runtime.policy.whenReady()
  deferred.loads[0].finish()
  await pendingReady

  runtime.setFiltering({ blockingLevel: 0, contentTypes: [], exceptionDomains: [] })
  runtime.setFiltering({ blockingLevel: 2, contentTypes: [], exceptionDomains: [] })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(deferred.loads.length, 1)
  assert.equal((await runtime.request('https://asset.example/blocked-resource')).cancel, false)
})

test('switching active levels reuses the list and preserves popup and exception handling', async function (t) {
  const runtime = createPolicy({}, {
    readFile: (filename, callback) => callback(null, 'blocked-resource\npopup-resource$popup')
  })
  t.after(runtime.destroy)
  await runtime.policy.whenReady()
  runtime.setFiltering({ blockingLevel: 1, contentTypes: [], exceptionDomains: [] })
  assert.equal((await runtime.request('https://asset.example/blocked-resource')).cancel, true)
  assert.equal((await runtime.request('https://page.example/blocked-resource')).cancel, false)
  runtime.setFiltering({ blockingLevel: 2, contentTypes: [], exceptionDomains: [] })
  assert.equal(runtime.policy.filterPopups('https://asset.example/popup-resource'), false)
  runtime.setFiltering({ blockingLevel: 2, contentTypes: [], exceptionDomains: ['asset.example'] })
  assert.equal(runtime.policy.filterPopups('https://asset.example/popup-resource'), true)
  assert.equal(runtime.policy.getPerformanceSnapshot().filterListLoadCount, 1)
})
