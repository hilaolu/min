const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const search = require('../main/vaultContentSearch.js')

async function fixture (t, prefix = 'min-content-search-') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  return root
}

test('content search finds python in notes, not filenames; groups by file and highlights the best line', async t => {
  const root = await fixture(t)
  await fs.mkdir(path.join(root, 'nested'))
  await fs.writeFile(path.join(root, 'nested', 'notes.md'), 'intro\nLearn Python programming here.\nPython again.')
  await fs.writeFile(path.join(root, 'python.md'), 'An unrelated topic.')
  const result = await search(root, 'vault://', 'python')
  assert.equal(result.total, 1)
  assert.equal(result.entries[0].relativePath, 'nested/notes.md')
  const passage = result.entries[0].passage
  assert.equal(passage.line, 2)
  assert.deepEqual(passage.ranges.map(([a, b]) => passage.text.slice(a, b)), ['Python'])
  assert.equal(result.truncated, false)
  assert.equal((await search(root, 'vault://', 'pythn')).total, 1)
  assert.equal((await search(root, 'vault://', 'pythn', () => true, { exact: true })).total, 0)
  assert.equal((await search(root, 'vault://', ' ', () => true)).ok, false)
})

test('content search respects scope, skips binaries and symlinks, and cancels', async t => {
  const root = await fixture(t)
  await fs.mkdir(path.join(root, 'nested'))
  await fs.writeFile(path.join(root, 'outside.md'), 'python')
  await fs.symlink(path.join(root, 'outside.md'), path.join(root, 'nested', 'link.md'))
  await fs.writeFile(path.join(root, 'nested', 'binary.md'), Buffer.from('python\0data'))
  await fs.writeFile(path.join(root, 'nested', 'document.pdf'), 'python')
  await fs.writeFile(path.join(root, 'nested', 'invalid.md'), Buffer.from([0xff, 0xfe]))
  const result = await search(root, 'vault://nested/', 'python')
  assert.equal(result.total, 0)
  assert.equal(result.skipped, 4)
  await assert.rejects(search(root, 'vault://', 'python', () => false), /canceled/)
})

test('content search excludes hidden paths and an explicitly scoped hidden folder', async t => {
  const root = await fixture(t, '.min-content-search-')
  await fs.writeFile(path.join(root, 'visible.note.md'), 'hidden-path regression phrase')
  await fs.writeFile(path.join(root, '.hidden.md'), 'hidden-path regression phrase')
  await fs.mkdir(path.join(root, '.hidden-folder'))
  await fs.writeFile(path.join(root, '.hidden-folder', 'descendant.md'), 'hidden-path regression phrase')
  await fs.mkdir(path.join(root, 'visible', '.nested-hidden'), { recursive: true })
  await fs.writeFile(path.join(root, 'visible', '.nested-hidden', 'descendant.md'), 'hidden-path regression phrase')

  const result = await search(root, 'vault://', 'hidden-path regression phrase', () => true, { exact: true })
  assert.deepEqual(result.entries.map(entry => entry.relativePath), ['visible.note.md'])

  const scoped = await search(root, 'vault://.hidden-folder/', 'hidden-path regression phrase', () => true, { exact: true })
  assert.equal(scoped.total, 0)
  assert.deepEqual(scoped.entries, [])
})

test('content search finds long-line boundary matches and reports file-size truncation', async t => {
  const root = await fixture(t)
  await fs.writeFile(path.join(root, 'long.txt'), 'x'.repeat(1022) + 'python' + 'y'.repeat(600))
  let result = await search(root, 'vault://', 'python', () => true, { exact: true })
  assert.equal(result.total, 1)
  assert.ok(result.entries[0].passage.text.length < 1000)
  await fs.writeFile(path.join(root, 'large.txt'), 'x'.repeat(4 * 1024 * 1024) + '\npython')
  result = await search(root, 'vault://', 'python', () => true, { exact: true })
  assert.equal(result.total, 1)
  assert.equal(result.scanLimited, true)
  assert.ok(result.notes.some(note => note.includes('4 MiB')))
})

test('content matches outrank fuzzy matches and result counts survive limiting', async t => {
  const root = await fixture(t)
  await fs.writeFile(path.join(root, 'fuzzy.md'), 'Python')
  for (let i = 0; i < 30; i++) await fs.writeFile(path.join(root, 'note-' + i + '.txt'), 'pythn')
  const result = await search(root, 'vault://', 'pythn', () => true, { limit: 25 })
  assert.equal(result.total, 31)
  assert.equal(result.entries.length, 25)
  assert.equal(result.truncated, true)
  assert.equal(result.entries[0].score, 1)
  assert.ok(result.entries.every(entry => entry.name !== 'fuzzy.md'))
  const full = await search(root, 'vault://', 'pythn', () => true, { limit: 50 })
  assert.deepEqual(result.entries, full.entries.slice(0, 25), 'bounded results preserve complete ranking')
  assert.equal(full.truncated, false)
})

test('matching stays literal for regex metacharacters and yields to cancellation during a large scan', async t => {
  const root = await fixture(t)
  await fs.writeFile(path.join(root, 'note.txt'), 'intro\nLiteral [a+b].* <img src=x> 雪\n')
  for (const query of ['[a+b].*', '<img src=x>', '雪']) {
    const result = await search(root, 'vault://', query, () => true, { exact: true })
    assert.equal(result.total, 1)
    const { text, ranges } = result.entries[0].passage
    assert.equal(text.slice(...ranges[0]), query)
  }
  await fs.writeFile(path.join(root, 'large.txt'), 'unrelated text\n'.repeat(100000))
  let checks = 0
  await assert.rejects(search(root, 'vault://', 'absent', () => ++checks < 20), /canceled/)
  assert.ok(checks >= 20)
})
