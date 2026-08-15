const assert = require('node:assert/strict')
const test = require('node:test')
const v8 = require('node:v8')

const { PlacesCache } = require('../js/places/placesCache.js')

function createCache () {
  const events = []
  const tagIndex = {
    addPage: item => events.push(['add', item.url]),
    onChange: (before, after) => events.push(['change', before.url, after.url]),
    removePage: item => events.push(['remove', item.url]),
    reset: () => events.push(['reset'])
  }
  const cache = new PlacesCache({
    calculateScore: item => item.lastVisit + item.visitCount,
    getSearchTextCache: item => ({ title: item.title.toLowerCase(), url: item.url.toLowerCase() }),
    tagIndex
  })
  return { cache, events }
}

function place (id, overrides = {}) {
  return {
    id,
    url: `https://example.com/${id}`,
    title: `Page ${id}`,
    color: null,
    visitCount: 1,
    lastVisit: id,
    isBookmarked: false,
    tags: [],
    extractedText: 'body'.repeat(75000),
    pageHTML: '<body>large</body>',
    searchIndex: ['body'],
    metadata: { private: 'internal' },
    ...overrides
  }
}

test('Places cache retains only lightweight summaries and projects independent results', function () {
  const { cache } = createCache()
  for (let id = 1; id <= 100; id++) cache.add(place(id), { sort: false })
  cache.sort()

  const results = cache.getAllPublic()
  const payloadSize = v8.serialize(results).byteLength

  assert.equal(results.length, 100)
  assert.ok(payloadSize < 32 * 1024, `projected payload was ${payloadSize} bytes`)
  for (const item of cache.items.concat(results)) {
    assert.equal('extractedText' in item, false)
    assert.equal('pageHTML' in item, false)
    assert.equal('searchIndex' in item, false)
    assert.equal('metadata' in item, false)
  }
  results[0].tags.push('mutated')
  assert.deepEqual(cache.getById(results[0].id).tags, [])
})

test('Places cache maintains ranking, URL and ID indexes, and tag lifecycle', function () {
  const { cache, events } = createCache()
  cache.add(place(1, { isBookmarked: true, tags: ['docs'] }))
  cache.add(place(2))
  cache.upsert(place(1, { lastVisit: 100, visitCount: 5, isBookmarked: true, tags: ['reference'] }))

  assert.equal(cache.items[0].id, 1)
  assert.equal(cache.getByURL('https://example.com/1').id, 1)
  assert.equal(cache.getById(1).tags[0], 'reference')

  cache.removeByIds([1])
  assert.equal(cache.getById(1), null)
  assert.equal(cache.getByURL('https://example.com/1'), null)
  assert.deepEqual(events, [
    ['add', 'https://example.com/1'],
    ['change', 'https://example.com/1', 'https://example.com/1'],
    ['remove', 'https://example.com/1']
  ])

  cache.reset()
  assert.equal(cache.items.length, 0)
  assert.deepEqual(events.at(-1), ['reset'])
})

test('recent Places suggestions reuse cache order and stop after the requested results', function () {
  let scoreCalls = 0
  const tagIndex = { addPage: function () {}, onChange: function () {}, removePage: function () {}, reset: function () {} }
  const cache = new PlacesCache({
    calculateScore: item => {
      scoreCalls++
      return item.lastVisit + item.visitCount
    },
    getSearchTextCache: item => ({ title: item.title.toLowerCase(), url: item.url.toLowerCase() }),
    tagIndex
  })
  for (let id = 1; id <= 1000; id++) cache.add(place(id), { sort: false })
  cache.sort()
  scoreCalls = 0
  const metrics = {}

  const results = cache.getRecentPublic({
    after: 900,
    excludeURLs: ['https://example.com/1000'],
    limit: 4,
    metrics
  })

  assert.deepEqual(results.map(item => item.id), [999, 998, 997, 996])
  assert.equal(scoreCalls, 0)
  assert.deepEqual(metrics, {
    candidatesVisited: 5,
    resultCount: 4,
    usedSortedCache: true
  })
})

test('recent Places suggestions preserve relevance before initial cache sorting finishes', function () {
  const { cache } = createCache()
  cache.add(place(1, { lastVisit: 1 }), { sort: false })
  cache.add(place(2, { lastVisit: 100 }), { sort: false })
  const metrics = {}

  const results = cache.getRecentPublic({ after: 0, limit: 1, metrics })

  assert.deepEqual(results.map(item => item.id), [2])
  assert.equal(metrics.usedSortedCache, false)
})
