const assert = require('node:assert/strict')
const test = require('node:test')

const { stringify, parse, isMarkdown } = require('../main/annotationMarkdown.js')

const rect = { origin: { x: 1.25, y: -2 }, size: { width: 30, height: 4 } }

function webRecord () {
  return {
    version: 1,
    source: 'https://example.com/article?left=a|b',
    title: 'A | useful page',
    tags: '#research',
    annotations: [{
      uid: 'highlight-1',
      sourceType: 'webpage',
      data: {
        color: '#aBc123',
        textBefore: 'before\ncontext',
        text: 'selected text',
        textAfter: 'after context',
        notes: '# Readable Markdown\n\nA note.'
      }
    }]
  }
}

test('writes the tab-picker table and annotation blocks and round trips webpages', () => {
  const value = webRecord()
  const text = stringify(value)

  assert.equal(isMarkdown(text), true)
  assert.ok(text.startsWith('| Field | Value |\n| --- | --- |\n'))
  assert.match(text, /\| Title \| A \\\| useful page \|/)
  assert.match(text, /\| URL \| https:\/\/example\.com\/article\?left=a\\\|b \|/)
  assert.match(text, /## Annotations\n\n%% annotation: highlight-1 \| color: aBc123 %%/)
  assert.match(text, /<pre>before\ncontext<\/pre>\n<pre>selected text<\/pre>\n<pre>after context<\/pre>\n\n# Readable Markdown/)
  assert.deepEqual(parse(text), value)
})

test('defaults title and tags and handles an empty annotation list', () => {
  const value = { version: 1, source: 'https://example.com/empty', annotations: [] }
  const text = stringify(value)

  assert.match(text, /\| Title \| https:\/\/example\.com\/empty \|/)
  assert.match(text, /\| Tags \| #annotation \|/)
  assert.deepEqual(parse(text), {
    version: 1,
    source: value.source,
    title: value.source,
    tags: '#annotation',
    annotations: []
  })
})

test('keeps PDF page and geometry metadata in plugin format', () => {
  const value = {
    version: 1,
    source: 'https://example.com/file.pdf',
    title: 'PDF',
    tags: '#pdf',
    annotations: [{
      uid: 'pdf-1',
      sourceType: 'pdf',
      data: {
        color: '#ffEb3b',
        pageIndex: 9,
        rect,
        segmentRects: [rect],
        textBefore: '',
        text: 'PDF text',
        textAfter: '',
        notes: 'PDF note'
      }
    }]
  }
  const text = stringify(value)

  assert.match(text, /%% annotation: pdf-1 \| color: ffEb3b \| sourceType: pdf \| pageIndex: 9 %%/)
  assert.match(text, /%% annotation-rect: \{"origin":/)
  assert.match(text, /%% annotation-segments: \[\{"origin":/)
  assert.deepEqual(parse(text), value)
})

test('parses escaped pipes in table metadata', () => {
  const text = stringify(webRecord())
    .replace('| Tags | #research |', '| Tags | #research\\|archive |')

  assert.deepEqual(parse(text), {
    ...webRecord(),
    tags: '#research|archive'
  })
})

test('rejects unsafe marker and pre delimiters instead of corrupting content', () => {
  for (const [field, value] of [
    ['text', 'selected </pre> injected'],
    ['textBefore', '%% annotation: injected | color: ffffff %%'],
    ['notes', '<pre>not a note delimiter</pre>'],
    ['notes', 'note\n%% annotation: injected | color: ffffff %%']
  ]) {
    const record = webRecord()
    record.annotations[0].data[field] = value
    assert.throws(() => stringify(record), /Unsafe annotation Markdown content/)
  }

  const record = webRecord()
  record.tags = '#one|#two'
  assert.throws(() => stringify(record), /Unsafe annotation Markdown content/)
})

test('bounds input and output to one mebibyte and detects only tables', () => {
  assert.throws(() => parse('| Field | Value |\n| --- | --- |\n' + 'x'.repeat(1024 * 1024)), /1 MiB/)
  const oversized = webRecord()
  oversized.annotations[0].data.notes = 'x'.repeat(1024 * 1024)
  assert.throws(() => stringify(oversized), /size limit/)
  assert.equal(isMarkdown('# PDF annotations\n\n'), false)
  assert.equal(isMarkdown(' | Field | Value |\n| --- | --- |\n'), false)
})
