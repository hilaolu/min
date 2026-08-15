const assert = require('node:assert/strict')
const test = require('node:test')

global.nonLetterRegex = /[^\s0-9A-Za-z]/g
global.calculateHistoryScore = (item, boost = 0) => item.lastVisit * (1 + boost)
global.Dexie = { Promise }

const fullText = require('../js/places/fullTextSearch.js')

function runGenerator (generator) {
  function next (value) {
    const result = generator.next(value)
    if (result.done) return Promise.resolve(result.value)
    return Promise.resolve(result.value).then(next)
  }
  return next()
}

function configureDatabase (summaries, documents, postings, instrumentation = {}) {
  global.historyInMemoryCache = summaries
  global.db = {
    places: {
      where: function (field) {
        return {
          anyOf: function (ids) {
            instrumentation.idsLoaded = ids.slice()
            return { toArray: () => Promise.resolve(documents.filter(doc => ids.includes(doc.id))) }
          },
          equals: function (token) {
            if (instrumentation.tokensQueried) instrumentation.tokensQueried.push(token)
            return { primaryKeys: () => Promise.resolve(postings[token] || []) }
          }
        }
      }
    },
    transaction: function (mode, table, callback) {
      return runGenerator(callback())
    }
  }
}

function summary (id, overrides = {}) {
  return {
    id,
    url: `https://example.com/${id}`,
    title: `Document ${id}`,
    tags: [],
    lastVisit: id,
    visitCount: 1,
    isBookmarked: false,
    ...overrides
  }
}

function document (item, body, index) {
  return { ...item, extractedText: body, searchIndex: index, pageHTML: '<large>' }
}

test('full-text search bounds loaded documents and snippet work to the requested result count', async function () {
  const summaries = Array.from({ length: 10000 }, (_, index) => summary(index + 1))
  const matchingIds = Array.from({ length: 10000 }, (_, index) => index + 1)
  matchingIds.includes = () => { throw new Error('linear posting membership used') }
  const documents = summaries.map(item => document(item, `context alpha result ${item.id}`, ['alpha']))
  const instrumentation = {}
  configureDatabase(summaries, documents, { alpha: matchingIds }, instrumentation)

  let response
  let responseCount = 0
  const metrics = await fullText.fullTextPlacesSearch('alpha', function (results, error, resultMetrics) {
    responseCount++
    response = { error, resultMetrics, results }
  }, { limit: 4 })

  assert.equal(responseCount, 1)
  assert.equal(response.error, null)
  assert.equal(response.results.length, 4)
  assert.equal(metrics.candidateCount, 10000)
  assert.equal(metrics.documentsLoaded, fullText.getCandidateLimit(4))
  assert.equal(metrics.bodiesStemmed, 4)
  assert.equal(instrumentation.idsLoaded.length, fullText.getCandidateLimit(4))
  response.results.forEach(function (result) {
    assert.equal('extractedText' in result, false)
    assert.equal('searchIndex' in result, false)
    assert.match(result.searchSnippet, /alpha/)
  })
})

test('full-text matching includes metadata-only matches and preserves body relevance ordering', async function () {
  const items = [
    summary(1, { title: 'Alpha title', lastVisit: 10 }),
    summary(2, { url: 'https://alpha.example', lastVisit: 20 }),
    summary(3, { tags: ['alpha'], lastVisit: 30 }),
    summary(4, { lastVisit: 40 })
  ]
  const documents = [
    document(items[0], '', []),
    document(items[1], '', []),
    document(items[2], '', []),
    document(items[3], 'alpha alpha alpha', ['alpha', 'alpha', 'alpha'])
  ]
  configureDatabase(items, documents, { alpha: [4] })

  const results = await new Promise((resolve, reject) => {
    fullText.fullTextPlacesSearch('alpha', (results, error) => error ? reject(error) : resolve(results), { limit: 4 })
  })

  assert.deepEqual(results.map(result => result.id), [4, 1, 3, 2])
})

test('full-text search intersects multiple tokens across body, title, URL, and tags', async function () {
  const items = [
    summary(1, { title: 'Alpha Beta title', lastVisit: 30 }),
    summary(2, { lastVisit: 20 }),
    summary(3, { tags: ['alpha'], lastVisit: 10 }),
    summary(4, { url: 'https://alpha-beta.example', lastVisit: 5 })
  ]
  const documents = [
    document(items[0], '', []),
    document(items[1], 'alpha and beta occur in the body', ['alpha', 'beta']),
    document(items[2], 'alpha only', ['alpha']),
    document(items[3], '', [])
  ]
  configureDatabase(items, documents, { alpha: [2, 3], beta: [2] })

  const results = await new Promise((resolve, reject) => {
    fullText.fullTextPlacesSearch('alpha beta', (results, error) => error ? reject(error) : resolve(results), { limit: 4 })
  })

  assert.deepEqual(results.map(result => result.id), [1, 2, 4])
})

test('full-text search queries each normalized token once', async function () {
  const item = summary(1, { lastVisit: 10 })
  const instrumentation = { tokensQueried: [] }
  configureDatabase([item], [document(item, 'alpha', ['alpha'])], { alpha: [1] }, instrumentation)

  const results = await new Promise((resolve, reject) => {
    fullText.fullTextPlacesSearch('alpha alpha', (results, error) => error ? reject(error) : resolve(results), { limit: 4 })
  })

  assert.deepEqual(instrumentation.tokensQueried, ['alpha'])
  assert.deepEqual(results.map(result => result.id), [1])
})

test('full-text search responds exactly once for empty results and storage errors', async function () {
  configureDatabase([], [], {})
  let emptyResponses = 0
  await fullText.fullTextPlacesSearch('the', results => {
    emptyResponses++
    assert.deepEqual(results, [])
  }, { limit: 4 })
  assert.equal(emptyResponses, 1)

  global.db.transaction = () => Promise.reject(new Error('storage unavailable'))
  let errorResponses = 0
  await fullText.fullTextPlacesSearch('alpha', (results, error) => {
    errorResponses++
    assert.equal(results, null)
    assert.match(error.message, /storage unavailable/)
  }, { limit: 4 })
  assert.equal(errorResponses, 1)

  const originalCalculateHistoryScore = global.calculateHistoryScore
  global.calculateHistoryScore = () => { throw new Error('ranking unavailable') }
  configureDatabase([summary(1)], [document(summary(1), 'alpha', ['alpha'])], { alpha: [1] })
  let rankingResponses = 0
  await fullText.fullTextPlacesSearch('alpha', (results, error) => {
    rankingResponses++
    assert.equal(results, null)
    assert.match(error.message, /ranking unavailable/)
  }, { limit: 4 })
  global.calculateHistoryScore = originalCalculateHistoryScore
  assert.equal(rankingResponses, 1)
})

test('snippet generation handles one-token and multi-token windows in one bounded pass', function () {
  const single = fullText.createSnippet('before alpha after', 'alpha')
  const multiple = fullText.createSnippet('zero alpha one two beta three', 'alpha beta')

  assert.equal(single.searchFragment.fragment, 'alpha')
  assert.equal(multiple.searchFragment.fragment, 'alpha one two beta')
  assert.equal(multiple.searchFragment.contextBefore, 'zero')
  assert.equal(multiple.searchFragment.contextAfter, 'three')
})

test('cooperative snippet generation stops superseded body work', async function () {
  let cancelled = false
  setTimeout(() => { cancelled = true }, 0)
  const result = await fullText.createSnippetAsync(
    Array.from({ length: 10000 }, (_, index) => `word${index}`).join(' ') + ' alpha',
    'alpha',
    () => cancelled
  )
  assert.equal(result, null)
})
