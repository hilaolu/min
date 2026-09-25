const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

const sources = ['ext/xregexp/nonLetterRegex.js', 'js/places/fullTextSearch.js', 'js/places/tagIndex.js']
  .map(file => ({ file, source: fs.readFileSync(path.join(__dirname, '..', file), 'utf8') }))
const tokenizers = new WeakMap()

function loadTagIndex (history = []) {
  const context = vm.createContext({ historyInMemoryCache: history, require, URL })
  sources.forEach(({ file, source }) => vm.runInContext(source, context, { filename: file }))
  history.filter(page => page.isBookmarked).forEach(page => context.tagIndex.addPage(page))
  tokenizers.set(context.tagIndex, context.tokenize)
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
function referenceTags (index, page) {
  const tokens = index.getPageTokens(page)
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
