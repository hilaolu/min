const assert = require('node:assert/strict')
const test = require('node:test')

const historyPolicy = require('../js/places/historyPolicy.js')

const urlParser = {
  getSourceURL: function (url) {
    if (!url.startsWith('min://reader')) return url
    return new URL(url).searchParams.get('url') || url
  },
  isInternalURL: url => url.startsWith('min://'),
  removeTextFragment: url => url.split('#:~:text=')[0]
}

test('history extraction is disabled before work for private and non-indexable Tabs', function () {
  assert.equal(historyPolicy.canExtractHistory({ private: true }, 'https://example.com', urlParser), false)
  assert.equal(historyPolicy.canExtractHistory({ private: false }, 'min://settings', urlParser), false)
  assert.equal(historyPolicy.canExtractHistory({ private: false }, 'data:text/plain,body', urlParser), false)
  assert.equal(historyPolicy.canExtractHistory({ private: false }, 'https://example.com', urlParser), true)
  assert.equal(historyPolicy.canExtractHistory(
    { private: false },
    'min://reader?url=https%3A%2F%2Fexample.com',
    urlParser
  ), true)
})

test('stale URLs and navigation generations cannot be persisted', function () {
  const tab = { url: 'https://current.example#:~:text=match' }
  assert.equal(historyPolicy.matchesCurrentNavigation(tab, {
    navigationGeneration: 4,
    sourceURL: 'https://current.example'
  }, 4, urlParser), true)
  assert.equal(historyPolicy.matchesCurrentNavigation(tab, {
    navigationGeneration: 3,
    sourceURL: 'https://current.example'
  }, 4, urlParser), false)
  assert.equal(historyPolicy.matchesCurrentNavigation(tab, {
    navigationGeneration: 4,
    sourceURL: 'https://previous.example'
  }, 4, urlParser), false)
})
