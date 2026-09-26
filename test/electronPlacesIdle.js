const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { app, BrowserWindow, MessageChannelMain, webContents } = require('electron')
const createPlacesManager = require('../main/placesManager.js')

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'min-places-idle-'))
app.setPath('userData', temporary)
app.disableHardwareAcceleration()
app.on('window-all-closed', () => {})
process.on('uncaughtException', error => { console.error(error); app.exit(1) })
const deadline = setTimeout(() => { console.error('Places idle timeout'); app.exit(1) }, 90000)
const places = createPlacesManager({
  BrowserWindow,
  pageURL: 'file://' + path.resolve(__dirname, '../js/places/placesService.html')
})
const clients = []

async function connect () {
  const window = new BrowserWindow({ show: false })
  clients.push(window)
  const { port1, port2 } = new MessageChannelMain()
  let markReady
  const ready = new Promise(resolve => { markReady = resolve })
  const callbacks = new Map()
  let nextId = 1
  port1.on('message', ({ data }) => {
    if (data.type === 'ready') {
      assert.equal(data.ok, true)
      markReady()
    } else {
      const callback = callbacks.get(data.callbackId)
      callbacks.delete(data.callbackId)
      assert.equal(data.ok, true, JSON.stringify(data.error))
      if (callback) callback(data.result)
    }
  })
  port1.start()
  places.connect(window.webContents, port2)
  await ready
  return {
    request (data) {
      return new Promise(resolve => {
        const callbackId = nextId++
        callbacks.set(callbackId, resolve)
        port1.postMessage({ ...data, callbackId })
      })
    },
    close () { port1.close(); callbacks.clear(); window.destroy() }
  }
}

async function run () {
  await app.whenReady()
  assert.equal(places.getWindow(), null)
  const client = await connect()
  const service = places.getWindow()
  const serviceContents = service.webContents
  const bookmarkURL = 'https://places-idle.test/bookmark'
  await client.request({ action: 'updatePlace', pageData: { url: bookmarkURL, title: 'Durable bookmark', isBookmarked: true, tags: ['idle'] } })

  // Exercise the same work barrier used by periodic maintenance, with a real
  // IndexedDB write finishing after the last client disconnects.
  await serviceContents.executeJavaScript(`void placesConnection.runTask(async () => {
    await new Promise(resolve => setTimeout(resolve, 150))
    await db.places.put({ id: 999, url: 'https://places-idle.test/late', title: 'Late write',
      lastVisit: Date.now(), visitCount: 1, isBookmarked: true, tags: [],
      extractedText: '', searchIndex: [], pageHTML: '', metadata: {} })
  })`)
  const serviceClosed = new Promise(resolve => service.once('closed', resolve))
  const serviceDisposed = new Promise(resolve => serviceContents.once('destroyed', resolve))
  const started = Date.now()
  // Post a burst and immediately disconnect without waiting for acknowledgements.
  // Native MessagePort delivery and the work barrier must not lose these writes.
  for (let index = 0; index < 20; index++) {
    client.request({ action: 'updatePlace', pageData: { url: `https://places-idle.test/burst${index}`, title: 'Queued bookmark', isBookmarked: true } })
  }
  client.close()
  assert.equal(places.getWindow(), service)
  await serviceClosed
  await serviceDisposed
  assert.equal(places.getWindow(), null)
  assert.equal(places.isReady(), false)
  assert.equal(webContents.getAllWebContents().length, 0)
  const idleMs = Date.now() - started

  const next = await connect()
  assert.notEqual(places.getWindow(), service)
  const bookmark = await next.request({ action: 'getPlace', pageData: { url: bookmarkURL } })
  const late = await next.request({ action: 'getPlace', pageData: { url: 'https://places-idle.test/late' } })
  assert.equal(bookmark.title, 'Durable bookmark')
  assert.equal(late.title, 'Late write')
  assert.equal(late.id, 999)
  for (let index = 0; index < 20; index++) {
    const queued = await next.request({ action: 'getPlace', pageData: { url: `https://places-idle.test/burst${index}` } })
    assert.equal(queued?.title, 'Queued bookmark')
  }
  next.close()
  console.log(JSON.stringify({ idleMs, retainedIdleWebContents: 0, recreated: true, durableRecords: 22 }))
}

run().then(() => {
  clearTimeout(deadline)
  places.destroy()
  fs.rmSync(temporary, { recursive: true, force: true })
  app.quit()
}).catch(error => {
  console.error(error)
  clearTimeout(deadline)
  places.destroy()
  for (const client of clients) if (!client.isDestroyed()) client.destroy()
  app.exit(1)
})
