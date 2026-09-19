const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { createNote, maximumBytes } = require('../main/vaultNotes.js')

function temporaryVault (t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'min-vault-notes-'))
  t.after(() => fs.promises.rm(root, { force: true, recursive: true }))
  return root
}

function noteURL (relativePath = 'note.md') {
  return `vault://${relativePath}`
}

test('read and no-op save preserve UTF-8 source bytes, BOM, CRLF, and relative references', async function (t) {
  const root = temporaryVault(t)
  const notePath = path.join(root, 'note.md')
  fs.mkdirSync(path.join(root, 'images'))
  fs.writeFileSync(path.join(root, 'images', 'diagram.png'), Buffer.from([1, 2, 3]))
  const source = '# Café\r\n\r\n![diagram](images/diagram.png)\r\n'
  const decodedSource = '\ufeff' + source
  const originalBytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(source)])
  fs.writeFileSync(notePath, originalBytes)

  const note = createNote(root, noteURL())
  assert.equal(await note.read(), decodedSource)
  const before = fs.statSync(notePath)

  assert.deepEqual(await note.save(decodedSource), { ok: true })

  const after = fs.statSync(notePath)
  assert.equal(after.ino, before.ino)
  assert.deepEqual(fs.readFileSync(notePath), originalBytes)
})

test('changed saves are atomic and can be read back', async function (t) {
  const root = temporaryVault(t)
  const notePath = path.join(root, 'note.md')
  fs.writeFileSync(notePath, 'before\n')
  const note = createNote(root, noteURL())
  await note.read()

  const changed = 'after\nwith UTF-8: ✓\n'
  assert.deepEqual(await note.save(changed), { ok: true })
  assert.equal(fs.readFileSync(notePath, 'utf8'), changed)
  assert.equal(await note.read(), changed)
  assert.deepEqual(fs.readdirSync(root), ['note.md'])
})

test('an external conflict leaves disk intact and a later queued retry succeeds', async function (t) {
  const root = temporaryVault(t)
  const notePath = path.join(root, 'note.md')
  const original = 'original\n'
  const external = 'changed elsewhere\n'
  fs.writeFileSync(notePath, original)
  const note = createNote(root, noteURL())
  await note.read()

  fs.writeFileSync(notePath, external)
  await assert.rejects(note.save('discarded\n'), { message: 'MARKDOWN_EXTERNAL_CHANGE' })
  assert.equal(fs.readFileSync(notePath, 'utf8'), external)

  fs.writeFileSync(notePath, original)
  await assert.doesNotReject(note.save('retry\n'))
  assert.equal(fs.readFileSync(notePath, 'utf8'), 'retry\n')
})

test('concurrent saves serialize and the last snapshot wins', async function (t) {
  const root = temporaryVault(t)
  const notePath = path.join(root, 'note.md')
  fs.writeFileSync(notePath, 'initial\n')
  const note = createNote(root, noteURL())
  await note.read()

  const first = note.save('first\n')
  const second = note.save('second\n')
  assert.deepEqual(await Promise.all([first, second]), [{ ok: true }, { ok: true }])
  assert.equal(fs.readFileSync(notePath, 'utf8'), 'second\n')
  assert.equal(await note.read(), 'second\n')
})

test('rejects oversized and non-string note content', async function (t) {
  const root = temporaryVault(t)
  const notePath = path.join(root, 'note.md')
  fs.writeFileSync(notePath, 'valid\n')
  const note = createNote(root, noteURL())
  await note.read()

  await assert.rejects(note.save('x'.repeat(maximumBytes + 1)), { message: 'MARKDOWN_SIZE_OR_TYPE' })
  await assert.rejects(note.save(null), { message: 'MARKDOWN_SIZE_OR_TYPE' })
  assert.equal(fs.readFileSync(notePath, 'utf8'), 'valid\n')

  fs.writeFileSync(notePath, Buffer.alloc(maximumBytes + 1, 0x61))
  await assert.rejects(createNote(root, noteURL()).read(), { message: 'MARKDOWN_SIZE_OR_TYPE' })
})

test('rejects a symlinked note path', async function (t) {
  const root = temporaryVault(t)
  const outside = path.join(root, '..', `${path.basename(root)}-outside.md`)
  const notePath = path.join(root, 'note.md')
  t.after(() => fs.rmSync(outside, { force: true }))
  fs.writeFileSync(outside, 'outside\n')
  fs.symlinkSync(outside, notePath)

  await assert.rejects(createNote(root, noteURL()).read(), /Vault resource unavailable/)
})
