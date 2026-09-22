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
const annotationMarkdown = require('../main/annotationMarkdown.js')

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
let promptCount = 0
let focused
const messages = []
const mode = createMode({ userDataPath: temp, ipc: ipcMain, dialog: { showMessageBox: async () => { promptCount++; return { response: answer } } }, isTab: contents => Array.from(views.values()).some(view => view.webContents === contents) })
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
  const stream = '0 0 1 rg 20 20 100 100 re f\n0 0 0 rg BT /F1 12 Tf 20 160 Td (Highlight this text) Tj ET\n'
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>', `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
  let text = '%PDF-1.4\n'
  const offsets = [0]
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(text)); text += `${i + 1} 0 obj\n${object}\nendobj\n` })
  const xref = Buffer.byteLength(text)
  text += 'xref\n0 6\n0000000000 65535 f \n' + offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('')
  return text + `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
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
  fs.writeFileSync(path.join(root, 'Example 雪#%.jpg'), image.toJPEG(90))
  fs.writeFileSync(path.join(root, 'Projects/images/detail.jpg'), image.toJPEG(90))
  fs.writeFileSync(path.join(root, 'assets/shared.png'), image.toPNG())
  fs.writeFileSync(path.join(root, 'a.txt'), 'alpha')
  fs.writeFileSync(path.join(root, 'b.txt'), 'beta')
  fs.writeFileSync(path.join(root, 'reference.pdf'), pdfFixture())
  const source = '# Note\n\n' + ['images/detail.jpg', '../assets/shared.png', '/test.jpg', 'vault://test.jpg', 'vault://Example%20%E9%9B%AA%23%25.jpg'].map((url, i) => `![Image ${i}](${url})`).join('\n\n') + '\n'
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
    await load('vault://', "document.querySelectorAll('#files .entry').length > 0")
    await evaluate("document.getElementById('files').dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true })); document.getElementById('fuzzy-query').value = '# Note'; document.getElementById('fuzzy-form').requestSubmit()")
    await until(() => evaluate("document.querySelector('#files .entry')?.title === 'Projects/note.md'"), 'recursive content search')
    await until(() => evaluate("document.querySelector('#preview .preview-text')?.textContent.startsWith('# Note')"), 'fuzzy hit preview')
    await evaluate("document.querySelector('#files .entry').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))")
    await until(() => evaluate("typeof cherry !== 'undefined' && !!cherry && document.querySelectorAll('.cherry-previewer img').length === 5").catch(() => false), 'Cherry production page')
    await until(() => evaluate("Array.from(document.querySelectorAll('.cherry-previewer img')).every(i => i.complete && i.naturalWidth > 0 && i.naturalHeight > 0)"), 'five Cherry images')

    const notePath = path.join(root, 'Projects/note.md')
    assert.equal(await evaluate('document.documentElement.lang'), 'en')
    assert.equal(await evaluate('cherry.options.locale'), 'en_US')
    await until(() => evaluate("cherry.editor.editor.currentKeyMap === 'vim'"), 'Vim keymap')
    await evaluate("cherry.getCodeMirror().dispatch({ changes: { from: 0, insert: 'Autosave test\\n' } }); window.dispatchEvent(new Event('blur'))")
    await until(() => fs.readFileSync(notePath, 'utf8') === 'Autosave test\n' + source, 'blur autosave')
    await evaluate("document.querySelector('[data-mode=previewOnly]').click()")
    assert.equal(await evaluate("document.querySelector('[data-mode=previewOnly]').getAttribute('aria-pressed')"), 'true')
    await evaluate("document.querySelector('[data-mode=editOnly]').click()")
    assert.equal(await evaluate("document.querySelector('[data-mode=editOnly]').getAttribute('aria-pressed')"), 'true')
    await evaluate(`cherry.setMarkdown(${JSON.stringify(source)}); document.querySelector('[data-mode="edit&preview"]').click()`)
    await until(() => fs.readFileSync(notePath, 'utf8') === source, 'mode switch autosave')
    const noteURL = 'vault://Projects/note.md'
    const editorReady = "typeof cherry !== 'undefined' && !!cherry && document.querySelectorAll('.cherry-previewer img').length === 5"
    const loadNoteFresh = async () => {
      answer = 1
      await load('vault://a.txt', "document.body.innerText.includes('alpha')")
      await command('navigation.load', { url: noteURL })
      await until(() => contents.getURL().split('#')[0].includes('pages/markdown/index.html') && evaluate(editorReady).catch(() => false), 'fresh Cherry editor')
      await until(() => evaluate("document.querySelectorAll('.cherry-previewer img').length === 5 && Array.from(document.querySelectorAll('.cherry-previewer img')).every(i => i.complete && i.naturalWidth > 0 && i.naturalHeight > 0)"), 'fresh Cherry images')
    }
    const editorSnapshot = async () => ({
      url: contents.getURL(),
      page: contents.getURL().split('#')[0],
      association: mode.getAssociation(contents),
      dirty: await evaluate('window.vaultEditorState().dirty'),
      buffer: await evaluate('cherry.getCodeMirror().state.doc.toString()')
    })
    const assertEditorUnchanged = async (snapshot, label) => {
      assert.equal(contents.getURL().split('#')[0], snapshot.page, label + ' page')
      assert.equal(mode.getAssociation(contents), snapshot.association, label + ' association')
      assert.equal(await evaluate('window.vaultEditorState().dirty'), snapshot.dirty, label + ' dirty state')
      assert.equal(await evaluate('cherry.getCodeMirror().state.doc.toString()'), snapshot.buffer, label + ' buffer')
      assert.equal(await evaluate('document.body.inert'), false, label + ' body is live')
    }
    const setDirty = async text => {
      await evaluate(`cherry.setMarkdown(${JSON.stringify(text)})`)
      await until(() => evaluate('window.vaultEditorState().dirty'), 'dirty Cherry editor')
    }
    const internalHistory = () => {
      const history = contents.navigationHistory
      const active = history.getActiveIndex()
      const current = history.getEntryAtIndex(active)?.url || ''
      return { active, current }
    }
    const historyURL = () => internalHistory().current

    // Fragment history stays in the same production editor document. It must
    // not prepare the note, replace its association, or freeze Cherry.
    let snapshot = await editorSnapshot()
    let prompts = promptCount
    await evaluate("location.hash = 'history-clean'")
    await until(() => historyURL().endsWith('#history-clean'), 'clean fragment')
    await until(() => contents.getURL().endsWith('#history-clean'), 'clean fragment page')
    assert.equal(await command('navigation.back'), true)
    await until(() => contents.getURL() === snapshot.url, 'clean fragment back')
    await until(() => evaluate(editorReady).catch(() => false), 'clean fragment back editor')
    await assertEditorUnchanged(snapshot, 'clean fragment back')
    assert.equal(await command('navigation.forward'), true)
    await until(() => historyURL().endsWith('#history-clean'), 'clean fragment forward')
    await until(() => contents.getURL().endsWith('#history-clean'), 'clean fragment forward page')
    await until(() => evaluate(editorReady).catch(() => false), 'clean fragment forward editor')
    await assertEditorUnchanged(snapshot, 'clean fragment forward')
    assert.equal(promptCount, prompts, 'clean fragment history does not prompt')

    await evaluate("location.hash = 'clean-skip'")
    await until(() => historyURL().endsWith('#clean-skip'), 'clean skip fragment')
    const cleanSkip = await editorSnapshot()
    const cleanSkipActive = internalHistory().active
    prompts = promptCount
    assert.equal(await command('navigation.back-skipping-internal'), true)
    await until(() => internalHistory().active === cleanSkipActive - 1, 'clean back skipping internal')
    await until(() => evaluate(editorReady).catch(() => false), 'clean skipped editor')
    await assertEditorUnchanged(cleanSkip, 'clean back skipping internal')
    assert.equal(promptCount, prompts, 'clean back skipping internal does not prompt')

    snapshot = await editorSnapshot()
    contents.navigationHistory.clear()
    for (const operation of ['navigation.back', 'navigation.forward', 'navigation.back-skipping-internal']) {
      assert.equal(await command(operation), false, 'clean unavailable ' + operation)
      assert.equal(contents.getURL(), snapshot.url, 'clean unavailable history preserves URL')
      await assertEditorUnchanged(snapshot, 'clean unavailable ' + operation)
    }
    assert.equal(promptCount, prompts, 'clean unavailable history does not prompt')
    assert.equal(await evaluate('window.vaultEditorSave()'), true, 'clean history baseline remains initialized')
    assert.equal(fs.readFileSync(notePath, 'utf8'), source)

    fs.writeFileSync(notePath, source)
    await loadNoteFresh()
    const dirtyBuffer = source + '\nHistory dirty'
    await setDirty(dirtyBuffer)
    snapshot = await editorSnapshot()
    prompts = promptCount
    await evaluate("location.hash = 'history-dirty'")
    await until(() => historyURL().endsWith('#history-dirty'), 'dirty fragment')
    assert.equal(await command('navigation.back'), true)
    await until(() => contents.getURL() === snapshot.url, 'dirty fragment back')
    await until(() => evaluate(editorReady).catch(() => false), 'dirty fragment back editor')
    await assertEditorUnchanged(snapshot, 'dirty fragment back')
    assert.equal(await command('navigation.forward'), true)
    await until(() => historyURL().endsWith('#history-dirty'), 'dirty fragment forward')
    await until(() => contents.getURL().endsWith('#history-dirty'), 'dirty fragment forward page')
    await until(() => evaluate(editorReady).catch(() => false), 'dirty fragment forward editor')
    await assertEditorUnchanged(snapshot, 'dirty fragment forward')
    assert.equal(promptCount, prompts, 'dirty fragment history does not prompt')

    await evaluate("location.hash = 'dirty-skip'")
    await until(() => historyURL().endsWith('#dirty-skip'), 'dirty skip fragment')
    snapshot = await editorSnapshot()
    const dirtySkipActive = internalHistory().active
    prompts = promptCount
    assert.equal(await command('navigation.back-skipping-internal'), true)
    await until(() => internalHistory().active === dirtySkipActive - 1, 'dirty back skipping internal')
    await until(() => evaluate(editorReady).catch(() => false), 'dirty skipped editor')
    await assertEditorUnchanged(snapshot, 'dirty back skipping internal')
    assert.equal(promptCount, prompts, 'dirty back skipping internal does not prompt')

    contents.navigationHistory.clear()
    snapshot = await editorSnapshot()
    for (const operation of ['navigation.back', 'navigation.forward', 'navigation.back-skipping-internal']) {
      assert.equal(await command(operation), false, 'dirty unavailable ' + operation)
      assert.equal(contents.getURL(), snapshot.url, 'dirty unavailable history preserves URL')
      await assertEditorUnchanged(snapshot, 'dirty unavailable ' + operation)
    }
    assert.equal(promptCount, prompts, 'dirty unavailable history does not prompt')
    assert.equal(await evaluate('window.vaultEditorSave()'), true, 'dirty history buffer can still save')
    assert.equal(fs.readFileSync(notePath, 'utf8'), dirtyBuffer, 'dirty history save updates the note')

    // Exercise the real will-navigate interception, including all three
    // choices. Each attempt must show exactly one prompt.
    const assignedSave = source + '\nAssigned Save'
    fs.writeFileSync(notePath, source)
    await loadNoteFresh()
    await setDirty(assignedSave)
    prompts = promptCount
    answer = 0
    await evaluate("location.assign('vault://b.txt')")
    await until(() => evaluate("document.body.innerText.includes('beta')"), 'will-navigate Save')
    assert.equal(promptCount, prompts + 1, 'will-navigate Save prompts once')
    assert.equal(fs.readFileSync(notePath, 'utf8'), assignedSave, 'will-navigate Save updates disk')

    const assignedDiscard = source + '\nAssigned Discard'
    fs.writeFileSync(notePath, source)
    answer = 2
    await loadNoteFresh()
    await setDirty(assignedDiscard)
    prompts = promptCount
    answer = 1
    await evaluate("location.assign('vault://b.txt')")
    await until(() => evaluate("document.body.innerText.includes('beta')"), 'will-navigate Discard')
    assert.equal(promptCount, prompts + 1, 'will-navigate Discard prompts once')
    assert.equal(fs.readFileSync(notePath, 'utf8'), source, 'will-navigate Discard leaves disk unchanged')

    fs.writeFileSync(notePath, source)
    answer = 2
    await loadNoteFresh()
    const duplicateWindow = new BrowserWindow({ show: false })
    windows.push(duplicateWindow)
    const duplicateID = id + '-history-duplicate'
    await manager.executeTabContentCommand(duplicateWindow.webContents, { id: duplicateID, operation: 'lifecycle.create', payload: { bounds: { x: 0, y: 0, width: 800, height: 600 } } })
    const duplicateContents = views.get(duplicateID).webContents
    await manager.executeTabContentCommand(duplicateWindow.webContents, { id: duplicateID, operation: 'navigation.load', payload: { url: noteURL + '?duplicate=1' } })
    const cancelAssociation = mode.getAssociation(contents)
    assert.equal(focused, id, 'duplicate navigation focuses note owner')
    assert.equal(mode.getAssociation(duplicateContents), undefined, 'duplicate navigation does not acquire note')
    const assignedCancel = source + '\nAssigned Cancel'
    await setDirty(assignedCancel)
    const cancelURL = contents.getURL()
    prompts = promptCount
    answer = 2
    await evaluate("location.assign('vault://b.txt')")
    await until(() => promptCount === prompts + 1 && evaluate('document.body.inert').then(inert => inert === false).catch(() => false), 'will-navigate Cancel')
    assert.equal(promptCount, prompts + 1, 'will-navigate Cancel prompts once')
    assert.equal(contents.getURL(), cancelURL, 'Cancel preserves page')
    assert.equal(mode.getAssociation(contents), cancelAssociation, 'Cancel preserves association')
    assert.equal(await evaluate('cherry.getCodeMirror().state.doc.toString()'), assignedCancel, 'Cancel preserves buffer')
    assert.equal(fs.readFileSync(notePath, 'utf8'), source, 'will-navigate Cancel leaves disk unchanged')
    focused = null
    await manager.executeTabContentCommand(duplicateWindow.webContents, { id: duplicateID, operation: 'navigation.load', payload: { url: noteURL + '?duplicate=2' } })
    assert.equal(focused, id, 'Cancel preserves duplicate owner')
    assert.equal(mode.getAssociation(duplicateContents), undefined, 'Cancel preserves duplicate tab')
    assert.equal(await evaluate('window.vaultEditorSave()'), true, 'Cancel buffer can subsequently save')
    assert.equal(fs.readFileSync(notePath, 'utf8'), assignedCancel, 'Cancel subsequent save updates disk')
    await manager.executeTabContentCommand(duplicateWindow.webContents, { id: duplicateID, operation: 'lifecycle.destroy' })

    // Restore the original note and a fresh production page before the
    // established image/save assertions below.
    fs.writeFileSync(notePath, source)
    answer = 2
    await loadNoteFresh()
    assert.equal(await evaluate('cherry.getMarkdown()'), source)
    await evaluate("location.hash = 'note'")
    assert.equal(await evaluate("fetch('vault://Projects/note.md').then(r => r.text())"), source)
    const count = views.size
    await evaluate("fetch('vault://test.jpg').then(r => r.arrayBuffer())")
    assert.equal(views.size, count)
    await evaluate("cherry.setMarkdown(cherry.getMarkdown() + '\\nEdited')")
    await evaluate('window.vaultEditorSave()')
    assert.equal(fs.readFileSync(path.join(root, 'Projects/note.md'), 'utf8'), source + '\nEdited')
    assert.equal(await evaluate('window.vaultEditorState().dirty'), false)
    // The save promise drains newer edits before reporting a clean buffer.
    await evaluate("cherry.setMarkdown('older'); window.racingSave = window.vaultEditorSave(); cherry.setMarkdown('newer')")
    await evaluate('window.racingSave')
    assert.equal(await evaluate('window.vaultEditorState().dirty'), false)
    assert.equal(fs.readFileSync(path.join(root, 'Projects/note.md'), 'utf8'), 'newer')
    fs.writeFileSync(path.join(root, 'Projects/note.md'), 'external')
    await evaluate("cherry.setMarkdown('newest')")
    assert.equal(await evaluate('window.vaultEditorSave()'), false)
    assert.equal(await evaluate('cherry.getCodeMirror().state.doc.toString()'), 'newest')
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
    assert.equal(await command('navigation.load', { url: 'vault://a.txt' }), false)
    assert.equal(await manager.prepareWindow(win), false)
    assert.equal(await manager.prepareWindow(), false)
    const second = new BrowserWindow({ show: false })
    windows.push(second)
    const otherID = id + '-other'
    await manager.executeTabContentCommand(second.webContents, { id: otherID, operation: 'lifecycle.create', payload: { bounds: { x: 0, y: 0, width: 800, height: 600 } } })
    await manager.executeTabContentCommand(second.webContents, { id: otherID, operation: 'navigation.load', payload: { url: 'vault://Projects/note.md?alias=1' } })
    assert.equal(focused, id, 'cross-window canonical editor ownership')
    assert.equal(views.get(otherID).webContents.getURL(), '')
    answer = 1
    await load('vault://a.txt', "document.body.innerText.includes('alpha')")
    await load('vault://b.txt', "document.body.innerText.includes('beta')")
    await command('navigation.back')
    await until(() => evaluate("document.body.innerText.includes('alpha')"), 'history authorization')
    const pdfReady = "document.body.dataset.pdfReady === 'true'"
    await load('vault://reference.pdf', pdfReady)
    assert.equal(await evaluate('document.title'), 'reference.pdf', 'root-level vault PDF retains its filename')
    assert.equal(await evaluate("document.querySelector('details').open"), false, 'backup tools start collapsed')
    await evaluate("document.querySelector('summary').click()")
    assert.equal(await evaluate("document.getElementById('export').getBoundingClientRect().height > 0"), true, 'backup tools can be revealed')
    await evaluate("document.querySelector('summary').click()")
    views.get(id).setBounds({ x: 0, y: 0, width: 390, height: 800 })
    await until(() => evaluate('innerWidth === 390'), 'narrow PDF viewport')
    assert.equal(await evaluate(`(() => {
      const viewer = document.getElementById('viewer').getBoundingClientRect()
      return viewer.height >= 280 && viewer.width === innerWidth && !document.querySelector('aside') && document.getElementById('annotation-editor').hidden && document.documentElement.scrollWidth <= innerWidth
    })()`), true, 'narrow PDF keeps full-width reading area without an annotation sidebar')
    views.get(id).setBounds({ x: 0, y: 0, width: 1000, height: 800 })
    await until(() => evaluate('innerWidth === 1000'), 'restore PDF viewport')
    await command('find.start', { text: 'Highlight', options: {} })
    assert.equal(messages.filter(message => message.type === 'find-result').at(-1).payload.result.matches, 1, 'browser Find searches PDF text through EmbedPDF')
    await command('find.stop', { action: 'clearSelection' })
    await until(() => evaluate("Array.from(document.querySelector('embedpdf-container').shadowRoot.querySelectorAll('img')).some(img => { if (!img.complete || !img.naturalWidth) return false; const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight; const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0); const d = ctx.getImageData(0,0,c.width,c.height).data; return d.some((v,i) => i % 4 === 2 && v > d[i-2]) })"), 'actual EmbedPDF pixels')
    assert.equal(await evaluate("fetch('vault://reference.pdf').then(r => r.status)"), 200)
    assert.equal(await evaluate("fetch('vault://a.txt').then(r => r.status)"), 403, 'PDF consumer is source-scoped')
    await load('min://app/pages/pdfViewer/index.html?url=' + encodeURIComponent('vault://reference.pdf'), pdfReady)
    assert.equal(await evaluate("fetch('vault://reference.pdf').then(r => r.headers.get('content-type'))"), 'application/pdf')
    if (privateMode) {
      assert.equal(await evaluate("document.getElementById('highlight').disabled"), true)
      assert.match((await evaluate('window.pdfAnnotations.load()')).error, /private tabs/)
    } else {
      await until(() => evaluate("Array.from(document.querySelector('embedpdf-container').shadowRoot.querySelectorAll('img')).some(img => img.complete && img.naturalWidth > 100)"), 'PDF page image ready for selection')
      const pageBox = await evaluate("(() => { const img = Array.from(document.querySelector('embedpdf-container').shadowRoot.querySelectorAll('img')).find(img => img.naturalWidth > 100); const r = img.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()")
      const startX = Math.round(pageBox.x + pageBox.width * 0.1)
      const endX = Math.round(pageBox.x + pageBox.width * 0.62)
      const textY = Math.round(pageBox.y + pageBox.height * 0.18)
      contents.sendInputEvent({ type: 'mouseDown', x: startX, y: textY, button: 'left', clickCount: 1 })
      await sleep(150)
      for (let x = startX + 5; x <= endX; x += 5) {
        contents.sendInputEvent({ type: 'mouseMove', x, y: textY, button: 'left', modifiers: ['leftButtonDown'] })
        await sleep(5)
      }
      contents.sendInputEvent({ type: 'mouseUp', x: endX, y: textY, button: 'left', clickCount: 1 })
      await until(() => evaluate("(async () => { const r = await document.querySelector('embedpdf-container').registry; return r.getPlugin('selection').provides().getFormattedSelection().length > 0; })()"), 'real PDF text selection')
      await until(() => evaluate("!document.getElementById('selection-palette').hidden"), 'inline selection palette')
      assert.deepEqual(await evaluate(`(() => {
        const palette = getComputedStyle(document.getElementById('selection-palette'))
        const swatch = getComputedStyle(document.querySelector('#selection-palette .swatch'))
        return [palette.borderRadius, palette.flexWrap, swatch.width, swatch.height, swatch.borderRadius]
      })()`), ['4px', 'nowrap', '20px', '20px', '2px'], 'PDF palette matches web annotation geometry')
      await evaluate("document.querySelector('#selection-palette .swatch').click()")
      await until(async () => (await evaluate('window.pdfAnnotations.load()')).annotations.length === 1, 'selection highlight saved')
      assert.match((await evaluate('window.pdfAnnotations.load()')).annotations[0].data.text, /Highlight/)
      assert.equal((await evaluate('window.pdfAnnotations.load()')).annotations[0].data.color, '#ffeb3b')
      assert.equal(await evaluate("document.getElementById('selection-palette').hidden"), true)
      contents.sendInputEvent({ type: 'mouseDown', x: startX + 20, y: textY, button: 'left', clickCount: 1 })
      contents.sendInputEvent({ type: 'mouseUp', x: startX + 20, y: textY, button: 'left', clickCount: 1 })
      await until(() => evaluate("!document.getElementById('annotation-editor').hidden"), 'click highlight opens inline note editor')
      assert.deepEqual(await evaluate(`(() => {
        const editor = getComputedStyle(document.getElementById('annotation-editor'))
        const save = getComputedStyle(document.getElementById('save'))
        return [editor.padding, editor.borderRadius, editor.backgroundColor, save.backgroundColor]
      })()`), ['8px', '4px', 'rgb(255, 255, 255)', 'rgb(0, 123, 255)'], 'PDF note editor matches web annotation styling')
      await evaluate("document.getElementById('note').value = 'Inline note'; document.getElementById('note').dispatchEvent(new Event('input')); document.getElementById('save').click()")
      await until(() => evaluate("document.getElementById('annotation-editor').hidden"), 'saving closes inline note editor')
      assert.equal((await evaluate('window.pdfAnnotations.load()')).annotations[0].data.notes, 'Inline note')
      await until(() => evaluate("Array.from(document.querySelector('embedpdf-container').shadowRoot.querySelectorAll('span')).some(el => el.textContent === 'Inline note' && el.getBoundingClientRect().height > 0)"), 'saved note is displayed over the PDF')
      const noteBox = await evaluate("(() => { const el = Array.from(document.querySelector('embedpdf-container').shadowRoot.querySelectorAll('span')).find(el => el.textContent === 'Inline note'); const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()")
      contents.sendInputEvent({ type: 'mouseDown', ...noteBox, button: 'left', clickCount: 1 })
      contents.sendInputEvent({ type: 'mouseUp', ...noteBox, button: 'left', clickCount: 1 })
      const getBox = "(async () => { const r = await document.querySelector('embedpdf-container').registry; return r.getPlugin('annotation').provides().getAnnotations().find(a => a.object.custom?.vaultNoteFor).object; })()"
      const autoBox = await evaluate(getBox)
      assert.deepEqual(await evaluate(`(async () => {
        const r = await document.querySelector('embedpdf-container').registry
        const api = r.getPlugin('annotation').provides()
        const box = api.getAnnotations().find(a => a.object.custom?.vaultNoteFor).object
        const highlight = api.getAnnotations().find(a => a.object.id === box.custom.vaultNoteFor).object
        return [api.isAnnotationStructurallyLocked(box), api.isAnnotationContentLocked(box), api.isAnnotationInteractive(highlight), api.isAnnotationInteractive({ ...box, id: 'not-a-vault-note' })]
      })()`), [false, true, false, false], 'only display companions allow geometry changes; text and source annotations stay protected')
      const savedBeforeMove = await evaluate('window.pdfAnnotations.load()')
      await sleep(200)
      contents.sendInputEvent({ type: 'mouseDown', ...noteBox, button: 'left', clickCount: 1 })
      for (let offset = 5; offset <= 40; offset += 5) {
        contents.sendInputEvent({ type: 'mouseMove', x: noteBox.x + offset, y: noteBox.y + offset, button: 'left', modifiers: ['leftButtonDown'] })
        await sleep(20)
      }
      contents.sendInputEvent({ type: 'mouseUp', x: noteBox.x + 40, y: noteBox.y + 40, button: 'left', clickCount: 1 })
      await until(async () => (await evaluate(getBox)).rect.origin.y !== autoBox.rect.origin.y, 'native note box drag changes its position')
      assert.deepEqual(await evaluate('window.pdfAnnotations.load()'), savedBeforeMove, 'moving note box does not write vault geometry')
      assert.equal(await evaluate('window.pdfHighlightsState().dirty'), false, 'temporary layout does not mark vault notes dirty')
      contents.sendInputEvent({ type: 'mouseDown', x: noteBox.x + 40, y: noteBox.y + 40, button: 'left', clickCount: 2 })
      contents.sendInputEvent({ type: 'mouseUp', x: noteBox.x + 40, y: noteBox.y + 40, button: 'left', clickCount: 2 })
      await until(() => evaluate("!document.getElementById('annotation-editor').hidden"), 'double click moved free-text box opens the vault note editor')
      assert.equal(await evaluate("document.getElementById('note').value"), 'Inline note')
      await evaluate("document.getElementById('close-note').click()")
      const corner = await evaluate("(() => { const el = Array.from(document.querySelector('embedpdf-container').shadowRoot.querySelectorAll('span')).find(el => el.textContent === 'Inline note'); const r = el.getBoundingClientRect(); return { x: Math.round(r.right), y: Math.round(r.bottom) }; })()")
      contents.sendInputEvent({ type: 'mouseDown', ...corner, button: 'left', clickCount: 1 })
      for (let offset = 5; offset <= 40; offset += 5) {
        contents.sendInputEvent({ type: 'mouseMove', x: corner.x - offset, y: corner.y + offset, button: 'left', modifiers: ['leftButtonDown'] })
        await sleep(20)
      }
      contents.sendInputEvent({ type: 'mouseUp', x: corner.x - 40, y: corner.y + 40, button: 'left', clickCount: 1 })
      await until(async () => (await evaluate(getBox)).rect.size.width !== autoBox.rect.size.width, 'native resize handle changes note box size')
      assert.deepEqual(await evaluate('window.pdfAnnotations.load()'), savedBeforeMove, 'resizing note box does not write vault geometry')
      const resizedRect = (await evaluate(getBox)).rect
      await evaluate("document.getElementById('save').click()")
      await until(() => evaluate("document.getElementById('status').textContent === 'Saved to vault'"), 'save after temporary layout change')
      assert.deepEqual((await evaluate(getBox)).rect, resizedRect, 'saving annotations preserves the temporary layout')
      await load('vault://a.txt', "document.body.innerText.includes('alpha')")
      await load('vault://reference.pdf', pdfReady)
      assert.deepEqual((await evaluate(getBox)).rect, autoBox.rect, 'reopening restores automatic size and position')
      await until(() => evaluate("!document.getElementById('delete').disabled"), 'saved highlight controls')
      await evaluate("document.getElementById('delete').click()")
      await until(() => evaluate("document.getElementById('annotations').options.length === 1 && document.getElementById('status').textContent === 'Saved to vault'"), 'selection highlight removed')
      await until(() => evaluate("!document.querySelector('embedpdf-container').shadowRoot.textContent.includes('Inline note')"), 'deleting highlight removes its free-text box')
      assert.equal(await evaluate("document.getElementById('annotations').disabled"), true, 'empty highlight picker is disabled')
      assert.equal(await evaluate("document.getElementById('annotations').selectedOptions[0].textContent"), 'No highlights yet')
      assert.equal(await evaluate("document.getElementById('retry').hidden"), true, 'retry stays hidden without an unsaved change')
      const rect = { origin: { x: 20, y: 25 }, size: { width: 100, height: 12 } }
      const legacy = '| Field | Value |\n| --- | --- |\n| Title | Reference |\n| URL | vault://reference.pdf |\n| Tags | #annotation |\n\n## Annotations\n\n' +
        '%% annotation: pdf-test-id | color: ffcd45 | sourceType: pdf | pageIndex: 0 %%\n<pre></pre>\n<pre>Test highlight</pre>\n<pre></pre>\n\n' +
        `%% annotation-rect: ${JSON.stringify(rect)} %%\n%% annotation-segments: ${JSON.stringify([rect])} %%\nOriginal note\n`
      for (const [index, note] of ['https://example.com/' + 'abcdefghij'.repeat(15), '中文注释'.repeat(30)].entries()) {
        const uid = 'wrapping-note-' + index
        const fixture = legacy.replace('pdf-test-id', uid).replace('Original note', note)
        await evaluate(`(() => { const input = document.getElementById('import'); const transfer = new DataTransfer(); transfer.items.add(new File([${JSON.stringify(fixture)}], 'wrapping.md')); input.files = transfer.files; input.dispatchEvent(new Event('change')); })()`)
        await until(() => evaluate(`document.getElementById('status').textContent === 'Saved to vault' && document.getElementById('annotations').value === '${uid}'`), 'long note imported')
        const box = await evaluate(`(async () => { const r = await document.querySelector('embedpdf-container').registry; return r.getPlugin('annotation').provides().getAnnotations().find(a => a.object.custom?.vaultNoteFor === '${uid}').object; })()`)
        assert.equal(box.contents, note)
        assert.ok(box.rect.size.height > 23 && box.rect.size.height <= 100, 'unbroken text gets a bounded multiline preview')
        await evaluate("document.getElementById('delete').click()")
        await until(() => evaluate("document.getElementById('annotations').options.length === 1 && document.getElementById('status').textContent === 'Saved to vault'"), 'wrapping fixture removed')
      }
      await evaluate(`(() => { const input = document.getElementById('import'); const transfer = new DataTransfer(); transfer.items.add(new File([${JSON.stringify(legacy)}], 'legacy.md')); input.files = transfer.files; input.dispatchEvent(new Event('change')); })()`)
      await until(() => evaluate("document.getElementById('status').textContent === 'Saved to vault' && document.getElementById('annotations').value === 'pdf-test-id'"), 'legacy PDF import and save').catch(async error => { throw new Error(error.message + ': ' + await evaluate("document.getElementById('status').textContent")) })
      assert.equal(await evaluate("document.getElementById('note').value"), 'Original note')
      const loaded = await evaluate('window.pdfAnnotations.load()')
      assert.equal(loaded.annotations.length, 1)
      assert.deepEqual(loaded.annotations[0].data.segmentRects, [rect])
      await evaluate("document.getElementById('note').value = 'Edited note'; document.getElementById('note').dispatchEvent(new Event('input')); document.getElementById('color').value = '#33aa77'; document.getElementById('save').click()")
      await until(async () => (await evaluate('window.pdfAnnotations.load()')).annotations[0]?.data.notes === 'Edited note', 'PDF note and color save')
      await until(() => evaluate("(async () => { const r = await document.querySelector('embedpdf-container').registry; return r.getPlugin('annotation').provides().getAnnotations().some(a => a.object.id === 'pdf-test-id' && a.object.strokeColor === '#33aa77'); })()"), 'native highlight color updated without reopening')
      await load('vault://a.txt', "document.body.innerText.includes('alpha')")
      await load('vault://reference.pdf', pdfReady)
      assert.equal(await evaluate("document.getElementById('note').value"), 'Edited note')
      await until(() => evaluate("Array.from(document.querySelector('embedpdf-container').shadowRoot.querySelectorAll('span')).some(el => el.textContent === 'Edited note' && el.getBoundingClientRect().height > 0)"), 'note box restored after reopening PDF')
      assert.equal(await evaluate("document.getElementById('color').value"), '#33aa77')
      const restored = await evaluate("(async () => { const r = await document.querySelector('embedpdf-container').registry; return r.getPlugin('annotation').provides().getAnnotations().filter(a => a.object.id === 'pdf-test-id').map(a => a.object); })()")
      assert.equal(restored.length, 1, 'highlight rehydrated into EmbedPDF, not just sidebar')
      assert.deepEqual(restored[0].rect, rect)
      await evaluate("(async () => { const r = await document.querySelector('embedpdf-container').registry; r.getPlugin('rotate').provides().rotateForward(); r.getPlugin('zoom').provides().requestZoom(1.5); })()")
      assert.deepEqual((await evaluate('window.pdfAnnotations.load()')).annotations[0].data.rect, rect, 'viewport changes never rewrite geometry')
      await evaluate("document.getElementById('note').value = 'Guarded note'; document.getElementById('note').dispatchEvent(new Event('input'))")
      answer = 2
      assert.equal(await command('lifecycle.destroy'), false, 'Cancel keeps dirty PDF open')
      assert.equal(await evaluate("document.getElementById('note').value"), 'Guarded note')
      assert.equal(await evaluate('document.body.inert'), false)
      answer = 0
      await load('vault://a.txt', "document.body.innerText.includes('alpha')")
      await load('vault://reference.pdf', pdfReady)
      assert.equal(await evaluate("document.getElementById('note').value"), 'Guarded note', 'Save-on-leave persists PDF note')
      const storagePath = path.join(root, 'Annotations', fs.readdirSync(path.join(root, 'Annotations'))[0])
      assert.equal(path.extname(storagePath), '.md')
      const external = annotationMarkdown.parse(fs.readFileSync(storagePath, 'utf8'))
      external.annotations[0].data.notes = 'External note'
      fs.writeFileSync(storagePath, annotationMarkdown.stringify(external))
      await evaluate("document.getElementById('note').value = 'Recoverable conflict'; document.getElementById('note').dispatchEvent(new Event('input')); document.getElementById('save').click()")
      await until(() => evaluate("document.getElementById('status').textContent.startsWith('Not saved:')"), 'visible PDF save conflict')
      assert.equal(await evaluate("document.getElementById('note').value"), 'Recoverable conflict')
      answer = 0
      assert.equal(await command('lifecycle.destroy'), false, 'failed Save prevents PDF close')
      answer = 1
      await load('vault://a.txt', "document.body.innerText.includes('alpha')")
      await load('vault://reference.pdf', pdfReady)
      assert.equal(await evaluate("document.getElementById('note').value"), 'External note', 'conflicting disk change preserved')
      await evaluate("document.getElementById('delete').click()")
      await until(async () => (await evaluate('window.pdfAnnotations.load()')).annotations.length === 0, 'PDF deletion persistence')
      await load('vault://a.txt', "document.body.innerText.includes('alpha')")
      await load('vault://reference.pdf', pdfReady)
      assert.equal(await evaluate("document.getElementById('annotations').options.length"), 1)
      assert.equal(fs.readFileSync(path.join(root, 'reference.pdf'), 'utf8'), pdfFixture(), 'PDF bytes remain unchanged')
    }
    await load('min://app/pages/pdfViewer/index.html?url=' + encodeURIComponent(require('url').pathToFileURL(path.join(root, 'reference.pdf')).href), pdfReady)
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
