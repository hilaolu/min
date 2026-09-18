/* global Cherry, vaultPage, resolveNoteReference */
let cherry
let savedText
let saving = false
let error = ''
let pendingSave
let loaded = false
function sourceText () {
  // Cherry 0.11 caches getMarkdown until the preview debounce fires. Read its
  // live CodeMirror document so Ctrl+S/close cannot miss the most recent key.
  const text = cherry.getCodeMirror().state.doc.toString()
  return text === savedText.replace(/\r\n?/g, '\n') ? savedText : text
}
function state () { return { dirty: Boolean(cherry && sourceText() !== savedText), saving } }
function update () {
  document.getElementById('status').textContent = error || (saving ? 'Saving…' : state().dirty ? 'Unsaved changes' : 'Saved')
}
async function saveSnapshot () {
  if (!cherry || saving) return false
  const snapshot = sourceText()
  saving = true
  error = ''
  update()
  try {
    const result = await vaultPage.saveCurrent(snapshot)
    if (!result.ok) { error = result.error; return false }
    savedText = snapshot
    return true
  } finally { saving = false; update() }
}
function save () {
  if (pendingSave) return pendingSave
  pendingSave = saveSnapshot().finally(() => { pendingSave = null })
  return pendingSave
}
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
vaultPage.readCurrent().then(result => {
  loaded = true
  if (!result.ok) { error = result.error; update(); return }
  savedText = result.markdown
  document.getElementById('path').textContent = decodeURIComponent(new URL(result.vaultURL).pathname)
  document.title = document.getElementById('path').textContent
  cherry = new Cherry({
    id: 'editor',
    value: savedText,
    engine: { global: { htmlBlackList: '*' } },
    editor: { defaultModel: 'edit&preview' },
    toolbars: { toolbar: ['bold', 'italic', 'header', '|', 'list', 'quote', 'code', '|', 'togglePreview'] },
    callback: {
      urlProcessor: reference => { try { return resolveNoteReference(reference, result.vaultURL) } catch (_) { return '' } },
      afterChange: () => { error = ''; update() }
    }
  })
  update()
})
