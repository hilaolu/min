const assert = require('node:assert/strict')
const test = require('node:test')

const createFilteringPolicy = require('../main/filtering.js')

function createPolicy (filteringSettings = {}, options = {}) {
  let requestHandler
  let settingsListener
  let timerCancelled = false
  const values = {
    filteringBlockedCount: 0
  }
  const policy = createFilteringPolicy({
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

test('filter-list replacement remains atomic until every source is ready', async function (t) {
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
  activeRule = 'replacement-resource'
  deferredReads = []
  runtime.setFiltering({ blockingLevel: 2, contentTypes: [], exceptionDomains: [] })
  const replacementReady = runtime.policy.whenReady()

  assert.equal((await runtime.request('https://asset.example/first-resource')).cancel, true)
  assert.equal((await runtime.request('https://asset.example/replacement-resource')).cancel, false)

  deferredReads.forEach(complete => complete())
  await replacementReady

  assert.equal((await runtime.request('https://asset.example/first-resource')).cancel, false)
  assert.equal((await runtime.request('https://asset.example/replacement-resource')).cancel, true)
})
