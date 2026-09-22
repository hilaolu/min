/* global Response */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { app, BrowserWindow, ipcMain, protocol, webContents } = require('electron')
const createSettings = require('../js/util/settings/settingsMain.js')
const createSettingsAccess = require('../main/settingsAccess.js')

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'min-settings-authority-'))
app.setPath('userData', temp)
app.disableHardwareAcceleration()
protocol.registerSchemesAsPrivileged([{ scheme: 'min', privileges: { standard: true, secure: true } }])
const chrome = new Set()
const tabs = new Set()
const windows = []
const settings = createSettings({
  authorize: createSettingsAccess({ isChrome: sender => chrome.has(sender), isTab: sender => tabs.has(sender) }),
  getAllWebContents: () => webContents.getAllWebContents(),
  ipc: ipcMain,
  storage: { read: () => '{}', write: async function () {} }
})
const deadline = setTimeout(() => { console.error('Settings authority timeout'); app.exit(1) }, 30000)

async function open (url, owners) {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'fixtures/settingsIPCPreload.js'),
      nodeIntegration: false,
      nodeIntegrationInSubFrames: true,
      contextIsolation: true,
      sandbox: true
    }
  })
  windows.push(win)
  if (owners) owners.add(win.webContents)
  await win.loadURL(url)
  return win.webContents
}

async function run () {
  await settings.initialize(temp)
  await app.whenReady()
  // Controlled documents: the test concerns real IPC sender/frame metadata,
  // independent of the packaged pages' preload-side URL checks.
  protocol.handle('min', () => new Response('<!doctype html><body>Settings authority fixture</body>', { headers: { 'Content-Type': 'text/html' } }))
  const toolbar = await open('min://app/index.html', chrome)
  const page = await open('min://app/pages/settings/index.html', tabs)
  const foreign = await open('min://app/pages/settings/index.html')
  assert.equal((await toolbar.executeJavaScript('settingsTest.connect()')).values.siteTheme, true)
  assert.equal((await page.executeJavaScript('settingsTest.set("siteTheme", false)')).ok, true)
  assert.equal((await toolbar.executeJavaScript('settingsTest.connect()')).values.siteTheme, false)
  assert.equal((await foreign.executeJavaScript('settingsTest.connect()')).error.code, 'SETTINGS_CALLER_DENIED')
  assert.equal((await foreign.executeJavaScript('settingsTest.set("siteTheme", true)')).error.code, 'SETTINGS_CALLER_DENIED')
  assert.equal((await foreign.executeJavaScript('settingsTest.changes()')).length, 0)

  await page.executeJavaScript(`new Promise(resolve => {
    const frame = document.createElement('iframe')
    frame.onload = () => resolve()
    frame.src = 'min://app/pages/settings/index.html'
    document.body.appendChild(frame)
  })`)
  const child = page.mainFrame.frames[0]
  assert.equal((await child.executeJavaScript('settingsTest.connect()')).error.code, 'SETTINGS_CALLER_DENIED')
  assert.equal((await child.executeJavaScript('settingsTest.set("siteTheme", true)')).error.code, 'SETTINGS_CALLER_DENIED')

  const reader = await open('min://app/reader/index.html?url=https://example.com', tabs)
  assert.equal((await reader.executeJavaScript('settingsTest.set("readerDayTheme", "sepia")')).ok, true)
  assert.equal((await reader.executeJavaScript('settingsTest.set("siteTheme", true)')).error.code, 'SETTINGS_CALLER_DENIED')
  const error = await open('min://app/pages/error/index.html', tabs)
  assert.equal((await error.executeJavaScript('settingsTest.connect()')).values.readerDayTheme, 'sepia')
  assert.equal((await error.executeJavaScript('settingsTest.set("siteTheme", true)')).error.code, 'SETTINGS_CALLER_DENIED')

  await page.loadURL('data:text/html,<body>external</body>')
  assert.equal((await page.executeJavaScript('settingsTest.connect()')).error.code, 'SETTINGS_CALLER_DENIED')
  assert.equal((await page.executeJavaScript('settingsTest.set("siteTheme", true)')).error.code, 'SETTINGS_CALLER_DENIED')
  await settings.set('siteTheme', true)
  assert.equal((await page.executeJavaScript('settingsTest.changes()')).length, 0)
  console.log('PASS settings authority: owned chrome/pages, denied foreign contents/subframes/navigation, scoped broadcasts and reader writes')
}

run().then(() => finish(0), error => { console.error(error); finish(1) })
function finish (code) {
  clearTimeout(deadline)
  windows.forEach(win => win.destroy())
  fs.rmSync(temp, { recursive: true, force: true })
  app.exit(code)
}
