/* global calculateHistoryScore db Dexie historyInMemoryCache nonLetterRegex */

const stemmer = require('stemmer')

const whitespaceRegex = /\s+/g
const ignoredCharactersRegex = /[']+/g

// A small ranking margin lets body relevance reorder history-ranked candidates
// without returning to the old fixed 100-document workload.
const candidateMargin = 4
const candidateMultiplier = 3

// stop words list from https://github.com/weixsong/elasticlunr.js/blob/master/lib/stop_word_filter.js
const stopWords = new Set([
  '', 'a', 'able', 'about', 'across', 'after', 'all', 'almost', 'also', 'am',
  'among', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'because', 'been',
  'but', 'by', 'can', 'cannot', 'could', 'dear', 'did', 'do', 'does', 'either',
  'else', 'ever', 'every', 'for', 'from', 'get', 'got', 'had', 'has', 'have',
  'he', 'her', 'hers', 'him', 'his', 'how', 'however', 'i', 'if', 'in',
  'into', 'is', 'it', 'its', 'just', 'least', 'let', 'like', 'likely', 'may',
  'me', 'might', 'most', 'must', 'my', 'neither', 'no', 'nor', 'not', 'of',
  'off', 'often', 'on', 'only', 'or', 'other', 'our', 'own', 'rather', 'said',
  'say', 'says', 'she', 'should', 'since', 'so', 'some', 'than', 'that', 'the',
  'their', 'them', 'then', 'there', 'these', 'they', 'this', 'tis', 'to', 'too',
  'twas', 'us', 'wants', 'was', 'we', 'were', 'what', 'when', 'where', 'which',
  'while', 'who', 'whom', 'why', 'will', 'with', 'would', 'yet', 'you', 'your'
])

function tokenize (string) {
  return string.trim().toLowerCase()
    .replace(ignoredCharactersRegex, '')
    .replace(nonLetterRegex, ' ')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .split(whitespaceRegex).filter(function (token) {
      return !stopWords.has(token) && token.length <= 100
    })
    .map(token => stemmer(token))
    .slice(0, 20000)
}

function getCandidateLimit (resultLimit) {
  return Math.max(resultLimit + candidateMargin, resultLimit * candidateMultiplier)
}

function getResultLimit (options) {
  return Number.isFinite(options.limit) ? Math.max(0, options.limit) : 4
}

function getMetadataText (item) {
  return (item.url + ' ' + item.title + ' ' + item.tags.join(' ')).toLowerCase()
}

function fullTextQuery (tokens, options = {}) {
  const resultLimit = getResultLimit(options)
  return db.transaction('r', db.places, function * () {
    const tokenMatches = yield Dexie.Promise.all(tokens.map(token => db.places
      .where('searchIndex')
      .equals(token)
      .primaryKeys()))
    const postingSets = tokenMatches.map(matches => new Set(matches))
    const tokenMatchCounts = {}
    tokens.forEach((token, index) => { tokenMatchCounts[token] = tokenMatches[index].length })

    const candidates = []
    historyInMemoryCache.forEach(function (item) {
      const metadataText = getMetadataText(item)
      const matches = tokens.every(function (token, index) {
        return postingSets[index].has(item.id) || metadataText.includes(token)
      })
      if (matches) candidates.push(item)
    })

    candidates.sort((a, b) => calculateHistoryScore(b) - calculateHistoryScore(a))
    const ids = candidates.slice(0, getCandidateLimit(resultLimit)).map(item => item.id)
    const documents = ids.length === 0
      ? []
      : yield db.places.where('id').anyOf(ids).toArray()

    return {
      candidateCount: candidates.length,
      documents,
      documentsLoaded: documents.length,
      tokenMatchCounts
    }
  })
}

function getDocumentBoost (doc, searchWords, tokenMatchCounts, totalDocumentCount) {
  const termCounts = {}
  const positions = []
  searchWords.forEach(token => { termCounts[token] = 0 })

  const index = (doc.searchIndex || []).concat(tokenize(doc.title || ''))
  index.forEach(function (token, position) {
    if (termCounts[token] === undefined) return
    termCounts[token]++
    positions.push(position)
  })
  positions.sort((a, b) => a - b)

  let proximityBoost = 0
  for (let index = 1; index < positions.length; index++) {
    const distance = positions[index] - positions[index - 1]
    if (distance < 50) proximityBoost += Math.pow(50 - distance, 2) * 0.000075
    if (distance === 1) proximityBoost += 0.05
  }

  const k1 = 1.5
  const b = 0.75
  let bm25 = 0
  searchWords.forEach(function (token) {
    const matchingDocuments = tokenMatchCounts[token]
    const inverseFrequency = Math.log(((totalDocumentCount - matchingDocuments + 0.5) / (matchingDocuments + 0.5)) + 1)
    const frequency = termCounts[token]
    const normalizedFrequency = (frequency * (k1 + 1)) /
      (frequency + (k1 * (1 - b + (b * (index.length / 500)))))
    bm25 += inverseFrequency * normalizedFrequency
  })

  return Math.min(proximityBoost, 7.5) + bm25
}

function normalizeSnippetWord (word) {
  return stemmer(word.toLowerCase().replace(nonLetterRegex, ''))
}

function createSnippetScan (text, searchText) {
  if (!text) return null

  const searchWords = new Set(searchText.split(whitespaceRegex)
    .map(normalizeSnippetWord)
    .filter(Boolean))
  if (searchWords.size === 0) return null

  return {
    bestScore: 0,
    bestWindow: null,
    matches: text.matchAll(/\S+/g),
    searchWords,
    window: []
  }
}

function scanSnippetWord (scan, word) {
  scan.window.push({ raw: word, normalized: normalizeSnippetWord(word) })
  if (scan.window.length > 18) scan.window.shift()
  const score = new Set(scan.window
    .filter(item => scan.searchWords.has(item.normalized))
    .map(item => item.normalized)).size
  if (score > scan.bestScore || (score === scan.bestScore && score > 0)) {
    scan.bestScore = score
    scan.bestWindow = scan.window.slice()
  }
}

function finishSnippetScan (scan) {
  if (!scan?.bestWindow) return null
  const firstMatch = scan.bestWindow.findIndex(item => scan.searchWords.has(item.normalized))
  let lastMatch = firstMatch
  for (let index = firstMatch + 1; index < scan.bestWindow.length; index++) {
    if (scan.searchWords.has(scan.bestWindow[index].normalized)) lastMatch = index
  }
  const snippetStart = Math.max(0, firstMatch - 2)
  const snippetEnd = Math.min(scan.bestWindow.length, lastMatch + 5)

  return {
    searchFragment: {
      contextBefore: scan.bestWindow[firstMatch - 1]?.raw,
      fragment: scan.bestWindow.slice(firstMatch, lastMatch + 1).map(item => item.raw).join(' '),
      contextAfter: scan.bestWindow[lastMatch + 1]?.raw
    },
    searchSnippet: scan.bestWindow.slice(snippetStart, snippetEnd).map(item => item.raw).join(' ') + '...'
  }
}

function createSnippet (text, searchText) {
  const scan = createSnippetScan(text, searchText)
  if (!scan) return null
  for (const match of scan.matches) scanSnippetWord(scan, match[0])
  return finishSnippetScan(scan)
}

async function createSnippetAsync (text, searchText, isCancelled = () => false) {
  const scan = createSnippetScan(text, searchText)
  if (!scan) return null
  let processedWords = 0

  for (const match of scan.matches) {
    if (isCancelled()) return null
    scanSnippetWord(scan, match[0])
    processedWords++
    if (processedWords % 2000 === 0) {
      await new Promise(resolve => setTimeout(resolve, 0))
    }
  }

  return isCancelled() ? null : finishSnippetScan(scan)
}

function projectFullTextResult (doc) {
  const result = {}
  const fields = [
    'id', 'url', 'title', 'color', 'visitCount', 'lastVisit', 'isBookmarked',
    'tags', 'searchFragment', 'searchSnippet'
  ]
  fields.forEach(function (field) {
    if (doc[field] !== undefined) result[field] = doc[field]
  })
  return result
}

function fullTextPlacesSearch (searchText, respond, options = {}) {
  let responded = false
  const respondOnce = function (results, error, metrics) {
    if (responded) return
    responded = true
    respond(results, error, metrics)
  }
  const searchWords = Array.from(new Set(tokenize(searchText)))
  const resultLimit = getResultLimit(options)
  const metrics = {
    bodiesStemmed: 0,
    candidateCount: 0,
    documentsLoaded: 0,
    resultCount: 0
  }

  if (searchWords.length === 0 || resultLimit === 0) {
    respondOnce([], null, metrics)
    return Promise.resolve(metrics)
  }

  const isCancelled = options.isCancelled || (() => false)
  return fullTextQuery(searchWords, { limit: resultLimit }).then(async function (queryResults) {
    metrics.candidateCount = queryResults.candidateCount
    metrics.documentsLoaded = queryResults.documentsLoaded

    const ranked = queryResults.documents.map(function (doc) {
      return {
        doc,
        score: calculateHistoryScore(doc, getDocumentBoost(
          doc,
          searchWords,
          queryResults.tokenMatchCounts,
          historyInMemoryCache.length
        ))
      }
    }).sort((a, b) => b.score - a.score).slice(0, resultLimit)

    const results = []
    for (const { doc } of ranked) {
      if (isCancelled()) break
      const snippet = await createSnippetAsync(doc.extractedText, searchText, isCancelled)
      metrics.bodiesStemmed++
      if (snippet) Object.assign(doc, snippet)
      if (!isCancelled()) results.push(projectFullTextResult(doc))
    }
    metrics.resultCount = results.length
    respondOnce(results, null, metrics)
    return metrics
  }).catch(function (error) {
    respondOnce(null, error, metrics)
    return metrics
  })
}

if (typeof window !== 'undefined') {
  window.fullTextPlacesSearch = fullTextPlacesSearch
  window.tokenize = tokenize
}

if (typeof module !== 'undefined') {
  module.exports = {
    createSnippet,
    createSnippetAsync,
    fullTextPlacesSearch,
    getCandidateLimit,
    getDocumentBoost,
    projectFullTextResult,
    tokenize
  }
}
