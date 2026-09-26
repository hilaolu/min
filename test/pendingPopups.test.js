const assert = require('node:assert/strict')
const EventEmitter = require('node:events')
const test = require('node:test')
const createPendingPopups = require('../main/pendingPopups.js')

function contents () {
  const target = new EventEmitter()
  target.destroyCount = 0
  target.isDestroyed = () => target.destroyCount > 0
  target.destroy = function () {
    this.destroyCount++
    this.emit('destroyed')
  }
  return target
}

function owner () {
  return { contents: contents(), window: contents() }
}

function checkReleased (owner) {
  assert.equal(owner.contents.listenerCount('destroyed'), 0)
  assert.equal(owner.contents.listenerCount('render-process-gone'), 0)
  assert.equal(owner.window.listenerCount('closed'), 0)
}

test('many pending popups share owner listeners and adoption releases all bookkeeping', function () {
  const popups = createPendingPopups()
  const source = owner()
  for (let id = 0; id < 100; id++) {
    assert.equal(popups.add(id, { webContents: contents() }, source.contents, source.window), true)
  }
  assert.equal(source.contents.listenerCount('destroyed'), 1)
  assert.equal(source.contents.listenerCount('render-process-gone'), 1)
  assert.equal(source.window.listenerCount('closed'), 1)
  const adopted = []
  for (let id = 0; id < 100; id++) {
    const view = popups.take(id, source.contents)
    adopted.push(view)
    assert.equal(view.webContents.listenerCount('destroyed'), 0)
    assert.equal(popups.take(id, source.contents), null)
  }
  checkReleased(source)
  popups.destroyAll()
  source.contents.destroy()
  for (const view of adopted) assert.equal(view.webContents.destroyCount, 0)
})

for (const event of ['destroyed', 'render-process-gone', 'closed']) {
  test(`unadopted popups are destroyed on owner ${event}, without touching other owners`, function () {
    const popups = createPendingPopups()
    const first = owner()
    const second = owner()
    const views = Array.from({ length: 3 }, () => ({ webContents: contents() }))
    popups.add('one', views[0], first.contents, first.window)
    popups.add('two', views[1], first.contents, first.window)
    popups.add('other', views[2], second.contents, second.window)
    ;(event === 'closed' ? first.window : first.contents).emit(event)
    assert.deepEqual(views.map(view => view.webContents.destroyCount), [1, 1, 0])
    assert.equal(popups.take('one', first.contents), null)
    checkReleased(first)
    popups.destroyAll()
    popups.destroyAll()
    assert.deepEqual(views.map(view => view.webContents.destroyCount), [1, 1, 1])
    checkReleased(second)
  })
}

test('destroyed popups, failed owners and rejected cross-window adoption leave no orphan', function () {
  const popups = createPendingPopups()
  const source = owner()
  const view = { webContents: contents() }
  popups.add('one', view, source.contents, source.window)
  assert.throws(() => popups.take('one', contents()), { code: 'TAB_CONTENT_NOT_OWNER' })
  view.webContents.destroy()
  assert.equal(popups.take('one', source.contents), null)
  checkReleased(source)
  source.contents.destroy()
  const orphan = { webContents: contents() }
  assert.equal(popups.add('orphan', orphan, source.contents, source.window), false)
  assert.equal(orphan.webContents.destroyCount, 1)
  checkReleased(source)
})

test('popup cleanup does not read the view getter after WebContents destruction', function () {
  const popups = createPendingPopups()
  const source = owner()
  const popupContents = contents()
  const view = { get webContents () { return popupContents.isDestroyed() ? undefined : popupContents } }
  popups.add('popup', view, source.contents, source.window)
  popupContents.destroy()
  checkReleased(source)
  assert.equal(popups.take('popup', source.contents), null)
})
