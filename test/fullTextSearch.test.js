const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')
const stemmer = require('stemmer')

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

test('bounded candidate selection matches stable full sorting for ties, arbitrary order and limits', async function () {
  let seed = 17
  const mixed = Array.from({ length: 1000 }, (_, index) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return summary(index + 1, { lastVisit: seed % 23, title: index % 3 === 0 ? 'Alpha metadata' : 'Other' })
  })
  const postings = mixed.filter(item => item.id % 2 === 0).map(item => item.id)
  const bodyMatches = new Set(postings)
  for (const items of [mixed, mixed.slice().reverse(), mixed.slice().sort((a, b) => a.lastVisit - b.lastVisit)]) {
    for (const limit of [0.5, 1, 4, 20, 1000]) {
      const expected = items.filter(item => bodyMatches.has(item.id) || item.title.includes('Alpha'))
        .sort((a, b) => global.calculateHistoryScore(b) - global.calculateHistoryScore(a))
      const instrumentation = {}
      configureDatabase(items, items.map(item => document(item, '', [])), { alpha: postings }, instrumentation)
      const metrics = await fullText.fullTextPlacesSearch('alpha', (results, error) => assert.equal(error, null), { limit })
      assert.deepEqual(instrumentation.idsLoaded, expected.slice(0, fullText.getCandidateLimit(limit)).map(item => item.id))
      assert.equal(metrics.candidateCount, expected.length)
      assert.equal(metrics.documentsLoaded, Math.min(expected.length, Math.floor(fullText.getCandidateLimit(limit))))
    }
  }
})

test('malformed history scores retain the legacy stable-sort behavior', async function () {
  const items = Array.from({ length: 40 }, (_, index) => summary(index + 1, { lastVisit: index % 7 === 0 ? NaN : (index * 17) % 31 }))
  const expected = items.slice().sort((a, b) => global.calculateHistoryScore(b) - global.calculateHistoryScore(a))
  const instrumentation = {}
  configureDatabase(items, items.map(item => document(item, '', [])), { alpha: items.map(item => item.id) }, instrumentation)
  await fullText.fullTextPlacesSearch('alpha', (results, error) => assert.equal(error, null), { limit: 4 })
  assert.deepEqual(instrumentation.idsLoaded, expected.slice(0, fullText.getCandidateLimit(4)).map(item => item.id))
})

test('full-text query releases posting-set entries before loading selected bodies', async function () {
  const items = Array.from({ length: 100 }, (_, index) => summary(index + 1))
  configureDatabase(items, items.map(item => document(item, 'alpha beta', ['alpha', 'beta'])), {
    alpha: items.map(item => item.id), beta: items.map(item => item.id)
  })
  const sets = []
  const instrumented = instrumentFullText({
    Dexie: global.Dexie,
    db: global.db,
    historyInMemoryCache: items,
    calculateHistoryScore: global.calculateHistoryScore,
    setTimeout,
    Set: class extends Set {
      constructor (values) {
        super(values)
        if (Array.isArray(values) && typeof values[0] === 'number') sets.push(this)
      }
    }
  })
  const where = global.db.places.where
  global.db.places.where = field => {
    if (field === 'id') {
      assert.equal(sets.length, 2)
      assert.deepEqual(sets.map(set => set.size), [0, 0])
    }
    return where(field)
  }
  await instrumented.fullTextPlacesSearch('alpha beta', (results, error) => assert.equal(error, null), { limit: 4 })
})

test('candidate history scores are evaluated once per match, not across a full-library sort', async function () {
  const items = Array.from({ length: 10000 }, (_, index) => summary(index + 1))
  configureDatabase(items, items.map(item => document(item, '', [])), { alpha: items.map(item => item.id) })
  let calls = 0
  const calculate = global.calculateHistoryScore
  const instrumented = instrumentFullText({
    Dexie: global.Dexie,
    db: global.db,
    historyInMemoryCache: items,
    calculateHistoryScore: (...args) => { calls++; return calculate(...args) }
  })
  await instrumented.fullTextPlacesSearch('alpha', (results, error) => assert.equal(error, null), { limit: 4 })
  assert.ok(calls <= items.length + fullText.getCandidateLimit(4), `evaluated ${calls} scores`)
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

// Independent pre-cache pipeline; share only the unchanged stop-word policy.
function referenceTokenize (text, nonLetters, stopWords) {
  return text.trim().toLowerCase()
    .replace(/[']+/g, '')
    .replace(nonLetters, ' ')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .split(/\s+/g).filter(token => !stopWords.has(token) && token.length <= 100)
    .slice(0, 20000)
    .map(token => stemmer(token))
}

function instrumentFullText (globals = {}, stem = stemmer) {
  const context = {
    module: { exports: {} },
    nonLetterRegex: global.nonLetterRegex,
    require: name => {
      assert.equal(name, 'stemmer')
      return stem
    },
    ...globals
  }
  const stopWords = vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../js/places/fullTextSearch.js'), 'utf8') + '\nstopWords', context)
  context.module.exports.referenceTokenize = text => referenceTokenize(text, context.nonLetterRegex, stopWords)
  return context.module.exports
}

test('tokenization filters and caps tokens before doing expensive stemming', function () {
  let stems = 0
  const instrumented = instrumentFullText({}, word => { stems++; return stemmer(word) })
  const text = Array.from({ length: 20005 }, (_, index) => `the ${'x'.repeat(101)} word${index}`).join(' ')
  const result = instrumented.tokenize(text)
  assert.equal(result.length, 20000)
  assert.deepEqual(Array.from(result), Array.from({ length: 20000 }, (_, index) => `word${index}`))
  assert.equal(stems, 20000)
  assert.deepEqual(fullText.tokenize("The RUNNING runner's café alpha-beta"), ['run', 'runner', 'caf', 'alpha', 'beta'])
})

test('word normalization is reused within, but not retained across, text operations', function () {
  let stems = 0
  const instrumented = instrumentFullText({}, word => { stems++; return stemmer(word) })
  const text = 'running runners running '.repeat(2000)
  const tokens = instrumented.tokenize(text)
  assert.equal(tokens.length, 6000)
  assert.equal(stems, 2)
  assert.ok(tokens.every((token, index) => token === (index % 3 === 1 ? 'runner' : 'run')))
  instrumented.tokenize(text)
  assert.equal(stems, 4)

  stems = 0
  const result = instrumented.createSnippet(text, 'running')
  assert.equal(JSON.stringify(result), JSON.stringify(referenceSnippet(text, 'running')))
  assert.equal(stems, 2)
  instrumented.createSnippet(text, 'running')
  assert.equal(stems, 4)
})

test('normalization caches bound both entry count and key size on high-diversity input', function () {
  const maps = []
  const instrumented = instrumentFullText({
    Map: class extends Map {
      constructor (...args) { super(...args); maps.push(this) }
      set (key, value) {
        assert.ok(key.length <= 100)
        const result = super.set(key, value)
        assert.ok(this.size <= 256)
        return result
      }
    }
  })
  const text = Array.from({ length: 1000 }, (_, index) => `word${index}`).join(' ') + ' ' + 'z'.repeat(10000)
  assert.equal(instrumented.tokenize(text).length, 1000)
  assert.equal(JSON.stringify(instrumented.createSnippet(text, 'word999')), JSON.stringify(referenceSnippet(text, 'word999')))
  assert.equal(maps.filter(map => map.size === 256).length, 2)
})

test('streamed tokenization preserves Unicode normalization, duplicates and stop-word filtering', function () {
  const instrumented = instrumentFullText({ nonLetterRegex: /[^\p{L}\p{N}\s]/gu })
  assert.deepEqual(Array.from(instrumented.tokenize("  CAFÉ cafe\u0301 日本語 coöperate THE running RUNNING runner's  ")), [
    'cafe', 'cafe', '日本語', 'cooper', 'run', 'run', 'runner'
  ])
  assert.deepEqual(Array.from(instrumented.tokenize('the\tand\n!!!')), [])
})

test('high-diversity text stops probing an ineffective cache', function () {
  let lookups = 0
  const instrumented = instrumentFullText({
    Map: class extends Map {
      get (key) { lookups++; return super.get(key) }
    }
  })
  const text = Array.from({ length: 5000 }, (_, i) => `word${i}`).join(' ')
  const tokens = instrumented.tokenize(text)
  assert.equal(tokens.length, 5000)
  assert.equal(lookups, 768)
  assert.deepEqual(Array.from(tokens), Array.from({ length: 5000 }, (_, i) => `word${i}`))
})

test('tokenization agrees with the legacy pipeline using the production Unicode policy', function () {
  const nonLetters = vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../ext/xregexp/nonLetterRegex.js'), 'utf8') + '\nnonLetterRegex')
  const instrumented = instrumentFullText({ nonLetterRegex: nonLetters })
  const vocabulary = ['THE', 'running', "runner's", 'CAFÉ', 'cafe\u0301', '日本語', 'Ελληνικά', 'İ', '👩‍💻', 'alpha-beta', '123', 'constructor', 'x'.repeat(100), 'x'.repeat(101)]
  let seed = 731
  const texts = ['', ' \t\n', ('the running ' + 'x'.repeat(101) + ' ').repeat(20005)]
  for (let sample = 0; sample < 30; sample++) {
    texts.push(Array.from({ length: 300 }, () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return vocabulary[seed % vocabulary.length]
    }).join(' \u00a0\n'))
  }
  for (const text of texts) {
    assert.deepEqual(Array.from(instrumented.tokenize(text)), instrumented.referenceTokenize(text))
  }
})

// Deliberately simple reference: rescan each complete window, as before the
// rolling counts optimization, including the rule that the last best tie wins.
function referenceSnippet (text, query) {
  const normalize = word => stemmer(word.toLowerCase().replace(global.nonLetterRegex, ''))
  const search = new Set(query.split(/\s+/).map(normalize).filter(Boolean))
  const words = (text.match(/\S+/g) || []).map(raw => ({ raw, normalized: normalize(raw) }))
  let best
  let bestScore = 0
  for (let end = 1; end <= words.length; end++) {
    const window = words.slice(Math.max(0, end - 18), end)
    const score = new Set(window.filter(word => search.has(word.normalized)).map(word => word.normalized)).size
    if (score > 0 && score >= bestScore) { best = window; bestScore = score }
  }
  if (!best) return null
  const matching = best.map((word, index) => search.has(word.normalized) ? index : -1).filter(index => index >= 0)
  const first = matching[0]
  const last = matching[matching.length - 1]
  return {
    searchFragment: {
      contextBefore: best[first - 1]?.raw,
      fragment: best.slice(first, last + 1).map(word => word.raw).join(' '),
      contextAfter: best[last + 1]?.raw
    },
    searchSnippet: best.slice(Math.max(0, first - 2), Math.min(best.length, last + 5)).map(word => word.raw).join(' ') + '...'
  }
}

test('rolling snippet scoring preserves repeated tokens, window eviction, and last-best ties', function () {
  const vocabulary = ['alpha', 'ALPHA!', 'betas', 'plain', 'words', 'running', 'runs', '!!!', "runner's", 'café']
  let seed = 731
  const randomWord = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return vocabulary[seed % vocabulary.length]
  }
  const texts = [
    '', 'plain words', 'alpha', 'alpha alpha ' + 'plain '.repeat(17) + 'beta',
    'alpha beta ' + 'plain '.repeat(18) + 'alpha plain beta',
    ...Array.from({ length: 30 }, () => Array.from({ length: 80 }, randomWord).join(' \n\t'))
  ]
  for (const text of texts) {
    for (const query of ['', '!!!', 'alpha', 'alpha alpha', 'alpha beta', 'run runner', 'missing', 'café']) {
      assert.deepEqual(fullText.createSnippet(text, query), referenceSnippet(text, query), JSON.stringify({ text, query }))
    }
  }
})

test('snippet scanning allocates query sets once, not once per body word', function () {
  let sets = 0
  const instrumented = instrumentFullText({
    Set: class extends Set {
      constructor (values) { super(values); sets++ }
    }
  })
  sets = 0
  assert.ok(instrumented.createSnippet('alpha beta plain '.repeat(1000), 'alpha beta'))
  assert.equal(sets, 1)
})

test('cooperative snippet generation returns the same result across yield boundaries', async function () {
  const text = 'alpha plain '.repeat(1100) + 'beta alpha ending'
  assert.deepEqual(await fullText.createSnippetAsync(text, 'alpha beta'), referenceSnippet(text, 'alpha beta'))
  assert.equal(await fullText.createSnippetAsync(text, 'alpha beta', () => true), null)
})
