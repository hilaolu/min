// Runs only in the isolated preload world; no vault API is exposed to sites.
if (process.isMainFrame && /^https?:$/.test(window.location.protocol)) {
  window.addEventListener('DOMContentLoaded', () => {
    const host = document.createElement('div')
    const shadow = host.attachShadow({ mode: 'closed' })
    document.documentElement.append(host)
    shadow.innerHTML = `<style>
      :host { all: initial; font: 14px sans-serif; color: #222; }
      button, textarea { font: inherit; } button { cursor: pointer; margin: 4px; }
      section { position: fixed; right: 12px; bottom: 12px; z-index: 2147483647; background: white; border: 1px solid #888; border-radius: 8px; padding: 12px; width: 300px; max-height: 65vh; overflow: auto; box-shadow: 0 2px 12px #888; }
      #palette, #edit-menu { position: fixed; z-index: 2147483647; display: flex; flex-direction: row; gap: 4px; padding: 8px; background: white; border: 1px solid #ccc; border-radius: 4px; box-shadow: 0 2px 10px rgba(0,0,0,.1); max-width: calc(100vw - 34px); overflow-x: auto; }
      #palette button, #edit-menu button { margin: 0; } .swatch { box-sizing: content-box; flex: 0 0 20px; width: 20px; height: 20px; padding: 0; border: 1px solid #ddd; border-radius: 2px; }
      #palette[hidden], #edit-menu[hidden], #note-editor[hidden] { display: none; }
      #note-editor { display: inline-block; vertical-align: top; box-sizing: border-box; width: 320px; max-width: calc(100vw - 32px); padding: 8px; border: 1px solid #ddd; border-radius: 4px; background: white; color: #333; font: 14px system-ui, sans-serif; }
      #note-editor label { display: block; margin-bottom: 6px; }
      #note-editor.detached { position: fixed; right: 12px; bottom: 12px; z-index: 2147483647; }
      #note-editor textarea { box-sizing: border-box; width: 100%; min-height: 80px; padding: 8px; border: 1px solid #ddd; border-radius: 4px; resize: vertical; margin-bottom: 8px; }
      .actions { display: flex; gap: 10px; justify-content: flex-end; } .actions button { margin: 0; padding: 8px 16px; border: 1px solid #ddd; border-radius: 4px; background: white; color: #666; }
      #save-note { background: #007bff; color: white; border: none; } #save-note:hover { background: #0056b3; }
      button:focus-visible { outline: 2px solid #2474da; outline-offset: 2px; }
      [hidden] { display: none; }
    </style><div id="palette" role="toolbar" aria-label="Annotate selection" hidden></div>
    <div id="edit-menu" role="toolbar" aria-label="Edit annotation" hidden><button id="edit-note" title="Edit Notes" aria-label="Edit Notes">📝</button><button id="delete-note" title="Delete" aria-label="Delete">🗑️</button></div>
    <div id="note-editor" hidden><label for="note-input">Edit Note</label><textarea id="note-input" aria-label="Annotation notes" placeholder="Enter your notes here..."></textarea><div class="actions"><button id="cancel-note">Cancel</button><button id="save-note">Save</button></div></div>
    <section hidden aria-label="Annotation status"><button id="close">Close</button><button id="reload">Reload</button><p role="status"></p></section>`
    const panel = shadow.querySelector('section')
    const status = shadow.querySelector('[role=status]')
    const editMenu = shadow.querySelector('#edit-menu')
    const editor = shadow.querySelector('#note-editor')
    const notes = editor.querySelector('textarea')
    const noteHosts = new Map()
    const uiHosts = new WeakSet([host])
    let editing = null
    let editRange = null
    const palette = shadow.querySelector('#palette')
    const colors = ['#ffeb3b', '#ff9800', '#f44336', '#e91e63', '#9c27b0', '#673ab7', '#3f51b5', '#2196f3', '#03a9f4', '#00bcd4', '#009688', '#4caf50', '#8bc34a', '#cddc39', '#ffc107', '#ff5722']
    let annotations = []
    let revision = null
    let ready = false
    let saving = false
    let dirty = false
    let selection = null
    let selectionRange = null
    const paintedNames = new Set()
    const source = window.location.href.split('#')[0]
    const sameSource = () => source === window.location.href.split('#')[0]
    const hasDraft = () => !editor.hidden && notes.value !== editing?.data.notes
    const invoke = (operation, payload) => require('electron').ipcRenderer.invoke('web-annotations', operation, payload)
    const style = document.createElement('style')
    document.documentElement.append(style)

    function textIndex () {
      const walker = document.createTreeWalker(document.body, 4)
      const nodes = []
      let text = ''
      let node
      while ((node = walker.nextNode())) {
        if (node.parentElement.closest('script,style,textarea,input,select,[contenteditable]')) continue
        nodes.push({ node, start: text.length })
        text += node.textContent
      }
      return { text, nodes }
    }
    function locate (data, index) {
      if (!data.text) return null
      const context = data.textBefore + data.text + data.textAfter
      let start = index.text.indexOf(context)
      if (start >= 0) {
        if (index.text.indexOf(context, start + 1) !== -1) return null
        start += data.textBefore.length
      } else {
        start = index.text.indexOf(data.text)
        if (start < 0 || index.text.indexOf(data.text, start + 1) !== -1) return null
      }
      const end = start + data.text.length
      const first = index.nodes.find(item => item.start + item.node.length > start)
      const last = index.nodes.find(item => item.start + item.node.length >= end)
      if (!first || !last) return null
      const range = document.createRange()
      range.setStart(first.node, start - first.start)
      range.setEnd(last.node, end - last.start)
      return range
    }
    function clearHighlights () {
      if (window.CSS?.highlights) {
        for (const name of paintedNames) window.CSS.highlights.delete(name)
      }
      paintedNames.clear()
      style.textContent = ''
    }
    function paint () {
      renderNotes()
      clearHighlights()
      if (!window.CSS?.highlights || !window.Highlight) return
      if (!annotations.length) return
      const index = textIndex()
      const groups = new Map()
      for (const item of annotations) {
        const range = locate(item.data, index)
        if (!range || !/^#[0-9a-f]{6}$/i.test(item.data.color)) continue
        const color = item.data.color.toLowerCase()
        if (!groups.has(color)) groups.set(color, [])
        groups.get(color).push(range)
      }
      const rules = []
      for (const [color, ranges] of groups) {
        const name = 'min-annotations-' + color.slice(1)
        paintedNames.add(name)
        const rgb = [1, 3, 5].map(offset => parseInt(color.slice(offset, offset + 2), 16)).join(', ')
        rules.push(`::highlight(${name}) { background-color: rgba(${rgb}, 0.133); text-decoration: underline 2px ${color}; }`)
        window.CSS.highlights.set(name, new window.Highlight(...ranges))
      }
      style.textContent = rules.join('\n')
    }
    async function save () {
      dirty = true
      paint()
      if (!sameSource()) ready = false
      if (saving || !ready) return
      saving = true
      while (dirty && ready) {
        dirty = false
        status.textContent = 'Saving…'
        try {
          const result = await invoke('save', { revision, annotations: JSON.parse(JSON.stringify(annotations)) })
          if (!result.ok) throw new Error(result.error)
          revision = result.revision
          status.textContent = 'Saved'
        } catch (error) {
          ready = false
          dirty = true
          panel.hidden = false
          status.textContent = error.message + ' — edits are not saved. Copy notes before reloading.'
        }
      }
      saving = false
      if (!ready) dismissPalette()
    }
    // Keep notes in the document flow, immediately after their quoted text.
    // Closed shadow roots exclude note/editor text from anchoring and page CSS.
    function renderNotes () {
      const active = new Set()
      let index = null
      for (const item of annotations) {
        if (!index) index = textIndex()
        const range = locate(item.data, index)
        if (!range) continue
        active.add(item.uid)
        let record = noteHosts.get(item.uid)
        if (!record) {
          const noteHost = document.createElement('span')
          uiHosts.add(noteHost)
          const root = noteHost.attachShadow({ mode: 'closed' })
          // An annotation can sit inside a link; editing it must not navigate.
          root.addEventListener('click', event => { event.preventDefault(); event.stopPropagation() })
          root.innerHTML = `<style>
            :host { all: initial; display: inline; }
            .annotation-note { display: inline-block; vertical-align: baseline; box-sizing: border-box; width: max-content; max-width: min(320px, calc(100vw - 32px)); margin: 2px 6px; padding: 4px 8px; border: 0; border-left: 3px solid; border-radius: 3px; font: 14px/1.5 system-ui, sans-serif; color: #222; text-align: left; white-space: pre-wrap; overflow-wrap: anywhere; cursor: text; }
            .annotation-note[hidden] { display: none; }
          </style><button class="annotation-note" title="Edit note" hidden></button>`
          const note = root.querySelector('button')
          record = { host: noteHost, root, note }
          noteHosts.set(item.uid, record)
        }
        if (!record.host.isConnected) {
          const end = range.cloneRange()
          end.collapse(false)
          end.insertNode(record.host)
          // insertNode can split a text node. Rebuild only after a mutation,
          // not once per annotation on every periodic refresh.
          index = null
        }
        if (record.note.textContent !== item.data.notes) record.note.textContent = item.data.notes
        record.note.onclick = () => openEditor(item)
        record.note.hidden = !item.data.notes || (!editor.hidden && editing?.uid === item.uid)
        record.note.style.borderColor = item.data.color
        record.note.style.backgroundColor = item.data.color + '22'
        if (!editor.hidden && editing?.uid === item.uid) {
          editor.classList.remove('detached')
          if (host.parentNode !== record.root) record.root.append(host)
        }
      }
      for (const [uid, record] of noteHosts) {
        if (active.has(uid)) continue
        if (record.root.contains(host)) {
          if (hasDraft()) {
            // Dynamic pages may remove the quote while a note is being edited.
            // Keep the draft visible and saveable even without an inline anchor.
            document.documentElement.append(host)
            editor.classList.add('detached')
          } else closeEditor()
        }
        record.host.remove()
        noteHosts.delete(uid)
      }
    }
    function isAnnotationUI (event) {
      return uiHosts.has(event.target)
    }
    function openEditor (item) {
      if (!sameSource()) return
      if (hasDraft() && editing === item) { notes.focus(); return }
      if (hasDraft() && editing !== item && !window.confirm('Discard unsaved note edits?')) return
      closeEditor()
      editing = item
      editRange = locate(item.data, textIndex())
      renderNotes()
      const record = noteHosts.get(item.uid)
      if (!record || !editRange) return
      notes.value = item.data.notes
      dismissPalette()
      editMenu.hidden = true
      editor.hidden = false
      record.note.hidden = true
      record.root.append(host)
      notes.focus()
      notes.style.height = 'auto'
      notes.style.height = notes.scrollHeight + 'px'
    }
    function closeEditor () {
      editor.hidden = true
      editor.classList.remove('detached')
      if (host.parentNode !== document.documentElement) document.documentElement.append(host)
      for (const record of noteHosts.values()) record.note.hidden = !record.note.textContent
    }
    async function load () {
      ready = false
      closeEditor()
      editing = null
      editRange = null
      editMenu.hidden = true
      dismissPalette()
      status.textContent = 'Loading…'
      try {
        const result = await invoke('load')
        if (!result.ok) throw new Error(result.error)
        annotations = result.annotations
        revision = result.revision
        dirty = false
        ready = true
        status.textContent = 'Select page text and choose a highlight color.'
        paint()
      } catch (error) { status.textContent = error.message }
    }
    function dismissPalette () {
      palette.hidden = true
      selection = null
      selectionRange = null
    }
    function positionPalette () {
      if (!editMenu.hidden && editRange) positionMenu(editMenu, editRange, false)
      if (!selectionRange || palette.hidden) return
      positionMenu(palette, selectionRange, true)
    }
    function positionMenu (menu, range, centered) {
      const rect = range.getBoundingClientRect()
      if (rect.bottom < 0 || rect.top > window.innerHeight) { menu.hidden = true; return }
      const width = menu.offsetWidth
      const height = menu.offsetHeight
      menu.style.left = Math.max(8, Math.min(window.innerWidth - width - 8, centered ? rect.left + (rect.width - width) / 2 : rect.left)) + 'px'
      const top = rect.top >= height + 8 ? rect.top - height - 8 : rect.bottom + 8
      menu.style.top = Math.max(8, Math.min(window.innerHeight - height - 8, top)) + 'px'
    }
    function updateSelection () {
      if (shadow.activeElement || !editor.hidden) return
      const selected = window.getSelection()
      if (!selected.rangeCount || selected.isCollapsed || !selected.toString().trim() || !sameSource()) { dismissPalette(); return }
      const range = selected.getRangeAt(0)
      const index = textIndex()
      const selectedNodes = index.nodes.filter(item => range.intersectsNode(item.node))
      const first = selectedNodes[0]
      const last = selectedNodes[selectedNodes.length - 1]
      if (!first || !last) { dismissPalette(); return }
      const start = first.start + (range.startContainer === first.node ? range.startOffset : 0)
      const end = last.start + (range.endContainer === last.node ? range.endOffset : last.node.length)
      selection = { color: '#ffcd45', text: index.text.slice(start, end), notes: '', textBefore: index.text.slice(Math.max(0, start - 32), start), textAfter: index.text.slice(end, end + 32) }
      selectionRange = range.cloneRange()
      palette.hidden = false
      editMenu.hidden = true
      if (!ready) panel.hidden = false
      for (const button of palette.querySelectorAll('.swatch')) button.disabled = !ready
      positionPalette()
    }
    document.addEventListener('selectionchange', updateSelection)
    document.addEventListener('mouseup', event => {
      if (!isAnnotationUI(event)) updateSelection()
    })
    document.addEventListener('keyup', event => {
      if (event.key !== 'Escape' && !isAnnotationUI(event)) updateSelection()
    })
    window.addEventListener('scroll', positionPalette, true)
    window.addEventListener('resize', positionPalette)
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') { dismissPalette(); editMenu.hidden = true; closeEditor(); panel.hidden = true }
    })
    document.addEventListener('pointerdown', event => {
      if (!isAnnotationUI(event)) { dismissPalette(); editMenu.hidden = true }
    })
    function hitAnnotation (event) {
      if (!annotations.length) return
      const index = textIndex()
      return annotations.find(item => {
        const range = locate(item.data, index)
        return range && Array.from(range.getClientRects()).some(rect => event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom)
      })
    }
    document.addEventListener('click', event => {
      if (isAnnotationUI(event) || !editor.hidden || !window.getSelection().isCollapsed || !sameSource()) return
      const item = hitAnnotation(event)
      if (item) {
        editing = item
        editRange = locate(item.data, textIndex())
        editMenu.hidden = false
        positionMenu(editMenu, editRange, false)
      }
    })
    shadow.querySelector('#edit-note').onclick = () => {
      if (editing) openEditor(editing)
    }
    shadow.querySelector('#cancel-note').onclick = closeEditor
    shadow.querySelector('#save-note').onclick = () => {
      if (!editing || !ready || !sameSource()) { panel.hidden = false; return }
      editing.data.notes = notes.value
      closeEditor()
      save()
    }
    shadow.querySelector('#delete-note').onclick = () => {
      if (editing && ready && sameSource() && window.confirm('Delete this annotation?')) {
        annotations = annotations.filter(item => item !== editing)
        editing = null
        save()
      }
      editMenu.hidden = true
    }
    shadow.querySelector('#close').onclick = () => { panel.hidden = true }
    shadow.querySelector('#reload').onclick = () => {
      if (sameSource() && !saving && ((!dirty && !hasDraft()) || window.confirm('Discard unsaved annotation edits?'))) load()
    }
    palette.onmousedown = event => event.preventDefault()
    function annotate (color) {
      if (!ready || !selection?.text || !sameSource()) return
      const uid = Array.from(window.crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('')
      annotations.push({ uid, sourceType: 'webpage', data: { ...selection, color } })
      dismissPalette()
      window.getSelection().removeAllRanges()
      save()
    }
    for (const color of colors) {
      const button = document.createElement('button')
      button.className = 'swatch'
      button.style.backgroundColor = color
      button.setAttribute('aria-label', 'Highlight ' + color)
      button.title = 'Highlight ' + color
      button.onclick = () => annotate(color)
      palette.append(button)
    }
    // Re-anchor on dynamic pages; never save an old page's edits to a new URL.
    setInterval(() => {
      if (!sameSource()) {
        ready = false
        dismissPalette()
        editMenu.hidden = true
        for (const record of noteHosts.values()) record.note.hidden = true
        status.textContent = 'Page address changed. Reload the page to annotate it.'
        clearHighlights()
      } else paint()
    }, 1500)
    window.addEventListener('beforeunload', event => {
      if (dirty || saving || hasDraft()) { event.preventDefault(); event.returnValue = '' }
    })
    load()
  })
}
