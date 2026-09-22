/* global Option, crypto, location, vaultDisplayPath, pdfNoteLayout */
import EmbedPDF, { PdfAnnotationSubtype, LockModeType } from '@embedpdf/snippet'
import { PdfBlendMode, PdfStandardFont, PdfTextAlignment, PdfVerticalAlignment } from '@embedpdf/models'

const source = new URLSearchParams(location.search).get('url')
const ui = Object.fromEntries(['viewer', 'viewer-message', 'status', 'annotations', 'note', 'color', 'save', 'delete', 'retry'].map(id => [id, document.getElementById(id)]))
let annotations = []
let revision = null
let pending = null
let scope
let selection
let documentId
let pages = []
let noteBoxes = new Map()
let noteLayouts = new Map()
let searchScope
let commands
let searchGeneration = 0
let busy = false
let savingDone = Promise.resolve()
let writable = false
let noteDirty = false
let rendered = []
const palette = document.getElementById('selection-palette')
const editor = document.getElementById('annotation-editor')
let selectionPoint = { x: 16, y: 80 }
let creating = false
const colors = ['#ffeb3b', '#ff9800', '#f44336', '#e91e63', '#9c27b0', '#673ab7', '#3f51b5', '#2196f3', '#03a9f4', '#00bcd4', '#009688', '#4caf50', '#8bc34a', '#cddc39', '#ffc107', '#ff5722']
function hidePalette () { palette.hidden = true }
function positionPopup (element) {
  element.style.left = Math.max(8, Math.min(selectionPoint.x, window.innerWidth - element.offsetWidth - 8)) + 'px'
  element.style.top = Math.max(8, Math.min(selectionPoint.y + 12, window.innerHeight - element.offsetHeight - 8)) + 'px'
}
function openNote () {
  hidePalette()
  editor.hidden = false
  positionPopup(editor)
  ui.note.focus()
}
function closeNote () {
  if (busy || pending || noteDirty) return
  editor.hidden = true
}
document.getElementById('close-note').onclick = () => {
  if (busy || pending) return
  showNote()
  closeNote()
}
function showPalette () {
  if (!writable || busy || pending || noteDirty || creating || !selection.getFormattedSelection(documentId).length) return hidePalette()
  palette.hidden = false
  closeNote()
  positionPopup(palette)
}
for (const color of colors) {
  const button = document.createElement('button')
  button.className = 'swatch'
  button.style.backgroundColor = color
  button.title = 'Highlight ' + color
  button.setAttribute('aria-label', button.title)
  button.onclick = () => highlightSelection(color)
  palette.appendChild(button)
}
const addNote = document.createElement('button')
addNote.textContent = 'Highlight & add note'
addNote.onclick = () => highlightSelection(ui.color.value, true)
palette.appendChild(addNote)
palette.onpointerdown = event => event.preventDefault()
ui.viewer.addEventListener('pointerup', event => {
  selectionPoint = { x: event.clientX, y: event.clientY }
})
document.addEventListener('pointerdown', event => { if (!palette.contains(event.target)) hidePalette() })
document.addEventListener('keydown', event => { if (event.key === 'Escape') { hidePalette(); closeNote() } })
window.addEventListener('scroll', hidePalette, true)
window.addEventListener('resize', () => { hidePalette(); if (!editor.hidden) positionPopup(editor) })

function status (text) {
  ui.status.textContent = text
  ui['viewer-message'].hidden = !text
}
function controls () {
  if (!writable || busy || pending || noteDirty) hidePalette()
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
  const layouts = new Map(Array.from(noteBoxes, ([uid, box]) => [uid, scope.getAnnotationById(box.id)?.object.rect]))
  const nextLayouts = new Map()
  for (const item of rendered) scope.deleteAnnotation(item.data.pageIndex, item.uid)
  for (const box of noteBoxes.values()) scope.deleteAnnotation(box.pageIndex, box.id)
  noteBoxes = new Map()
  const measure = document.createElement('canvas').getContext('2d')
  measure.font = '12px Helvetica, Arial, sans-serif'
  for (const item of annotations) {
    const page = pages[item.data.pageIndex]
    if (!page || !item.data.notes.trim()) continue
    // Display-only companions: the vault note remains the single source of truth.
    // Bound the preview so a long note cannot obscure the entire PDF page.
    const text = item.data.notes.replace(/\s+/g, ' ').trim()
    const characters = Array.from(text)
    const contents = characters.length > 240 ? characters.slice(0, 237).join('') + '…' : text
    const width = Math.min(220, page.size.width)
    let lines = 1
    let line = ''
    for (const word of contents.split(' ')) {
      const next = line ? line + ' ' + word : word
      if (line && measure.measureText(next).width > width) {
        lines++
        line = ''
      } else if (line) {
        line = next
        continue
      }
      // Long URLs and text without spaces still wrap within the preview box.
      for (const character of word) {
        if (line && measure.measureText(line + character).width > width) {
          lines++
          line = ''
        }
        line += character
      }
    }
    const height = Math.min(lines * 15 + 8, 100, page.size.height)
    const highlight = item.data.rect
    const right = highlight.origin.x + highlight.size.width + 6
    const x = right + width <= page.size.width ? right : Math.max(0, Math.min(highlight.origin.x, page.size.width - width))
    const y = right + width <= page.size.width ? highlight.origin.y : highlight.origin.y + highlight.size.height + 6
    const automatic = {
      origin: { x, y: Math.max(0, Math.min(y, page.size.height - height)) },
      size: { width, height }
    }
    const layout = pdfNoteLayout(automatic, noteLayouts.get(item.uid), layouts.get(item.uid))
    nextLayouts.set(item.uid, layout)
    noteBoxes.set(item.uid, {
      id: 'min-note-' + crypto.randomUUID(),
      type: PdfAnnotationSubtype.FREETEXT,
      pageIndex: item.data.pageIndex,
      rect: { origin: { ...layout.rect.origin }, size: { ...layout.rect.size } },
      // Native handles may change geometry, but note text is edited through the vault UI.
      flags: ['lockedContents'],
      contents,
      fontFamily: PdfStandardFont.Helvetica,
      fontSize: 12,
      fontColor: '#333333',
      textAlign: PdfTextAlignment.Left,
      verticalAlign: PdfVerticalAlignment.Top,
      color: '#fff9dc',
      opacity: 1,
      created: new Date(),
      custom: { vaultNoteFor: item.uid }
    })
  }
  noteLayouts = nextLayouts
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
  scope.importAnnotations(Array.from(noteBoxes.values(), annotation => ({ annotation })))
  rendered = annotations
  const previous = ui.annotations.value
  ui.annotations.replaceChildren(new Option(annotations.length ? 'Select a highlight' : 'No highlights yet', ''))
  for (const item of annotations) ui.annotations.add(new Option(`Page ${item.data.pageIndex + 1}: ${item.data.text.slice(0, 60) || item.uid}`, item.uid))
  ui.annotations.value = annotations.some(item => item.uid === previous) ? previous : annotations[0]?.uid || ''
  showNote()
}

async function commit (items, selectedId) {
  if (busy) return
  busy = true
  let finishSave
  savingDone = new Promise(resolve => { finishSave = resolve })
  pending = items
  controls()
  status('')
  try {
    const result = await window.pdfAnnotations.save({ annotations: items, revision })
    if (!result.ok) throw new Error(result.error)
    revision = result.revision
    annotations = result.annotations
    pending = null
    noteDirty = false
    render()
    if (selectedId) {
      ui.annotations.value = selectedId
      showNote()
    }
    status('')
  } catch (error) {
    if (pending) ui.retry.hidden = false
    status(pending ? 'Not saved: ' + error.message + ' Retry before leaving this tab.' : 'Saved, but the display could not refresh. Reopen this PDF: ' + error.message)
  } finally {
    busy = false
    finishSave()
    controls()
  }
}

async function highlightSelection (color, editNote = false) {
  if (!writable || busy || pending || noteDirty || creating) return
  creating = true
  hidePalette()
  try {
    const selections = selection.getFormattedSelection(documentId)
    if (!selections.length) return status('Select text in the PDF first.')
    const text = (await selection.getSelectedText(documentId).toPromise()).join(' ').trim()
    const items = selections.map(part => ({
      uid: crypto.randomUUID(),
      sourceType: 'pdf',
      data: {
        color,
        notes: '',
        text,
        textBefore: '',
        textAfter: '',
        pageIndex: part.pageIndex,
        rect: part.rect,
        segmentRects: part.segmentRects
      }
    }))
    await commit(annotations.concat(items), items[0].uid)
    if (!pending) {
      selection.clear(documentId)
      if (editNote) openNote()
    }
  } catch (error) { status(error.message) } finally { creating = false }
}
ui.save.onclick = async () => {
  const item = selected()
  if (item) await commit(annotations.map(ann => ann.uid === item.uid ? { ...ann, data: { ...ann.data, notes: ui.note.value, color: ui.color.value } } : ann))
  closeNote()
}
ui.delete.onclick = async () => { await commit(annotations.filter(item => item.uid !== ui.annotations.value)); closeNote() }
ui.retry.onclick = () => { if (pending) commit(pending) }
ui.annotations.onchange = showNote
ui.note.oninput = ui.color.oninput = () => {
  noteDirty = true
  status('')
  controls()
}
window.parentProcessActions = {
  downloadPDF: () => window.postMessage({ message: 'downloadFile', url: source }),
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
    wasmUrl: new URL('../../dist/pdfViewer/pdfium.wasm', location.href).href,
    worker: true,
    fonts: { ui: null, signature: null },
    theme: { preference: 'system' },
    fontFallback: { fonts: {} },
    // Stamp tools are disabled; don't download their default asset library.
    stamp: { manifests: [], defaultLibrary: false },
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
  const pdf = await opened.task.toPromise()
  pages = pdf.pages
  documentId = opened.documentId
  searchScope = registry.getPlugin('search').provides().forDocument(documentId)
  commands = registry.getPlugin('commands').provides().forDocument(documentId)
  const annotationAPI = registry.getPlugin('annotation').provides()
  annotationAPI.addTool({
    ...annotationAPI.getTool('freeText'),
    id: 'vaultNote',
    categories: ['vault-note'],
    matchScore: annotation => noteBoxes.get(annotation.custom?.vaultNoteFor)?.id === annotation.id ? 2 : 0
  })
  scope = annotationAPI.forDocument(documentId)
  // Unlock only our display companions, never highlights or annotations in the source PDF.
  scope.setLocked({ type: LockModeType.Exclude, categories: ['vault-note'] })
  selection = registry.getPlugin('selection').provides()
  const scroll = registry.getPlugin('scroll').provides().forDocument(documentId)
  const viewport = registry.getPlugin('viewport').provides().forDocument(documentId)
  function handleAnnotationClick (event) {
    if (!writable || busy || pending || noteDirty || selection.getFormattedSelection(documentId).length) return
    const metrics = viewport.getMetrics()
    const container = event.composedPath().find(node => node.nodeType === 1 && node.style.overflow === 'auto' && node.clientWidth === metrics.clientWidth && node.clientHeight === metrics.clientHeight)
    if (!container) return
    const bounds = container.getBoundingClientRect()
    const x = event.clientX - bounds.left - metrics.clientLeft + metrics.scrollLeft
    const y = event.clientY - bounds.top - metrics.clientTop + metrics.scrollTop
    function hit (pageIndex, segment) {
      const rect = scroll.getRectPositionForPage(pageIndex, segment)
      return rect && x >= rect.origin.x && x <= rect.origin.x + rect.size.width && y >= rect.origin.y && y <= rect.origin.y + rect.size.height
    }
    const note = annotations.find(item => {
      const box = noteBoxes.get(item.uid)
      const rect = box && scope.getAnnotationById(box.id)?.object.rect
      return rect && hit(item.data.pageIndex, rect)
    })
    // Single click selects the native move/resize handles. Double click edits the note.
    if (note && event.type !== 'dblclick') { closeNote(); return }
    const item = note || annotations.find(item => item.data.segmentRects.some(segment => hit(item.data.pageIndex, segment)))
    if (item) {
      selectionPoint = { x: event.clientX, y: event.clientY }
      ui.annotations.value = item.uid
      showNote()
      openNote()
    } else closeNote()
  }
  ui.viewer.addEventListener('click', handleAnnotationClick)
  ui.viewer.addEventListener('dblclick', handleAnnotationClick)
  viewport.onScrollChange(() => { hidePalette(); closeNote() })
  selection.onBeginSelection(hidePalette)
  selection.onEndSelection(event => {
    if (event.documentId === documentId) setTimeout(showPalette, 0)
  })
  selection.onSelectionChange(event => {
    if (event.documentId === documentId && !event.selection) hidePalette()
  })
  const result = await window.pdfAnnotations.load()
  if (result.ok) {
    annotations = result.annotations
    revision = result.revision
    render()
    writable = true
    status('')
  } else status(result.error + '. PDF reading remains available.')
  controls()
  document.body.dataset.pdfBackend = 'embedpdf'
  document.body.dataset.pdfReady = 'true'
}

start().catch(error => status('Unable to open PDF: ' + error.message))
