const { performance } = require('node:perf_hooks')
const v8 = require('node:v8')

const BrowserSession = require('../js/tabState/browserSession.js')
const { PlacesCache } = require('../js/places/placesCache.js')
const { extractPageText } = require('../js/preload/textExtractor.js')
const { schemaV1, schemaV2 } = require('../js/util/databaseSchema.js')
const createTaskOverlayHarness = require('../test/fixtures/taskOverlayHarness.js')
const searchbarDeduplicationHarness = require('../test/fixtures/searchbarDeduplicationHarness.js')

global.oneDayInMS = 24 * 60 * 60 * 1000
global.quickScore = { quickScore: () => 0 }
global.calculateHistoryScore = (item, boost = 0) => item.lastVisit * (1 + boost)
global.nonLetterRegex = /[^\s0-9A-Za-z]/g
global.Dexie = { Promise }
const placesSearch = require('../js/places/placesSearch.js')
const fullTextSearch = require('../js/places/fullTextSearch.js')
const tagIndex = require('../js/places/tagIndex.js')
global.tokenize = fullTextSearch.tokenize

function measure (work) {
  const start = performance.now()
  const result = work()
  return { elapsedMs: Number((performance.now() - start).toFixed(2)), result }
}

function measureMedian (work) {
  for (let index = 0; index < 5; index++) work()
  const samples = Array.from({ length: 15 }, () => measure(work).elapsedMs)
  return samples.sort((a, b) => a - b)[Math.floor(samples.length / 2)]
}

function retainedHeap () {
  if (!global.gc) return null
  // Diagnostic heap deltas only, not peak memory or whole-app RSS. A second
  // collection reduces noise from objects promoted during the first one.
  global.gc()
  global.gc()
  return process.memoryUsage().heapUsed
}

function benchmarkFullTextProcessing () {
  const tokenization = [6000, 60000, 300000].map(characters => {
    const text = 'cat dog sun '.repeat(characters / 12)
    let retainedTokens
    const medianMs = measureMedian(() => { retainedTokens = fullTextSearch.tokenize(text).length })
    return { characters, inputWords: characters / 4, retainedTokens, medianMs }
  })
  const diverseText = Array.from({ length: 30000 }, (_, index) => `vocabulary${index % 700}`).join(' ')
  const uniqueText = Array.from({ length: 20000 }, (_, index) => `word${index}`).join(' ')
  const variedTokenization = [
    { name: 'mixed vocabulary', text: diverseText },
    { name: 'unique words', text: uniqueText }
  ].map(({ name, text }) => ({
    name,
    characters: text.length,
    medianMs: measureMedian(() => fullTextSearch.tokenize(text))
  }))
  const snippets = [
    { name: 'no matches', text: 'plain words '.repeat(25000), query: 'alpha beta' },
    { name: 'dense matches', text: 'alpha beta '.repeat(25000), query: 'alpha beta' },
    { name: 'sparse matches', text: ('alpha beta ' + 'plain words '.repeat(100)).repeat(240), query: 'alpha beta' },
    { name: 'mixed vocabulary', text: diverseText, query: 'vocabulary5 vocabulary699' },
    { name: 'unique words', text: uniqueText, query: 'word10 word19999' }
  ].map(({ name, text, query }) => ({
    name,
    characters: text.length,
    medianMs: measureMedian(() => fullTextSearch.createSnippet(text, query))
  }))
  return { tokenization, variedTokenization, snippets }
}

function benchmarkTaskSummaries () {
  return [200, 1000, 5000].flatMap(tabCount => [20, tabCount].map(uniqueFavicons => {
    const tabs = Array.from({ length: tabCount }, (_, index) => ({
      title: `Tab ${index}`,
      lastActivity: (index * 37) % 101,
      favicon: { url: `https://example.com/icon-${index % uniqueFavicons}`, luminance: index % 100 }
    }))
    const { render, metrics } = createTaskOverlayHarness(tabs)
    const medianMs = measureMedian(() => {
      metrics.snapshots = 0
      metrics.sorts = 0
      render()
    })
    return { tabs: tabCount, uniqueFavicons, medianMs, snapshotsPerRender: metrics.snapshots, sortsPerRender: metrics.sorts }
  }))
}

function benchmarkBookmarkTags (itemCount) {
  tagIndex.reset()
  global.historyInMemoryCache = Array.from({ length: itemCount }, (_, id) => ({
    id,
    url: `https://library.example/topic${id % 50}/${id}`,
    title: `Topic${id % 50} category${id % 50} reference guide resource${id % 17}`,
    isBookmarked: id % 11 !== 0,
    tags: id % 3 === 0 ? ['reference'] : [`topic${id % 50}`, `group${id % 5}`],
    lastVisit: id
  }))
  const bookmarks = global.historyInMemoryCache.filter(page => page.isBookmarked)
  const heapBefore = retainedHeap()
  const buildMs = measure(() => bookmarks.forEach(page => tagIndex.addPage(page))).elapsedMs
  const queries = [['topic7'], ['topic7', 'reference'], ['missing']].map(tags => {
    let resultCount
    const firstQueryMs = measure(() => tagIndex.getSuggestedItemsForTags(tags)).elapsedMs
    const medianMs = measureMedian(() => { resultCount = tagIndex.getSuggestedItemsForTags(tags).length })
    return { tags, resultCount, firstQueryMs, medianMs }
  })
  const heapAfter = retainedHeap()
  return {
    historyEntries: itemCount,
    bookmarks: bookmarks.length,
    distinctTags: Object.keys(tagIndex.tagCounts).length,
    buildMs,
    retainedIndexHeapBytes: heapBefore === null ? null : heapAfter - heapBefore,
    queries
  }
}

function benchmarkSearchbarDeduplication (resultCount) {
  const run = searchbarDeduplicationHarness(resultCount)
  const medianMs = measureMedian(run)
  if (run() !== resultCount) throw new Error('Unexpected result count')
  return { resultCount, medianMs }
}

function createPlace (id, bodyLength = 300000) {
  return {
    id,
    url: `https://example.com/${id}`,
    title: `Page ${id}`,
    color: null,
    visitCount: id % 20,
    lastVisit: id,
    isBookmarked: id % 10 === 0,
    tags: id % 10 === 0 ? ['benchmark'] : [],
    extractedText: 'x'.repeat(bodyLength),
    pageHTML: '',
    searchIndex: ['benchmark']
  }
}

function benchmarkPlaces () {
  const tagIndex = { addPage: function () {}, onChange: function () {}, removePage: function () {}, reset: function () {} }
  const cache = new PlacesCache({
    calculateScore: item => item.lastVisit + item.visitCount,
    getSearchTextCache: item => ({ title: item.title.toLowerCase(), url: item.url.toLowerCase() }),
    tagIndex
  })
  const load = measure(function () {
    for (let id = 1; id <= 20000; id++) cache.add(createPlace(id, 0), { sort: false })
    cache.sort()
  })
  const projected = cache.items.slice(0, 100).map(item => cache.getPublicByURL(item.url))
  const bodies = Array.from({ length: 100 }, (_, index) => createPlace(index))
  return {
    load20000Ms: load.elapsedMs,
    projected100Bytes: v8.serialize(projected).byteLength,
    raw100MaximumBodyBytes: v8.serialize(bodies).byteLength
  }
}

function benchmarkOrdinarySearch (itemCount) {
  global.historyInMemoryCache = Array.from({ length: itemCount }, (_, index) => {
    const item = createPlace(index, 0)
    // Mix prefix and title matches so query boosts change the cache's order.
    if (index % 2 === 0) item.url = `https://benchmark.example.com/${index}`
    else item.title = `Benchmark page ${index}`
    const searchText = placesSearch.getSearchTextCache(item)
    item.searchTitle = searchText.title
    item.searchURL = searchText.url
    return item
  }).sort((a, b) => global.calculateHistoryScore(b) - global.calculateHistoryScore(a))
  const score = global.calculateHistoryScore
  let scoreCalculations = 0
  global.calculateHistoryScore = (item, boost) => {
    scoreCalculations++
    return score(item, boost)
  }
  try {
    const searches = [
      { query: 'no-match-query', limit: 4 },
      { query: 'benchmark', limit: 4 },
      { query: 'benchmark', limit: 20 },
      { query: 'benchmark', limit: 1000 },
      { query: '', limit: 100 }
    ].map(({ query, limit }) => {
      let resultCount
      const medianMs = measureMedian(() => {
        scoreCalculations = 0
        placesSearch.searchPlaces(query, results => { resultCount = results.length }, { limit })
      })
      return { query, limit, medianMs, resultCount, scoreCalculations }
    })
    return { summaries: itemCount, searches }
  } finally {
    global.calculateHistoryScore = score
  }
}

function benchmarkPlacesDeletion (itemCount) {
  const ids = Array.from({ length: itemCount / 2 }, (_, index) => index * 2)
  const samples = []
  for (let run = 0; run < 20; run++) {
    const cache = new PlacesCache({
      calculateScore: item => item.lastVisit,
      getSearchTextCache: () => ({}),
      tagIndex: { addPage: function () {}, removePage: function () {} }
    })
    for (let id = 0; id < itemCount; id++) cache.add(createPlace(id, 0), { sort: false })
    const { elapsedMs } = measure(() => cache.removeByIds(ids))
    if (cache.items.length !== itemCount - ids.length) throw new Error('Unexpected deletion count')
    if (run >= 5) samples.push(elapsedMs)
  }
  return { historyEntries: itemCount, deleted: ids.length, medianMs: samples.sort((a, b) => a - b)[7] }
}

function benchmarkSuggestions (itemCount) {
  const tagIndex = { addPage: function () {}, onChange: function () {}, removePage: function () {}, reset: function () {} }
  const cache = new PlacesCache({
    calculateScore: item => item.lastVisit + item.visitCount,
    getSearchTextCache: item => ({ title: item.title.toLowerCase(), url: item.url.toLowerCase() }),
    tagIndex
  })
  for (let id = 1; id <= itemCount; id++) cache.add(createPlace(id, 0), { sort: false })
  cache.sort()
  const metrics = {}
  const timing = measure(() => cache.getRecentPublic({ after: -Infinity, limit: 4, metrics }))
  return { elapsedMs: timing.elapsedMs, summaries: itemCount, ...metrics }
}

function runGenerator (generator) {
  function next (value) {
    const result = generator.next(value)
    if (result.done) return Promise.resolve(result.value)
    return Promise.resolve(result.value).then(next)
  }
  return next()
}

async function benchmarkFullText () {
  const summaries = Array.from({ length: 10000 }, (_, index) => createPlace(index, 0))
  const ids = summaries.map(item => item.id)
  const documents = summaries.slice(-fullTextSearch.getCandidateLimit(4)).map(item => ({
    ...item,
    extractedText: `alpha representative body ${item.id}`,
    searchIndex: ['alpha']
  }))
  global.historyInMemoryCache = summaries
  global.db = {
    places: {
      where: field => ({
        anyOf: requestedIds => ({ toArray: () => Promise.resolve(documents.filter(doc => requestedIds.includes(doc.id))) }),
        equals: () => ({ primaryKeys: () => Promise.resolve(ids) })
      })
    },
    transaction: (mode, table, work) => runGenerator(work())
  }
  const start = performance.now()
  let results
  let metrics
  await fullTextSearch.fullTextPlacesSearch('alpha', function (value, error, valueMetrics) {
    if (error) throw error
    results = value
    metrics = valueMetrics
  }, { limit: 4 })
  return {
    ...metrics,
    elapsedMs: Number((performance.now() - start).toFixed(2)),
    payloadBytes: v8.serialize(results).byteLength
  }
}

function textNode (value) {
  return { nodeType: 3, textContent: value }
}

function element (children) {
  return {
    childNodes: children,
    getClientRects: () => [],
    matches: () => false,
    offsetHeight: 1,
    offsetWidth: 0
  }
}

function benchmarkExtraction () {
  const children = [textNode('x'.repeat(300000))]
  for (let index = 0; index < 20000; index++) children.push(element([textNode('unused')]))
  const metrics = {}
  const result = measure(() => extractPageText({
    body: { childNodes: children },
    head: { querySelector: () => null }
  }, {}, 300000, metrics))
  return {
    elapsedMs: result.elapsedMs,
    extractedCharacters: result.result.length,
    nodesVisited: metrics.nodesVisited,
    stackPushes: metrics.stackPushes
  }
}

function createSnapshot (taskCount, tabsPerTask) {
  return {
    tasks: Array.from({ length: taskCount }, (_, taskIndex) => ({
      id: `task-${taskIndex}`,
      name: null,
      selectedInWindow: taskIndex === 0 ? 'benchmark' : null,
      tabs: Array.from({ length: tabsPerTask }, (_, tabIndex) => ({
        id: `tab-${taskIndex}-${tabIndex}`,
        lastActivity: tabIndex,
        selected: tabIndex === 0,
        url: `https://example.com/${taskIndex}/${tabIndex}`
      }))
    }))
  }
}

function benchmarkRestore (tabCount) {
  const taskCount = Math.max(1, Math.round(tabCount / 100))
  const session = new BrowserSession({ windowId: 'benchmark' })
  const timing = measure(() => session.restoreSnapshot(createSnapshot(taskCount, 100)))
  const persistedSnapshot = measure(() => v8.serialize(session.getPersistedSnapshot()).byteLength)
  const persistenceRevision = session.getPersistenceRevision()
  const idleRevisionChecks = measure(function () {
    for (let index = 0; index < 1000; index++) {
      if (session.getPersistenceRevision() !== persistenceRevision) throw new Error('persistence revision changed')
    }
  })
  return {
    elapsedMs: timing.elapsedMs,
    idleRevisionChecks1000Ms: idleRevisionChecks.elapsedMs,
    indexedTabs: session.tasks.getIndexSnapshot().tabs.length,
    persistedSnapshotBytes: persistedSnapshot.result,
    persistedSnapshotMs: persistedSnapshot.elapsedMs,
    tabs: taskCount * 100,
    tasks: taskCount
  }
}

async function measureStorageSchema (schema, label, bodyLength) {
  const Dexie = require('dexie')
  const { indexedDB, IDBKeyRange } = require('fake-indexeddb')
  Dexie.dependencies.indexedDB = indexedDB
  Dexie.dependencies.IDBKeyRange = IDBKeyRange
  const databaseName = `performance-${label}-${bodyLength}`
  await Dexie.delete(databaseName)
  const database = new Dexie(databaseName)
  database.version(1).stores(schema)
  await database.open()
  const records = Array.from({ length: 10 }, (_, index) => createPlace(index, bodyLength))
  const start = performance.now()
  await database.places.bulkPut(records)
  const writeMs = Number((performance.now() - start).toFixed(2))
  const indexedValueBytes = records.reduce(function (total, record) {
    return total + database.places.schema.indexes.reduce(function (indexTotal, index) {
      return indexTotal + v8.serialize(record[index.name]).byteLength
    }, 0)
  }, 0)
  database.close()
  await Dexie.delete(databaseName)
  return { bodyLength, indexedValueBytes, label, writeMs }
}

async function benchmarkStorage () {
  const results = []
  for (const bodyLength of [1000, 50000, 300000]) {
    results.push(await measureStorageSchema(schemaV1, 'v1', bodyLength))
    results.push(await measureStorageSchema(schemaV2, 'v2', bodyLength))
  }
  return results
}

async function main () {
  const report = {
    runtime: { node: process.versions.node, electron: process.versions.electron, v8: process.versions.v8 },
    bookmarkTags: [1000, 5000].map(benchmarkBookmarkTags),
    browserSessionRestore: [1000, 10000, 20000].map(benchmarkRestore),
    extraction: benchmarkExtraction(),
    fullText: await benchmarkFullText(),
    fullTextProcessing: benchmarkFullTextProcessing(),
    ordinarySearch: [1000, 10000, 20000].map(benchmarkOrdinarySearch),
    placesDeletion: [1000, 20000].map(benchmarkPlacesDeletion),
    placeSuggestions: [1000, 10000, 20000].map(benchmarkSuggestions),
    places: benchmarkPlaces(),
    searchbarDeduplicationCPUOnly: [10, 30, 1000].map(benchmarkSearchbarDeduplication),
    storage: await benchmarkStorage(),
    taskSummaryCPUOnly: benchmarkTaskSummaries()
  }

  console.log(JSON.stringify(report, null, 2))
}

main().catch(function (error) {
  console.error(error)
  process.exitCode = 1
})
