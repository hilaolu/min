const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const createIndex = require('../main/vaultFileIndex.js')

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
