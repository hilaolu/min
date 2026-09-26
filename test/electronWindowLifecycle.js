const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { app, BaseWindow, ipcMain, screen, webContents, WebContentsView } = require('electron')
const createBrowserWindows = require('../main/windowManagement.js')
const createPendingPopups = require('../main/pendingPopups.js')

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'min-window-lifecycle-'))
app.setPath('userData', temporary)
app.disableHardwareAcceleration()
app.on('window-all-closed', () => {})
process.on('uncaughtException', error => { console.error(error); app.exit(1) })
const deadline = setTimeout(() => { console.error('Window lifecycle timeout'); app.exit(1) }, 30000)

async function run () {
  await app.whenReady()
  const windows = createBrowserWindows({
    app: { getName: () => 'Min test', getVersion: () => 'test', quit: () => {} },
    BaseWindow,
    WebContentsView,
    browserChromePreloadPath: path.join(__dirname, 'fixtures/windowLifecyclePreload.js'),
    browserPage: 'data:text/html,<title>Window lifetime test</title>',
    buildTouchBar: () => null,
    createBrowserChromeRuntimeArgument: () => '--min-window-test',
    fs,
    getSetting: () => false,
    onAllWindowsClosed: () => {},
    onRecenterOverlay: () => {},
    prepareClose: () => true,
    path,
    platform: 'darwin',
    rootDir: path.resolve(__dirname, '..'),
    screen,
    userDataPath: temporary
  })
  const baseline = webContents.getAllWebContents().length
  let unloads = 0
  ipcMain.on('test-chrome-unload', function (event) {
    const owner = windows.windowFromContents(event.sender)
    assert.ok(owner && windows.getAll().includes(owner.win), 'ownership must remain available for session persistence during beforeunload')
    unloads++
    event.returnValue = true
  })
  const pending = createPendingPopups()
  try {
    for (let cycle = 0; cycle < 3; cycle++) {
      const win = windows.create()
      const chrome = windows.getChromeContents(win)
      await new Promise(resolve => chrome.once('did-finish-load', resolve))
      const popup = new WebContentsView()
      const popupContents = popup.webContents
      pending.add(String(cycle), popup, chrome, win)
      const closed = new Promise(resolve => win.once('closed', resolve))
      win.close()
      await closed
      assert.equal(chrome.isDestroyed(), true)
      assert.equal(popupContents.isDestroyed(), true)
      assert.equal(unloads, cycle + 1)
      assert.equal(webContents.getAllWebContents().length, baseline)
    }
    const forced = windows.create()
    const forcedChrome = windows.getChromeContents(forced)
    await new Promise(resolve => forcedChrome.once('did-finish-load', resolve))
    const forcedClosed = new Promise(resolve => forced.once('closed', resolve))
    const forcedDisposed = new Promise(resolve => forcedChrome.once('destroyed', resolve))
    forced.destroy()
    await forcedClosed
    await forcedDisposed
    assert.equal(forcedChrome.isDestroyed(), true)
    assert.equal(webContents.getAllWebContents().length, baseline)
    console.log(JSON.stringify({ cycles: 3, unloads, retainedWebContents: 0, forcedClose: 'passed' }))
  } finally {
    pending.destroyAll()
    for (const win of windows.getAll()) win.destroy()
    for (const contents of webContents.getAllWebContents()) contents.destroy()
  }
}

run().then(() => {
  clearTimeout(deadline)
  fs.rmSync(temporary, { recursive: true, force: true })
  app.quit()
}).catch(error => {
  console.error(error)
  clearTimeout(deadline)
  fs.rmSync(temporary, { recursive: true, force: true })
  app.exit(1)
})
