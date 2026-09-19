const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const createVaultMode = require('../main/vaultMode.js')

function profile (t) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'min-pdf-authority-'))
  const root = path.join(userDataPath, 'vault')
  fs.mkdirSync(root)
  fs.writeFileSync(path.join(root, 'document.pdf'), 'pdf')
  fs.writeFileSync(path.join(userDataPath, 'vault-root.json'), JSON.stringify({ root }))
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }))
  return { userDataPath, root }
}

function sender (url, { kind = 'tab', persistent = true } = {}) {
  const mainFrame = { url }
  return {
    kind,
    id: 1,
    mainFrame,
    session: { isPersistent: () => persistent }
  }
}

function harness (t) {
  const { userDataPath, root } = profile(t)
  const handlers = new Map()
  const mode = createVaultMode({
    userDataPath,
    ipc: { handle: (name, handler) => handlers.set(name, handler) },
    dialog: {},
    isTab: contents => contents.kind === 'tab',
    isChrome: contents => contents.kind === 'chrome'
  })
  t.after(() => handlers.clear())
  return { handler: handlers.get('pdf-annotations'), root, mode }
}

function eventFor (contents, frame = contents.mainFrame) {
  return { sender: contents, senderFrame: frame }
}

test('pdf annotation IPC enforces the viewer, tab, frame, source, and session authority', async t => {
  const { handler, root } = harness(t)
  const annotations = path.join(root, '.min-annotations')
  const viewer = 'min://app/pages/pdfViewer/index.html?url=https://example.com/document.pdf'
  const tab = sender(viewer)

  async function rejected (event, message = 'Annotation caller denied') {
    assert.deepEqual(await handler(event, 'load'), { ok: false, error: message })
    assert.equal(fs.existsSync(annotations), false)
  }

  await rejected(eventFor(sender('http://example.com/document.pdf')))

  const childFrame = { url: viewer }
  await rejected(eventFor(tab, childFrame))

  await rejected(eventFor(sender(viewer, { kind: 'chrome' })))

  await rejected(eventFor(sender('min://app/pages/pdfViewer/index.html?url=vault://local/document.pdf')), 'VAULT_CALLER_DENIED')
  await rejected(eventFor(sender('min://app/pages/pdfViewer/index.html?url=VAULT://local/document.pdf')), 'VAULT_CALLER_DENIED')

  assert.deepEqual(await handler(eventFor(tab), 'load'), {
    ok: true,
    revision: null,
    annotations: []
  })
  assert.equal(fs.existsSync(annotations), false)

  await rejected(
    eventFor(sender(viewer, { persistent: false })),
    'Vault annotations are disabled in private tabs'
  )
})

test('root change admits only the prepared PDF Save to the old vault before switching', async t => {
  const { root, userDataPath } = profile(t)
  const nextRoot = path.join(userDataPath, 'next-vault')
  fs.mkdirSync(nextRoot)
  const handlers = new Map()
  const mode = createVaultMode({
    userDataPath,
    ipc: { handle: (name, handler) => handlers.set(name, handler) },
    dialog: { showMessageBox: async () => ({ response: 0 }) },
    isTab: contents => contents.kind === 'tab'
  })
  const pdf = Object.assign(new (require('node:events').EventEmitter)(), sender('about:blank'))
  pdf.getURL = () => pdf.mainFrame.url
  pdf.isDestroyed = () => false
  pdf.mainFrame.url = await mode.navigate(pdf, 'vault://local/document.pdf')
  const call = (operation, payload) => handlers.get('pdf-annotations')(eventFor(pdf), operation, payload)
  assert.equal((await call('load')).ok, true)
  let saved = false
  pdf.executeJavaScript = async code => {
    if (code.includes('pdfHighlightsPrepare')) return { dirty: true }
    if (code.includes('pdfHighlightsSave()')) {
      assert.equal((await call('load')).ok, false, 'root transition denies new reads')
      const result = await call('save', { revision: null, annotations: [] })
      assert.equal(result.ok, true, result.error)
      saved = true
      return true
    }
    return true
  }
  mode.configure({
    close: async contents => {
      assert.equal(saved, true, 'Save completed before PDF close')
      mode.loadFailed(contents, contents.getURL())
    }
  })
  const settings = sender('min://app/pages/settings/index.html')
  settings.id = 2
  const result = await handlers.get('vault:select-root')(eventFor(settings), nextRoot)
  assert.equal(result.ok, true, result.error)
  assert.equal(fs.readdirSync(path.join(root, '.min-annotations')).length, 1)
  assert.equal(fs.existsSync(path.join(nextRoot, '.min-annotations')), false)
})
