const { performance } = require('node:perf_hooks')
const v8 = require('node:v8')

const BrowserSession = require('../js/tabState/browserSession.js')
const { PlacesCache } = require('../js/places/placesCache.js')
const { extractPageText } = require('../js/preload/textExtractor.js')
const { schemaV1, schemaV2 } = require('../js/util/databaseSchema.js')

global.oneDayInMS = 24 * 60 * 60 * 1000
global.quickScore = { quickScore: () => 0 }
global.calculateHistoryScore = (item, boost = 0) => item.lastVisit * (1 + boost)
global.nonLetterRegex = /[^\s0-9A-Za-z]/g
global.Dexie = { Promise }
const placesSearch = require('../js/places/placesSearch.js')
const fullTextSearch = require('../js/places/fullTextSearch.js')

function measure (work) {
  const start = performance.now()
  const result = work()
  return { elapsedMs: Number((performance.now() - start).toFixed(2)), result }
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
    item.searchTextCache = placesSearch.getSearchTextCache(item)
    return item
  })
  const timing = measure(function () {
    placesSearch.searchPlaces('no-match-query', function () {}, { limit: 4 })
  })
  return { elapsedMs: timing.elapsedMs, summaries: itemCount }
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
  return {
    elapsedMs: timing.elapsedMs,
    indexedTabs: session.tasks.getIndexSnapshot().tabs.length,
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
    browserSessionRestore: [1000, 10000, 20000].map(benchmarkRestore),
    extraction: benchmarkExtraction(),
    fullText: await benchmarkFullText(),
    ordinarySearch: [1000, 10000, 20000].map(benchmarkOrdinarySearch),
    places: benchmarkPlaces(),
    storage: await benchmarkStorage()
  }

  console.log(JSON.stringify(report, null, 2))
}

main().catch(function (error) {
  console.error(error)
  process.exitCode = 1
})
