const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { pathToFileURL } = require('node:url')
const test = require('node:test')
const { search, discover, rank, checkSource } = require('../main/annotatedResourceSearch.js')
const { createStore } = require('../main/annotationStore.js')
const { installPdfAnnotations } = require('../main/pdfAnnotations.js')
const VaultFileStrategy = require('../js/commandPalette/strategies/VaultFileStrategy.js')

const source = 'https://example.com/download?id=42'
const rect = { origin: { x: 10, y: 20 }, size: { width: 30, height: 5 } }
const annotation = {
  uid: 'test-id',
  sourceType: 'pdf',
  data: { color: '#FFCD45', text: 'quote', notes: '', textBefore: '', textAfter: '', pageIndex: 2, rect, segmentRects: [rect] }
}
function legacy (url = source, title = 'Research paper') {
  return `| Field | Value |
| --- | --- |
| Title | ${title} |
| URL | ${url} |
| Tags | #science |

## Annotations

%% annotation: test-id | color: FFCD45 | sourceType: pdf | pageIndex: 2 %%
<pre></pre>
<pre>quote</pre>
<pre></pre>

%% annotation-rect: ${JSON.stringify(rect)} %%
%% annotation-segments: ${JSON.stringify([rect])} %%
`
}
function webpageLegacy (url = 'https://example.com/article', title = 'Web research', color = '00AA00') {
  return `| Field | Value |
| --- | --- |
| Title | ${title} |
| URL | ${url} |
| Tags | #web |

## Annotations

%% annotation: web-id | color: ${color} %%
<pre>before</pre>
<pre>selected text</pre>
<pre>after</pre>

Useful note
`
}
function fixture (t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'min-annotated-search-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const directory = path.join(root, 'Archives', 'Annotations')
  fs.mkdirSync(directory, { recursive: true })
  const filename = path.join(directory, 'resource.md')
  fs.writeFileSync(filename, legacy())
  return { root, directory, filename }
}

test('discovers archived legacy annotations, not raw PDFs, and opens the PDF wrapper', async t => {
  const { root, directory, filename } = fixture(t)
  fs.writeFileSync(path.join(directory, 'unannotated.pdf'), '%PDF-')
  fs.writeFileSync(path.join(directory, 'empty.md'), legacy('https://example.com/empty.pdf').split('%% annotation:')[0])
  fs.writeFileSync(path.join(directory, 'plain.md'), 'Research paper')
  for (const query of ['', 'research', 'SCIENCE', 'id=42', 'rsrch']) {
    const result = await search(root, query)
    assert.equal(result.entries.length, 1)
    assert.equal(result.entries[0].annotationCount, 1)
    assert.equal(result.errors, 0)
    assert.equal(new URL(result.entries[0].url).searchParams.get('url'), source)
  }
  for (const query of ['unannotated.pdf', 'resource.md', 'quote', 'https://unknown.test/a.pdf']) {
    assert.deepEqual((await search(root, query)).entries, [])
  }
  assert.equal(fs.readFileSync(filename, 'utf8'), legacy())
  assert.equal(fs.existsSync(path.join(root, 'Archive', 'Annotations')), false, 'the singular typo is not used')
})

test('discovers and ranks webpage annotations separately, opens original URLs, and routes mixed records to PDF', async t => {
  const { root, directory } = fixture(t)
  const webpageSource = 'https://example.com/article'
  fs.writeFileSync(path.join(directory, 'web.md'), webpageLegacy(webpageSource))
  const mixedSource = 'https://example.com/mixed'
  const pdfBlock = legacy(mixedSource).slice(legacy(mixedSource).indexOf('%% annotation:'))
  fs.writeFileSync(path.join(directory, 'mixed.md'), webpageLegacy(mixedSource, 'Mixed highlights').trimEnd() + '\n\n' + pdfBlock)
  fs.writeFileSync(path.join(directory, 'web-empty.md'), webpageLegacy('https://example.com/empty').split('%% annotation:')[0])

  const discovered = await discover(root)
  const webpage = discovered.resources.find(resource => resource.source === webpageSource)
  const mixed = discovered.resources.find(resource => resource.source === mixedSource)
  assert.equal(webpage.sourceType, 'webpage')
  assert.equal(webpage.annotations[0].sourceType, 'webpage')
  assert.equal(mixed.sourceType, 'pdf')
  assert.deepEqual(mixed.annotations.map(item => item.sourceType), ['pdf'])

  const webResult = rank(discovered, 'web research', 'a')
  assert.equal(webResult.entries.length, 1)
  assert.equal(webResult.entries[0].url, webpageSource)
  assert.deepEqual(rank(discovered, 'mixed', 'a').entries, [])
  assert.equal(new URL(rank(discovered, 'mixed').entries[0].url).searchParams.get('url'), mixedSource)
  assert.deepEqual((await search(root, 'web research')).entries, [])
})

test('rejects unsafe or invalid webpage records without treating plain notes as errors', async t => {
  const { root, directory, filename } = fixture(t)
  fs.unlinkSync(filename)
  fs.writeFileSync(path.join(directory, 'plain.md'), 'Just a note')
  fs.writeFileSync(path.join(directory, 'script.md'), webpageLegacy('javascript:alert(1)', 'Script page'))
  fs.writeFileSync(path.join(directory, 'credentials.md'), webpageLegacy('https://user:secret@example.com/', 'Credential page'))
  fs.writeFileSync(path.join(directory, 'local.md'), webpageLegacy('file:///tmp/page.html', 'Local page'))
  fs.writeFileSync(path.join(directory, 'color.md'), webpageLegacy('https://example.com/color', 'Bad color', 'red'))
  const result = await discover(root)
  assert.deepEqual(result.resources, [])
  assert.equal(result.errors, 4)
  await assert.rejects(checkSource('javascript:alert(1)', root), /Unsupported annotation source/)
})

test('legacy annotations hydrate through IPC; URL-derived store edits and empty stores override legacy', async t => {
  const { root, filename } = fixture(t)
  let handler
  const frame = {}
  const sender = { session: { isPersistent: () => true } }
  installPdfAnnotations({ ipc: { handle: (_, fn) => { handler = fn } }, context: () => ({ root, source, generation: 1 }) })
  const event = { sender, senderFrame: frame }
  const loaded = await handler(event, 'load')
  assert.deepEqual(loaded, { ok: true, revision: null, annotations: [annotation] })
  assert.equal(fs.existsSync(path.join(root, 'Archives', 'Annotations', 'example.com', '%2Fdownload%3Fid%3D42.md')), false)
  const saved = await handler(event, 'save', { revision: null, annotations: [] })
  assert.equal(saved.ok, true)
  assert.deepEqual((await handler(event, 'load')).annotations, [])
  assert.deepEqual((await search(root, '')).entries, [])
  assert.equal(fs.readFileSync(filename, 'utf8'), legacy())
})

test('URL-derived table annotations are discoverable without legacy records; stale scans fail', async t => {
  const { root, filename } = fixture(t)
  fs.unlinkSync(filename)
  await createStore(root, source).save([annotation], null)
  const storedFile = path.join(root, 'Archives', 'Annotations', 'example.com', '%2Fdownload%3Fid%3D42.md')
  assert.equal(fs.existsSync(storedFile), true)
  assert.match(fs.readFileSync(storedFile, 'utf8'), /^\| Field \| Value \|\n\| --- \| --- \|\n\| Title \| https:\/\/example\.com\/download\?id=42 \|\n\| URL \| https:\/\/example\.com\/download\?id=42 \|/)
  assert.equal((await search(root, 'download')).entries.length, 1)
  await assert.rejects(discover(root, () => false), /Vault changed/)
})

test('old native JSON and Min Markdown are ignored while URL-derived table Markdown is authoritative', async t => {
  const { root, directory, filename } = fixture(t)
  fs.unlinkSync(filename)
  const oldDirectory = path.join(root, 'Annotations')
  fs.mkdirSync(oldDirectory)
  const jsonFile = path.join(oldDirectory, '395f5a04b57b3b2da1fc00ef46b8926fecb25ff850ac8c592cabf875ba1f29f4.json')
  const minFile = path.join(directory, 'old-min-format.md')
  const jsonText = JSON.stringify({ version: 1, source, annotations: [annotation] })
  const minText = `# PDF annotations

<!-- min-annotation-source: {"version":1,"source":"${source}"} -->

## Highlight test-id

<!-- min-annotation: {"uid":"test-id","sourceType":"pdf","color":"#FFCD45","pageIndex":2,"rect":${JSON.stringify(rect)},"segmentRects":${JSON.stringify([rect])}} -->

### textBefore

\`\`\`text

\`\`\`

### text

\`\`\`text
quote
\`\`\`

### textAfter

\`\`\`text

\`\`\`

### notes

\`\`\`markdown

\`\`\`

`
  fs.writeFileSync(jsonFile, jsonText)
  fs.writeFileSync(minFile, minText)
  const ignored = await search(root, '')
  assert.deepEqual(ignored.entries, [])
  assert.equal(ignored.errors, 0)

  const store = createStore(root, source)
  await store.save([annotation], null)
  assert.equal((await search(root, '')).entries.length, 1)
  const loaded = await store.read()
  await store.save([], loaded.revision)
  assert.deepEqual((await search(root, '')).entries, [])
  assert.equal(fs.readFileSync(jsonFile, 'utf8'), jsonText)
  assert.equal(fs.readFileSync(minFile, 'utf8'), minText)
})

test('rejects ambiguous records, invalid geometry, unsafe sources and symlinks without modifying them', async t => {
  const { root, directory, filename } = fixture(t)
  fs.writeFileSync(path.join(directory, 'duplicate.md'), legacy())
  let result = await search(root, '')
  assert.equal(result.entries.length, 0)
  assert.ok(result.errors)
  fs.unlinkSync(path.join(directory, 'duplicate.md'))
  fs.symlinkSync(filename, path.join(directory, 'linked.md'))
  assert.equal((await search(root, '')).entries.length, 1)
  for (const contents of [legacy('javascript:alert(1)'), legacy('file:///outside.pdf'), legacy().replace('"width":30', '"width":-1')]) {
    fs.writeFileSync(filename, contents)
    result = await search(root, '')
    assert.equal(result.entries.length, 0)
    assert.ok(result.errors)
    assert.equal(fs.readFileSync(filename, 'utf8'), contents)
  }
})

test('palette PDF search has no literal path or URL fallback', async () => {
  const opened = []
  const strategy = new VaultFileStrategy(async () => ({ ok: true, entries: [], total: 0 }), url => opened.push(url))
  const rows = await strategy.updateUI('>p raw.pdf', { command: 'p', query: 'raw.pdf' })
  assert.ok(rows.every(row => !row.action))
  assert.deepEqual(opened, [])
})

test('local PDF store records open through vault routing, and result limits are explicit', async t => {
  const { root, directory, filename } = fixture(t)
  fs.unlinkSync(filename)
  fs.writeFileSync(path.join(root, 'local.pdf'), '%PDF-')
  await createStore(root, 'vault://local.pdf').save([annotation], null)
  await checkSource('vault://local.pdf', root)
  assert.equal((await search(root, 'local')).entries[0].url, 'vault://local.pdf')
  for (let index = 0; index < 21; index++) {
    fs.writeFileSync(path.join(directory, `${index}.md`), legacy(`https://example.com/${String(index).padStart(2, '0')}`, 'Same title'))
  }
  const result = await search(root, 'Same title')
  assert.equal(result.entries.length, 20)
  assert.equal(result.truncated, true)
  assert.equal(result.scanLimited, false)
  assert.equal(result.resultLimited, true)
  assert.equal(result.entries[0].source, 'https://example.com/00')
  assert.equal(result.entries[19].source, 'https://example.com/19')
})

test('picker distinguishes incomplete scans from display result limits', async () => {
  for (const scanLimited of [false, true]) {
    const result = rank({ resources: [], truncated: scanLimited, errors: 0, diagnostics: [] }, '')
    assert.equal(result.scanLimited, scanLimited)
    assert.equal(result.resultLimited, false)
    const strategy = new VaultFileStrategy(async () => ({ ...result, truncated: true }), () => {})
    const rows = await strategy.updateUI('>p', { command: 'p', query: '' })
    const title = rows.find(row => row.id === 'vault-limit').title
    assert.match(title, scanLimited ? /scan incomplete/ : /More matches available/)
    if (!scanLimited) assert.doesNotMatch(title, /scan|incomplete/)
  }
})

test('checkSource rejects hidden local PDFs and accepts visible dotted PDF names for vault and file URLs', async t => {
  const { root } = fixture(t)
  const hiddenFile = path.join(root, '.hidden.pdf')
  const hiddenDescendant = path.join(root, 'papers', '.private', 'hidden.pdf')
  const visibleDottedFile = path.join(root, 'papers', 'visible.draft.pdf')
  fs.mkdirSync(path.dirname(hiddenDescendant), { recursive: true })
  fs.writeFileSync(hiddenFile, '%PDF-')
  fs.writeFileSync(hiddenDescendant, '%PDF-')
  fs.writeFileSync(visibleDottedFile, '%PDF-')

  for (const hiddenSource of [
    'vault://.hidden.pdf',
    pathToFileURL(hiddenFile).href,
    'vault://papers/.private/hidden.pdf',
    pathToFileURL(hiddenDescendant).href
  ]) {
    await assert.rejects(checkSource(hiddenSource, root), /Unavailable local PDF/)
  }
  for (const visibleSource of [
    'vault://papers/visible.draft.pdf',
    pathToFileURL(visibleDottedFile).href
  ]) {
    await assert.doesNotReject(checkSource(visibleSource, root))
  }
})

test('unrelated invalid paths do not prevent annotation loading for a new PDF', async t => {
  const { root, directory } = fixture(t)
  fs.writeFileSync(path.join(directory, 'invalid?.md'), 'ordinary note')
  let handler
  installPdfAnnotations({ ipc: { handle: (_, fn) => { handler = fn } }, context: () => ({ root, source: 'https://example.com/new.pdf', generation: 1 }) })
  const loaded = await handler({ sender: { session: { isPersistent: () => true } } }, 'load')
  assert.deepEqual(loaded, { ok: true, revision: null, annotations: [] })
})

test('depth truncation does not discard other queued directories', async t => {
  const { root, directory, filename } = fixture(t)
  fs.unlinkSync(filename)
  const parent = path.join(directory, ...Array(31).fill('level'))
  fs.mkdirSync(path.join(parent, 'deep', 'excluded'), { recursive: true })
  fs.mkdirSync(path.join(parent, 'sibling'))
  fs.writeFileSync(path.join(parent, 'sibling', 'resource.md'), legacy())
  const result = await search(root, '')
  assert.equal(result.truncated, true)
  assert.equal(result.entries.length, 1)
  assert.equal(result.entries[0].source, source)
})

test('optional snapshots resolve inventory files, exclude private components, and have no directory scan cap', async t => {
  const { root, directory } = fixture(t)
  fs.writeFileSync(path.join(directory, 'plain.md'), 'ordinary note')
  fs.mkdirSync(path.join(directory, '.git'))
  fs.writeFileSync(path.join(directory, '.git', 'ignored.md'), webpageLegacy('https://example.com/ignored', 'Ignored page'))
  const repeated = Array.from({ length: 20001 }, (_, version) => ({ relativePath: 'Archives/Annotations/plain.md', url: 'vault://Archives/Annotations/plain.md', version }))
  const snapshot = repeated.concat([
    { relativePath: 'Archives/Annotations/.git/ignored.md', url: 'vault://Archives/Annotations/.git/ignored.md', version: 1 },
    { relativePath: 'Archives/Annotations/resource.md', url: 'vault://Archives/Annotations/resource.md', version: 1 }
  ])
  const result = await discover(root, () => true, snapshot)
  assert.equal(result.truncated, false)
  assert.equal(result.errors, 0)
  assert.deepEqual(result.resources.map(resource => resource.source), [source])
})

test('walker and supplied snapshots exclude hidden legacy files and hidden-directory descendants', async t => {
  const { root, directory } = fixture(t)
  const hiddenFile = path.join(directory, '.legacy.md')
  const hiddenDescendant = path.join(directory, '.private', 'nested', 'legacy.md')
  fs.mkdirSync(path.dirname(hiddenDescendant), { recursive: true })
  fs.writeFileSync(hiddenFile, legacy('https://example.com/hidden-file.pdf', 'Hidden file'))
  fs.writeFileSync(hiddenDescendant, legacy('https://example.com/hidden-descendant.pdf', 'Hidden descendant'))
  // Excluded paths must not even be resolved, including dangling symlinks.
  fs.symlinkSync(path.join(root, 'missing'), path.join(directory, '.linked.md'))
  const snapshot = [
    { relativePath: 'Archives/Annotations/.linked.md', url: 'vault://Archives/Annotations/.linked.md', version: 1 },
    { relativePath: 'Archives/Annotations/.legacy.md', url: 'vault://Archives/Annotations/.legacy.md', version: 1 },
    { relativePath: 'Archives/Annotations/.private/nested/legacy.md', url: 'vault://Archives/Annotations/.private/nested/legacy.md', version: 1 },
    { relativePath: 'Archives/Annotations/resource.md', url: 'vault://Archives/Annotations/resource.md', version: 1 }
  ]

  for (const result of [await discover(root), await discover(root, () => true, snapshot)]) {
    assert.equal(result.errors, 0)
    assert.deepEqual(result.resources.map(resource => resource.source), [source])
  }
})

test('reports malformed tables while renamed valid plugin notes remain accepted', async t => {
  const { root, directory, filename } = fixture(t)
  const renamed = path.join(directory, 'renamed-plugin-note.md')
  fs.renameSync(filename, renamed)
  assert.equal((await search(root, '')).entries.length, 1)

  const malformed = legacy().replace('| --- | --- |', '| -- | --- |')
  fs.writeFileSync(renamed, malformed)
  const result = await search(root, '')
  assert.deepEqual(result.entries, [])
  assert.equal(result.errors, 1)
  assert.equal(fs.readFileSync(renamed, 'utf8'), malformed)
})

test('reports invalid annotation URLs and colors', async t => {
  const { root, filename } = fixture(t)
  for (const invalid of [
    legacy('https://%'),
    legacy().replace('color: FFCD45', 'color: red')
  ]) {
    fs.writeFileSync(filename, invalid)
    const result = await search(root, '')
    assert.deepEqual(result.entries, [])
    assert.equal(result.errors, 1)
    assert.equal(fs.readFileSync(filename, 'utf8'), invalid)
  }
})
