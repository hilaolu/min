const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const EventEmitter = require('node:events')
const createVaultMode = require('../main/vaultMode.js')

test('explorer excludes hidden files and folders from listings and recursive search', async t => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'min-vault-list-'))
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }))
  const root = path.join(userDataPath, '.vault')
  for (const name of [
    'note.md',
    'ordinary.file.txt',
    '.note.md',
    '.config',
    '.hidden/note.md',
    'visible/note.md',
    'visible/.note.md',
    'visible/.hidden/note.md'
  ]) {
    const file = path.join(root, name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '')
  }
  fs.writeFileSync(path.join(userDataPath, 'vault-root.json'), JSON.stringify({ root }))
  const handlers = new Map()
  const contents = Object.assign(new EventEmitter(), {
    id: 1,
    mainFrame: { url: '' },
    getURL () { return this.mainFrame.url },
    isDestroyed: () => false
  })
  const mode = createVaultMode({
    userDataPath,
    ipc: { handle: (name, handler) => handlers.set(name, handler) },
    dialog: {},
    isTab: sender => sender === contents
  })
  t.after(() => mode.destroy())
  contents.mainFrame.url = await mode.navigate(contents, 'vault://')
  const event = { sender: contents, senderFrame: contents.mainFrame }
  const list = async (query, directory) => {
    const result = await handlers.get('vault:list')(event, query, directory)
    assert.equal(result.ok, true)
    return result.entries.map(entry => entry.relativePath).sort()
  }
  assert.deepEqual(await list('', 'vault://'), ['note.md', 'ordinary.file.txt', 'visible'])
  assert.deepEqual(await list('', 'vault://visible/'), ['visible/note.md'])
  assert.deepEqual(await list('note'), ['note.md', 'visible/note.md'])
  assert.deepEqual(await list('hidden'), [])
  assert.deepEqual(await list('config'), [])
  assert.deepEqual(await list('file'), ['ordinary.file.txt'])
})

test('explorer opens Markdown in new tabs without replacing its directory', async t => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'min-vault-open-'))
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }))
  const root = path.join(userDataPath, 'vault')
  fs.mkdirSync(root)
  fs.mkdirSync(path.join(root, 'folder.md'))
  for (const name of ['note.md', 'Upper.MD', 'long.markdown', 'Encoded name.md', 'other.txt']) fs.writeFileSync(path.join(root, name), '')
  fs.writeFileSync(path.join(userDataPath, 'vault-root.json'), JSON.stringify({ root }))
  const handlers = new Map()
  const contents = Object.assign(new EventEmitter(), {
    id: 1,
    mainFrame: { url: '' },
    getURL () { return this.mainFrame.url },
    isDestroyed: () => false
  })
  const mode = createVaultMode({
    userDataPath,
    ipc: { handle: (name, handler) => handlers.set(name, handler) },
    dialog: {},
    isTab: sender => sender === contents
  })
  t.after(() => mode.destroy())
  const opened = []
  mode.configure({
    open: (sender, url) => {
      assert.equal(sender, contents)
      opened.push(['current', url])
      return { ok: true }
    },
    openNewTab: (sender, url) => {
      assert.equal(sender, contents)
      opened.push(['new', url])
      return { ok: true }
    }
  })
  contents.mainFrame.url = await mode.navigate(contents, 'vault://')
  const browserURL = contents.getURL()
  const event = { sender: contents, senderFrame: contents.mainFrame }
  const open = url => handlers.get('vault:open')(event, url)
  for (const name of ['note.md', 'Upper.MD', 'long.markdown', 'Encoded%20name.md#heading']) {
    assert.deepEqual(await open('vault://' + name), { ok: true })
    assert.deepEqual(opened.pop(), ['new', 'vault://' + name])
    assert.equal(contents.getURL(), browserURL)
    assert.equal((await handlers.get('vault:list')(event)).ok, true)
  }
  for (const name of ['folder.md/', 'other.txt']) {
    assert.deepEqual(await open('vault://' + name), { ok: true })
    assert.deepEqual(opened.pop(), ['current', 'vault://' + name])
  }
  for (const url of ['vault://missing.md', 'vault://%2e%2e/outside.md', 'file:///outside.md', 'javascript:alert(1)', null]) {
    assert.equal((await open(url)).ok, false)
  }
  assert.equal((await handlers.get('vault:open')({ sender: contents, senderFrame: { url: browserURL } }, 'vault://note.md')).ok, false)
  assert.equal(opened.length, 0)
  assert.deepEqual(await open('https://example.com'), { ok: true })
  assert.deepEqual(opened.pop(), ['new', 'https://example.com'])

  // Navigation revokes the browser while the target is being resolved.
  const pending = open('vault://note.md')
  contents.mainFrame.url = 'https://example.com'
  contents.emit('did-navigate', {}, contents.getURL())
  assert.equal((await pending).ok, false)
  assert.equal(opened.length, 0)

  contents.mainFrame.url = await mode.navigate(contents, 'vault://note.md')
  assert.deepEqual(await open('vault://Upper.MD'), { ok: true })
  assert.deepEqual(opened.pop(), ['current', 'vault://Upper.MD'])
})
