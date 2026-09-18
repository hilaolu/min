/* global Response */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const electron = require('electron')
const { app, BrowserWindow, WebContentsView, session, protocol, net, nativeImage, ipcMain } = electron
const createProtocol = require('../main/minInternalProtocol.js')
const createMode = require('../main/vaultMode.js')
const createViews = require('../main/viewManager.js')
const createUA = require('../main/UASwitcher.js')

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'min-vault-pages-'))
const root = path.join(temp, 'vault')
fs.mkdirSync(root)
fs.writeFileSync(path.join(temp, 'vault-root.json'), JSON.stringify({ root }))
app.setPath('userData', path.join(temp, 'profile'))
app.disableHardwareAcceleration()
const bundle = createProtocol({ net, path, protocol, rootDir: path.resolve(__dirname, '..'), Response })
const windows = []
const views = new Map()
const owners = new Map()
let answer = 2
let focused
const messages = []
const mode = createMode({ userDataPath: temp, ipc: ipcMain, dialog: { showMessageBox: async () => ({ response: answer }) }, isTab: contents => Array.from(views.values()).some(view => view.webContents === contents) })
const settings = { get: () => null }
const ua = createUA({ app, settings, vault: mode })
const installed = new WeakSet()
ipcMain.on('settings:connect', event => { event.returnValue = { revision: 0, values: {} } })
function install (ses) {
  if (installed.has(ses)) return
  installed.add(ses)
  bundle.install(ses)
  mode.install(ses)
  ua.install(ses)
}
app.on('session-created', install)
const deadline = setTimeout(() => { console.error('Production pages timeout'); app.exit(1) }, 90000)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until (fn, label) {
  for (let i = 0; i < 200; i++) { if (await fn()) return; await sleep(50) }
  throw new Error('Timed out: ' + label)
}
function pdfFixture () {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> /Contents 4 0 R >>', '<< /Length 28 >>\nstream\n0 0 1 rg 20 20 100 100 re f\nendstream']
  let text = '%PDF-1.4\n'
  const offsets = [0]
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(text)); text += `${i + 1} 0 obj\n${object}\nendobj\n` })
  const xref = Buffer.byteLength(text)
  text += 'xref\n0 5\n0000000000 65535 f \n' + offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('')
  return text + `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
}

async function run () {
  await app.whenReady()
  install(session.defaultSession)
  const registry = {
    registerTabContent (sender, id, view) { views.set(id, view); owners.set(id, sender); BrowserWindow.fromWebContents(sender).contentView.addChildView(view) },
    removeTabContent (id) { views.delete(id); owners.delete(id) },
    ownsTabContent: (sender, id) => owners.get(id) === sender,
    windowFromContents (contents) {
      const id = Array.from(views.keys()).find(id => views.get(id).webContents === contents)
      const win = BrowserWindow.fromWebContents(owners.get(id) || contents)
      return win ? { win } : null
    },
    attachSelectedTabContent () {},
    presentTabContent () {},
    hideSelectedTabContent () {}
  }
  const manager = createViews({ app, BrowserWindow, WebContentsView, electron, createPrompt () {}, filterPopups: () => true, getWindowWebContents: win => ({ send (channel, message) { messages.push(message); if (message.type === 'vault-focus-requested') focused = message.tabId } }), ipc: ipcMain, path, rootDir: path.resolve(__dirname, '..'), settings, vault: mode, windows: registry })
  fs.mkdirSync(path.join(root, 'Projects/images'), { recursive: true })
  fs.mkdirSync(path.join(root, 'assets'))
  const image = nativeImage.createFromBitmap(Buffer.alloc(64, 255), { width: 4, height: 4 })
  fs.writeFileSync(path.join(root, 'test.jpg'), image.toJPEG(90))
  fs.writeFileSync(path.join(root, 'Projects/images/detail.jpg'), image.toJPEG(90))
  fs.writeFileSync(path.join(root, 'assets/shared.png'), image.toPNG())
  fs.writeFileSync(path.join(root, 'a.txt'), 'alpha')
  fs.writeFileSync(path.join(root, 'b.txt'), 'beta')
  fs.writeFileSync(path.join(root, 'reference.pdf'), pdfFixture())
  const source = '# Note\n\n' + ['images/detail.jpg', '../assets/shared.png', '/test.jpg', 'vault://local/test.jpg', 'vault://test.jpg'].map((url, i) => `![Image ${i}](${url})`).join('\n\n') + '\n'
  for (const privateMode of [false, true]) {
    fs.writeFileSync(path.join(root, 'Projects/note.md'), source)
    const win = new BrowserWindow({ show: false, width: 1000, height: 800 })
    windows.push(win)
    const id = privateMode ? 'private' : 'normal'
    const command = (operation, payload) => manager.executeTabContentCommand(win.webContents, { id, operation, payload })
    await command('lifecycle.create', { private: privateMode, bounds: { x: 0, y: 0, width: 1000, height: 800 } })
    const contents = views.get(id).webContents
    contents.on('console-message', event => console.log('page:', event.message))
    const evaluate = script => contents.executeJavaScript(script)
    const load = async (url, ready) => {
      await command('navigation.load', { url })
      await until(async () => !contents.isLoading() && await evaluate(ready).catch(() => false), url)
    }
    await load('vault://local/', "document.querySelectorAll('#files a').length > 0")
    await evaluate("Array.from(document.querySelectorAll('#files details')).find(d => d.querySelector('a').textContent === 'Projects').open = true")
    await until(() => evaluate("Array.from(document.querySelectorAll('#files a')).some(a => a.textContent === 'Projects/note.md')"), 'expand folder tree')
    await evaluate("document.getElementById('search').value = 'note'; document.getElementById('search').dispatchEvent(new Event('input'))")
    await until(() => evaluate("document.querySelector('#files a')?.textContent === 'Projects/note.md'"), 'recursive search')
    await evaluate("document.querySelector('#files a').click()")
    await until(() => evaluate("typeof cherry !== 'undefined' && !!cherry && document.querySelectorAll('.cherry-previewer img').length === 5").catch(() => false), 'Cherry production page')
    await until(() => evaluate("Array.from(document.querySelectorAll('.cherry-previewer img')).every(i => i.complete && i.naturalWidth > 0 && i.naturalHeight > 0)"), 'five Cherry images')
    assert.equal(await evaluate('cherry.getMarkdown()'), source)
    await evaluate("location.hash = 'note'")
    assert.equal(await evaluate("fetch('vault://local/Projects/note.md').then(r => r.text())"), source)
    const count = views.size
    await evaluate("fetch('vault://test.jpg').then(r => r.arrayBuffer())")
    assert.equal(views.size, count)
    await evaluate("cherry.setMarkdown(cherry.getMarkdown() + '\\nEdited')")
    await evaluate('window.vaultEditorSave()')
    assert.equal(fs.readFileSync(path.join(root, 'Projects/note.md'), 'utf8'), source + '\nEdited')
    assert.equal(await evaluate('window.vaultEditorState().dirty'), false)
    // The acknowledgement belongs only to its captured snapshot.
    await evaluate("cherry.setMarkdown('older'); window.racingSave = window.vaultEditorSave(); cherry.setMarkdown('newer')")
    await evaluate('window.racingSave')
    assert.equal(await evaluate('window.vaultEditorState().dirty'), true)
    assert.equal(fs.readFileSync(path.join(root, 'Projects/note.md'), 'utf8'), 'older')
    fs.writeFileSync(path.join(root, 'Projects/note.md'), 'external')
    assert.equal(await evaluate('window.vaultEditorSave()'), false)
    assert.equal(await evaluate('cherry.getCodeMirror().state.doc.toString()'), 'newer')
    assert.equal(fs.readFileSync(path.join(root, 'Projects/note.md'), 'utf8'), 'external')
    fs.unlinkSync(path.join(root, 'Projects/note.md'))
    assert.equal(await evaluate('window.vaultEditorSave()'), false, 'I/O failure preserves the buffer')
    assert.equal(await evaluate('window.vaultEditorState().dirty'), true)
    answer = 0
    assert.equal(await command('lifecycle.destroy'), false, 'failed Save cannot close the editor')
    assert.equal(contents.isDestroyed(), false)
    fs.writeFileSync(path.join(root, 'Projects/note.md'), 'external')
    answer = 2
    assert.equal(await command('lifecycle.prepare'), false)
    assert.equal(await command('navigation.reload'), false)
    assert.equal(await command('navigation.load', { url: 'vault://local/a.txt' }), false)
    assert.equal(await manager.prepareWindow(win), false)
    assert.equal(await manager.prepareWindow(), false)
    const second = new BrowserWindow({ show: false })
    windows.push(second)
    const otherID = id + '-other'
    await manager.executeTabContentCommand(second.webContents, { id: otherID, operation: 'lifecycle.create', payload: { bounds: { x: 0, y: 0, width: 800, height: 600 } } })
    await manager.executeTabContentCommand(second.webContents, { id: otherID, operation: 'navigation.load', payload: { url: 'vault://local/Projects/note.md?alias=1' } })
    assert.equal(focused, id, 'cross-window canonical editor ownership')
    assert.equal(views.get(otherID).webContents.getURL(), '')
    answer = 1
    await load('vault://local/a.txt', "document.body.innerText.includes('alpha')")
    await load('vault://local/b.txt', "document.body.innerText.includes('beta')")
    await command('navigation.back')
    await until(() => evaluate("document.body.innerText.includes('alpha')"), 'history authorization')
    await load('vault://local/reference.pdf', "document.querySelector('canvas')?.width > 0")
    await until(() => evaluate("Array.from(document.querySelectorAll('canvas')).some(c => { const d = c.getContext('2d').getImageData(0,0,c.width,c.height).data; return d.some((v,i) => i % 4 === 2 && v > d[i-2]) })"), 'actual PDF pixels')
    assert.equal(await evaluate("fetch('vault://local/reference.pdf').then(r => r.status)"), 200)
    assert.equal(await evaluate("fetch('vault://local/a.txt').then(r => r.status)"), 403, 'PDF consumer is source-scoped')
    await load('min://app/pages/pdfViewer/index.html?url=' + encodeURIComponent('vault://local/reference.pdf'), "document.querySelector('canvas')?.width > 0")
    assert.equal(await evaluate("fetch('vault://local/reference.pdf').then(r => r.headers.get('content-type'))"), 'application/pdf')
    await command('lifecycle.destroy')
    await manager.executeTabContentCommand(second.webContents, { id: otherID, operation: 'lifecycle.destroy' })
    console.log('PASS production pages', id)
  }
}
run().then(() => finish(0), error => { console.error(error); finish(1) })
function finish (code) {
  clearTimeout(deadline)
  for (const view of views.values()) if (!view.webContents.isDestroyed()) view.webContents.destroy()
  for (const win of windows) if (!win.isDestroyed()) win.destroy()
  fs.rmSync(temp, { recursive: true, force: true })
  app.exit(code)
}
