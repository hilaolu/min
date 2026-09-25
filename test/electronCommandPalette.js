const assert = require('node:assert/strict')
const path = require('node:path')
const { app, BaseWindow, WebContentsView, webContents } = require('electron')
const createPresentation = require('../main/commandPaletteOverlay.js')

app.disableHardwareAcceleration()
const deadline = setTimeout(() => {
  console.error('Command palette focus smoke timed out')
  app.exit(1)
}, 30000)

async function run () {
  await app.whenReady()
  const window = new BaseWindow({ width: 900, height: 700 })
  const chrome = new WebContentsView()
  const tab = new WebContentsView()
  window.contentView.addChildView(chrome)
  window.contentView.addChildView(tab)
  chrome.setBounds({ x: 0, y: 0, width: 900, height: 700 })
  tab.setBounds({ x: 0, y: 80, width: 900, height: 620 })
  let attached = false
  const presentation = createPresentation({
    WebContentsView,
    getWindowWebContents: () => chrome.webContents,
    pageURL: 'data:text/html,Palette',
    preloadPath: path.join(__dirname, '../main/commandPalettePreload.js'),
    windows: {
      windowFromContents: () => ({ win: window }),
      isOverlayAttached: () => attached,
      attachOverlay: function (id, view) {
        window.contentView.addChildView(view)
        attached = true
        return true
      },
      detachOverlay: function (id, view) {
        window.contentView.removeChildView(view)
        attached = false
      }
    }
  })
  try {
    await chrome.webContents.loadURL('data:text/html,' + encodeURIComponent('<input id="input"><script>window.entered = null; input.onkeydown = e => { if (e.key === "Enter") window.entered = input.value }</script>'))
    await tab.webContents.loadURL('data:text/html,Tab')
    window.show()
    window.focus()
    for (const text of ['w', 'r', 'goo']) {
      // Prepare the DOM target just as showWithPrefix does, then start with
      // native keyboard focus in the tab to exercise the presentation handoff.
      await chrome.webContents.executeJavaScript('input.value = ">"; window.entered = null; input.focus()')
      tab.webContents.focus()
      assert.equal(tab.webContents.isFocused(), true)
      assert.deepEqual(presentation.present(chrome.webContents, { open: true, visible: true, input: '>' }), { ok: true })
      const focused = webContents.getFocusedWebContents()
      assert.equal(focused, chrome.webContents)
      // No timer or overlay-ready wait before the next character and Enter.
      for (const key of text) focused.sendInputEvent({ type: 'char', keyCode: key })
      focused.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
      focused.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
      assert.equal(await chrome.webContents.executeJavaScript('window.entered'), '>' + text)
      presentation.present(chrome.webContents, { visible: false })
    }
    console.log('Command palette immediate-focus Electron smoke passed')
  } finally {
    presentation.destroy()
    chrome.webContents.close()
    tab.webContents.close()
    window.destroy()
  }
}

run().then(() => {
  clearTimeout(deadline)
  app.exit(0)
}).catch(error => {
  console.error(error)
  app.exit(1)
})
