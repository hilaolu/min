const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const EventEmitter = require('node:events')
const createVaultMode = require('../main/vaultMode.js')

function settingsInstance (userDataPath) {
  const handlers = new Map()
  const frame = { url: 'min://app/pages/settings/index.html' }
  const sender = Object.assign(new EventEmitter(), { id: 1, mainFrame: frame })
  const mode = createVaultMode({
    userDataPath,
    ipc: { handle: (name, handler) => handlers.set(name, handler) },
    dialog: {},
    isTab: contents => contents === sender
  })
  return { mode, handlers, event: { sender, senderFrame: frame } }
}

function profile (t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'min-vault-settings-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

test('saved vault directory survives a fresh main-process settings instance', async t => {
  const userDataPath = profile(t)
  const root = path.join(userDataPath, 'My notes')
  fs.mkdirSync(root)
  const first = settingsInstance(userDataPath)
  assert.deepEqual(first.handlers.get('vault:get-root')(first.event), { ok: true, directory: '' })
  const result = await first.handlers.get('vault:select-root')(first.event, root)
  assert.deepEqual(result, { ok: true, directory: fs.realpathSync(root) })
  const reopened = settingsInstance(userDataPath)
  assert.deepEqual(reopened.handlers.get('vault:get-root')(reopened.event), result)
})

test('temporarily unavailable saved directory remains visible after restart', t => {
  const userDataPath = profile(t)
  const root = path.join(userDataPath, 'disconnected-drive')
  fs.writeFileSync(path.join(userDataPath, 'vault-root.json'), JSON.stringify({ root }))
  const reopened = settingsInstance(userDataPath)
  assert.deepEqual(reopened.handlers.get('vault:get-root')(reopened.event), { ok: true, directory: root })
})

test('reapplying the same folder preserves open consumers and configuration', async t => {
  const userDataPath = profile(t)
  const root = fs.realpathSync(userDataPath)
  const config = path.join(userDataPath, 'vault-root.json')
  const original = JSON.stringify({ root })
  fs.writeFileSync(config, original)
  const before = fs.statSync(config)
  const instance = settingsInstance(userDataPath)
  const association = instance.mode.associate(instance.event.sender, { url: 'vault://note.md' })
  const result = await instance.handlers.get('vault:select-root')(instance.event, root + path.sep)
  assert.deepEqual(result, { ok: true, directory: root })
  assert.equal(instance.mode.getAssociation(instance.event.sender), association)
  assert.equal(fs.readFileSync(config, 'utf8'), original)
  assert.equal(fs.statSync(config).ino, before.ino)
  assert.equal(fs.statSync(config).mtimeMs, before.mtimeMs)
})

test('saved directory is disclosed only to the registered Settings main frame', t => {
  const instance = settingsInstance(profile(t))
  const getRoot = instance.handlers.get('vault:get-root')
  assert.equal(getRoot({ sender: {}, senderFrame: instance.event.senderFrame }).ok, false)
  assert.equal(getRoot({ ...instance.event, senderFrame: { url: instance.event.senderFrame.url } }).ok, false)
  instance.event.senderFrame.url = 'min://app/pages/markdown/index.html'
  assert.equal(getRoot(instance.event).ok, false)
})

test('content search is denied from Settings and unmanaged browser frames', async t => {
  const instance = settingsInstance(profile(t))
  const search = instance.handlers.get('vault:search-content')
  assert.equal((await search(instance.event, 'query')).ok, false)
  instance.event.senderFrame.url = 'min://app/pages/vault/index.html'
  assert.equal((await search(instance.event, 'query')).ok, false)
})
