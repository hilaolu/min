/* global Blob, Option, crypto, location, vaultDisplayPath */
import EmbedPDF, { PdfAnnotationSubtype, LockModeType } from '../../node_modules/@embedpdf/snippet/dist/embedpdf.js'
import { PdfBlendMode } from '../../node_modules/@embedpdf/models/dist/index.js'

const source = new URLSearchParams(location.search).get('url')
const ui = Object.fromEntries(['viewer', 'status', 'highlight', 'annotations', 'note', 'color', 'save', 'delete', 'retry', 'export', 'import', 'download'].map(id => [id, document.getElementById(id)]))
let annotations = []
let revision = null
let pending = null
let scope
let selection
let documentId
let pageCount = 0
let searchScope
let commands
let searchGeneration = 0
let busy = false
let savingDone = Promise.resolve()
let writable = false
let noteDirty = false
let rendered = []

function status (text) { ui.status.textContent = text }
function controls () {
  for (const id of ['highlight', 'import']) ui[id].disabled = !writable || busy || Boolean(pending) || noteDirty
  for (const id of ['save', 'delete']) ui[id].disabled = !writable || busy || Boolean(pending) || !ui.annotations.value
  ui.retry.disabled = !pending || busy
  if (!pending) ui.retry.hidden = true
  ui.annotations.disabled = !annotations.length || busy || Boolean(pending) || noteDirty
  ui.note.disabled = ui.color.disabled = busy || Boolean(pending) || !writable || !selected()
}
function selected () { return annotations.find(item => item.uid === ui.annotations.value) }
function showNote () {
  const item = selected()
  ui.note.value = item?.data.notes || ''
  ui.color.value = item?.data.color || '#ffcd45'
  noteDirty = false
  controls()
}
function render () {
  for (const item of rendered) scope.deleteAnnotation(item.data.pageIndex, item.uid)
  scope.importAnnotations(annotations.map(item => ({
    annotation: {
      id: item.uid,
      type: PdfAnnotationSubtype.HIGHLIGHT,
      blendMode: PdfBlendMode.Multiply,
      strokeColor: item.data.color,
      opacity: 1,
      pageIndex: item.data.pageIndex,
      rect: item.data.rect,
      segmentRects: item.data.segmentRects,
      created: new Date(),
      custom: { text: item.data.text }
    }
  })))
  rendered = annotations
  const previous = ui.annotations.value
  ui.annotations.replaceChildren(new Option(annotations.length ? 'Select a highlight' : 'No highlights yet', ''))
  for (const item of annotations) ui.annotations.add(new Option(`Page ${item.data.pageIndex + 1}: ${item.data.text.slice(0, 60) || item.uid}`, item.uid))
  ui.annotations.value = annotations.some(item => item.uid === previous) ? previous : annotations[0]?.uid || ''
  showNote()
}

async function commit (items) {
  if (busy) return
  if (items.some(item => item.data.pageIndex >= pageCount)) return status('Import not saved: a highlight refers to a page outside this PDF.')
  busy = true
  let finishSave
  savingDone = new Promise(resolve => { finishSave = resolve })
  pending = items
  controls()
  status('Saving to vault…')
  try {
    const result = await window.pdfAnnotations.save({ annotations: items, revision })
    if (!result.ok) throw new Error(result.error)
    revision = result.revision
    annotations = result.annotations
    pending = null
    noteDirty = false
    render()
    status('Saved to vault')
  } catch (error) {
    if (pending) {
      ui.retry.hidden = false
      ui.export.closest('details').open = true
    }
    status(pending ? 'Not saved: ' + error.message + ' Retry or export before leaving this tab.' : 'Saved, but the display could not refresh. Reopen this PDF: ' + error.message)
  } finally {
    busy = false
    finishSave()
    controls()
  }
}

ui.highlight.onclick = async () => {
  try {
    const selections = selection.getFormattedSelection(documentId)
    if (!selections.length) return status('Select text in the PDF first.')
    const text = (await selection.getSelectedText(documentId).toPromise()).join(' ').trim()
    const items = selections.map(part => ({
      uid: crypto.randomUUID(),
      sourceType: 'pdf',
      data: {
        color: ui.color.value,
        notes: '',
        text,
        textBefore: '',
        textAfter: '',
        pageIndex: part.pageIndex,
        rect: part.rect,
        segmentRects: part.segmentRects
      }
    }))
    await commit(annotations.concat(items))
    if (!pending) selection.clear()
  } catch (error) { status(error.message) }
}
ui.save.onclick = () => {
  const item = selected()
  if (item) commit(annotations.map(ann => ann.uid === item.uid ? { ...ann, data: { ...ann.data, notes: ui.note.value, color: ui.color.value } } : ann))
}
ui.delete.onclick = () => commit(annotations.filter(item => item.uid !== ui.annotations.value))
ui.retry.onclick = () => { if (pending) commit(pending) }
ui.annotations.onchange = showNote
ui.note.oninput = ui.color.oninput = () => {
  noteDirty = true
  status('Unsaved changes. Choose Save changes to save your note and color.')
  controls()
}
ui.export.onclick = () => {
  const items = (pending || annotations).map(item => item.uid === ui.annotations.value && noteDirty ? { ...item, data: { ...item.data, notes: ui.note.value, color: ui.color.value } } : item)
  const blob = new Blob([JSON.stringify({ version: 1, source, annotations: items }, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = 'pdf-highlights.json'
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 10000)
}
ui.import.onchange = async () => {
  try {
    const file = ui.import.files[0]
    if (!file || file.size > 1024 * 1024) throw new Error('Choose a Markdown or JSON file smaller than 1 MiB')
    const result = await window.pdfAnnotations.importLegacy(await file.text())
    if (!result.ok) throw new Error(result.error)
    const ids = new Set(annotations.map(item => item.uid))
    if (result.annotations.some(item => ids.has(item.uid))) throw new Error('Duplicate highlight IDs; import canceled')
    await commit(annotations.concat(result.annotations))
  } catch (error) { status('Import failed: ' + error.message) } finally { ui.import.value = '' }
}
ui.download.onclick = () => window.postMessage({ message: 'downloadFile', url: source })
window.parentProcessActions = {
  downloadPDF: () => ui.download.click(),
  printPDF: () => commands?.execute('document.print'),
  startFindInPage: () => searchScope?.startSearch(),
  endFindInPage: () => { searchGeneration++; if (searchScope) searchScope.stopSearch() },
  async findPDF (text, options = {}) {
    if (!searchScope) return null
    const generation = ++searchGeneration
    searchScope.startSearch()
    if (searchScope.getState().query !== text) {
      await searchScope.searchAllPages(text).toPromise()
    } else if (options.findNext === false) {
      if (options.forward === false) searchScope.previousResult()
      else searchScope.nextResult()
    }
    if (generation !== searchGeneration) return null
    const state = searchScope.getState()
    return { matches: state.total, activeMatchOrdinal: state.total ? state.activeResultIndex + 1 : 0, finalUpdate: true }
  }
}
window.addEventListener('beforeunload', event => {
  if (!window.pdfHighlightsLeaving && (busy || pending || noteDirty)) { event.preventDefault(); event.returnValue = '' }
})
window.addEventListener('unload', () => ui.viewer.replaceChildren())
window.pdfHighlightsState = () => ({ dirty: Boolean(busy || pending || noteDirty) })
window.pdfHighlightsPrepare = () => {
  document.body.inert = true
  return window.pdfHighlightsState()
}
window.pdfHighlightsSave = async () => {
  await savingDone
  if (pending) await commit(pending)
  else if (noteDirty && selected()) await commit(annotations.map(item => item.uid === ui.annotations.value ? { ...item, data: { ...item.data, notes: ui.note.value, color: ui.color.value } } : item))
  return !window.pdfHighlightsState().dirty
}

async function start () {
  if (!source || !/^(vault|https?|file):/.test(source)) throw new Error('Unsupported PDF source')
  document.title = (source.startsWith('vault://')
    ? vaultDisplayPath(source).split('/').pop()
    : decodeURIComponent(new URL(source).pathname.split('/').pop())) || 'PDF'
  const viewer = EmbedPDF.init({
    type: 'container',
    target: ui.viewer,
    wasmUrl: new URL('../../node_modules/@embedpdf/snippet/dist/pdfium.wasm', location.href).href,
    worker: true,
    fonts: { ui: null, signature: null },
    theme: { preference: 'system' },
    fontFallback: { fonts: {} },
    documentManager: { maxDocuments: 1 },
    tabBar: 'never',
    // Other tools would imply persistence we do not provide.
    disabledCategories: ['annotation', 'redaction', 'signature', 'document-open'],
    annotations: { autoCommit: false, autoOpenLinks: false, locked: { type: LockModeType.All } },
    zoom: { defaultZoomLevel: 'fit-width' }
  })
  const registry = await viewer.registry
  let buffer
  if (source.startsWith('file:')) {
    const result = await window.pdfAnnotations.readFile()
    if (!result.ok) throw new Error(result.error)
    buffer = result.bytes.buffer
  } else {
    const response = await fetch(source, { credentials: source.startsWith('vault:') ? 'omit' : 'include' })
    if (!response.ok) throw new Error('PDF load failed: ' + response.status)
    buffer = await response.arrayBuffer()
  }
  const manager = registry.getPlugin('document-manager').provides()
  const opened = await manager.openDocumentBuffer({ buffer, name: document.title, autoActivate: true }).toPromise()
  pageCount = (await opened.task.toPromise()).pageCount
  documentId = opened.documentId
  searchScope = registry.getPlugin('search').provides().forDocument(documentId)
  commands = registry.getPlugin('commands').provides().forDocument(documentId)
  scope = registry.getPlugin('annotation').provides().forDocument(documentId)
  selection = registry.getPlugin('selection').provides()
  const result = await window.pdfAnnotations.load()
  if (result.ok) {
    annotations = result.annotations
    revision = result.revision
    render()
    writable = true
    status('Select PDF text, then choose Highlight selection.')
  } else status(result.error + '. PDF reading remains available.')
  controls()
  document.body.dataset.pdfBackend = 'embedpdf'
  document.body.dataset.pdfReady = 'true'
}

start().catch(error => status('Unable to open PDF: ' + error.message))
