// DISPLAY=:0 node_modules/.bin/electron --no-sandbox test/electronWebAnnotations.js
const { app, BrowserWindow, ipcMain } = require('electron')
const assert = require('node:assert/strict')
const http = require('node:http')
const path = require('node:path')
let server
app.whenReady().then(async () => {
  server = http.createServer((request, response) => response.end('<html><body><p>before selected quote after</p></body></html>'))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  let loaded = false
  let saved
  ipcMain.handle('web-annotations', (event, operation, payload) => {
    if (operation === 'save') {
      saved = payload.annotations
      return { ok: true, revision: 'saved', annotations: saved }
    }
    assert.equal(operation, 'load')
    loaded = true
    return { ok: true, revision: null, annotations: [{ uid: 'test', sourceType: 'webpage', data: { color: '#ffcd45', text: 'selected quote', notes: 'note', textBefore: 'before ', textAfter: ' after' } }] }
  })
  const window = new BrowserWindow({ show: true, webPreferences: { preload: path.resolve(__dirname, '../js/preload/annotations.js'), contextIsolation: true, sandbox: true, nodeIntegration: false } })
  await window.loadURL(`http://127.0.0.1:${server.address().port}/`)
  for (let attempt = 0; attempt < 50; attempt++) {
    const painted = await window.webContents.executeJavaScriptInIsolatedWorld(999, [{ code: 'window.CSS.highlights.get("min-annotations-ffcd45")?.size || 0' }])
    if (painted) break
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.equal(loaded, true)
  assert.equal(await window.webContents.executeJavaScriptInIsolatedWorld(999, [{ code: '[...window.CSS.highlights.get("min-annotations-ffcd45")][0].toString()' }]), 'selected quote')
  assert.equal(await window.webContents.executeJavaScript('typeof window.webAnnotations'), 'undefined')
  // DevTools can inspect the closed shadow root without exposing it to sites.
  const debug = window.webContents.debugger
  debug.attach('1.3')
  const { root } = await debug.sendCommand('DOM.getDocument', { depth: -1, pierce: true })
  function findPalette (node) {
    if (node.attributes?.includes('palette')) return node
    for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) {
      const found = findPalette(child)
      if (found) return found
    }
  }
  const { object } = await debug.sendCommand('DOM.resolveNode', { nodeId: findPalette(root).nodeId })
  async function palette (body) {
    const result = await debug.sendCommand('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: `function () { ${body} }`, returnByValue: true })
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  async function waitHidden (hidden) {
    for (let attempt = 0; attempt < 50; attempt++) {
      if (await palette('return this.hidden') === hidden) return
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert.equal(await palette('return this.hidden'), hidden)
  }
  async function displayedNotes (clickText) {
    const { root } = await debug.sendCommand('DOM.getDocument', { depth: -1, pierce: true })
    const nodes = []
    function visit (node) {
      if (node.attributes?.includes('annotation-note')) nodes.push(node)
      for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) visit(child)
    }
    visit(root)
    return Promise.all(nodes.map(async node => {
      const { object } = await debug.sendCommand('DOM.resolveNode', { nodeId: node.nodeId })
      const { result } = await debug.sendCommand('Runtime.callFunctionOn', {
        objectId: object.objectId,
        arguments: [{ value: clickText || null }],
        functionDeclaration: `function (clickText) {
          if (this.textContent === clickText) this.click();
          const style = getComputedStyle(this);
          return { text: this.textContent, hidden: this.hidden, whiteSpace: style.whiteSpace, overflow: style.overflow, wrap: style.overflowWrap, height: this.clientHeight, scrollHeight: this.scrollHeight };
        }`,
        returnByValue: true
      })
      return result.value
    }))
  }
  assert.equal((await displayedNotes()).find(note => note.text === 'note').hidden, false)
  assert.equal(await palette('return this.hidden'), true)
  for (let attempt = 0; attempt < 50; attempt++) {
    if (await window.webContents.executeJavaScriptInIsolatedWorld(999, [{ code: 'innerHeight > 0' }])) break
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  await window.webContents.executeJavaScript(`
    const range = document.createRange();
    range.setStart(document.querySelector('p').firstChild, 7);
    range.setEnd(document.querySelector('p').firstChild, 21);
    getSelection().removeAllRanges(); getSelection().addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup'));
  `)
  await waitHidden(false)
  assert.equal(await palette('return this.hidden'), false)
  assert.equal(await palette('return this.querySelectorAll(".swatch").length'), 16)
  assert.equal(await palette('return this.children.length'), 16)
  assert.equal(await palette('const buttons = [...this.children]; return buttons.every(button => button.offsetTop === buttons[0].offsetTop) && getComputedStyle(buttons[0]).borderRadius === "2px"'), true)
  assert.equal(await palette('const r = this.getBoundingClientRect(); return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight'), true)
  await palette('this.querySelectorAll(".swatch")[7].click()')
  for (let attempt = 0; attempt < 50; attempt++) {
    if (saved) break
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.equal(saved[1].data.text, 'selected quote')
  assert.equal(saved[1].data.color, '#2196f3')
  assert.equal(await palette('return this.hidden'), true)
  assert.equal(await window.webContents.executeJavaScriptInIsolatedWorld(999, [{ code: 'window.CSS.highlights.get("min-annotations-2196f3").size' }]), 1)
  const highlightStyle = await window.webContents.executeJavaScript(`(() => {
    const style = getComputedStyle(document.querySelector('p'), '::highlight(min-annotations-2196f3)');
    return { background: style.backgroundColor, line: style.textDecorationLine, thickness: style.textDecorationThickness, color: style.textDecorationColor };
  })()`)
  assert.deepEqual(highlightStyle, { background: 'rgba(33, 150, 243, 0.133)', line: 'underline', thickness: '2px', color: 'rgb(33, 150, 243)' })
  await window.webContents.executeJavaScript('getSelection().selectAllChildren(document.querySelector("p")); document.dispatchEvent(new MouseEvent("mouseup"))')
  await waitHidden(false)
  assert.equal(await palette('return this.hidden'), false)
  await window.webContents.executeJavaScript('getSelection().removeAllRanges(); document.dispatchEvent(new MouseEvent("mouseup"))')
  await waitHidden(true)
  assert.equal(await palette('return this.hidden'), true)
  async function clickHighlight () {
    await window.webContents.executeJavaScript(`(() => {
      const range = document.createRange();
      range.setStart(document.querySelector('p').firstChild, 7);
      range.setEnd(document.querySelector('p').firstChild, 21);
      const rect = range.getBoundingClientRect();
      document.querySelector('p').dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: rect.left + 2, clientY: rect.top + 2 }));
    })()`)
  }
  await clickHighlight()
  assert.equal(await palette('return this.getRootNode().querySelector("#edit-menu").hidden'), false)
  await palette('this.getRootNode().querySelector("#edit-note").click()')
  assert.equal(await palette('return this.getRootNode().querySelector("#note-editor").hidden'), false)
  assert.equal(await palette('return this.getRootNode().querySelector("dialog")'), null)
  assert.equal(await palette('return this.getRootNode().querySelector("#note-editor textarea").value'), 'note')
  assert.equal(await palette('return this.getRootNode().host.getRootNode().host.parentElement.tagName'), 'P')
  assert.equal(await palette('return getComputedStyle(this.getRootNode().querySelector("#note-editor")).position'), 'static')
  await palette('this.getRootNode().querySelector("#note-editor textarea").value = "discard me"')
  await window.webContents.executeJavaScriptInIsolatedWorld(999, [{ code: 'void (window.confirm = () => false)' }])
  await palette('this.getRootNode().querySelector("#reload").click()')
  assert.equal(await palette('return this.getRootNode().querySelector("#note-input").value'), 'discard me')
  assert.equal(await palette('return this.getRootNode().querySelector("#note-editor").hidden'), false)
  // Periodic re-anchoring must preserve the editor and its unsaved draft.
  await new Promise(resolve => setTimeout(resolve, 1600))
  assert.equal(await palette('return this.getRootNode().querySelector("#note-input").value'), 'discard me')
  assert.equal((await displayedNotes()).length, 2)
  // Losing the quote must not silently close the editor or discard its draft.
  await window.webContents.executeJavaScript('document.querySelector("p").textContent = "Content temporarily unavailable"')
  await new Promise(resolve => setTimeout(resolve, 1600))
  assert.equal(await palette('return this.getRootNode().querySelector("#note-editor").hidden'), false)
  assert.equal(await palette('return this.getRootNode().querySelector("#note-input").value'), 'discard me')
  assert.equal(await palette('return getComputedStyle(this.getRootNode().querySelector("#note-editor")).position'), 'fixed')
  assert.equal(await window.webContents.executeJavaScriptInIsolatedWorld(999, [{ code: '(() => { const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented })()' }]), true)
  await window.webContents.executeJavaScript('document.querySelector("p").textContent = "before selected quote after"')
  await new Promise(resolve => setTimeout(resolve, 1600))
  assert.equal(await palette('return this.getRootNode().querySelector("#note-input").value'), 'discard me')
  assert.equal(await palette('return getComputedStyle(this.getRootNode().querySelector("#note-editor")).position'), 'static')
  await displayedNotes('note')
  assert.equal(await palette('return this.getRootNode().querySelector("#note-input").value'), 'discard me', 'reopening the same note preserves its draft')
  await palette('this.getRootNode().querySelector("#cancel-note").click()')
  assert.equal(saved[0].data.notes, 'note')
  await clickHighlight()
  const longNote = 'First line\n' + 'A long note without truncation. '.repeat(60) + '\n<script>plain text</script>'
  await palette(`this.getRootNode().querySelector('#edit-note').click(); this.getRootNode().querySelector('#note-editor textarea').value = ${JSON.stringify(longNote)}; this.getRootNode().querySelector('#save-note').click()`)
  for (let attempt = 0; attempt < 50; attempt++) {
    if (saved[0].data.notes === longNote) break
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.equal(saved[0].data.notes, longNote)
  assert.equal(await palette('return this.getRootNode().querySelector("#note-editor").hidden'), true)
  const visibleNote = (await displayedNotes()).find(note => note.text === longNote)
  assert.equal(visibleNote.hidden, false)
  assert.equal(visibleNote.whiteSpace, 'pre-wrap')
  assert.equal(visibleNote.wrap, 'anywhere')
  assert.equal(visibleNote.overflow, 'visible')
  assert.equal(visibleNote.height, visibleNote.scrollHeight)
  await displayedNotes(longNote)
  assert.equal(await palette('return this.getRootNode().querySelector("#note-editor").hidden'), false)
  assert.equal(await palette('return this.getRootNode().querySelector("#note-input").value'), longNote)
  const detachedNote = longNote + '\nSaved without an anchor'
  await palette(`this.getRootNode().querySelector('#note-input').value = ${JSON.stringify(detachedNote)}`)
  await window.webContents.executeJavaScript('document.querySelector("p").textContent = "Content temporarily unavailable"')
  await new Promise(resolve => setTimeout(resolve, 1600))
  await palette('this.getRootNode().querySelector("#save-note").click()')
  for (let attempt = 0; attempt < 50; attempt++) {
    if (saved[0].data.notes === detachedNote) break
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.equal(saved[0].data.notes, detachedNote)
  assert.equal(await palette('return this.getRootNode().querySelector("#note-editor").hidden'), true)
  await window.webContents.executeJavaScript('document.querySelector("p").textContent = "before selected quote after"')
  await new Promise(resolve => setTimeout(resolve, 1600))
  assert.equal((await displayedNotes()).find(note => note.text === detachedNote).hidden, false)
  await clickHighlight()
  await window.webContents.executeJavaScriptInIsolatedWorld(999, [{ code: 'void (window.confirm = () => false)' }])
  await palette('this.getRootNode().querySelector("#delete-note").click()')
  assert.equal(saved.length, 2)
  await clickHighlight()
  await window.webContents.executeJavaScriptInIsolatedWorld(999, [{ code: 'void (window.confirm = () => true)' }])
  await palette('this.getRootNode().querySelector("#delete-note").click()')
  for (let attempt = 0; attempt < 50; attempt++) {
    if (saved.length === 1) break
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.equal(saved.length, 1)
  assert.notEqual(saved[0].uid, 'test')
  assert.equal((await displayedNotes()).some(note => note.text === detachedNote), false)
  await clickHighlight()
  await palette('this.getRootNode().querySelector("#delete-note").click()')
  for (let attempt = 0; attempt < 50; attempt++) {
    if (!saved.length) break
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.equal(saved.length, 0)
  assert.equal(await window.webContents.executeJavaScriptInIsolatedWorld(999, [{
    code: `(() => {
    const original = document.createTreeWalker;
    let scans = 0;
    document.createTreeWalker = function (...args) { scans++; return original.apply(this, args) };
    try { document.querySelector('p').click(); return scans } finally { document.createTreeWalker = original }
  })()`
  }]), 0, 'clicks without annotations do not scan page text')
  debug.detach()
  window.destroy()
  console.log('PASS: persistent untruncated notes, inline editor Save/Cancel, deletion, palette and translucent underlines')
  server.close()
  app.exit(0)
}).catch(error => {
  console.error(error)
  if (server) server.close()
  app.exit(1)
})
