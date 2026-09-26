const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { PlacesCache, projectPlace, publicPlaceFields } = require('../js/places/placesCache.js')
const { getSearchTextCache } = require('../js/places/placesSearch.js')
const tagIndex = require('../js/places/tagIndex.js')

global.nonLetterRegex = /[^\s0-9A-Za-z]/g
global.tokenize = require('../js/places/fullTextSearch.js').tokenize

// Only the summary layout differs. Arrays, URL/ID maps, bookmark indexes,
// normalization, projection and sorting all use the production implementation.
class NestedPlacesCache extends PlacesCache {
  createSummary (item) {
    const summary = projectPlace(item)
    summary.searchTextCache = this.getSearchTextCache(summary)
    return summary
  }
}

function calculateScore (item, boost = 0) {
  return item.lastVisit * (1 + boost)
}

function createPlace (id) {
  return {
    id,
    url: `https://www.${id % 2 === 0 ? 'needle' : 'library'}.example/Café/record${id}?ignored=yes`,
    title: `Café+Reference ${id} group${id % 23}`,
    color: null,
    visitCount: id % 20,
    lastVisit: id + 1,
    isBookmarked: id % 10 === 0,
    tags: id % 10 === 0 ? ['archive', `group${id % 23}`] : []
  }
}

function retainedHeap () {
  global.gc()
  global.gc()
  return process.memoryUsage().heapUsed
}

function populate (Cache, count) {
  const cache = new Cache({ calculateScore, getSearchTextCache, tagIndex })
  for (let id = 0; id < count; id++) cache.add(createPlace(id), { sort: false })
  cache.sort()
  return cache
}

function verify (cache, layout, count) {
  const publicHash = createHash('sha256')
  const normalizedHash = createHash('sha256')
  for (const item of cache.items) {
    assert.equal(cache.getById(item.id), item)
    assert.equal(cache.getByURL(item.url), item)
    const projected = projectPlace(item)
    assert.deepEqual(Object.keys(projected), publicPlaceFields)
    assert.deepEqual(projected, createPlace(item.id))
    const normalized = layout === 'nested'
      ? item.searchTextCache
      : { title: item.searchTitle, url: item.searchURL }
    assert.deepEqual(normalized, getSearchTextCache(projected))
    assert.equal('searchTextCache' in item, layout === 'nested')
    assert.equal('searchTitle' in item, layout === 'inline')
    assert.equal('searchURL' in item, layout === 'inline')
    publicHash.update(JSON.stringify(projected) + '\n')
    normalizedHash.update(JSON.stringify(normalized) + '\n')
  }

  // Run the same search logic against both layouts, adapting only field reads
  // for the old representation. Verification allocations occur AFTER measuring.
  let source = fs.readFileSync(path.join(__dirname, '../js/places/placesSearch.js'), 'utf8')
  if (layout === 'nested') {
    source = source.replaceAll('item.searchURL', 'item.searchTextCache.url')
      .replaceAll('item.searchTitle', 'item.searchTextCache.title')
  }
  const context = vm.createContext({
    window: {},
    historyInMemoryCache: cache.items,
    calculateHistoryScore: calculateScore,
    oneDayInMS: 86400000,
    quickScore: require('quick-score')
  })
  vm.runInContext(source, context)
  const searches = [
    { query: '', limit: count, expectedCount: count },
    { query: 'cafe reference', limit: count, expectedCount: count },
    { query: 'archive', limit: count, searchBookmarks: true, expectedCount: count / 10 },
    { query: 'record0', limit: 4, searchBookmarks: true, expectedCount: 1 },
    { query: 'needle', limit: 4, expectedCount: 4 },
    { query: 'reference cafe', limit: 20, expectedCount: 20 },
    { query: 'missing query', limit: 100, expectedCount: 0 }
  ].map(({ query, expectedCount, ...options }) => {
    let results
    context.window.searchPlaces(query, value => { results = Array.from(value) }, options)
    assert.equal(results.length, expectedCount)
    assert.equal(new Set(results.map(item => item.id)).size, expectedCount)
    if (query === 'record0') assert.equal(results[0].id, 0)
    if (expectedCount === count) assert.deepEqual(results.map(item => item.id), cache.items.map(item => item.id))
    const hash = createHash('sha256')
    for (const item of results) hash.update(JSON.stringify(projectPlace(item)) + '\n')
    return { query, ...options, results: results.length, digest: hash.digest('hex') }
  })
  return { publicDigest: publicHash.digest('hex'), normalizedDigest: normalizedHash.digest('hex'), searches }
}

async function child (layout, count) {
  assert.ok(global.gc, 'Run with --expose-gc')
  assert.ok(['nested', 'inline'].includes(layout))
  assert.ok([20000, 100000].includes(count))
  tagIndex.reset()
  const before = retainedHeap()
  const cache = populate(layout === 'nested' ? NestedPlacesCache : PlacesCache, count)
  global.historyInMemoryCache = cache.items
  // Let construction frames and temporary normalization objects become dead.
  await new Promise(resolve => setImmediate(resolve))
  const heapDeltaBytes = retainedHeap() - before
  const retained = {
    summaries: cache.items.length,
    byURL: cache.byURL.size,
    byId: cache.byId.size,
    indexedBookmarks: tagIndex.totalDocs,
    normalizedStrings: cache.items.length * 2
  }
  assert.deepEqual(retained, { summaries: count, byURL: count, byId: count, indexedBookmarks: count / 10, normalizedStrings: count * 2 })
  console.log(JSON.stringify({ layout, heapDeltaBytes, retained, verification: verify(cache, layout, count) }))
}

function runChild (layout, count) {
  const result = spawnSync(process.execPath, ['--expose-gc', __filename, '--child', layout, String(count)], {
    // In particular, preserve ELECTRON_RUN_AS_NODE=1 when using Electron's Node.
    env: process.env,
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 1024 * 1024
  })
  assert.ifError(result.error)
  assert.equal(result.status, 0, `${layout}/${count}: ${result.stderr}`)
  return JSON.parse(result.stdout)
}

function median (samples) {
  return samples.slice().sort((a, b) => a - b)[Math.floor(samples.length / 2)]
}

function main () {
  const cases = [20000, 100000].map(count => {
    const samples = { nested: [], inline: [] }
    let reference
    for (let run = 0; run < 3; run++) {
      for (const layout of ['nested', 'inline']) {
        const result = runChild(layout, count)
        const equivalence = { retained: result.retained, verification: result.verification }
        if (!reference) reference = equivalence
        else assert.deepEqual(equivalence, reference, 'Layouts must retain and return identical public fields and ordered results')
        samples[layout].push(result.heapDeltaBytes)
      }
    }
    const baselineBytes = median(samples.nested)
    const inlineBytes = median(samples.inline)
    return {
      count,
      samples,
      baselineBytes,
      inlineBytes,
      savedBytes: baselineBytes - inlineBytes,
      savedPercent: Number((100 * (baselineBytes - inlineBytes) / baselineBytes).toFixed(2)),
      ...reference
    }
  })
  console.log(JSON.stringify({
    runtime: { node: process.versions.node, electron: process.versions.electron, v8: process.versions.v8 },
    metric: 'Median post-GC heapUsed delta in bytes; three fresh subprocesses per layout/count; not RSS',
    cases
  }, null, 2))
  assert.ok(cases.every(result => result.savedBytes > 0), 'Inline layout must reduce heap in BOTH cases')
}

if (process.argv[2] === '--child') {
  child(process.argv[3], Number(process.argv[4])).catch(error => {
    console.error(error)
    process.exitCode = 1
  })
} else {
  main()
}
