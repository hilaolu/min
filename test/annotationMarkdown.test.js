const assert = require('node:assert/strict')
const test = require('node:test')

const { stringify, parse, isMarkdown } = require('../main/annotationMarkdown.js')

const rect = { origin: { x: 1.25, y: -2 }, size: { width: 30, height: 4 } }

function record () {
  return {
    version: 1,
    source: 'https://example.com/a<b>.pdf?x=1>0',
    annotations: [{
      uid: 'highlight-1',
      sourceType: 'pdf',
      data: {
        color: '#aBc123',
        pageIndex: 9,
        rect,
        segmentRects: [rect],
        textBefore: '\r\n  leading and trailing  \r',
        text: '## not a heading\n<!-- not metadata -->\n` `` ``` `````\n',
        textAfter: '',
        notes: '  # readable Markdown\r\n\r\n```js\r\nconst x = 1\r\n```\r\n  '
      }
    }]
  }
}

test('round trips arbitrary annotation strings without normalizing whitespace or CR', () => {
  const value = record()
  const text = stringify(value)

  assert.equal(isMarkdown(text), true)
  assert.ok(text.startsWith('# PDF annotations\n\n'))
  assert.match(text, /"source":"https:\/\/example\.com\/a\\u003cb\\u003e\.pdf\?x=1\\u003e0"/)
  assert.match(text, /``````text\n## not a heading/)
  assert.match(text, /### notes\n\n````markdown\n/)
  assert.deepEqual(parse(text), value)
})

test('uses fixed readable sections and keeps geometry in annotation metadata', () => {
  const text = stringify(record())
  const positions = ['### textBefore\n\n', '### text\n\n', '### textAfter\n\n', '### notes\n\n'].map(section => text.indexOf(section))

  assert.deepEqual([...positions].sort((a, b) => a - b), positions)
  assert.match(text, /<!-- min-annotation: \{"uid":"highlight-1","sourceType":"pdf","color":"#aBc123","pageIndex":9,"rect":/)
  assert.doesNotMatch(text.slice(0, positions[0]), /readable Markdown/)
})

test('rejects malformed, trailing, and oversized Markdown', () => {
  const text = stringify(record())

  assert.throws(() => parse(text + 'trailing'), /Malformed annotation Markdown/)
  assert.throws(() => parse(text.replace('### textAfter', '### notes')), /Malformed annotation Markdown/)
  assert.throws(() => parse(text.replace('## Highlight highlight-1', '## Highlight other-id')), /Malformed annotation Markdown/)
  assert.throws(() => parse('# PDF annotations\n\n' + 'x'.repeat(1024 * 1024)), /size limit/)
  const oversized = record()
  oversized.annotations[0].data.notes = 'x'.repeat(1024 * 1024)
  assert.throws(() => stringify(oversized), /size limit/)
  assert.equal(isMarkdown(' # PDF annotations\n\n'), false)
})
