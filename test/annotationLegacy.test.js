const assert = require('node:assert/strict')
const test = require('node:test')

const parseLegacy = require('../main/annotationLegacy.js')
const { validateAnnotations } = require('../main/annotationStore.js')

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
    tags: '#annotation',
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
  assert.equal(result.tags, '#annotation')
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

test('legacy and stored rectangles share numeric boundaries for bounds and segments', () => {
  const base = parseLegacy(pdfMarkdown).annotations[0]
  // Specify expected outcomes independently of the validator implementation.
  const cases = [
    [-1000001, false, false], [-1000000, true, false], [-1, true, false],
    [0, true, true], [0.5, true, true], [1000000, true, true], [1000001, false, false],
    [NaN, false, false], [Infinity, false, false], [-Infinity, false, false],
    [null, false, false], ['1', false, false], [true, false, false]
  ]
  for (const [group, key] of [['origin', 'x'], ['origin', 'y'], ['size', 'width'], ['size', 'height']]) {
    for (const [value, validOrigin, validSize] of cases) {
      const rect = { origin: { x: 0, y: 0 }, size: { width: 1, height: 1 } }
      rect[group][key] = value
      const valid = group === 'origin' ? validOrigin : validSize
      for (const field of ['rect', 'segmentRects']) {
        const geometry = field === 'rect' ? rect : [rect]
        const marker = field === 'rect' ? 'rect' : 'segments'
        const markdown = pdfMarkdown.replace(new RegExp(`%% annotation-${marker}: .+ %%`), `%% annotation-${marker}: ${JSON.stringify(geometry)} %%`)
        const items = [{ ...base, data: { ...base.data, [field]: geometry } }]
        const label = `${field}.${group}.${key} = ${String(value)}`
        if (valid) {
          assert.deepEqual(validateAnnotations(parseLegacy(markdown).annotations), items, label)
          assert.deepEqual(validateAnnotations(items), items, label)
        } else {
          assert.throws(() => parseLegacy(markdown), /invalid .* geometry/, label)
          assert.throws(() => validateAnnotations(items), /Invalid PDF rectangle/, label)
        }
      }
    }
  }
})

test('legacy geometry still rejects unknown keys while storage strips them', () => {
  const expected = parseLegacy(pdfMarkdown).annotations
  for (const group of [null, 'origin', 'size']) {
    const items = parseLegacy(pdfMarkdown).annotations
    const rect = items[0].data.rect
    const target = group ? rect[group] : rect
    target.extra = true
    assert.deepEqual(validateAnnotations(items), expected)
    const markdown = pdfMarkdown.replace(/%% annotation-rect: .+ %%/, `%% annotation-rect: ${JSON.stringify(rect)} %%`)
    assert.throws(() => parseLegacy(markdown), /invalid rect geometry/)
  }
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

test('accepts formatted tables and identical duplicated plugin geometry, but rejects conflicts', () => {
  const formatted = pdfMarkdown.replace('| Field | Value |', '| Field | value      |')
    .replace('| --- | --- |', '| ----- | ---------- |')
    .replace('| Title | A PDF |', '| Title   | A PDF      |')
  assert.equal(parseLegacy(formatted).title, 'A PDF')
  const geometry = pdfMarkdown.split('\n').filter(line => line.startsWith('%% annotation-')).join('\n')
  const duplicated = pdfMarkdown.replace(geometry, geometry + '\n' + geometry)
  assert.deepEqual(parseLegacy(duplicated), parseLegacy(pdfMarkdown))
  assert.throws(() => parseLegacy(pdfMarkdown.replace(geometry, geometry + '\n' + geometry.replace('"x":12.3', '"x":99'))), /conflicting rect geometry/)
})
