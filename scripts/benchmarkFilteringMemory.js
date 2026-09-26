const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const createFilteringPolicy = require('../main/filtering.js')

const rootDir = path.resolve(__dirname, '..')
const bundledList = path.join(rootDir, 'ext/filterLists/easylist+easyprivacy-noelementhiding.txt')

async function retainedHeap () {
  // Let completed file reads, parser timers and promise continuations unwind.
  await new Promise(resolve => setImmediate(resolve))
  global.gc()
  global.gc()
  return process.memoryUsage().heapUsed
}

function warmMatching (request) {
  // Exercise separator caches as well as list storage. Read only bundled data,
  // never the user's custom filters/profile, and issue no network requests.
  const text = fs.readFileSync(bundledList, 'utf8')
  let requests = 0
  let blocked = 0
  for (const match of text.matchAll(/^\|\|([a-z0-9.-]+)\^/gm)) {
    request({
      requestHeaders: {},
      resourceType: 'script',
      url: `https://${match[1]}/resource.js`
    }, result => { if (result.cancel) blocked++ })
    requests++
  }
  return { requests, blocked }
}

async function main () {
  if (!global.gc) throw new Error('Run with node --expose-gc scripts/benchmarkFilteringMemory.js')

  let setFiltering
  let request
  const configuration = blockingLevel => ({ blockingLevel, contentTypes: [], exceptionDomains: [] })
  const policy = createFilteringPolicy({
    app: { getPath: () => rootDir },
    fs: {
      readFile: function (filename, encoding, callback) {
        if (path.basename(filename) === 'customFilters.txt') callback(null, '')
        else fs.readFile(filename, encoding, callback)
      }
    },
    path,
    rootDir,
    settings: {
      get: () => 0,
      listen: function (key, listener) {
        setFiltering = listener
        listener(configuration(0))
      },
      set: function () {}
    },
    webContents: {}
  })
  policy.install({ webRequest: { onBeforeRequest: handler => { request = handler } } })

  try {
    const baselineHeapBytes = await retainedHeap()
    const cycles = []
    let previousWorkload
    for (let cycle = 1; cycle <= 3; cycle++) {
      const start = performance.now()
      setFiltering(configuration(2))
      await policy.whenReady()
      const loadMs = Number((performance.now() - start).toFixed(2))
      const matchStart = performance.now()
      const workload = warmMatching(request)
      const matchingMs = Number((performance.now() - matchStart).toFixed(2))
      assert.ok(workload.blocked > 0)
      if (previousWorkload) assert.deepEqual(workload, previousWorkload)
      previousWorkload = workload
      const enabledHeapBytes = await retainedHeap()

      setFiltering(configuration(0))
      await policy.whenReady()
      const disabledHeapBytes = await retainedHeap()
      cycles.push({
        cycle,
        loadMs,
        matchingMs,
        ...workload,
        enabledHeapBytes,
        disabledHeapBytes,
        releasedHeapBytes: enabledHeapBytes - disabledHeapBytes,
        disabledGrowthBytes: disabledHeapBytes - baselineHeapBytes
      })
    }
    console.log(JSON.stringify({
      node: process.version,
      electron: process.versions.electron || null,
      note: 'Post-GC JavaScript heap only; not peak memory, Electron process RSS, or whole-app savings.',
      baselineHeapBytes,
      cycles
    }, null, 2))
  } finally {
    policy.destroy()
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
