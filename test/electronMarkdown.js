/* global Response */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { app, BrowserWindow, ipcMain, nativeTheme, net, protocol, session } = require('electron')
const createProtocol = require('../main/minInternalProtocol.js')

const rootArgument = process.argv.find(arg => arg.startsWith('--app-root='))
const rootDir = path.resolve(rootArgument ? rootArgument.slice('--app-root='.length) : path.join(__dirname, '..'))

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'min-markdown-'))
const preload = path.join(temporary, 'preload.js')
const saveChannel = 'markdown-smoke:save'
const windows = []
const saves = []
const deferredSaves = []
let deferNextSave = false
let nextSaveResult = null
let finished = false

app.disableHardwareAcceleration()
app.setPath('userData', path.join(temporary, 'profile'))

// Keep the preload ephemeral so this smoke test does not need a production
// vault backend or any production-file changes.
fs.writeFileSync(preload, `
const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('vaultPage', {
  readCurrent: async () => ({
    ok: true,
    markdown: '# Hello',
    vaultURL: 'vault://note.md'
  }),
  saveCurrent: text => ipcRenderer.invoke(${JSON.stringify(saveChannel)}, text),
  open: async () => ({ ok: true })
})
`)

const bundle = createProtocol({
  net,
  path,
  protocol,
  rootDir,
  Response
})

ipcMain.handle(saveChannel, (event, text) => {
  saves.push(text)
  if (deferNextSave) {
    deferNextSave = false
    return new Promise(resolve => deferredSaves.push(resolve))
  }
  if (nextSaveResult) {
    const result = nextSaveResult
    nextSaveResult = null
    return result
  }
  return { ok: true }
})

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

async function until (fn, label) {
  let lastError
  for (let attempt = 0; attempt < 300; attempt++) {
    try {
      const value = await fn()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await sleep(25)
  }
  throw new Error(`Timed out: ${label}${lastError ? ` (${lastError.message})` : ''}`)
}

function finish (code) {
  if (finished) return
  finished = true
  clearTimeout(deadline)
  ipcMain.removeHandler(saveChannel)
  for (const window of windows) {
    if (!window.isDestroyed()) window.destroy()
  }
  fs.rmSync(temporary, { force: true, recursive: true })
  app.exit(code)
}

const deadline = setTimeout(() => {
  console.error('Markdown smoke timeout')
  finish(1)
}, 60000)

async function run () {
  await app.whenReady()
  bundle.install(session.defaultSession)
  // Editor acceptance must not silently depend on downloading missing assets.
  const networkRequests = []
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, respond) => {
    networkRequests.push(details.url)
    respond({ cancel: true })
  })

  const window = new BrowserWindow({
    height: 700,
    show: false,
    width: 1000,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload
    }
  })
  windows.push(window)
  window.webContents.on('console-message', event => console.log('renderer:', event.message))
  const evaluate = script => window.webContents.executeJavaScript(script)

  await window.loadURL('min://app/pages/markdown/index.html')
  await until(() => evaluate("typeof cherry !== 'undefined' && !!cherry && document.getElementById('status').textContent === 'Saved'").catch(() => false), 'Cherry editor ready')

  assert.equal(await evaluate('document.title'), 'note.md')
  assert.equal(await evaluate("document.getElementById('path').textContent"), 'note.md')

  const initial = await evaluate(`({
    lang: document.documentElement.lang,
    locale: cherry.options.locale,
    keyMap: cherry.editor.editor.currentKeyMap,
    source: cherry.getCodeMirror().state.doc.toString(),
    pressed: Array.from(document.querySelectorAll('[data-mode]'), button => [button.dataset.mode, button.getAttribute('aria-pressed'), button.disabled])
  })`)
  assert.equal(initial.lang, 'en')
  assert.equal(initial.locale, 'en_US')
  assert.equal(initial.keyMap, 'vim')
  assert.equal(initial.source, '# Hello')
  await evaluate(`(() => {
    const view = cherry.getCodeMirror()
    view.dispatch({ selection: { anchor: 2 } })
    window.vimTestKey = (key, ctrlKey = false) => view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey, bubbles: true, cancelable: true }))
    vimTestKey(';')
  })()`)
  assert.equal(await evaluate('cherry.getCodeMirror().state.selection.main.head'), 3, '; moves right without recursively mapping l')
  await evaluate("vimTestKey('j')")
  assert.equal(await evaluate('cherry.getCodeMirror().state.selection.main.head'), 2, 'j moves left')
  await evaluate("vimTestKey(';', true)")
  assert.equal(await evaluate('cherry.getCodeMirror().state.selection.main.head'), 6, 'Ctrl+; moves to end')
  await evaluate("vimTestKey('j', true)")
  assert.equal(await evaluate('cherry.getCodeMirror().state.selection.main.head'), 0, 'Ctrl+j moves to start')
  await evaluate("vimTestKey('i'); vimTestKey('j'); vimTestKey('j')")
  assert.equal(await evaluate('cherry.getCodeMirror().cm.state.vim.insertMode'), true, 'jj must not exit insert mode')
  await evaluate("vimTestKey('c', true)")
  assert.equal(await evaluate('cherry.getCodeMirror().cm.state.vim.insertMode'), false, 'Ctrl+c exits insert mode')
  assert.equal(await evaluate('cherry.getCodeMirror().state.doc.toString()'), '# Hello')
  await evaluate(`(() => {
    const view = cherry.getCodeMirror()
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: Array(20).fill('one two three').join('\\n') }, selection: { anchor: 0 } })
  })()`)
  await sleep(100)
  await evaluate("vimTestKey('l')")
  assert.equal(await evaluate('cherry.getCodeMirror().state.selection.main.head'), 14, 'l moves down')
  await evaluate("vimTestKey('k')")
  assert.equal(await evaluate('cherry.getCodeMirror().state.selection.main.head'), 0, 'k moves up')
  await evaluate("vimTestKey('l', true)")
  assert.equal(await evaluate('cherry.getCodeMirror().state.selection.main.head'), 112, 'Ctrl+l moves down eight lines')
  await evaluate("vimTestKey('k', true)")
  assert.equal(await evaluate('cherry.getCodeMirror().state.selection.main.head'), 0, 'Ctrl+k moves up eight lines')
  await evaluate("vimTestKey('c', true)")
  assert.equal(await evaluate('cherry.getCodeMirror().state.selection.main.head'), 6, 'Ctrl+c moves two word ends')
  await evaluate("vimTestKey('d')")
  assert.equal(await evaluate('cherry.getCodeMirror().state.doc.line(1).text'), 'one tw three', 'd deletes a character rather than starting an operator')
  await evaluate(`(() => {
    const view = cherry.getCodeMirror()
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '# Hello' }, selection: { anchor: 0 } })
  })()`)
  console.log('PASS hardcoded Vim movement, deletion, and insert escape mappings')
  assert.deepEqual(initial.pressed, [
    ['editOnly', 'false', false],
    ['edit&preview', 'true', false],
    ['previewOnly', 'false', false]
  ])

  const modeState = async mode => {
    await evaluate(`document.querySelector('[data-mode=${JSON.stringify(mode)}]').click()`)
    return evaluate(`(() => {
      const visible = element => {
        const style = getComputedStyle(element)
        const rect = element.getBoundingClientRect()
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
      }
      return {
        editorVisible: visible(document.querySelector('.cherry-editor')),
        previewVisible: visible(document.querySelector('.cherry-previewer')),
        pressed: Object.fromEntries(Array.from(document.querySelectorAll('[data-mode]'), button => [button.dataset.mode, button.getAttribute('aria-pressed')]))
      }
    })()`)
  }
  let mode = await modeState('previewOnly')
  assert.deepEqual(mode.pressed, { editOnly: 'false', 'edit&preview': 'false', previewOnly: 'true' })
  assert.deepEqual([mode.editorVisible, mode.previewVisible], [false, true])
  mode = await modeState('editOnly')
  assert.deepEqual(mode.pressed, { editOnly: 'true', 'edit&preview': 'false', previewOnly: 'false' })
  assert.deepEqual([mode.editorVisible, mode.previewVisible], [true, false])
  mode = await modeState('edit&preview')
  assert.deepEqual(mode.pressed, { editOnly: 'false', 'edit&preview': 'true', previewOnly: 'false' })
  assert.deepEqual([mode.editorVisible, mode.previewVisible], [true, true])
  console.log('PASS locale, Vim keymap, mode button state, and rendered pane visibility')

  const replaceText = text => evaluate(`(() => {
    const codeMirror = cherry.getCodeMirror()
    codeMirror.dispatch({ changes: { from: 0, to: codeMirror.state.doc.length, insert: ${JSON.stringify(text)} } })
    return codeMirror.state.doc.toString()
  })()`)
  const savesBeforeBlur = saves.length
  const blurText = '# Latest live blur'
  assert.equal(await evaluate(`(() => {
    const codeMirror = cherry.getCodeMirror()
    codeMirror.dispatch({ changes: { from: 0, to: codeMirror.state.doc.length, insert: ${JSON.stringify(blurText)} } })
    window.dispatchEvent(new Event('blur'))
    return codeMirror.state.doc.toString()
  })()`), blurText)
  await until(() => saves.length === savesBeforeBlur + 1, 'window blur save')
  assert.equal(saves.at(-1), blurText)
  await until(() => evaluate('!window.vaultEditorState().dirty'), 'window blur clean state')
  console.log('PASS live CodeMirror document is captured by window blur')

  const savesBeforeFocus = saves.length
  const insideText = '# Stay inside editor'
  assert.equal(await replaceText(insideText), insideText)
  await evaluate(`(() => {
    const editor = document.getElementById('editor')
    editor.dispatchEvent(new FocusEvent('focusout', {
      bubbles: true,
      relatedTarget: document.querySelector('.cherry-editor')
    }))
  })()`)
  await sleep(150)
  assert.equal(saves.length, savesBeforeFocus, 'focus movement within the editor must not save')

  const outsideText = '# Focused outside editor'
  assert.equal(await replaceText(outsideText), outsideText)
  await evaluate(`(() => {
    const editor = document.getElementById('editor')
    editor.dispatchEvent(new FocusEvent('focusout', {
      bubbles: true,
      relatedTarget: document.getElementById('save')
    }))
  })()`)
  await until(() => saves.length === savesBeforeFocus + 1, 'focusout save')
  assert.equal(saves.at(-1), outsideText)
  await until(() => evaluate('!window.vaultEditorState().dirty'), 'focusout clean state')
  console.log('PASS focusout saves outside transitions but ignores transitions within the editor')

  const savesBeforePending = saves.length
  deferNextSave = true
  const pendingText = '# Pending snapshot'
  assert.equal(await evaluate(`(() => {
    const codeMirror = cherry.getCodeMirror()
    codeMirror.dispatch({ changes: { from: 0, to: codeMirror.state.doc.length, insert: ${JSON.stringify(pendingText)} } })
    window.dispatchEvent(new Event('blur'))
    return codeMirror.state.doc.toString()
  })()`), pendingText)
  await until(() => deferredSaves.length === 1 && saves.length === savesBeforePending + 1, 'deferred first save')
  assert.equal(saves.at(-1), pendingText)

  const newerText = '# Newer snapshot while saving'
  assert.equal(await replaceText(newerText), newerText)
  await evaluate("window.dispatchEvent(new Event('blur'))")
  await sleep(150)
  assert.equal(saves.length, savesBeforePending + 1, 'a pending save must not start a concurrent write')
  deferredSaves.shift()({ ok: true })
  await until(() => saves.length === savesBeforePending + 2, 'newer snapshot drain')
  assert.deepEqual(saves.slice(savesBeforePending), [pendingText, newerText])
  await until(() => evaluate('!window.vaultEditorState().dirty && !window.vaultEditorState().saving'), 'drained save state')
  console.log('PASS edits made during a pending save drain as a newer snapshot')

  const failureText = '# Retry after failure'
  nextSaveResult = { ok: false, error: 'Mock write failed' }
  assert.equal(await replaceText(failureText), failureText)
  assert.equal(await evaluate('window.vaultEditorSave()'), false)
  assert.equal(saves.at(-1), failureText)
  assert.deepEqual(await evaluate(`({
    dirty: window.vaultEditorState().dirty,
    saving: window.vaultEditorState().saving,
    status: document.getElementById('status').textContent
  })`), { dirty: true, saving: false, status: 'Mock write failed' })
  // Cherry reports changes after a debounce; this must not erase save errors.
  await sleep(500)
  assert.equal(await evaluate("document.getElementById('status').textContent"), 'Mock write failed')

  assert.equal(await evaluate('window.vaultEditorSave()'), true)
  assert.equal(saves.at(-1), failureText)
  assert.deepEqual(await evaluate(`({
    dirty: window.vaultEditorState().dirty,
    saving: window.vaultEditorState().saving,
    status: document.getElementById('status').textContent
  })`), { dirty: false, saving: false, status: 'Saved' })
  console.log('PASS failed saves preserve dirty status and retry the same latest text successfully')

  for (const theme of ['dark', 'light']) {
    nativeTheme.themeSource = theme
    await until(() => evaluate("document.querySelector('#editor .cherry').classList.contains('theme__default')"), 'hardcoded light editor theme')
    assert.equal(await evaluate('getComputedStyle(document.body).backgroundColor'), theme === 'dark' ? 'rgb(24, 29, 38)' : 'rgb(248, 249, 251)')
  }
  nativeTheme.themeSource = 'system'
  window.setContentSize(390, 700)
  await until(() => evaluate('window.innerWidth === 390'), 'narrow editor viewport')
  assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true, 'no horizontal page overflow')
  assert.equal(await evaluate(`(() => {
    const editor = document.getElementById('editor').getBoundingClientRect()
    const footer = document.querySelector('footer').getBoundingClientRect()
    return editor.height > 300 && editor.bottom <= footer.top + 1 && footer.bottom <= innerHeight + 1
  })()`), true, 'editor and save status fit the narrow viewport')
  console.log('PASS fixed light editor theme and narrow editor layout')
  assert.deepEqual(networkRequests, [], 'the editor should work entirely from local assets')
}

run().then(() => finish(0), error => {
  console.error(error)
  finish(1)
})
