const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const electron = require('electron')
const { app, webContents, dialog } = electron
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'min-vault-app-'))
const root = path.join(temp, 'vault')
const nextRoot = path.join(temp, 'next')
fs.mkdirSync(root)
fs.mkdirSync(nextRoot)
fs.writeFileSync(path.join(root, 'note.md'), '# Initial\n')
fs.writeFileSync(path.join(root, 'Report.pdf'), '')
fs.writeFileSync(path.join(nextRoot, 'note.md'), '# Other vault\n')
fs.writeFileSync(path.join(nextRoot, 'next-root-only.md'), '# Next root\n')
fs.writeFileSync(path.join(temp, 'vault-root.json'), JSON.stringify({ root }))
app.setPath('userData', temp)
app.disableHardwareAcceleration()
let response = 2
let prompts = 0
dialog.showMessageBox = async () => { prompts++; return { response } }
let pickerCalls = 0
dialog.showOpenDialog = async () => { pickerCalls++; throw new Error('Vault must not open a system directory picker') }
const main = require('../main/index.js')({ electron })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until (fn, label) {
  for (let i = 0; i < 300; i++) { const value = await fn(); if (value) return value; await sleep(50) }
  throw new Error('Timed out: ' + label)
}
async function assertPaletteResult (chrome, query, expected) {
  chrome.focus()
  chrome.sendInputEvent({ type: 'keyDown', keyCode: '.', modifiers: ['control'] })
  chrome.sendInputEvent({ type: 'keyUp', keyCode: '.', modifiers: ['control'] })
  await chrome.executeJavaScript(`(() => {
    const input = document.getElementById('command-palette-input')
    if (!input) throw new Error('Command palette input not found')
    input.value = ${JSON.stringify(query)}
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  const overlay = await until(() => webContents.getAllWebContents().find(c => c.getURL() === 'min://app/pages/commandPalette/overlay.html'), 'command palette overlay')
  for (let i = 0; i < 200; i++) {
    const candidates = await overlay.executeJavaScript("Array.from(document.querySelectorAll('.command-suggestion'), element => ({ id: element.dataset.key, title: element.querySelector('.command-suggestion-title')?.textContent }))")
    const error = candidates.find(candidate => candidate.id === 'vault-error')
    if (error) throw new Error(`Command palette search failed for ${query}: ${error.title}`)
    if (candidates.some(candidate => candidate.title === expected)) return
    await sleep(50)
  }
  throw new Error(`Timed out waiting for command palette result ${expected} from ${query}`)
}
const deadline = setTimeout(() => { console.error('App acceptance timeout'); app.exit(1) }, 90000)
async function run () {
  await app.whenReady()
  const win = await until(() => main.windows.getAll()[0], 'browser window')
  const chrome = main.windows.getChromeContents(win)
  await until(() => !chrome.isLoading(), 'browser chrome')
  await until(() => chrome.executeJavaScript("!!document.getElementById('command-palette-input')").catch(() => false), 'command palette input')
  await assertPaletteResult(chrome, '>m note', 'note.md')
  await assertPaletteResult(chrome, '>p Report', 'Report.pdf')
  main.windows.send(win, 'addTab', { url: 'vault://note.md' })
  const note = await until(() => webContents.getAllWebContents().find(c => c.getURL().startsWith('min://app/pages/markdown/index.html')), 'real tab routing')
  await until(() => note.executeJavaScript('typeof cherry !== "undefined" && !!cherry').catch(() => false), 'Cherry ready')
  await note.executeJavaScript("cherry.setMarkdown('# Dirty')")
  let before = prompts
  win.close()
  await until(() => prompts > before, 'window close prompt')
  await sleep(100)
  assert.equal(win.isDestroyed(), false)
  assert.equal(await note.executeJavaScript('window.vaultEditorState().dirty'), true)
  before = prompts
  note.focus()
  note.sendInputEvent({ type: 'keyDown', keyCode: 'w', modifiers: ['control'] })
  note.sendInputEvent({ type: 'keyUp', keyCode: 'w', modifiers: ['control'] })
  await until(() => prompts > before, 'tab close prompt')
  await sleep(100)
  assert.equal(note.isDestroyed(), false)
  const second = main.windows.create()
  const secondChrome = main.windows.getChromeContents(second)
  await until(() => !secondChrome.isLoading() && secondChrome.getURL().startsWith('min://app/'), 'second window chrome')
  let duplicate
  app.once('web-contents-created', (event, contents) => { duplicate = contents })
  main.windows.send(second, 'addTab', { url: 'vault://note.md' })
  await until(() => duplicate && duplicate.isDestroyed(), 'duplicate tab retired after focusing owner')
  assert.equal(webContents.getAllWebContents().filter(c => c.getURL().startsWith('min://app/pages/markdown/index.html')).length, 1)
  before = prompts
  app.quit()
  await until(() => prompts > before, 'quit prompt')
  await sleep(100)
  assert.equal(win.isDestroyed(), false)
  const id = main.viewManager.getTabIDFromWebContents(note)
  assert.equal(await main.viewManager.executeTabContentCommand(chrome, { id, operation: 'navigation.reload' }), false)
  // Test the actual shortcut path, including Electron's menu accelerator.
  response = 0
  note.focus()
  note.sendInputEvent({ type: 'keyDown', keyCode: 's', modifiers: ['control'] })
  note.sendInputEvent({ type: 'keyUp', keyCode: 's', modifiers: ['control'] })
  await until(() => fs.readFileSync(path.join(root, 'note.md'), 'utf8') === '# Dirty', 'Ctrl+S writes source')
  await note.executeJavaScript("cherry.setMarkdown('# Root change buffer')")
  response = 2
  main.windows.send(win, 'addTab', { url: 'min://app/pages/settings/index.html' })
  const settings = await until(() => webContents.getAllWebContents().find(c => c.getURL() === 'min://app/pages/settings/index.html'), 'Settings tab')
  await until(() => !settings.isLoading(), 'Settings ready')
  await until(() => settings.executeJavaScript(`document.getElementById('vault-root-path').value === ${JSON.stringify(root)}`), 'saved directory restored to Settings')
  const submitDirectory = async directory => {
    await settings.executeJavaScript(`document.getElementById('vault-root-path').value = ${JSON.stringify(directory)}; document.getElementById('vault-root-form').requestSubmit()`)
    await until(() => settings.executeJavaScript("!document.getElementById('select-vault-root').disabled"), 'directory submission')
    return settings.executeJavaScript("document.getElementById('vault-root-status').textContent")
  }
  const promptsBeforeNoOp = prompts
  assert.equal(await submitDirectory(root + path.sep), 'Saved')
  assert.equal(prompts, promptsBeforeNoOp, 'reapplying the same directory must not prompt or close notes')
  assert.equal(await note.executeJavaScript('window.vaultEditorState().dirty'), true)
  for (const invalid of ['relative/path', path.join(temp, 'missing'), path.join(root, 'note.md')]) {
    assert.match(await submitDirectory(invalid), /absolute path to an existing, accessible directory/)
    assert.equal(JSON.parse(fs.readFileSync(path.join(temp, 'vault-root.json'))).root, root)
    assert.equal(note.isDestroyed(), false)
  }
  assert.equal(await submitDirectory(nextRoot), 'Unchanged')
  assert.equal(JSON.parse(fs.readFileSync(path.join(temp, 'vault-root.json'))).root, root)
  assert.equal(await note.executeJavaScript('window.vaultEditorState().dirty'), true)
  response = 0
  assert.equal(await submitDirectory(nextRoot), 'Saved')
  assert.equal(pickerCalls, 0)
  assert.equal(note.isDestroyed(), true, 'old root editor closed before commit')
  assert.equal(fs.readFileSync(path.join(root, 'note.md'), 'utf8'), '# Root change buffer')
  assert.equal(fs.readFileSync(path.join(nextRoot, 'note.md'), 'utf8'), '# Other vault\n')
  assert.equal(JSON.parse(fs.readFileSync(path.join(temp, 'vault-root.json'))).root, nextRoot)
  await assertPaletteResult(chrome, '>m next-root-only', 'next-root-only.md')
  await main.viewManager.executeTabContentCommand(chrome, { id: main.viewManager.getTabIDFromWebContents(settings), operation: 'lifecycle.destroy' })
  main.windows.send(win, 'addTab', { url: 'min://app/pages/settings/index.html' })
  const reopened = await until(() => webContents.getAllWebContents().find(c => c !== settings && c.getURL() === 'min://app/pages/settings/index.html'), 'reopened Settings')
  await until(() => !reopened.isLoading(), 'reopened Settings loaded')
  await until(() => reopened.executeJavaScript(`document.getElementById('vault-root-path')?.value === ${JSON.stringify(nextRoot)}`).catch(() => false), 'saved directory visible after reopening Settings')
  console.log('PASS full app: bundled palette vault search, production tabs, Ctrl+S, native window-close/quit cancellation, reload guard, Settings root Save/Cancel/close-before-commit')
}
run().then(() => finish(0), error => { console.error(error); finish(1) })
function finish (code) {
  clearTimeout(deadline)
  main.filtering.destroy()
  main.places.destroy()
  // app.exit deliberately bypasses lifecycle only for test teardown.
  fs.rmSync(temp, { recursive: true, force: true })
  app.exit(code)
}
