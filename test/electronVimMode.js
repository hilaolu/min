/* global Response */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { app, BrowserWindow, ipcMain, Menu, protocol } = require('electron')

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'min-vim-mode-'))
app.setPath('userData', temp)
app.disableHardwareAcceleration()
protocol.registerSchemesAsPrivileged(['min', 'vault'].map(scheme => ({ scheme, privileges: { standard: true, secure: true } })))

// Register hostile shortcuts in the head, before DOMContentLoaded, in both
// capture and bubble phases. Vim must win even against window capture.
const html = `<!doctype html><html><head><script>
  window.websiteEvents = []
  window.clicks = 0
  for (const target of [window, document]) {
    for (const capture of [true, false]) {
      for (const type of ['keydown', 'keypress', 'keyup']) {
        target.addEventListener(type, event => {
          websiteEvents.push([type, event.key])
          if (!event.target.closest?.('input, textarea, select, [contenteditable], [data-shadow-editor]') &&
              ['k', 'l', '/', 'f', 'a', 'Enter', 'p', 'c'].includes(event.key)) {
            event.preventDefault()
            event.stopImmediatePropagation()
          }
        }, capture)
      }
    }
  }
</script><style>body { min-height: 4000px; }</style></head><body>
  <button onclick="clicks++">Hint target</button>
  <input id="input"><textarea id="textarea"></textarea>
  <div id="editable" contenteditable="true"></div>
  <p>Searchable example text</p>
</body></html>`
const server = http.createServer((request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html' })
  response.end(html)
})
let win
const deadline = setTimeout(() => { console.error('Vim mode test timeout'); finish(1) }, 30000)

async function run () {
  await app.whenReady()
  Menu.setApplicationMenu(null)
  ipcMain.handle('web-annotations', () => ({ ok: true, annotations: [], revision: null }))
  for (const scheme of ['min', 'vault']) {
    protocol.handle(scheme, () => new Response(html, { headers: { 'Content-Type': 'text/html' } }))
  }
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}/`
  win = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: path.resolve(__dirname, '../dist/preload.js'),
      nodeIntegration: false,
      nodeIntegrationInSubFrames: true,
      contextIsolation: true,
      sandbox: true
    }
  })
  const contents = win.webContents
  const preloadErrors = []
  contents.on('preload-error', (event, file, error) => preloadErrors.push(error.message))
  await win.loadURL(url)
  win.focus()
  contents.focus()
  const evaluate = script => contents.executeJavaScript(script)
  async function press (keyCode, modifiers = [], repeats = 0) {
    contents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    for (let i = 0; i < repeats; i++) {
      contents.sendInputEvent({ type: 'keyDown', keyCode, modifiers: [...modifiers, 'isautorepeat'] })
    }
    if (keyCode.length === 1 && !modifiers.includes('control')) {
      contents.sendInputEvent({ type: 'char', keyCode, modifiers })
    }
    contents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
    // Flush the input queue before inspecting the DOM.
    await evaluate('new Promise(resolve => requestAnimationFrame(() => resolve()))')
  }
  async function assertNoWebsiteKeys () {
    assert.deepEqual(await evaluate('websiteEvents'), [])
  }

  await evaluate('window.scrollTo(0, 500)')
  await press('k')
  assert.equal(await evaluate('scrollY'), 440)
  await assertNoWebsiteKeys()

  await press('/')
  await press('x')
  assert.equal(await evaluate('document.querySelector("[data-min-vim-hud]").textContent'), '/x')
  await press('Enter')
  await assertNoWebsiteKeys()

  await evaluate('window.scrollTo(0, 0)')
  await press('f')
  await press('a')
  assert.equal(await evaluate('clicks'), 1)
  await assertNoWebsiteKeys()

  // Native editing must still receive Vim-looking letters and punctuation.
  for (const id of ['input', 'textarea', 'editable']) {
    await evaluate(`document.getElementById('${id}').focus(); websiteEvents = []`)
    await press('k')
    await press('/')
    assert.equal(await evaluate(`document.getElementById('${id}').${id === 'editable' ? 'textContent' : 'value'}`), 'k/')
    assert.ok((await evaluate('websiteEvents')).length > 0)
    await evaluate('websiteEvents = []')
    await press('c', ['control'])
    assert.equal(await evaluate('document.activeElement === document.body'), true)
    await assertNoWebsiteKeys()
  }

  for (const mode of ['open', 'closed']) {
    await evaluate(`(() => {
      const host = document.createElement('div')
      host.setAttribute('data-shadow-editor', '')
      document.body.appendChild(host)
      window.shadowInput = document.createElement('textarea')
      host.attachShadow({ mode: '${mode}' }).appendChild(shadowInput)
      shadowInput.focus()
      websiteEvents = []
    })()`)
    await press('k')
    await press('/')
    assert.equal(await evaluate('shadowInput.value'), 'k/')
    await evaluate('websiteEvents = []')
    await press('c', ['control'])
    assert.equal(await evaluate('document.activeElement === document.body'), true)
    await assertNoWebsiteKeys()
  }

  await press('p', ['control'], 3)
  await assertNoWebsiteKeys()
  const beforePassthrough = await evaluate('scrollY')
  await press('l')
  await press('c', ['control'])
  assert.equal(await evaluate('scrollY'), beforePassthrough)
  const passthroughEvents = await evaluate('websiteEvents')
  assert.ok(passthroughEvents.some(([type, key]) => type === 'keydown' && key === 'l'))
  assert.ok(passthroughEvents.some(([type, key]) => type === 'keyup' && key === 'c'))
  await evaluate('websiteEvents = []')
  await press('p', ['control'], 3)
  await press('l')
  assert.equal(await evaluate('scrollY'), beforePassthrough + 60)
  await assertNoWebsiteKeys()

  // Both same-origin and cross-origin frames reserve keyboard priority.
  for (const frameURL of [`${url}frame`, `${url.replace('127.0.0.1', 'localhost')}frame`]) {
    await evaluate(`new Promise(resolve => {
      const frame = document.createElement('iframe')
      frame.onload = () => resolve()
      frame.src = '${frameURL}'
      document.body.appendChild(frame)
    })`)
    const frame = contents.mainFrame.frames.find(frame => frame.url === frameURL)
    assert.ok(frame, `Frame loaded: ${frameURL}`)
    const frameResult = await frame.executeJavaScript(`(() => {
      window.scrollTo(0, 500)
      for (const type of ['keydown', 'keypress', 'keyup']) {
        document.body.dispatchEvent(new KeyboardEvent(type, { key: 'k', code: 'KeyK', bubbles: true, cancelable: true }))
      }
      return { y: scrollY, events: websiteEvents }
    })()`)
    assert.deepEqual(frameResult, { y: 440, events: [] })
  }

  for (const internal of ['min://app/vim-test', 'vault://notes/vim-test']) {
    await win.loadURL(internal)
    await press('k')
    assert.ok((await evaluate('websiteEvents')).some(([type, key]) => type === 'keydown' && key === 'k'))
    assert.equal(await evaluate('document.querySelector("[data-min-vim-hud]")'), null)
  }
  assert.deepEqual(preloadErrors, [])
  console.log('PASS Vim keyboard priority: early website capture, full keystrokes, search, hints, editing, passthrough repeats, same/cross-origin frames and internal pages')
}

run().then(() => finish(0), error => { console.error(error); finish(1) })
function finish (code) {
  clearTimeout(deadline)
  if (win && !win.isDestroyed()) win.destroy()
  server.close()
  fs.rmSync(temp, { recursive: true, force: true })
  app.exit(code)
}
