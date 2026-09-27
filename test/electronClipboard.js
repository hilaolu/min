/* global Response */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { app, BrowserWindow, clipboard, ClipboardItem, ipcMain, protocol } = require('electron')
const { createRuntimeArgument } = require('../main/browserChromeRuntime.js')
const { installRendererHostClipboard } = require('../main/rendererHostClipboard.js')

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'min-clipboard-'))
app.setPath('userData', temp)
app.disableHardwareAcceleration()
protocol.registerSchemesAsPrivileged([{ scheme: 'min', privileges: { standard: true, secure: true } }])
let win
let originalClipboard
let finishing = false
const deadline = setTimeout(() => { console.error('Clipboard test timeout'); finish(1) }, 30000)

async function run () {
  await app.whenReady()
  // Do not log the user's clipboard, and restore it when the test finishes.
  originalClipboard = await Promise.all((await clipboard.read()).filter(item => item.types.length).map(async item => {
    const entries = await Promise.all(item.types.map(async type => [type, await item.getType(type)]))
    return new ClipboardItem(Object.fromEntries(entries))
  }))
  protocol.handle('min', () => new Response('<!doctype html><body>Clipboard fixture</body>', { headers: { 'Content-Type': 'text/html' } }))
  win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.resolve(__dirname, '../main/browserChromePreload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      additionalArguments: [createRuntimeArgument({
        appName: 'Min',
        appVersion: 'test',
        developmentMode: false,
        initialTask: null,
        initialWindow: true,
        launchWindow: true,
        platform: process.platform,
        windowId: 'clipboard-test'
      })]
    }
  })
  const preloadErrors = []
  installRendererHostClipboard({ clipboard, ClipboardItem, ipc: ipcMain, isChrome: contents => contents === win.webContents })
  win.webContents.on('preload-error', (event, file, error) => preloadErrors.push(error.message))
  await win.loadURL('min://app/index.html')
  assert.deepEqual(preloadErrors, [])

  const link = {
    url: 'https://example.com/path?q=one&other=two#section',
    title: 'Example title',
    html: '<a href="https://example.com/path?q=one&amp;other=two#section">Example</a>'
  }
  async function callHost (method, value) {
    return win.webContents.executeJavaScript(`(async function () {
      try {
        await browserChromeHost[${JSON.stringify(method)}](${JSON.stringify(value)})
        return null
      } catch (error) {
        return error.message
      }
    })()`)
  }
  const copyError = await callHost('copyPageLink', link)
  assert.equal(copyError, null, 'Copy Page URL must succeed through the isolated preload')
  assert.ok((await clipboard.readText()) === link.url, 'Clipboard text must contain the page URL')
  const items = await clipboard.read()
  const htmlItem = items.find(item => item.types.includes('text/html'))
  assert.ok(htmlItem, 'Copied links retain their HTML representation')
  assert.ok((await (await htmlItem.getType('text/html')).text()).includes(link.html))
  if (process.platform === 'darwin' || process.platform === 'win32') {
    const bookmarkItem = items.find(item => item.types.includes('electron application/bookmark'))
    assert.ok(bookmarkItem, 'Copied links retain their native bookmark representation')
    assert.deepEqual(await bookmarkItem.getType('electron application/bookmark'), { title: link.title, url: link.url })
  }

  assert.equal(await callHost('copyText', 42), null)
  assert.ok((await clipboard.readText()) === '42', 'Copy Text must update the native clipboard')
  assert.ok((await win.webContents.executeJavaScript('browserChromeHost.readClipboardText()')) === '42', 'Clipboard reads must resolve to text')
  assert.match(await callHost('copyPageLink', {}), /requires a non-empty URL/)
  assert.ok((await clipboard.readText()) === '42', 'Invalid links must not clear the clipboard')

  // A registered WebContents alone is not sufficient once its document changes.
  await win.loadURL('data:text/html,<!doctype html><body>Not browser chrome</body>')
  for (const [method, value] of [['copyPageLink', link], ['copyText', 'denied'], ['readClipboardText']]) {
    assert.match(await callHost(method, value), /only available to Browser Chrome/)
  }
  assert.ok((await clipboard.readText()) === '42', 'Denied requests must not change the clipboard')
  console.log('PASS clipboard: page links, text, asynchronous reads, invalid requests and navigation authorization')
}

run().then(() => finish(0), error => { console.error(error); finish(1) })
async function finish (code) {
  if (finishing) return
  finishing = true
  clearTimeout(deadline)
  try {
    if (originalClipboard) {
      if (originalClipboard.length) await clipboard.write(originalClipboard)
      else clipboard.clear()
    }
  } catch (error) {
    console.error('Failed to restore clipboard:', error.message)
    code = 1
  }
  if (win) win.destroy()
  fs.rmSync(temp, { recursive: true, force: true })
  app.exit(code)
}
