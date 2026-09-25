const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

function loadPlacesSearch (history, globals = {}) {
  const context = vm.createContext({
    calculateHistoryScore: (item, boost = 0) => item.lastVisit * (1 + boost),
    historyInMemoryCache: history,
    oneDayInMS: 24 * 60 * 60 * 1000,
    quickScore: { quickScore: () => 0 },
    window: {},
    ...globals
  })
  const source = fs.readFileSync(
    path.resolve(__dirname, '../js/places/placesSearch.js'),
    'utf8'
  )

  vm.runInContext(source, context, { filename: 'placesSearch.js' })

  return context.window
}

test('Places search formats history without ambient service globals', function () {
  const history = [{
    url: 'https://example.com/docs',
    title: 'Example Documentation',
    tags: [],
    visitCount: 1,
    lastVisit: Date.now()
  }]
  const placesSearch = loadPlacesSearch(history)
  history[0].searchTextCache = placesSearch.getSearchTextCache(history[0])

  let allResults
  let matchingResults
  placesSearch.searchPlaces('', results => { allResults = results }, { limit: Infinity })
  placesSearch.searchPlaces('example docs', results => { matchingResults = results }, { limit: 20 })

  assert.deepEqual(Array.from(allResults, result => result.url), ['https://example.com/docs'])
  assert.deepEqual(Array.from(matchingResults, result => result.url), ['https://example.com/docs'])
})

test('Places search considers late cache entries before applying a small result bound', function () {
  const history = Array.from({ length: 205 }, (_, index) => ({
    url: `https://example.com/path/needle/${index}`,
    title: `Earlier ${index}`,
    tags: [],
    visitCount: 1,
    lastVisit: 100
  }))
  history.push({
    url: 'https://needle.example',
    title: 'Late best match',
    tags: [],
    visitCount: 1,
    lastVisit: 90
  })
  const placesSearch = loadPlacesSearch(history)
  history.forEach(item => { item.searchTextCache = placesSearch.getSearchTextCache(item) })

  let results
  placesSearch.searchPlaces('needle', value => { results = value }, { limit: 4 })

  assert.equal(results[0].url, 'https://needle.example')
  assert.equal(results.length, 4)
})

function createHistory (count) {
  return Array.from({ length: count }, (_, index) => ({
    url: index % 3 === 0 ? `https://needle.example/${index}` : `https://example.com/${index}`,
    title: index % 3 === 1 ? 'A needle in the title' : 'Other title',
    tags: index % 3 === 2 ? ['needle'] : [],
    isBookmarked: index % 2 === 0,
    visitCount: 1,
    lastVisit: (index * 37) % 101
  }))
}

function prepareSearch (history, globals) {
  const search = loadPlacesSearch(history, globals)
  history.forEach(item => { item.searchTextCache = search.getSearchTextCache(item) })
  return function (query, options) {
    let results
    let responses = 0
    search.searchPlaces(query, value => { results = Array.from(value); responses++ }, options)
    assert.equal(responses, 1)
    return results
  }
}

test('bounded Places ranking matches a stable full sort without changing the cache', function () {
  const history = createHistory(513)
  const search = prepareSearch(history)
  const original = history.slice()
  const before = JSON.stringify(history)

  for (const searchBookmarks of [false, true]) {
    const expected = history.filter(item => !searchBookmarks || item.isBookmarked)
      .map(item => ({
        item,
        score: item.lastVisit * (1 + (item.url.startsWith('https://needle') ? 10 : 0.4 + 0.075 * 'needle'.length))
      }))
      .sort((a, b) => b.score - a.score)
      .map(match => match.item)

    for (const limit of [1, 2, 4, 20, 100, 512, 513, 1000]) {
      const results = search('needle', { limit, searchBookmarks })
      assert.deepEqual(results, expected.slice(0, limit))
      results.forEach((item, index) => assert.equal(item, expected[index]))
    }
  }
  assert.deepEqual(history, original)
  assert.equal(JSON.stringify(history), before)
})

test('Places ranking retains the earliest equal-score matches at the result boundary', function () {
  const history = createHistory(9)
  const scores = [10, 10, 10, 20, 10, 30, 20, 10, 30]
  history.forEach((item, index) => { item.score = scores[index] })
  const search = prepareSearch(history, { calculateHistoryScore: item => item.score })

  assert.deepEqual(search('needle', { limit: 5 }), [history[5], history[8], history[3], history[6], history[0]])
  assert.deepEqual(search('needle', { limit: 1 }), [history[5]])
})

test('bounded Places ranking preserves literal, out-of-order, tag, and fuzzy boosts', function () {
  const now = Date.now()
  const history = [
    { url: 'https://alpha-beta.example', title: 'URL prefix', boost: 10 },
    { title: 'Alpha beta in title', boost: 0.4 + 0.075 * 'alpha beta'.length },
    { title: 'Beta before alpha', boost: 0.125 * 2 + 0.02 * 'alpha beta'.length },
    { tags: ['alpha', 'beta'], boost: 0.4 + 0.075 * 'alpha beta'.length },
    { title: 'fuzzy target', boost: 0.9 * 0.33 },
    { title: 'no match', boost: null }
  ].map((item, index) => ({
    url: `https://example.com/${index}`,
    title: 'Other title',
    tags: [],
    visitCount: 1,
    lastVisit: now,
    ...item
  }))
  const search = prepareSearch(history, {
    quickScore: { quickScore: text => text === 'fuzzy target' ? 0.9 : 0 }
  })
  const expected = history.filter(item => item.boost !== null).sort((a, b) => b.boost - a.boost)

  for (const limit of [1, 3, 4, 20]) {
    assert.deepEqual(search('alpha beta', { limit }), expected.slice(0, limit))
  }
  assert.deepEqual(search('absent query', { limit: 4, searchBookmarks: true }), [])
})

test('Places search preserves default and fractional result limit semantics', function () {
  const history = createHistory(150)
  const search = prepareSearch(history)
  const all = search('needle', { limit: 150 })
  for (const options of [undefined, null, {}, { limit: -1 }, { limit: Infinity }, { limit: NaN }, { limit: '4' }]) {
    assert.deepEqual(search('needle', options), all.slice(0, 100))
  }
  for (const limit of [0, 0.5, 1.9, 4.5, Number.MAX_VALUE]) {
    assert.deepEqual(search('needle', { limit }), all.slice(0, limit))
  }
})

test('empty and nonmatching Places searches respond once without calculating scores', function () {
  for (const history of [[], createHistory(12)]) {
    const search = prepareSearch(history, {
      calculateHistoryScore: () => { throw new Error('nonmatching item was scored') }
    })
    assert.deepEqual(search('missing-query', { limit: 4 }), [])
  }
})

test('Places search calculates each matching score only once', function () {
  const history = createHistory(20000)
  const scored = new Set()
  const search = prepareSearch(history, {
    calculateHistoryScore: (item, boost) => {
      assert.equal(scored.has(item), false, 'score recomputed during ranking')
      scored.add(item)
      return item.lastVisit * (1 + boost)
    }
  })

  assert.equal(search('needle', { limit: 4, searchBookmarks: true }).length, 4)
  assert.equal(scored.size, history.filter(item => item.isBookmarked).length)
})

test('zero-result Places searches skip matching and scoring entirely', function () {
  const history = new Proxy([], {
    get: () => { throw new Error('history scanned for a zero-result search') }
  })
  const search = loadPlacesSearch(history)
  let responses = 0
  for (const limit of [0, 0.5]) {
    search.searchPlaces('needle', results => {
      responses++
      assert.deepEqual(Array.from(results), [])
    }, { limit })
  }
  assert.equal(responses, 2)
})
