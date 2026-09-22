/* global Cherry, vaultPage, resolveNoteReference, vaultDisplayPath */
let cherry
let savedText
let saving = false
let error = ''
let pendingSave
let loaded = false
async function configureVim () {
  // Cherry 0.11.10 bundles Vim privately. Wait for its asynchronous keymap
  // installation, then feed Ex commands through its command prompt bridge.
  await cherry.editor.editor.setKeyMap('vim')
  const view = cherry.getCodeMirror()
  const cm = view.cm
  const openDialog = cm.openDialog
  try {
    for (const command of [
      'noremap ; l', 'noremap k k', 'noremap l j', 'noremap j h',
      // Counted motions express the requested repeated movements.
      'noremap d x', 'noremap <C-k> 8k', 'noremap <C-j> 0',
      'noremap <C-l> 8j', 'noremap <C-;> $', 'noremap <C-c> 2e',
      'imap <C-c> <Esc>'
    ]) {
      cm.openDialog = (template, callback) => { callback(command); return () => {} }
      view.contentDOM.dispatchEvent(new window.KeyboardEvent('keydown', { key: ':', bubbles: true, cancelable: true }))
    }
  } finally {
    cm.openDialog = openDialog
  }
  // Cherry's Sublime shortcuts otherwise consume Ctrl+L before Vim sees it.
  view.contentDOM.addEventListener('keydown', event => {
    const vim = cm.state.vim
    if (vim && event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey &&
        ['k', 'j', 'l', ';', 'c'].includes(event.key) && !vim.insertMode) {
      if (cm.state.vimPlugin.handleKey(event, view)) {
        event.preventDefault()
        event.stopImmediatePropagation()
      }
    }
  }, true)
}
function sourceText () {
  // Cherry 0.11 caches getMarkdown until the preview debounce fires. Read its
  // live CodeMirror document so Ctrl+S/close cannot miss the most recent key.
  const text = cherry.getCodeMirror().state.doc.toString()
  return text === savedText.replace(/\r\n?/g, '\n') ? savedText : text
}
function state () { return { dirty: Boolean(cherry && sourceText() !== savedText), saving } }
function update () {
  document.getElementById('status').textContent = error || (saving ? 'Saving…' : state().dirty ? 'Unsaved changes' : 'Saved')
  document.getElementById('status').dataset.state = error ? 'error' : saving ? 'saving' : state().dirty ? 'dirty' : 'saved'
}
async function saveSnapshot () {
  if (!cherry || saving) return false
  const snapshot = sourceText()
  saving = true
  error = ''
  update()
  try {
    const result = await vaultPage.saveCurrent(snapshot)
    if (!result.ok) { error = result.error || 'Unable to save'; return false }
    savedText = snapshot
    return true
  } catch (err) {
    error = (err && err.message) || 'Unable to save'
    return false
  } finally { saving = false; update() }
}
function save () {
  if (pendingSave) return pendingSave
  pendingSave = (async () => {
    // A second blur can happen while a write is in flight. Drain newer edits
    // too, but stop on failure so the dirty buffer remains available to retry.
    do {
      if (!await saveSnapshot()) return false
    } while (state().dirty)
    return true
  })().finally(() => { pendingSave = null })
  return pendingSave
}
function autoSave () {
  if (loaded && cherry && !document.body.inert && state().dirty) save()
}
window.addEventListener('blur', autoSave)
document.addEventListener('visibilitychange', () => {
  if (document.hidden) autoSave()
})
document.getElementById('editor').addEventListener('focusout', event => {
  if (!event.currentTarget.contains(event.relatedTarget)) autoSave()
})
document.querySelectorAll('[data-mode]').forEach(button => {
  button.onclick = () => {
    if (!cherry) return
    autoSave()
    cherry.switchModel(button.dataset.mode)
    document.querySelectorAll('[data-mode]').forEach(other => {
      other.setAttribute('aria-pressed', String(other === button))
    })
    if (button.dataset.mode !== 'previewOnly') cherry.getCodeMirror().focus()
  }
})
window.vaultEditorState = state
window.vaultEditorSave = save
window.vaultEditorPrepare = async () => {
  document.body.inert = true
  if (pendingSave) await pendingSave
  return loaded ? state() : null
}
document.getElementById('save').onclick = save
document.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); save() }
})
document.addEventListener('click', event => {
  const link = event.target.closest('a')
  if (!link) return
  const href = link.getAttribute('href')
  if (href && href.startsWith('#')) return
  event.preventDefault()
  if (/^(vault|https?):\/\//.test(href)) vaultPage.open(href)
}, true)
vaultPage.readCurrent().then(async result => {
  loaded = true
  if (!result.ok) { error = result.error; update(); return }
  savedText = result.markdown
  const notePath = vaultDisplayPath(result.vaultURL)
  document.getElementById('path').textContent = notePath
  document.getElementById('path').title = notePath
  document.title = document.getElementById('path').textContent
  cherry = new Cherry({
    id: 'editor',
    value: savedText,
    locale: 'en_US',
    themeSettings: { mainTheme: 'default' },
    engine: { global: { htmlBlackList: '*' } },
    editor: { defaultModel: 'edit&preview', keyMap: 'vim' },
    toolbars: { toolbar: ['bold', 'italic', 'header', '|', 'list', 'quote', 'code'] },
    callback: {
      urlProcessor: reference => { try { return resolveNoteReference(reference, result.vaultURL) } catch (_) { return '' } },
      afterChange: update
    }
  })
  await configureVim()
  document.querySelectorAll('[data-mode]').forEach(button => { button.disabled = false })
  document.getElementById('save').disabled = false
  update()
}).catch(err => {
  loaded = true
  error = (err && err.message) || 'Unable to load note'
  update()
})
