const assert = require('node:assert/strict')
const EventEmitter = require('node:events')
const test = require('node:test')

const createWindowRegistry = require('../main/windowManagement.js')

function createWindow (contentsId) {
  const window = new EventEmitter()
  const chrome = { webContents: { id: contentsId } }
  const attachedView = { id: 'attached' }
  const removedViews = []

  window.getContentView = function () {
    return {
      children: [chrome, attachedView],
      removeChildView: view => removedViews.push(view)
    }
  }

  return { window, chrome, attachedView, removedViews }
}

test('window registry owns focus, lookup, detach, and final cleanup', function () {
  let quitCount = 0
  let cleanupCount = 0
  const registry = createWindowRegistry({
    app: { quit: () => { quitCount++ } },
    getWindowWebContents: window => window.getContentView().children[0].webContents,
    onAllWindowsClosed: () => { cleanupCount++ }
  })
  const first = createWindow(101)
  const second = createWindow(202)

  registry.addWindow(first.window)
  registry.addWindow(second.window)
  first.window.emit('focus')

  assert.equal(registry.getCurrent(), first.window)
  assert.equal(registry.windowFromContents(first.chrome.webContents).win, first.window)
  assert.deepEqual(registry.getAll(), [first.window, second.window])

  first.window.emit('close')
  assert.deepEqual(first.removedViews, [first.attachedView])
  assert.deepEqual(registry.getAll(), [second.window])
  first.window.emit('closed')

  assert.equal(cleanupCount, 0)

  second.window.emit('close')
  second.window.emit('closed')

  assert.equal(cleanupCount, 1)
  assert.equal(quitCount, process.platform === 'darwin' ? 0 : 1)
})
