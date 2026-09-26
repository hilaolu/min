const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')

// Optional old source for before/after measurements; regression assertions stay on.
const sourceArgument = process.argv.find(argument => argument.startsWith('--overlay-source='))
const overlaySource = sourceArgument ? fs.readFileSync(sourceArgument.slice('--overlay-source='.length), 'utf8') : null
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'min-overlay-memory-'))
app.setPath('userData', profile)
app.disableHardwareAcceleration()
let stage = 'ready'
const deadline = setTimeout(() => {
  console.error(`Task overlay memory smoke timed out: ${stage}`)
  app.exit(1)
}, 30000)

async function run () {
  await app.whenReady()
  const window = new BrowserWindow({
    show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  })
  try {
    stage = 'load fixture page'
    await window.loadURL('data:text/html,<!doctype html><title>Task overlay memory fixture</title>')
    const contents = window.webContents
    contents.debugger.attach('1.3')
    const memory = async function () {
      // Allow pending focus/layout work and drag animation timers to settle.
      await new Promise(resolve => setTimeout(resolve, 300))
      await contents.executeJavaScript('document.body.offsetHeight')
      stage = 'collect garbage'
      await contents.debugger.sendCommand('HeapProfiler.collectGarbage')
      stage = 'DOM counters'
      const dom = await contents.debugger.sendCommand('Memory.getDOMCounters')
      stage = 'heap usage'
      const heap = await contents.debugger.sendCommand('Runtime.getHeapUsage')
      return { nodes: dom.nodes, listeners: dom.jsEventListeners, heapBytes: heap.usedSize, embedderHeapBytes: heap.embedderHeapUsedSize }
    }
    const fixture = path.join(__dirname, 'fixtures/taskOverlayLifecycle.js')
    stage = 'initialize fixture'
    await contents.executeJavaScript(`window.fixture = require(${JSON.stringify(fixture)})(2000, ${overlaySource === null ? 'undefined' : JSON.stringify(overlaySource)}); undefined`)
    const before = await memory()
    stage = 'show'
    const shown = await contents.executeJavaScript('window.fixture.show()')
    stage = 'hide'
    const hidden = await contents.executeJavaScript('window.fixture.hide()')
    const after = await memory()
    // Print measurements before assertions so the same test documents the leak
    // when run against the old implementation. Heap bytes are informational.
    console.log(JSON.stringify({ tabCount: 2000, before, shown, hidden, after }))
    assert.deepEqual(hidden, { rows: 0, sortables: 0, detachedRows: 0 })
    assert.ok(after.nodes <= before.nodes + 10, 'closed overlay must not retain its detached DOM')
    assert.equal(after.listeners, before.listeners)
    for (let cycle = 0; cycle < 3; cycle++) {
      stage = 'check reopen/reclose'
      await contents.executeJavaScript('window.fixture.checkReopen(); window.fixture.checkReclose()')
    }
    const repeated = await memory()
    console.log(JSON.stringify({ repeated }))
    assert.ok(repeated.nodes <= before.nodes + 10)
    assert.equal(repeated.listeners, before.listeners)
    console.log('Task overlay lifecycle and memory smoke passed')
  } finally {
    window.destroy()
  }
}

run().then(() => {
  clearTimeout(deadline)
  fs.rmSync(profile, { recursive: true, force: true })
  app.exit(0)
}).catch(error => {
  console.error(error)
  fs.rmSync(profile, { recursive: true, force: true })
  app.exit(1)
})
