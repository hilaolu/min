const assert = require('node:assert/strict')
const test = require('node:test')
const v8 = require('node:v8')

const { PlacesCache, projectPlace, publicPlaceFields } = require('../js/places/placesCache.js')
const { getSearchTextCache } = require('../js/places/placesSearch.js')

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
    getSearchTextCache,
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
  for (const item of results.concat(cache.getPublicByURL(results[0].url), cache.getRecentPublic())) {
    assert.deepEqual(Object.keys(item), publicPlaceFields)
    assert.equal('searchTextCache' in item, false)
    assert.equal('searchTitle' in item, false)
    assert.equal('searchURL' in item, false)
  }
  for (const item of cache.items.concat(results)) {
    assert.equal('extractedText' in item, false)
    assert.equal('pageHTML' in item, false)
    assert.equal('searchIndex' in item, false)
    assert.equal('metadata' in item, false)
  }
  results[0].tags.push('mutated')
  assert.deepEqual(cache.getById(results[0].id).tags, [])
})

test('summaries inline real normalized strings and refresh titles and replacement URLs', function () {
  const { cache } = createCache()
  const original = place(1, { title: 'CAFÉ+Guide_Été', url: 'https://www.Example.com/Café-Guide?q=secret' })
  assert.deepEqual(getSearchTextCache(original), { title: 'cafe guide ete', url: 'example com cafe guide' })
  const summary = cache.add(original)
  assert.equal(summary.searchTitle, 'cafe guide ete')
  assert.equal(summary.searchURL, 'example com cafe guide')
  assert.equal('searchTextCache' in summary, false)
  assert.deepEqual(projectPlace(summary), projectPlace(original))

  const updated = cache.upsert({ ...original, title: 'RÉSUMÉ.New/Title', searchTitle: 'stale', searchURL: 'stale' })
  assert.equal(updated.searchTitle, 'resume new title')
  assert.equal(updated.searchURL, 'example com cafe guide')
  assert.equal(cache.getById(1), updated)

  // URLs are cache keys: replacing a URL uses remove + add, not an ID upsert.
  cache.removeByURL(original.url)
  const replacement = cache.add({ ...original, url: 'http://www.Example.org/À+New_Path?ignored=yes' })
  assert.equal(replacement.searchURL, 'example org a new path')
  assert.equal(replacement.searchTitle, 'cafe guide ete')
  assert.equal(cache.getByURL(original.url), null)
  assert.equal(cache.getById(1), replacement)
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

test('bulk deletion preserves cache identity, survivor order, indexes and tag lifecycle', function () {
  for (const sorted of [false, true]) {
    const { cache, events } = createCache()
    for (let id = 0; id < 8; id++) cache.add(place(id, { isBookmarked: true, tags: ['docs'] }), { sort: false })
    cache.add(place(undefined), { sort: false })
    if (sorted) cache.sort()
    const items = cache.items
    const survivors = items.filter(item => ![0, 2, 7].includes(item.id))
    events.length = 0

    cache.removeByIds([7, 2, 7, 99, undefined, 0])
    assert.equal(cache.items, items)
    assert.deepEqual(cache.items, survivors)
    assert.equal(cache.sorted, sorted)
    survivors.forEach((item, index) => {
      assert.equal(cache.items[index], item)
      assert.equal(cache.getByURL(item.url), item)
      if (item.id !== undefined) assert.equal(cache.getById(item.id), item)
    })
    for (const id of [0, 2, 7]) {
      assert.equal(cache.getById(id), null)
      assert.equal(cache.getByURL(place(id).url), null)
    }
    assert.deepEqual(events, [7, 2, 0].map(id => ['remove', place(id).url]))
    cache.removeByIds([1, 3, 4, 5, 6])
    assert.deepEqual(cache.items.map(item => item.id), [undefined])
    cache.removeByURL(place(undefined).url)
    assert.equal(cache.items.length, 0)
    assert.equal(cache.byId.size, 0)
    assert.equal(cache.byURL.size, 0)
  }
})

test('bulk deletion compacts once without repeated indexOf or splice calls', function () {
  const { cache } = createCache()
  for (let id = 0; id < 3000; id++) cache.add(place(id), { sort: false })
  cache.items.indexOf = cache.items.splice = () => { throw new Error('repeated array scan/shift') }
  cache.removeByIds(Array.from({ length: 1500 }, (_, i) => i * 2))
  assert.equal(cache.items.length, 1500)
  assert.ok(cache.items.every((item, index) => item.id === index * 2 + 1))
})

test('empty and missing-ID deletions do not scan the cache', function () {
  const { cache, events } = createCache()
  cache.add(place(1))
  cache.items[Symbol.iterator] = () => { throw new Error('unnecessary cache scan') }
  cache.removeByIds([])
  cache.removeByIds([2, 2, undefined])
  assert.equal(cache.items.length, 1)
  assert.deepEqual(events, [])
})

test('bulk deletion keeps completed removals consistent when tag cleanup throws', function () {
  const removalOrder = [0, 2, 3, 1]
  const ids = [99, 0, 0, 2, 3, 1]
  for (const sorted of [false, true]) {
    for (const failedId of removalOrder) {
      const { cache, events } = createCache()
      for (let id = 0; id < 4; id++) cache.add(place(id), { sort: false })
      if (sorted) cache.sort()
      const items = cache.items
      const original = items.slice()
      const completed = new Set(removalOrder.slice(0, removalOrder.indexOf(failedId)))
      const failure = new Error('Tag cleanup failed')
      const removePage = cache.tagIndex.removePage
      cache.tagIndex.removePage = item => {
        if (item.id === failedId) throw failure
        removePage(item)
      }

      assert.throws(() => cache.removeByIds(ids), error => error === failure)
      assert.equal(cache.items, items)
      assert.equal(cache.sorted, sorted)
      const survivors = original.filter(item => !completed.has(item.id))
      assert.deepEqual(cache.items, survivors)
      survivors.forEach((item, index) => assert.equal(cache.items[index], item))
      for (const item of original) {
        const expected = completed.has(item.id) ? null : item
        assert.equal(cache.getById(item.id), expected)
        assert.equal(cache.getByURL(item.url), expected)
      }
      assert.deepEqual(events, [...completed].map(id => ['remove', place(id).url]))

      // Retrying must not remove a completed record from the tag index twice.
      cache.tagIndex.removePage = removePage
      cache.removeByIds(ids)
      assert.equal(cache.items, items)
      assert.equal(cache.items.length, 0)
      assert.equal(cache.byId.size, 0)
      assert.equal(cache.byURL.size, 0)
      assert.deepEqual(events, removalOrder.map(id => ['remove', place(id).url]))
    }
  }
})
