const assert = require('node:assert/strict')
const EventEmitter = require('node:events')
const test = require('node:test')
const createSettingsAccess = require('../main/settingsAccess.js')
const createSettings = require('../js/util/settings/settingsMain.js')

function caller (url) {
  const sender = { mainFrame: { url }, isDestroyed: () => false, send: function () {} }
  return { sender, senderFrame: sender.mainFrame }
}

function harness () {
  const chrome = caller('min://app/index.html')
  const settings = caller('min://app/pages/settings/index.html')
  const reader = caller('min://app/reader/index.html?url=https%3A%2F%2Fexample.com')
  const error = caller('min://app/pages/error/index.html?url=https://example.com')
  const restore = caller('min://app/pages/sessionRestoreError/index.html?backupName=old')
  const tabs = new Set([settings.sender, reader.sender, error.sender, restore.sender])
  const authorize = createSettingsAccess({ isChrome: sender => sender === chrome.sender, isTab: sender => tabs.has(sender) })
  return { authorize, chrome, settings, reader, error, restore, tabs }
}

test('settings access preserves trusted chrome, Settings, reader and themed error pages', function () {
  const h = harness()
  for (const event of [h.chrome, h.settings, h.reader, h.error, h.restore]) {
    assert.equal(h.authorize(event, 'read'), true)
  }
  for (const event of [h.chrome, h.settings]) assert.equal(h.authorize(event, 'write', 'filtering'), true)
  for (const key of ['readerData', 'readerDayTheme', 'readerNightTheme']) assert.equal(h.authorize(h.reader, 'write', key), true)
  for (const event of [h.reader, h.error, h.restore]) assert.equal(h.authorize(event, 'write', 'filtering'), false)
})

test('settings access rejects foreign contents, subframes, navigations and destroyed frames', function () {
  const h = harness()
  const denied = [
    caller('min://app/index.html'),
    caller('min://app/pages/settings/index.html'),
    { sender: h.settings.sender, senderFrame: { url: h.settings.senderFrame.url } },
    { sender: h.settings.sender },
    {}
  ]
  for (const url of ['https://example.com', 'vault://note.md', 'min://app.evil/pages/settings/index.html',
    'min://user@app/pages/settings/index.html', 'min://app:123/pages/settings/index.html',
    'min://app/index.html', 'min://app/pages/settings/other.html']) {
    const event = caller(url)
    h.tabs.add(event.sender)
    denied.push(event)
  }
  for (const event of denied) {
    assert.equal(h.authorize(event, 'read'), false)
    assert.equal(h.authorize(event, 'write', 'siteTheme'), false)
  }
  h.chrome.senderFrame.url = 'https://example.com'
  assert.equal(h.authorize(h.chrome, 'read'), false)
  h.settings.sender.isDestroyed = () => true
  assert.equal(h.authorize(h.settings, 'read'), false)
  Object.defineProperty(h.reader.senderFrame, 'url', { get () { throw new Error('detached') } })
  assert.equal(h.authorize(h.reader, 'read'), false)
  h.tabs.delete(h.error.sender)
  assert.equal(h.authorize(h.error, 'read'), false)
})

async function service (h, storage) {
  const ipc = new EventEmitter()
  const handlers = new Map()
  ipc.handle = (name, handler) => handlers.set(name, handler)
  const writes = []
  const warnings = []
  const settings = createSettings({
    authorize: h.authorize,
    getAllWebContents: () => [h.chrome.sender, ...h.tabs],
    ipc,
    storage: storage || { read: () => '{}', write: async value => { writes.push(value) } },
    warn: (...args) => warnings.push(args)
  })
  await settings.initialize('/unused')
  return { ipc, settings, writes, warnings, set: handlers.get('settings:set') }
}

test('settings IPC fails closed and sends updates only to currently authorized contents', async function () {
  const h = harness()
  const external = caller('https://example.com')
  h.tabs.add(external.sender)
  const received = new Map()
  for (const sender of [h.chrome.sender, ...h.tabs]) sender.send = (channel, value) => received.set(sender, { channel, value })
  const s = await service(h)
  const writes = s.writes.length
  s.ipc.emit('settings:connect', external)
  assert.deepEqual(external.returnValue.values, {})
  assert.equal(external.returnValue.error.code, 'SETTINGS_CALLER_DENIED')
  assert.equal((await s.set(external, { key: 'siteTheme', value: false })).error.code, 'SETTINGS_CALLER_DENIED')
  assert.equal(s.writes.length, writes)
  h.reader.senderFrame.url = 'https://example.com'
  assert.equal((await s.set(h.settings, { key: 'siteTheme', value: false })).ok, true)
  s.ipc.emit('settings:connect', h.chrome)
  assert.equal(h.chrome.returnValue.values.siteTheme, false)
  assert.equal(received.has(h.chrome.sender), true)
  assert.equal(received.has(h.error.sender), true)
  assert.equal(received.has(external.sender), false)
  assert.equal(received.has(h.reader.sender), false)
  assert.equal(received.get(h.chrome.sender).channel, 'settings:changed')
})

test('settings notification failures do not misreport durable writes or block other recipients', async function () {
  const h = harness()
  const closed = new Error('Renderer closed while sending')
  const detached = new Error('Main frame unavailable')
  h.chrome.sender.send = () => { throw closed }
  Object.defineProperty(h.reader.sender, 'mainFrame', { get () { throw detached } })
  const received = []
  h.error.sender.send = (channel, value) => received.push({ channel, value })
  const s = await service(h)
  const failures = []
  s.settings.onError(error => failures.push(error))
  const writes = s.writes.length

  assert.deepEqual(await s.set(h.settings, { key: 'siteTheme', value: false }), { ok: true, revision: 1 })
  assert.equal(s.writes.length, writes + 1)
  assert.equal(s.writes[writes].siteTheme, false)
  assert.equal(s.settings.get('siteTheme'), false)
  assert.deepEqual(received, [{ channel: 'settings:changed', value: { key: 'siteTheme', revision: 1, value: false } }])
  assert.deepEqual(s.warnings.map(([, error]) => error), [closed, detached])

  assert.deepEqual(await s.settings.set('smoothScrolling', false), { ok: true, revision: 2 })
  assert.equal(received.length, 2)
  assert.equal(received[1].value.revision, 2)
  assert.deepEqual(failures, [])
})

test('queued settings requests lose authority after navigation or ownership removal', async function () {
  for (const revoke of [
    h => { h.settings.senderFrame.url = 'https://example.com' },
    h => { h.settings.senderFrame.url += '?new-document' },
    h => { h.settings.sender.mainFrame = { url: h.settings.senderFrame.url } },
    h => h.tabs.delete(h.settings.sender)
  ]) {
    const h = harness()
    let release
    let block = false
    let writes = 0
    const s = await service(h, {
      read: () => '{}',
      write: () => {
        writes++
        return block ? new Promise(resolve => { release = resolve }) : Promise.resolve()
      }
    })
    block = true
    const first = s.settings.set('siteTheme', false)
    await Promise.resolve()
    const queued = s.set(h.settings, { key: 'smoothScrolling', value: false })
    revoke(h)
    block = false
    release()
    await first
    const count = writes
    assert.equal((await queued).error.code, 'SETTINGS_CALLER_DENIED')
    assert.equal(writes, count)
    assert.equal(s.settings.get('smoothScrolling'), true)
    assert.equal((await s.settings.set('smoothScrolling', false)).ok, true)
  }
})

test('settings IPC is denied by default when no caller policy is wired', async function () {
  const h = harness()
  h.authorize = undefined
  const s = await service(h)
  s.ipc.emit('settings:connect', h.chrome)
  assert.deepEqual(h.chrome.returnValue.values, {})
  assert.equal((await s.set(h.settings, { key: 'siteTheme', value: false })).error.code, 'SETTINGS_CALLER_DENIED')
  assert.equal((await s.settings.set('siteTheme', false)).ok, true)
})
