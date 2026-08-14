const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

function loadPlacesSearch (history) {
  const context = vm.createContext({
    calculateHistoryScore: item => item.lastVisit,
    historyInMemoryCache: history,
    oneDayInMS: 24 * 60 * 60 * 1000,
    quickScore: { quickScore: () => 0 },
    window: {}
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
