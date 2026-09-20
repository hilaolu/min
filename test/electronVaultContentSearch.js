/* global Response */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { app, BrowserWindow, ipcMain, session, protocol, net } = require('electron')
const createMode = require('../main/vaultMode.js')
const createProtocol = require('../main/minInternalProtocol.js')
const createUA = require('../main/UASwitcher.js')

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'min-content-search-ipc-'))
const root = path.join(temporary, 'vault')
fs.mkdirSync(root)
fs.mkdirSync(path.join(root, 'Nested'))
fs.writeFileSync(path.join(root, 'Nested', 'needle.md'), 'padding\n'.repeat(12000) + 'The NEEDLE is here.\n')
fs.writeFileSync(path.join(root, 'Nested', 'notes.md'), 'Intro\nPython programming here.\n')
fs.writeFileSync(path.join(temporary, 'vault-root.json'), JSON.stringify({ root }))
app.setPath('userData', path.join(temporary, 'profile'))
app.disableHardwareAcceleration()
const bundle = createProtocol({ net, path, protocol, rootDir: path.resolve(__dirname, '..'), Response })
let win
const mode = createMode({ userDataPath: temporary, ipc: ipcMain, dialog: {}, isTab: contents => contents === win?.webContents })
const ua = createUA({ app, settings: { get: () => null }, vault: mode })
ipcMain.on('settings:connect', event => { event.returnValue = { revision: 0, values: {} } })
const deadline = setTimeout(() => { console.error('Content search IPC timeout'); app.exit(1) }, 30000)

async function run () {
  await app.whenReady()
  bundle.install(session.defaultSession)
  mode.install(session.defaultSession)
  ua.install(session.defaultSession)
  win = new BrowserWindow({ show: false, webPreferences: { preload: path.resolve(__dirname, '../dist/preload.js'), contextIsolation: true, sandbox: true } })
  const contents = win.webContents
  const url = await mode.navigate(contents, 'vault://')
  await contents.loadURL(url)
  assert.equal(await contents.executeJavaScript("document.getElementById('fuzzy-mode')"), null)
  const listing = await contents.executeJavaScript("vaultPage.listCurrent('')")
  assert.equal(listing.ok, true, JSON.stringify(listing))
  const content = await contents.executeJavaScript("vaultPage.searchContents('python', { exact: true, limit: 25 })")
  assert.equal(content.ok, true, JSON.stringify(content))
  assert.deepEqual(content.entries.map(entry => entry.relativePath), ['Nested/notes.md'])
  assert.equal(content.entries[0].passage.line, 2)
  assert.deepEqual(content.entries[0].passage.ranges.map(([start, end]) => content.entries[0].passage.text.slice(start, end)), ['Python'])

  const approximate = await contents.executeJavaScript("vaultPage.searchContents('pythn', { exact: false, limit: 25 })")
  assert.deepEqual(approximate.entries.map(entry => entry.relativePath), ['Nested/notes.md'])
  const strict = await contents.executeJavaScript("vaultPage.searchContents('pythn', { exact: true, limit: 25 })")
  assert.equal(strict.ok, true)
  assert.equal(strict.entries.length, 0, 'Exact phrase rejects a non-contiguous content match')
  const canceled = await contents.executeJavaScript("Promise.all([vaultPage.searchContents('needle'), vaultPage.cancelContentSearch()])")
  assert.equal(canceled[0].ok, false, 'Cancel stops an active content scan')
  assert.equal(canceled[1].ok, true)

  await contents.executeJavaScript("document.getElementById('files').dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true })); document.getElementById('fuzzy-query').value = 'needle'; document.getElementById('fuzzy-exact').checked = true; document.getElementById('fuzzy-limit').value = '25'; document.getElementById('fuzzy-form').requestSubmit()")
  let rendered = false
  for (let attempt = 0; attempt < 100; attempt++) {
    rendered = await contents.executeJavaScript("document.querySelector('#files .result-snippet')?.textContent.includes('NEEDLE') && document.querySelector('#preview mark')?.textContent === 'NEEDLE' && document.getElementById('preview').textContent.includes('line 12001')")
    if (rendered) break
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.equal(rendered, true, 'Content results render their snapshot and highlight beyond 64 KiB: ' + await contents.executeJavaScript("document.getElementById('status').textContent + ' / ' + document.getElementById('preview').textContent"))

  const badOptions = await contents.executeJavaScript("vaultPage.searchContents('needle', { limit: -1 })")
  assert.equal(badOptions.ok, false)
  assert.match(badOptions.error, /Invalid search options/)
  const invalid = await contents.executeJavaScript("vaultPage.searchContents('x'.repeat(257))")
  assert.equal(invalid.ok, false)
  assert.match(invalid.error, /256 characters/)
  // Loading the page directly must not silently grant it filesystem authority.
  await contents.loadURL('min://app/pages/vault/index.html')
  const disconnected = await contents.executeJavaScript("vaultPage.searchContents('needle', { exact: true, limit: 25 })")
  assert.equal(disconnected.ok, false)
  assert.match(disconnected.error, /Reopen vault:\/\//)
  assert.equal((await contents.executeJavaScript('vaultPage.cancelContentSearch()')).ok, false)
  console.log('PASS production vault preload, content search IPC, UI snippets, validation, and authority checks')
}

run().then(() => finish(0), error => { console.error(error); finish(1) })
async function finish (code) {
  clearTimeout(deadline)
  if (win && !win.isDestroyed()) win.destroy()
  await mode.destroy()
  fs.rmSync(temporary, { recursive: true, force: true })
  app.exit(code)
}
