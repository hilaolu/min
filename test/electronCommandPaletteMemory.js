const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { app, BaseWindow, screen, webContents, WebContentsView } = require('electron')
const createBrowserWindows = require('../main/windowManagement.js')

// Allows an old module to be measured without modifying the working tree.
const sourceArgument = process.argv.find(argument => argument.startsWith('--presentation-source='))
const createPresentation = require(sourceArgument ? path.resolve(sourceArgument.slice('--presentation-source='.length)) : '../main/commandPaletteOverlay.js')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'min-palette-memory-'))
app.setPath('userData', temporary)
app.disableHardwareAcceleration()
app.on('window-all-closed', () => {})
let stage = 'ready'
const deadline = setTimeout(() => {
  console.error('Command Palette memory timeout: ' + stage)
  app.exit(1)
}, 30000)

const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
async function waitFor (check) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await check()) return
    await pause(25)
  }
  throw new Error('Condition not met: ' + stage)
}

function resources () {
  const metrics = app.getAppMetrics()
  const pss = metrics.map(metric => {
    if (process.platform !== 'linux') return null
    try {
      return Number(fs.readFileSync(`/proc/${metric.pid}/smaps_rollup`, 'utf8').match(/^Pss:\s+(\d+)\s+kB$/m)[1])
    } catch (error) { return null }
  })
  return {
    webContents: webContents.getAllWebContents().length,
    appPssKiB: pss.includes(null) ? null : pss.reduce((total, value) => total + value, 0),
    // Informational OS working-set readings, not forced-GC heap or a promise
    // of whole-app savings. Renderer sharing/allocator behavior may vary.
    renderers: metrics.filter(metric => metric.type === 'Tab').map(metric => ({
      pid: metric.pid,
      workingSetKiB: metric.memory.workingSetSize
    }))
  }
}

async function run () {
  await app.whenReady()
  const windows = createBrowserWindows({
    app: { getName: () => 'Min test', getVersion: () => 'test', quit: () => {} },
    BaseWindow,
    WebContentsView,
    browserChromePreloadPath: path.join(__dirname, '../main/commandPalettePreload.js'),
    browserPage: 'data:text/html,' + encodeURIComponent('<input id="input"><script>window.entered = null; input.onkeydown = e => { if (e.key === "Enter") window.entered = input.value }</script>'),
    buildTouchBar: () => null,
    createBrowserChromeRuntimeArgument: () => '--min-palette-test',
    fs,
    getSetting: () => false,
    onAllWindowsClosed: () => {},
    onRecenterOverlay: window => presentation?.recenter(window),
    prepareClose: () => true,
    path,
    rootDir: path.resolve(__dirname, '..'),
    screen,
    userDataPath: temporary
  })
  let paletteContents
  const presentation = createPresentation({
    WebContentsView: function (options) {
      const view = new WebContentsView(options)
      paletteContents = view.webContents
      return view
    },
    getWindowWebContents: windows.getChromeContents,
    pageURL: pathToFileURL(path.join(__dirname, '../pages/commandPalette/overlay.html')).href,
    preloadPath: path.join(__dirname, '../main/commandPalettePreload.js'),
    idleDelay: 1000, // Unit tests check the production 30-second deadline.
    windows
  })
  try {
    stage = 'load browser windows'
    const windowA = windows.create()
    const chromeA = windows.getChromeContents(windowA)
    await new Promise(resolve => chromeA.once('did-finish-load', resolve))
    const windowB = windows.create()
    const chromeB = windows.getChromeContents(windowB)
    await new Promise(resolve => chromeB.once('did-finish-load', resolve))
    const tab = new WebContentsView()
    const tabContents = tab.webContents
    tab.setBounds({ x: 0, y: 80, width: 800, height: 500 })
    windows.presentTabContent(chromeA, 'fixture-tab', tab, true)
    await tabContents.loadURL('data:text/html,Tab')
    windowA.show()
    windowA.focus()
    await waitFor(() => windowA.isFocused())
    const baseline = resources()
    let previousContents

    for (let cycle = 0; cycle < 3; cycle++) {
      stage = 'open cycle ' + cycle
      await chromeA.executeJavaScript('input.value = ">"; window.entered = null; input.focus()')
      tabContents.focus()
      assert.equal(webContents.getFocusedWebContents(), tabContents)
      assert.deepEqual(presentation.present(chromeA, {
        open: true,
        visible: true,
        input: 'cycle ' + cycle,
        candidates: [{ id: cycle, title: 'Result ' + cycle }]
      }), { ok: true })
      const contents = paletteContents
      const ready = new Promise(resolve => contents.once('did-finish-load', resolve))
      assert.notEqual(contents, previousContents, 'cold reopen creates fresh content')
      assert.equal(webContents.getFocusedWebContents(), chromeA)
      // Keys must reach Chrome immediately, without waiting for a cold overlay.
      chromeA.sendInputEvent({ type: 'char', keyCode: 'w' })
      chromeA.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
      chromeA.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
      // Input dispatch and evaluation use different IPC queues. Wait only for
      // observation, never before sending the keys (and never resend them).
      stage = 'observe immediate keys in cycle ' + cycle
      await waitFor(async () => (await chromeA.executeJavaScript('window.entered')) !== null)
      assert.equal(await chromeA.executeJavaScript('window.entered'), '>w')
      await ready
      stage = 'render fresh state'
      await waitFor(async () => (await contents.executeJavaScript('document.querySelector(".command-suggestion-title")?.textContent')) === 'Result ' + cycle)
      assert.equal(await contents.executeJavaScript('document.getElementById("command-palette-input").value'), 'cycle ' + cycle)
      assert.equal(webContents.getAllWebContents().length, baseline.webContents + 1)
      const palettePID = contents.getOSProcessId()

      presentation.present(chromeA, { visible: false })
      presentation.present(chromeA, { open: true, visible: true, candidates: [{ title: 'Warm result' }] })
      assert.equal(paletteContents, contents, 'quick reopen reuses content')
      await pause(1100)
      assert.equal(contents.isDestroyed(), false, 'the canceled timer must not destroy visible content')
      presentation.present(chromeA, { visible: false })
      stage = 'clear hidden DOM'
      await waitFor(async () => (await contents.executeJavaScript('document.querySelectorAll(".command-suggestion").length')) === 0)
      const hidden = resources()
      await pause(1200)
      const retired = resources()
      console.log(JSON.stringify({ cycle, baseline, palettePID, hidden, retired }))
      assert.equal(contents.isDestroyed(), true, 'idle palette WebContents must be destroyed')
      assert.equal(retired.webContents, baseline.webContents)
      assert.equal(windows.windowFromContents(contents), undefined)
      assert.equal(chromeA.isDestroyed(), false)
      assert.equal(chromeB.isDestroyed(), false)
      assert.equal(tabContents.isDestroyed(), false)
      previousContents = contents
    }

    stage = 'dispose before the overlay finishes loading'
    presentation.present(chromeA, { open: true, visible: true })
    const loadingContents = paletteContents
    const disposed = new Promise(resolve => loadingContents.once('destroyed', resolve))
    presentation.destroy()
    await disposed
    assert.equal(webContents.getAllWebContents().length, baseline.webContents)

    stage = 'transfer ownership and close windows'
    presentation.present(chromeA, { open: true, visible: true })
    const transferredContents = paletteContents
    await new Promise(resolve => transferredContents.once('did-finish-load', resolve))
    presentation.present(chromeB, { open: true, visible: true })
    windowA.destroy()
    assert.equal(transferredContents.isDestroyed(), false, 'closing an old owner must not destroy the new owner\'s view')
    windowB.destroy()
    await waitFor(() => transferredContents.isDestroyed() && chromeA.isDestroyed() && chromeB.isDestroyed())
    assert.equal(tabContents.isDestroyed(), false, 'presentation cleanup never unloads tabs')
    tabContents.destroy()
    await waitFor(() => tabContents.isDestroyed())
    assert.equal(webContents.getAllWebContents().length, 0)
    console.log('Command Palette idle disposal, recreation, focus and owner cleanup passed')
  } finally {
    presentation.destroy()
    for (const window of windows.getAll()) window.destroy()
    for (const contents of webContents.getAllWebContents()) contents.destroy()
  }
}

run().then(() => {
  clearTimeout(deadline)
  fs.rmSync(temporary, { recursive: true, force: true })
  app.exit(0)
}).catch(error => {
  console.error(error)
  clearTimeout(deadline)
  fs.rmSync(temporary, { recursive: true, force: true })
  app.exit(1)
})
