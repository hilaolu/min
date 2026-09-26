const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

const sources = ['ext/xregexp/nonLetterRegex.js', 'js/places/fullTextSearch.js', 'js/places/tagIndex.js']
  .map(file => ({ file, source: fs.readFileSync(path.join(__dirname, '..', file), 'utf8') }))
const tokenizers = new WeakMap()

function loadTagIndex (history = [], onTokenize = () => {}) {
  const context = vm.createContext({ historyInMemoryCache: history, require, URL })
  sources.forEach(({ file, source }) => vm.runInContext(source, context, { filename: file }))
  const tokenize = context.tokenize
  context.tokenize = function (text) {
    onTokenize(text)
    return tokenize(text)
  }
  history.filter(page => page.isBookmarked).forEach(page => context.tagIndex.addPage(page))
  tokenizers.set(context.tagIndex, tokenize)
  return context.tagIndex
}

function createHistory (count = 240) {
  return Array.from({ length: count }, (_, id) => ({
    id,
    title: `Topic${id % 8} category${id % 8} reference guide resource${id % 17}`,
    url: `https://library.example/topic${id % 8}/${id}`,
    tags: id % 3 === 0 ? ['reference'] : [`topic${id % 8}`, `group${id % 4}`],
    isBookmarked: id % 11 !== 0,
    lastVisit: id
  }))
}

// Independent legacy scorer: do not share the optimized ranking implementation
// with the oracle, or a change affecting both paths could make this test vacuous.
function referencePageTokens (index, page) {
  let urlChunk = ''
  try {
    let url = new URL(page.url)
    if ((page.url.startsWith('file://') || page.url.startsWith('min://')) && url.searchParams.get('url')) {
      url = new URL(url.searchParams.get('url'))
    }
    urlChunk = url.hostname.split('.').slice(0, -1).join(' ') + ' ' + url.pathname.split('/').filter(p => p.length > 1).slice(0, 2).join(' ')
  } catch (e) {}
  const generic = ['http', 'htps', 'www', 'com', 'net', 'html', 'pdf', 'file']
  const tokens = Array.from(tokenizers.get(index)((/^(http|https|file):\/\//.test(page.title) ? '' : page.title) + ' ' + urlChunk))
    .filter(token => token.length > 2 && !generic.includes(token))
  return tokens.filter((token, i) => tokens.indexOf(token) === i)
}

function referenceTags (index, page) {
  const tokens = referencePageTokens(index, page)
  const scores = {}
  for (const term of tokens) {
    for (const tag in index.termTags[term]) {
      if (!scores[tag]) scores[tag] = { tag, value: 0, docs: 0, terms: 0 }
      if (index.tagCounts[tag] >= 2) {
        const docs = index.termTags[term][tag] || 0
        scores[tag].value += Math.pow(docs / (index.termDocCounts[term] || 1), 2) * (0.85 + 0.1 * Math.sqrt(index.termDocCounts[term]))
        scores[tag].docs += docs
        scores[tag].terms++
      }
    }
  }
  return Object.values(scores).map(({ tag, value, docs, terms }) => {
    if (tokens.includes(tokenizers.get(index)(tag)[0])) value *= 1.5
    return { tag, value: docs > 1 && terms > 1 ? value : 0 }
  }).sort((a, b) => b.value - a.value)
}

// Reference workload: rank every tag for every eligible bookmark, then filter.
function referenceSuggestions (index, history, tags) {
  return history
    .filter(page => page.isBookmarked && tags.some(tag => !page.tags.includes(tag)))
    .map(page => ({ page, tags: referenceTags(index, page).filter(tag => tag.value >= 1.1) }))
    .filter(result => tags.every(tag => result.tags.some(candidate => candidate.tag === tag)))
    .map(result => ({
      page: result.page,
      score: result.tags.reduce((total, tag) => total + (tags.includes(tag.tag) ? tag.value : 0), 0)
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 20)
    .map(result => result.page)
}

function checkSuggestions (index, history, queries) {
  for (const tags of queries) {
    const expected = referenceSuggestions(index, history, tags)
    const actual = Array.from(index.getSuggestedItemsForTags(tags))
    assert.deepEqual(actual, expected, JSON.stringify(tags))
    actual.forEach((page, position) => assert.equal(page, expected[position]))
  }
}

test('bookmark tag suggestions match exhaustive ranking for one, many, duplicate and missing tags', function () {
  const history = createHistory()
  const index = loadTagIndex(history)
  const before = JSON.stringify(history)
  const queries = [[], ['missing'], ['topic1', 'missing'], ['topic1', 'topic1'], ['reference', 'topic1', 'group1']]
  for (let topic = 0; topic < 8; topic++) {
    queries.push([`topic${topic}`], [`topic${topic}`, 'reference'], ['reference', `topic${topic}`])
  }
  checkSuggestions(index, history, queries)
  assert.ok(index.getSuggestedItemsForTags(['topic1']).length > 0)
  assert.ok(index.getSuggestedItemsForTags(['topic1', 'reference']).length > 0)
  assert.equal(JSON.stringify(history), before)
})

test('tag ranking matches the independent scorer with varied terms and Unicode tags', function () {
  const vocabulary = ['running', 'science', 'café', '日本語', 'alpha-beta', 'travel', 'art', 'guide']
  let seed = 731
  function next (maximum) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed % maximum
  }
  const history = Array.from({ length: 120 }, (_, id) => ({
    id,
    title: Array.from({ length: 2 + next(5) }, () => vocabulary[next(vocabulary.length)]).join(' '),
    url: id % 3 === 0 ? 'not-a-url' : `https://example.com/${vocabulary[next(vocabulary.length)]}/${id}`,
    tags: [...new Set(Array.from({ length: next(4) }, () => vocabulary[next(vocabulary.length)]))],
    isBookmarked: id % 7 !== 0,
    lastVisit: id
  }))
  const index = loadTagIndex(history)
  for (const page of history) {
    assert.deepEqual(Array.from(index.getAllTagsRanked(page), tag => ({ ...tag })), referenceTags(index, page))
  }
  checkSuggestions(index, history, vocabulary.flatMap((tag, i) => [[tag], [tag, tag], [tag, vocabulary[(i + 1) % vocabulary.length]]]))
})

test('bookmark suggestions preserve thresholds, exclusions, stable ties and the 20-item limit', function () {
  const history = Array.from({ length: 35 }, (_, id) => ({
    id,
    title: 'Alpha beta',
    url: 'https://example.com',
    tags: id < 3 ? ['alpha', 'other'] : [],
    isBookmarked: id !== 3,
    lastVisit: id
  }))
  const index = loadTagIndex(history)
  checkSuggestions(index, history, [['alpha'], ['other'], ['alpha', 'other'], ['other', 'alpha', 'other']])
  assert.deepEqual(Array.from(index.getSuggestedItemsForTags(['alpha']), page => page.id), history.slice(4, 24).map(page => page.id))
  const allTags = Array.from(index.getAllTagsRanked(history[4]), tag => ({ ...tag }))
  assert.deepEqual(allTags.map(tag => tag.tag), ['alpha', 'other'])
  assert.ok(allTags[0].value > allTags[1].value)
  assert.deepEqual(Array.from(index.getSuggestedTags(history[4])), ['alpha', 'other'])

  // One matching term alone is not enough, even if it occurs in several docs.
  const singleTermPage = { title: 'Alpha', url: 'not-a-url', tags: [], isBookmarked: true }
  history.push(singleTermPage)
  assert.equal(index.getAllTagsRanked(singleTermPage)[0].value, 0)
  assert.ok(!index.getSuggestedItemsForTags(['alpha']).includes(singleTermPage))
})

test('bookmark tag suggestions stay equivalent after updates, removals and reset', function () {
  const history = createHistory()
  const index = loadTagIndex(history)
  const queries = [['topic1'], ['topic1', 'reference'], ['renamed'], ['reference'], ['group1', 'topic1']]
  const original = history[1]
  history[1] = { ...original, tags: ['renamed'], title: 'Renamed topic1 reference' }
  index.onChange(original, history[1])
  const removed = history.splice(2, 1)[0]
  index.removePage(removed)
  checkSuggestions(index, history, queries)

  index.reset()
  checkSuggestions(index, history, queries)
  history.filter(page => page.isBookmarked).forEach(page => index.addPage(page))
  checkSuggestions(index, history, queries)
})

test('selected-tag scoring retains zero-valued postings left by removals', function () {
  const history = Array.from({ length: 3 }, () => ({
    title: 'Alpha beta', url: 'not-a-url', tags: ['alpha'], isBookmarked: true, lastVisit: 0
  }))
  const index = loadTagIndex(history)
  const removed = { title: 'Unique', url: 'not-a-url', tags: ['alpha'], lastVisit: 0 }
  index.addPage(removed)
  index.removePage(removed)
  const candidate = { title: 'Unique alpha', url: 'not-a-url', tags: [], isBookmarked: true }
  history.push(candidate)

  // The old scorer counts the zero posting as a second contributing term.
  assert.equal(index.termTags.uniqu.alpha, 0)
  assert.ok(index.getAllTagsRanked(candidate)[0].value >= 1.1)
  assert.deepEqual(Array.from(index.getSuggestedItemsForTags(['alpha'])), [candidate])
})

test('selected-tag scoring does not enumerate or score unrelated tags', function () {
  const history = createHistory()
  const index = loadTagIndex(history)
  const tags = ['topic1', 'reference', 'topic1']
  const expected = referenceSuggestions(index, history, tags)
  const reads = new Set()
  let enumerations = 0
  index.tagCounts = new Proxy(index.tagCounts, {
    get: (target, tag) => { reads.add(tag); return target[tag] }
  })
  for (const term of Object.keys(index.termTags)) {
    index.termTags[term] = new Proxy(index.termTags[term], {
      ownKeys: target => { enumerations++; return Reflect.ownKeys(target) }
    })
  }

  assert.deepEqual(Array.from(index.getSuggestedItemsForTags(tags)), expected)
  assert.deepEqual([...reads].sort(), ['reference', 'topic1'])
  assert.equal(enumerations, 0)
})

test('empty, unknown and singleton tag queries skip page tokenization', function () {
  const history = createHistory()
  const index = loadTagIndex(history)
  index.addPage({ title: 'Singleton guide', url: 'not-a-url', tags: ['singleton'], lastVisit: 0 })
  index.getPageTokens = () => { throw new Error('query cannot produce suggestions') }
  for (const tags of [[], ['unknown'], ['topic1', 'unknown'], ['singleton']]) {
    assert.deepEqual(Array.from(index.getSuggestedItemsForTags(tags)), [])
  }
})

test('page token reuse respects title/URL edits, removal, reset and caller mutation', function () {
  let tokenizations = 0
  const index = loadTagIndex([], () => { tokenizations++ })
  const page = { title: 'Running guide', url: 'https://example.com/alpha', tags: [] }
  const first = index.getPageTokens(page)
  assert.deepEqual(index.getPageTokens(page), first)
  assert.equal(tokenizations, 1)
  first.push('corruption')
  assert.ok(!index.getPageTokens(page).includes('corruption'))
  assert.equal(tokenizations, 1)

  page.title = 'Travel science'
  assert.ok(index.getPageTokens(page).includes('scienc'))
  assert.ok(!index.getPageTokens(page).includes('run'))
  assert.equal(tokenizations, 2)
  page.url = 'https://other.example/beta'
  assert.ok(index.getPageTokens(page).includes('beta'))
  assert.equal(tokenizations, 3)

  index.removePage(page)
  index.getPageTokens(page)
  assert.equal(tokenizations, 4)
  index.reset()
  index.getPageTokens(page)
  assert.equal(tokenizations, 5)
})

test('page token cache includes 64 tokens but does not retain larger token sets', function () {
  let tokenizations = 0
  const index = loadTagIndex([], () => { tokenizations++ })
  for (const count of [64, 65, 100]) {
    const page = { title: Array.from({ length: count }, (_, i) => `word${i}`).join(' '), url: '', tags: [] }
    tokenizations = 0
    assert.equal(index.getPageTokens(page).length, count)
    assert.equal(index.getPageTokens(page).length, count)
    assert.equal(tokenizations, count === 64 ? 1 : 2)
  }
})

test('page token cache bounds source size even when large inputs yield few tokens', function () {
  let tokenizations = 0
  const index = loadTagIndex([], () => { tokenizations++ })
  const page = { title: 'Guide'.padEnd(4096, ' '), url: '', tags: [] }
  index.getPageTokens(page)
  index.getPageTokens(page)
  assert.equal(tokenizations, 1)

  for (const update of [
    { title: 'Guide'.padEnd(4097, ' '), url: '' },
    { title: 'Guide', url: 'https://example.com/?unused=' + 'x'.repeat(4096) }
  ]) {
    Object.assign(page, update)
    tokenizations = 0
    assert.deepEqual(Array.from(index.getPageTokens(page)), referencePageTokens(index, page))
    assert.deepEqual(Array.from(index.getPageTokens(page)), referencePageTokens(index, page))
    assert.equal(tokenizations, 2)
  }
})

test('bookmark queries normalize each requested tag once, without caching stale scores', function () {
  const calls = []
  const history = createHistory()
  const index = loadTagIndex(history, text => calls.push(text))
  const tags = ['topic1', 'reference', 'topic1']
  const expected = referenceSuggestions(index, history, tags)
  calls.length = 0
  assert.deepEqual(Array.from(index.getSuggestedItemsForTags(tags)), expected)
  assert.equal(calls.filter(text => text === 'topic1').length, 1)
  assert.equal(calls.filter(text => text === 'reference').length, 1)
  assert.equal(calls.length, 2)

  const oldPage = history[1]
  history[1] = { ...oldPage, title: 'Different science', tags: ['reference'] }
  index.onChange(oldPage, history[1])
  checkSuggestions(index, history, [tags, ['reference']])
})
