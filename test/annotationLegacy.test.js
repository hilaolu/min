const assert = require('node:assert/strict')
const test = require('node:test')

const parseLegacy = require('../main/annotationLegacy.js')

const webMarkdown = `| Field | Value |
| --- | --- |
| Title | A web page |
| URL | https://example.com/article |
| Tags | #annotation |

## Annotations

%% annotation: web-1 | color: ffeb3b %%
<pre>before</pre>
<pre>selected</pre>
<pre>after</pre>

Useful note
`

const pdfMarkdown = `| Field | Value |
| --- | --- |
| Title | A PDF |
| URL | https://example.com/file.pdf |
| Tags | #annotation |

## Annotations

%% annotation: pdf-1 | color: #ffeb3b | sourceType: pdf | pageIndex: 2 %%
<pre></pre>
<pre>selected PDF text</pre>
<pre></pre>

%% annotation-rect: {"origin":{"x":12.3,"y":45.6},"size":{"width":107.8,"height":14.6}} %%
%% annotation-segments: [{"origin":{"x":12.3,"y":45.6},"size":{"width":37.7,"height":14.6}},{"origin":{"x":52,"y":45.6},"size":{"width":68.1,"height":14.6}}] %%

PDF note
`

test('parses the golden webpage fixture into the plugin annotation data model', function () {
  assert.deepEqual(parseLegacy(webMarkdown), {
    source: 'https://example.com/article',
    title: 'A web page',
    annotations: [{
      uid: 'web-1',
      sourceType: 'webpage',
      data: {
        color: '#ffeb3b',
        notes: 'Useful note',
        text: 'selected',
        textBefore: 'before',
        textAfter: 'after'
      }
    }]
  })
})

test('extracts PDF geometry instead of adding geometry comments to notes', function () {
  const result = parseLegacy(pdfMarkdown)
  const annotation = result.annotations[0]
  assert.equal(result.source, 'https://example.com/file.pdf')
  assert.equal(result.title, 'A PDF')
  assert.equal(annotation.uid, 'pdf-1')
  assert.equal(annotation.sourceType, 'pdf')
  assert.equal(annotation.data.pageIndex, 2)
  assert.equal(annotation.data.notes, 'PDF note')
  assert.equal(annotation.data.notes.includes('annotation-rect'), false)
  assert.equal(annotation.data.notes.includes('annotation-segments'), false)
  assert.deepEqual(annotation.data.rect, {
    origin: { x: 12.3, y: 45.6 },
    size: { width: 107.8, height: 14.6 }
  })
  assert.equal(annotation.data.segmentRects.length, 2)
})

test('rejects duplicate IDs, malformed geometry, and missing metadata', function () {
  const duplicate = webMarkdown.replace(
    'Useful note',
    'Useful note\n\n%% annotation: web-1 | color: ffeb3b %%\n<pre>a</pre>\n<pre>b</pre>\n<pre>c</pre>'
  )
  assert.throws(() => parseLegacy(duplicate), /duplicate annotation ID/)

  assert.throws(
    () => parseLegacy(pdfMarkdown.replace('"width":107.8', '"width":"wide"')),
    /invalid rect geometry/
  )
  assert.throws(() => parseLegacy(webMarkdown.replace('| Title | A web page |', '| URL | https://example.com |')), /Title/)
})

test('rejects embedded pre/marker content and pipe metadata without discarding it', function () {
  assert.throws(
    () => parseLegacy(webMarkdown.replace('<pre>selected</pre>', '<pre>selected <pre>nested</pre></pre>')),
    /embedded markup|trailing content/
  )
  assert.throws(
    () => parseLegacy(webMarkdown.replace('Useful note', 'Useful %% annotation: web-2 | color: ffeb3b %% note')),
    /embedded or unrecognized/
  )
  assert.throws(() => parseLegacy(webMarkdown.replace('A web page', 'A | web page')), /Title/)
})

test('bounds input at one mebibyte', function () {
  assert.throws(() => parseLegacy(`${webMarkdown}${'x'.repeat(1024 * 1024)}`), /1 MiB/)
})
