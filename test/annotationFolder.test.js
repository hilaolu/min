const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createStore } = require('../main/annotationStore.js')
const { discover } = require('../main/annotatedResourceSearch.js')
const { normalizeFolder } = require('../main/annotationPaths.js')
const annotationMarkdown = require('../main/annotationMarkdown.js')
const createIndex = require('../main/vaultFileIndex.js')
const createMode = require('../main/vaultMode.js')

const source = 'https://example.com/article'
const annotation = { uid: 'web-id', sourceType: 'webpage', data: { color: '#ffcd45', text: 'quote', notes: 'note', textBefore: '', textAfter: '' } }
function profile (t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'min-annotation-folder-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

test('annotation paths are relative, bounded and matched by directory boundaries', () => {
  assert.equal(normalizeFolder(' Research/Annotations/ '), 'Research/Annotations')
  for (const value of ['', '/', '../outside', 'notes/../outside', '/absolute', 'C:\\notes', 'a//b', '.secret/notes', 'a/.secret', 'node_modules/notes', 'a\0b', 'CON']) {
    assert.throws(() => normalizeFolder(value))
  }
})

test('configured storage creates safe nested folders without falling back to another store', async t => {
  const root = profile(t)
  await createStore(root, source).save([annotation], null)
  const folder = 'Research/Annotations'
  const store = createStore(root, source, folder)
  assert.deepEqual(await store.read(), { revision: null, annotations: [] })
  const saved = await store.save([annotation], null)
  assert.equal((await discover(root, () => true, undefined, folder)).resources.length, 1)
  await store.save([], saved.revision)
  assert.deepEqual((await store.read()).annotations, [])
  assert.equal(fs.readdirSync(path.join(root, folder)).length, 1)
  assert.deepEqual((await discover(root, () => true, undefined, folder)).resources, [])
  assert.deepEqual((await createStore(root, source).read()).annotations, [annotation], 'other folders are not moved or overwritten')
  fs.symlinkSync(root, path.join(root, 'linked'), 'dir')
  await assert.rejects(createStore(root, source, 'linked/Annotations').save([], null), /Unsafe annotation directory/)
})

test('>m excludes the configured subtree, not prefix siblings; >a still discovers its annotations', async t => {
  const root = profile(t)
  await createStore(root, source, 'Research/Annotations').save([annotation], null)
  fs.writeFileSync(path.join(root, 'Research/Annotations', 'legacy-note.md'), '# also excluded')
  fs.mkdirSync(path.join(root, 'Research/Annotations-extra'))
  fs.writeFileSync(path.join(root, 'Research/Annotations-extra', 'ordinary.md'), '# keep')
  fs.writeFileSync(path.join(root, 'note.md'), '# keep')
  const index = createIndex(root, 'Research/Annotations')
  t.after(() => index.close())
  assert.deepEqual((await index.search('')).entries.map(item => item.relativePath).sort(), ['Research/Annotations-extra/ordinary.md', 'note.md'])
  const resources = await index.searchAnnotations('a', '')
  assert.equal(resources.entries.length, 1)
  assert.equal(resources.entries[0].source, source)
})

test('hidden annotation records are neither discovered nor used as a storage fallback', async t => {
  const root = profile(t)
  await createStore(root, source).save([annotation], null)
  const hiddenFolder = path.join(root, '.hidden-records')
  fs.renameSync(path.join(root, 'Archives', 'Annotations'), hiddenFolder)
  assert.deepEqual(await createStore(root, source).read(), { revision: null, annotations: [] })
  assert.deepEqual((await discover(root)).resources, [])
  const index = createIndex(root)
  t.after(() => index.close())
  assert.deepEqual((await index.search('')).entries, [])
  assert.deepEqual((await index.searchAnnotations('a', '')).entries, [])
  await createStore(root, source).save([], null)
  assert.equal(fs.readdirSync(hiddenFolder).length, 1, 'hidden records are left untouched')
})

test('direct discovery and watcher snapshots use only the configured folder', async t => {
  const root = profile(t)
  const selected = 'Archives/Annotations'
  const secondSource = 'https://example.com/second'
  const secondAnnotation = { ...annotation, uid: 'second-id' }

  await createStore(root, source, selected).save([annotation], null)
  await createStore(root, secondSource, selected).save([secondAnnotation], null)
  await createStore(root, source, 'Archive/Annotations').save([{ ...annotation, uid: 'singular-duplicate' }], null)
  await createStore(root, source, 'Archives/Annotations-extra').save([{ ...annotation, uid: 'prefix-duplicate' }], null)
  await createStore(root, secondSource, 'Other/Annotations').save([{ ...secondAnnotation, uid: 'other-duplicate' }], null)

  const direct = await discover(root, () => true, undefined, selected)
  assert.equal(direct.errors, 0)
  assert.deepEqual(direct.resources.map(item => item.source).sort(), [secondSource, source].sort())

  const index = createIndex(root, selected)
  const missingIndex = createIndex(root, 'Missing/Annotations')
  t.after(async () => {
    await index.close()
    await missingIndex.close()
  })
  const watched = await index.searchAnnotations('a', '')
  assert.equal(watched.errors, 0)
  assert.deepEqual(watched.entries.map(item => item.source).sort(), [secondSource, source].sort())

  const missing = await discover(root, () => true, undefined, 'Missing/Annotations')
  assert.deepEqual(missing.resources, [])
  assert.equal(missing.errors, 0)
  assert.deepEqual((await missingIndex.searchAnnotations('a', '')).entries, [])
})

test('obsolete locations never supply, repair or receive configured annotations', async t => {
  const root = profile(t)
  const folder = 'Chosen/Annotations'
  const text = annotationMarkdown.stringify({ version: 1, source, annotations: [annotation] })
  const obsoleteFiles = [
    ['Archive/Annotations/example.com/%2Farticle.md', text],
    ['.min-annotations/example.com/%2Farticle.md', text],
    ['.min-annotations/' + require('crypto').createHash('sha256').update(source).digest('hex') + '.json', JSON.stringify({ version: 1, source, annotations: [annotation] })]
  ]
  for (const [relative, contents] of obsoleteFiles) {
    const filename = path.join(root, relative)
    fs.mkdirSync(path.dirname(filename), { recursive: true })
    fs.writeFileSync(filename, contents)
  }
  fs.writeFileSync(path.join(root, 'vault-root.json'), JSON.stringify({ root }))
  fs.writeFileSync(path.join(root, 'annotation-folder.json'), JSON.stringify({ folder }))
  const handlers = new Map()
  const frame = { url: source }
  const sender = { mainFrame: frame, session: { isPersistent: () => true } }
  createMode({ userDataPath: root, ipc: { handle: (name, handler) => handlers.set(name, handler) }, dialog: {}, isTab: value => value === sender })
  const invoke = (operation, payload) => handlers.get('web-annotations')({ sender, senderFrame: frame }, operation, payload)
  const store = createStore(root, source, folder)

  // Missing configured storage must not trigger migration or alias lookup.
  assert.deepEqual(await invoke('load'), { ok: true, revision: null, annotations: [] })
  assert.deepEqual(await store.read(), { revision: null, annotations: [] })
  const missing = await discover(root, () => true, undefined, folder)
  assert.deepEqual(missing.resources, [])
  assert.equal(missing.errors, 0)
  const index = createIndex(root, folder)
  try {
    assert.deepEqual((await index.searchAnnotations('a', '')).entries, [])
  } finally { await index.close() }
  assert.equal(fs.existsSync(path.join(root, folder)), false)

  const selected = { ...annotation, uid: 'selected-id' }
  const saved = await invoke('save', { revision: null, annotations: [selected] })
  assert.equal(saved.ok, true)
  assert.deepEqual((await invoke('load')).annotations, [selected])
  const removed = await invoke('save', { revision: saved.revision, annotations: [] })
  assert.equal(removed.ok, true)
  assert.deepEqual((await invoke('load')).annotations, [])

  // Corruption must remain visible, not be repaired with an obsolete record.
  const filename = path.join(root, folder, 'example.com', '%2Farticle.md')
  fs.writeFileSync(filename, 'malformed %% annotation: record')
  assert.equal((await invoke('load')).ok, false)
  assert.equal((await invoke('save', { revision: removed.revision, annotations: [selected] })).ok, false)
  const invalid = await discover(root, () => true, undefined, folder)
  assert.deepEqual(invalid.resources, [])
  assert.equal(invalid.errors, 1)
  assert.equal(fs.readFileSync(filename, 'utf8'), 'malformed %% annotation: record')
  for (const [relative, contents] of obsoleteFiles) {
    assert.equal(fs.readFileSync(path.join(root, relative), 'utf8'), contents)
  }
})

test('Settings persists the annotation folder, invalidates picker caches and revokes old save bindings', async t => {
  const root = profile(t)
  fs.writeFileSync(path.join(root, 'vault-root.json'), JSON.stringify({ root }))
  fs.mkdirSync(path.join(root, 'Chosen'))
  fs.writeFileSync(path.join(root, 'Chosen', 'hidden.md'), '# ordinary')
  await createStore(root, source).save([annotation], null)
  const handlers = new Map()
  const settingsFrame = { url: 'min://app/pages/settings/index.html' }
  const webFrame = { url: source }
  const settings = { mainFrame: settingsFrame }
  const web = { mainFrame: webFrame, session: { isPersistent: () => true } }
  const settingsEvent = { sender: settings, senderFrame: settingsFrame }
  const webEvent = { sender: web, senderFrame: webFrame }
  const options = { userDataPath: root, ipc: { handle: (name, handler) => handlers.set(name, handler) }, dialog: {}, isTab: sender => [settings, web].includes(sender), isChrome: sender => sender === settings }
  createMode(options)
  const get = () => handlers.get('vault:get-annotation-folder')(settingsEvent)
  const set = folder => handlers.get('vault:set-annotation-folder')(settingsEvent, folder)
  const annotations = (operation, payload) => handlers.get('web-annotations')(webEvent, operation, payload)
  const search = () => handlers.get('vault:search-files')(settingsEvent, 'm', 'hidden')
  assert.deepEqual(get(), { ok: true, folder: 'Archives/Annotations' })
  assert.equal((await search()).entries.length, 1)
  assert.deepEqual((await annotations('load')).annotations, [annotation])
  assert.equal((await set('Chosen')).ok, true)
  assert.equal((await search()).entries.length, 0)
  assert.equal((await annotations('save', { revision: null, annotations: [annotation] })).ok, false)
  assert.deepEqual(await annotations('load'), { ok: true, revision: null, annotations: [] })
  assert.equal((await annotations('save', { revision: null, annotations: [annotation] })).ok, true)
  assert.equal(fs.readdirSync(path.join(root, 'Chosen')).length, 2)
  assert.equal((await handlers.get('vault:set-annotation-folder')(webEvent, 'Other')).ok, false)
  assert.equal((await set('../outside')).ok, false)
  assert.equal(get().folder, 'Chosen')
  await set('Archives/Annotations') // closes the watcher before fixture cleanup
  await set('Chosen')
  createMode(options)
  assert.equal(get().folder, 'Chosen')
})
