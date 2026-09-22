const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fsSync = require('node:fs')
const fs = require('node:fs/promises')
const { createRequire, wrap } = require('node:module')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')
const createIndex = require('../main/vaultFileIndex.js')
const { createStore } = require('../main/annotationStore.js')

function webNote (title = 'Article', source = 'https://example.com/article?version=2') {
  return `| Field | Value |
| --- | --- |
| Title | ${title} |
| URL | ${source} |
| Tags | #reading |

## Annotations

%% annotation: web-id | color: ffeb3b %%
<pre>before</pre>
<pre>quote</pre>
<pre>after</pre>

My note
`
}

async function fixture (t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'min-file-index-'))
  const index = createIndex(root)
  t.after(async () => {
    await index.close()
    await fs.rm(root, { recursive: true, force: true })
  })
  return { root, index }
}

async function eventually (check) {
  const deadline = Date.now() + 5000
  while (true) {
    try { await check(); return } catch (error) {
      if (Date.now() >= deadline) throw error
      await new Promise(resolve => setTimeout(resolve, 30))
    }
  }
}

function loadIndexWithChokidar (chokidar) {
  const filename = require.resolve('../main/vaultFileIndex.js')
  const indexModule = { exports: {} }
  const localRequire = createRequire(filename)
  const scopedRequire = request => request === 'chokidar' ? chokidar : localRequire(request)
  const context = vm.createContext()
  const factory = vm.runInContext(wrap(fsSync.readFileSync(filename, 'utf8')), context, { filename })
  factory(indexModule.exports, scopedRequire, indexModule, filename, path.dirname(filename))
  return {
    createIndex: indexModule.exports,
    stringPrototype: vm.runInContext('String.prototype', context)
  }
}

test('live index tracks creation, renames, nested removal, and excludes symlinks', async t => {
  const { root, index } = await fixture(t)
  assert.deepEqual((await index.search('')).entries, [])
  await fs.mkdir(path.join(root, 'Nested'))
  await fs.writeFile(path.join(root, 'Nested', 'A #.MD'), '# Not indexed title')
  await fs.writeFile(path.join(root, 'other.txt'), '')
  await eventually(async () => {
    const result = await index.search('NESTED')
    assert.deepEqual(result.entries, [{ relativePath: 'Nested/A #.MD', url: 'vault://Nested/A%20%23.MD' }])
  })
  assert.deepEqual((await index.search('Not indexed title')).entries, [])
  await fs.symlink(path.join(root, 'Nested'), path.join(root, 'linked'))
  await fs.symlink(path.join(root, 'Nested', 'A #.MD'), path.join(root, 'linked.md'))
  await fs.rename(path.join(root, 'Nested', 'A #.MD'), path.join(root, 'Nested', 'B.md'))
  await eventually(async () => {
    assert.deepEqual((await index.search('')).entries.map(e => e.relativePath), ['Nested/B.md'])
  })
  await fs.rm(path.join(root, 'Nested'), { recursive: true })
  await eventually(async () => assert.deepEqual((await index.search('')).entries, []))
})

test('index excludes initial and live hidden paths and drops a visible file renamed hidden', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), '.min-file-index-'))
  await fs.writeFile(path.join(root, 'initial.visible.md'), '')
  await fs.writeFile(path.join(root, '.initial-hidden.md'), '')
  await fs.mkdir(path.join(root, '.initial-hidden-folder'))
  await fs.writeFile(path.join(root, '.initial-hidden-folder', 'descendant.md'), '')
  await fs.mkdir(path.join(root, 'visible', '.nested-hidden'), { recursive: true })
  await fs.writeFile(path.join(root, 'visible', '.nested-hidden', 'descendant.md'), '')
  const index = createIndex(root)
  t.after(async () => {
    await index.close()
    await fs.rm(root, { recursive: true, force: true })
  })

  assert.deepEqual((await index.search('')).entries.map(entry => entry.relativePath), ['initial.visible.md'])

  await fs.writeFile(path.join(root, '.live-hidden.md'), '')
  await fs.mkdir(path.join(root, '.live-hidden-folder'))
  await fs.writeFile(path.join(root, '.live-hidden-folder', 'descendant.md'), '')
  await fs.writeFile(path.join(root, 'live.visible.md'), '')
  await eventually(async () => {
    assert.deepEqual((await index.search('')).entries.map(entry => entry.relativePath), [
      'initial.visible.md',
      'live.visible.md'
    ])
  })

  await fs.rename(path.join(root, 'live.visible.md'), path.join(root, '.renamed-hidden.md'))
  await eventually(async () => {
    assert.deepEqual((await index.search('')).entries.map(entry => entry.relativePath), ['initial.visible.md'])
  })
})

test('initial index has no scan budget, limits results, and honors cancellation and close', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'min-file-index-large-'))
  t.after(async () => {
    await index.close()
    await fs.rm(root, { recursive: true, force: true })
  })
  for (let i = 0; i < 2005; i++) await fs.writeFile(path.join(root, `${String(i).padStart(4, '0')}.md`), '')
  const index = createIndex(root)
  assert.equal((await index.search('2004')).entries.length, 1)
  const result = await index.search('')
  assert.equal(result.entries.length, 20)
  assert.equal(result.truncated, true)
  assert.equal(result.entries[0].relativePath, '0000.md')
  await assert.rejects(index.search('', () => false), /Vault changed/)
  await index.close()
  await assert.rejects(index.search(''), /Vault changed/)
})

test('cached filename searches retain all broad matches and reset for changed queries', async t => {
  const { root, index } = await fixture(t)
  const filenames = Array.from({ length: 25 }, (_, i) => `broad-${String(i).padStart(2, '0')}${i === 24 ? '-needle' : ''}.md`)
  filenames.push('replacement-only.md')
  await Promise.all(filenames.map(filename => fs.writeFile(path.join(root, filename), '')))

  await eventually(async () => {
    const broad = await index.search('broad-')
    assert.equal(broad.entries.length, 20)
    assert.equal(broad.truncated, true)
  })

  assert.deepEqual((await index.search('broad-24-needle')).entries.map(entry => entry.relativePath), ['broad-24-needle.md'])

  const backspace = await index.search('broad-')
  assert.deepEqual(backspace.entries.map(entry => entry.relativePath), filenames.slice(0, 20))
  assert.equal(backspace.truncated, true)

  assert.deepEqual((await index.search('replacement')).entries.map(entry => entry.relativePath), ['replacement-only.md'])
  assert.deepEqual((await index.search('RePlAcEmEnT-OnLy')).entries.map(entry => entry.relativePath), ['replacement-only.md'])

  const empty = await index.search('')
  assert.deepEqual(empty.entries.map(entry => entry.relativePath), filenames.slice().sort((a, b) => a.localeCompare(b)).slice(0, 20))
  assert.equal(empty.truncated, true)
})

test('watcher changes invalidate a warm filename search cache', async t => {
  const { root, index } = await fixture(t)
  const original = path.join(root, 'cached-original.md')
  const created = path.join(root, 'cached-created.md')
  const renamed = path.join(root, 'renamed-result.md')

  await fs.writeFile(original, '')
  await eventually(async () => {
    assert.deepEqual((await index.search('cached')).entries.map(entry => entry.relativePath), ['cached-original.md'])
  })
  await index.search('cached')

  await fs.writeFile(created, '')
  await eventually(async () => {
    assert.deepEqual((await index.search('cached')).entries.map(entry => entry.relativePath), [
      'cached-created.md',
      'cached-original.md'
    ])
  })
  await index.search('cached-created')

  await fs.rename(created, renamed)
  await eventually(async () => {
    assert.deepEqual((await index.search('renamed')).entries.map(entry => entry.relativePath), ['renamed-result.md'])
    assert.deepEqual((await index.search('cached')).entries.map(entry => entry.relativePath), ['cached-original.md'])
  })
  await index.search('renamed')

  await fs.unlink(renamed)
  await eventually(async () => {
    assert.deepEqual((await index.search('renamed')).entries, [])
  })
})

test('content changes preserve the filename cache while invalidating annotation metadata', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'min-file-index-versions-'))
  const article = path.join(root, 'article.md')
  const middle = path.join(root, 'middle.md')
  const zed = path.join(root, 'zed.md')
  await fs.writeFile(article, webNote('Before edit'))
  await fs.writeFile(middle, '')
  await fs.writeFile(zed, '')

  const watcher = new EventEmitter()
  watcher.close = async () => {}
  let reportWatcher
  const watcherCreated = new Promise(resolve => { reportWatcher = resolve })
  const controlledModule = loadIndexWithChokidar({
    watch: watchedRoot => {
      reportWatcher(watchedRoot)
      return watcher
    }
  })
  const index = controlledModule.createIndex(root)
  const originalLocaleCompare = controlledModule.stringPrototype.localeCompare
  let localeCompareCalls = 0

  try {
    assert.equal(await watcherCreated, root)
    for (const filename of [article, middle, zed]) watcher.emit('add', filename, await fs.stat(filename))
    watcher.emit('ready')

    assert.deepEqual(Array.from((await index.search('')).entries, entry => entry.relativePath), [
      'article.md',
      'middle.md',
      'zed.md'
    ])
    assert.deepEqual((await index.searchAnnotations('a', 'Before edit')).entries.map(entry => entry.title), ['Before edit'])

    controlledModule.stringPrototype.localeCompare = function (...args) {
      localeCompareCalls++
      return originalLocaleCompare.apply(this, args)
    }

    await fs.writeFile(article, webNote('After edit'))
    watcher.emit('change', article, await fs.stat(article))
    assert.deepEqual(Array.from((await index.search('')).entries, entry => entry.relativePath), [
      'article.md',
      'middle.md',
      'zed.md'
    ])
    assert.equal(localeCompareCalls, 0, 'an existing-file change must not re-sort filename entries')
    assert.deepEqual((await index.searchAnnotations('a', 'After edit')).entries.map(entry => entry.title), ['After edit'])

    const added = path.join(root, 'added.md')
    await fs.writeFile(added, '')
    localeCompareCalls = 0
    watcher.emit('add', added, await fs.stat(added))
    assert.deepEqual(Array.from((await index.search('')).entries, entry => entry.relativePath), [
      'added.md',
      'article.md',
      'middle.md',
      'zed.md'
    ])
    assert.ok(localeCompareCalls > 0, 'adding a file must rebuild the sorted filename entries')

    await fs.unlink(middle)
    localeCompareCalls = 0
    watcher.emit('unlink', middle)
    assert.deepEqual(Array.from((await index.search('')).entries, entry => entry.relativePath), [
      'added.md',
      'article.md',
      'zed.md'
    ])
    assert.ok(localeCompareCalls > 0, 'unlinking a file must rebuild the sorted filename entries')
  } finally {
    controlledModule.stringPrototype.localeCompare = originalLocaleCompare
    try {
      await index.close()
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  }
})

test('missing roots fail and closing during initialization settles pending searches', async t => {
  const { root } = await fixture(t)
  const missing = createIndex(path.join(root, 'missing'))
  await assert.rejects(missing.search(''), /Vault resource unavailable/)
  assert.equal(missing.failed, true)
  await missing.close()
  const index = createIndex(root)
  const pending = assert.rejects(index.search(''), /Vault changed/)
  await index.close()
  await pending
})

test('shared index tracks webpage metadata edits, renames and deletion without rereading on queries', async t => {
  const { root, index } = await fixture(t)
  const filename = path.join(root, 'article.md')
  await fs.writeFile(filename, webNote())
  await eventually(async () => assert.equal((await index.searchAnnotations('a', 'Article')).entries.length, 1))
  assert.deepEqual((await index.searchAnnotations('p', '')).entries, [])
  assert.equal((await index.search('article')).entries.length, 1)
  // A warm query must not reopen annotation records or enumerate directories.
  const originalOpen = fs.open
  const originalOpendir = fs.opendir
  fs.open = async () => { throw new Error('Unexpected annotation read') }
  fs.opendir = async () => { throw new Error('Unexpected directory scan') }
  try {
    const result = await index.searchAnnotations('a', 'reading')
    assert.equal(result.entries.length, 1)
    assert.equal(result.entries[0].url, 'https://example.com/article?version=2')
  } finally {
    fs.open = originalOpen
    fs.opendir = originalOpendir
  }
  await fs.writeFile(filename, webNote('Changed title'))
  await eventually(async () => assert.equal((await index.searchAnnotations('a', 'Changed title')).entries.length, 1))
  await fs.rename(filename, path.join(root, 'renamed.md'))
  await eventually(async () => assert.equal((await index.search('renamed')).entries.length, 1))
  assert.equal((await index.searchAnnotations('a', '')).entries.length, 1)
  await fs.unlink(path.join(root, 'renamed.md'))
  await eventually(async () => assert.deepEqual((await index.searchAnnotations('a', '')).entries, []))
  await assert.rejects(index.searchAnnotations('a', '', () => false), /Vault changed/)
})

test('PDF index observes JSON migration, Markdown saves and empty deletion authority', async t => {
  const { root, index } = await fixture(t)
  const source = 'https://example.com/download?id=42'
  const rect = { origin: { x: 1, y: 2 }, size: { width: 3, height: 4 } }
  const annotations = [{ uid: 'pdf-id', sourceType: 'pdf', data: { text: 'quote', notes: '', textBefore: '', textAfter: '', color: '#ffeb3b', pageIndex: 0, rect, segmentRects: [rect] } }]
  assert.deepEqual((await index.searchAnnotations('p', '')).entries, [])
  const directory = path.join(root, 'Annotations')
  await fs.mkdir(directory)
  const jsonFile = path.join(directory, require('crypto').createHash('sha256').update(source).digest('hex') + '.json')
  const json = JSON.stringify({ version: 1, source, annotations })
  await fs.writeFile(jsonFile, json)
  await eventually(async () => {
    const result = await index.searchAnnotations('p', 'id=42')
    assert.equal(result.entries.length, 1)
    assert.equal(new URL(result.entries[0].url).searchParams.get('url'), source)
  })
  const store = createStore(root, source)
  const loaded = await store.read()
  await store.save([], loaded.revision)
  await eventually(async () => assert.deepEqual((await index.searchAnnotations('p', '')).entries, []))
  assert.equal(await fs.readFile(jsonFile, 'utf8'), json)
  assert.deepEqual((await index.search('')).entries, [], 'annotation metadata remains available to annotation search but is hidden from file search')
  assert.deepEqual((await index.searchAnnotations('a', '')).entries, [])
  const empty = await store.read()
  await store.save(annotations, empty.revision)
  await fs.unlink(jsonFile)
  const markdownFile = jsonFile.replace(/\.json$/, '.md')
  await fs.rename(markdownFile, path.join(root, 'moved-record.md'))
  await eventually(async () => assert.equal((await index.searchAnnotations('p', '')).entries.length, 1))
})
