const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { createStore, maximumBytes, validateAnnotations } = require('../main/annotationStore.js')
const annotationMarkdown = require('../main/annotationMarkdown.js')
const { sourcePath } = require('../main/annotationPaths.js')

const source = 'https://example.com/document.pdf'

function profile (t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'min-annotation-store-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

function annotation (uid = 'annotation-1', changes = {}) {
  const data = {
    color: '#ffeb3b',
    text: 'selected text',
    notes: 'a note',
    textBefore: 'before',
    textAfter: 'after',
    pageIndex: 2,
    rect: { origin: { x: 10, y: 20 }, size: { width: 30, height: 40 } },
    segmentRects: [
      { origin: { x: 10, y: 20 }, size: { width: 12, height: 40 } },
      { origin: { x: 25, y: 20 }, size: { width: 15, height: 40 } }
    ],
    ...changes.data
  }
  return { uid, sourceType: 'pdf', ...changes, data }
}

function annotationFile (root, pdfSource = source, folder = 'Archives/Annotations') {
  return path.join(root, folder, sourcePath(pdfSource))
}

function legacyJsonFile (root, pdfSource = source) {
  const digest = crypto.createHash('sha256').update(pdfSource).digest('hex')
  return path.join(root, 'Annotations', `${digest}.json`)
}

test('saves and loads PDF geometry, text, notes, colors, and IDs', async t => {
  const root = profile(t)
  const store = createStore(root, source)
  const item = annotation('saved-id', { data: { color: '#123ABC', pageIndex: 7 } })

  const saved = await store.save([item], null)
  assert.deepEqual(saved.annotations, [item])
  const loaded = await store.read()
  assert.deepEqual(loaded.annotations, [item])
  assert.equal(typeof loaded.revision, 'string')
  assert.equal(annotationFile(root), path.join(root, 'Archives', 'Annotations', 'example.com', '%2Fdocument.pdf.md'))
  assert.equal(fs.existsSync(annotationFile(root)), true)
})

test('uses the host and encoded canonical path with sorted allowed query parameters', async t => {
  const root = profile(t)
  const queriedSource = 'https://Example.com/document.pdf?utm_source=ignored&page=1&id=2#section'
  await createStore(root, queriedSource).save([annotation()], null)

  const expected = path.join(root, 'Archives', 'Annotations', 'example.com', '%2Fdocument.pdf%3Fid%3D2%26page%3D1.md')
  assert.equal(annotationFile(root, queriedSource), expected)
  assert.equal(fs.existsSync(expected), true)
  assert.deepEqual((await createStore(root, 'https://example.com/document.pdf?id=2&page=1').read()).annotations, [annotation()])
})

test('rejects a stale revision and accepts the latest revision', async t => {
  const store = createStore(profile(t), source)
  const first = await store.save([annotation('first')], null)

  await assert.rejects(
    store.save([annotation('second')], null),
    /Annotations changed on disk/
  )
  const second = await store.save([annotation('second')], first.revision)
  assert.deepEqual((await store.read()).annotations, second.annotations)
})

test('persists an empty deletion snapshot instead of resurrecting annotations', async t => {
  const root = profile(t)
  const store = createStore(root, source)
  const saved = await store.save([annotation('to-delete')], null)

  await store.save([], saved.revision)
  assert.deepEqual((await store.read()).annotations, [])
  assert.deepEqual(annotationMarkdown.parse(fs.readFileSync(annotationFile(root), 'utf8')).annotations, [])
})

test('serializes concurrent writers and rejects the writer with the stale snapshot', async t => {
  const root = profile(t)
  const first = createStore(root, source)
  const second = createStore(root, source)
  const results = await Promise.allSettled([
    first.save([annotation('writer-one')], null),
    second.save([annotation('writer-two')], null)
  ])

  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(results.filter(result => result.status === 'rejected').length, 1)
  assert.match(results.find(result => result.status === 'rejected').reason.message, /Annotations changed on disk/)
  assert.equal((await first.read()).annotations.length, 1)
})

test('enforces annotation count, encoded-size, and field-length schema limits', async t => {
  const store = createStore(profile(t), source)
  const smallAnnotation = index => ({
    uid: `id-${index}`,
    sourceType: 'pdf',
    data: {
      color: '#000000',
      text: '',
      notes: '',
      textBefore: '',
      textAfter: '',
      pageIndex: 0,
      rect: { origin: { x: 0, y: 0 }, size: { width: 0, height: 0 } },
      segmentRects: [{ origin: { x: 0, y: 0 }, size: { width: 0, height: 0 } }]
    }
  })
  const oneThousand = Array.from({ length: 1000 }, (_, index) => smallAnnotation(index))
  const saved = await store.save(oneThousand, null)
  const serializedTooLarge = oneThousand.map(item => ({ ...item, data: { ...item.data, text: 'x'.repeat(780) } }))
  assert.ok(Buffer.byteLength(JSON.stringify(serializedTooLarge)) < maximumBytes, 'validation input remains below 1 MiB')
  assert.throws(
    () => annotationMarkdown.stringify({ version: 1, source, annotations: serializedTooLarge }),
    /Annotation size limit exceeded/
  )
  await assert.rejects(
    store.save(serializedTooLarge, saved.revision),
    /Annotation size limit exceeded/
  )
  assert.throws(
    () => store.save([...oneThousand, annotation('one-too-many')], null),
    /Annotation size limit exceeded|Invalid or duplicate annotation/
  )

  assert.throws(
    () => validateAnnotations([annotation('too-long', { data: { notes: 'x'.repeat(100001) } })]),
    /Invalid annotation text/
  )
  assert.throws(
    () => validateAnnotations(Array.from({ length: 3 }, (_, index) => annotation(`too-large-${index}`, {
      data: {
        text: 'x'.repeat(100000),
        notes: 'x'.repeat(100000),
        textBefore: 'x'.repeat(100000),
        textAfter: 'x'.repeat(100000)
      }
    }))),
    /Annotation size limit exceeded/
  )
  assert.equal(maximumBytes, 1024 * 1024)
})

test('denies symlinked annotation directories and files', async t => {
  const root = profile(t)
  const outside = profile(t)
  fs.mkdirSync(path.join(root, 'Archives'))
  const directory = path.join(root, 'Archives', 'Annotations')
  fs.symlinkSync(outside, directory, 'dir')
  const store = createStore(root, source)
  await assert.rejects(store.read(), /Unsafe annotation directory/)
  await assert.rejects(store.save([annotation()], null), /Unsafe annotation directory/)

  const fileRoot = profile(t)
  const file = annotationFile(fileRoot)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const target = path.join(outside, 'target.md')
  const original = 'outside bytes\n'
  fs.writeFileSync(target, original)
  fs.symlinkSync(target, file)
  const fileStore = createStore(fileRoot, source)
  await assert.rejects(fileStore.read(), /Unsafe annotation file/)
  await assert.rejects(fileStore.save([annotation()], null), /Unsafe annotation file/)
  assert.equal(fs.readFileSync(target, 'utf8'), original)
})

test('rejects a source-mismatched record without rewriting it', async t => {
  const root = profile(t)
  const file = annotationFile(root)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const original = annotationMarkdown.stringify({ version: 1, source: 'https://other.example/file.pdf', annotations: [] })
  fs.writeFileSync(file, original)
  const store = createStore(root, source)

  await assert.rejects(store.read(), /Annotation source or version mismatch/)
  await assert.rejects(store.save([], null), /Annotation source or version mismatch/)
  assert.equal(fs.readFileSync(file, 'utf8'), original)
})

test('ignores old JSON storage and leaves its bytes unchanged', async t => {
  const root = profile(t)
  const jsonFile = legacyJsonFile(root)
  const markdownFile = annotationFile(root)
  const items = [annotation('legacy-id')]
  const original = JSON.stringify({ version: 1, source, annotations: items }, null, 2) + '\n'
  fs.mkdirSync(path.dirname(jsonFile), { recursive: true })
  fs.writeFileSync(jsonFile, original)
  const store = createStore(root, source)

  assert.deepEqual(await store.read(), { revision: null, annotations: [] })
  await store.save(items, null)
  assert.deepEqual(annotationMarkdown.parse(fs.readFileSync(markdownFile, 'utf8')).annotations, items)
  assert.equal(fs.readFileSync(jsonFile, 'utf8'), original)
})

test('preserves existing plugin Markdown title and tags when editing annotations', async t => {
  const root = profile(t)
  const markdownFile = annotationFile(root)
  const original = annotationMarkdown.stringify({
    version: 1,
    source,
    title: 'Plugin title | with a pipe',
    tags: '#annotation #research',
    annotations: [annotation('plugin-id')]
  })
  fs.mkdirSync(path.dirname(markdownFile), { recursive: true })
  fs.writeFileSync(markdownFile, original)
  const store = createStore(root, source)
  const loaded = await store.read()
  await store.save([annotation('edited-id', { data: { notes: 'edited' } })], loaded.revision)

  const edited = annotationMarkdown.parse(fs.readFileSync(markdownFile, 'utf8'))
  assert.equal(edited.title, 'Plugin title | with a pipe')
  assert.equal(edited.tags, '#annotation #research')
  assert.equal(edited.annotations[0].uid, 'edited-id')
  assert.equal(edited.annotations[0].data.notes, 'edited')
})

test('rejects colliding HTTP and HTTPS sources without changing the existing file', async t => {
  const root = profile(t)
  const httpSource = 'http://example.com/document.pdf'
  const httpStore = createStore(root, httpSource)
  await httpStore.save([annotation('http-id')], null)
  const file = annotationFile(root, httpSource)
  const original = fs.readFileSync(file)

  assert.equal(file, annotationFile(root, source))
  const httpsStore = createStore(root, source)
  await assert.rejects(httpsStore.read(), /Annotation source or version mismatch/)
  await assert.rejects(httpsStore.save([annotation('https-id')], null), /Annotation source or version mismatch/)
  assert.deepEqual(fs.readFileSync(file), original)
})

test('cancels before writing when current returns false, including after an await', async t => {
  const root = profile(t)
  const store = createStore(root, source)
  await assert.rejects(store.save([annotation()], null, () => false), /Document or vault changed/)
  assert.equal(fs.existsSync(path.join(root, 'Archives')), false)

  let checks = 0
  await assert.rejects(
    store.save([annotation('after-await')], null, () => ++checks < 2),
    /Document or vault changed/
  )
  assert.equal(fs.existsSync(annotationFile(root)), false)
})

test('preserves malformed on-disk data on read and attempted save', async t => {
  const root = profile(t)
  const file = annotationFile(root)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const original = '| Field | Value |\nthis is not valid plugin Markdown\n'
  fs.writeFileSync(file, original)
  const store = createStore(root, source)

  await assert.rejects(store.read(), /Malformed annotation Markdown|Invalid legacy annotation Markdown/)
  await assert.rejects(store.save([], null), /Malformed annotation Markdown|Invalid legacy annotation Markdown/)
  assert.equal(fs.readFileSync(file, 'utf8'), original)
})

test('missing vault is an error, while missing annotation storage is empty', async t => {
  const root = profile(t)
  assert.deepEqual(await createStore(root, source).read(), { revision: null, annotations: [] })
  const missing = createStore(path.join(root, 'missing'), source)
  await assert.rejects(missing.read(), /Vault unavailable/)
  await assert.rejects(missing.save([], null), /Vault unavailable/)
})

test('rejects invalid UTF-8 and oversized files without replacing their bytes', async t => {
  const root = profile(t)
  const file = annotationFile(root)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const store = createStore(root, source)
  const text = annotationMarkdown.stringify({ version: 1, source, annotations: [annotation('utf8')] })
  const invalid = Buffer.from(text)
  invalid[invalid.indexOf('selected text')] = 0xff
  fs.writeFileSync(file, invalid)
  await assert.rejects(store.read(), /encoded data|encoding/i)
  await assert.rejects(store.save([], null), /encoded data|encoding/i)
  assert.deepEqual(fs.readFileSync(file), invalid)
  fs.writeFileSync(file, Buffer.alloc(maximumBytes + 1, 32))
  await assert.rejects(store.read(), /Unsafe annotation file/)
  assert.equal(fs.statSync(file).size, maximumBytes + 1)
})

test('unchanged saves preserve the revision and existing file metadata', async t => {
  const root = profile(t)
  const store = createStore(root, source)
  const items = [annotation()]
  const saved = await store.save(items, null)
  const file = annotationFile(root)
  fs.utimesSync(file, new Date(0), new Date(0))
  const before = fs.statSync(file)
  assert.deepEqual(await store.save(items, saved.revision), saved)
  const after = fs.statSync(file)
  assert.equal(after.ino, before.ino)
  assert.equal(after.mtimeMs, before.mtimeMs)
})
