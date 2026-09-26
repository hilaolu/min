const assert = require('node:assert/strict')
const EventEmitter = require('node:events')
const test = require('node:test')
const createPermissionManager = require('../main/permissionManager.js')

function createHarness () {
  const ipc = new EventEmitter()
  const chrome = {}
  const window = {}
  let windows = [window]
  const messages = []
  const manager = createPermissionManager({
    getTabIDFromWebContents: contents => contents.id,
    ipc,
    sendIPCToWindow: (win, channel, data) => { messages.push({ win, channel, data }) },
    windows: {
      getAll: () => windows,
      windowFromContents: sender => sender === chrome ? { win: window } : undefined
    }
  })
  const contents = id => Object.assign(new EventEmitter().setMaxListeners(0), { id, focus: () => {} })
  const details = { isMainFrame: true, requestingUrl: 'https://example.test/page' }
  return {
    ...manager,
    contents,
    details,
    messages,
    closeWindows: () => { windows = [] },
    openWindows: () => { windows = [window] },
    grant: (id, sender = chrome) => ipc.emit('permissionGranted', { sender }, id),
    revoke: (id, sender = chrome) => ipc.emit('revokePermission', { sender }, id),
    latest: () => messages[messages.length - 1]?.data || [],
    request: (target, type = 'notifications', respond = () => {}, extra = {}) => manager.pagePermissionRequestHandler(target, type, respond, { ...details, ...extra }),
    check: (target, type = 'notifications', extra = {}) => manager.pagePermissionCheckHandler(target, type, 'https://example.test/', { isMainFrame: true, ...extra })
  }
}

test('permission listeners stay bounded across repeated requests and navigations', function () {
  const harness = createHarness()
  const contents = harness.contents('a')
  let denied = 0
  for (let cycle = 0; cycle < 3; cycle++) {
    for (let request = 0; request < 1000; request++) {
      harness.request(contents, 'notifications', result => { if (!result) denied++ })
    }
    assert.equal(harness.latest().length, 1)
    assert.equal(contents.listenerCount('did-start-navigation'), 1)
    assert.equal(contents.listenerCount('destroyed'), 1)
    const updates = harness.messages.length
    contents.emit('did-start-navigation', {}, 'https://other.test/', false, true)
    assert.deepEqual(harness.latest(), [])
    assert.equal(harness.messages.length, updates + 1)
  }
  assert.equal(denied, 3 * 999, 'duplicate notifications are still denied, not silently approved')
  contents.emit('destroyed')
  assert.equal(contents.listenerCount('did-start-navigation'), 0)
  assert.equal(contents.listenerCount('destroyed'), 0)
})

test('destroying contents with no browser windows removes grants without sending IPC', function () {
  const harness = createHarness()
  const contents = harness.contents('a')
  const replies = []
  harness.request(contents, 'notifications', result => replies.push(result))
  harness.grant(harness.latest()[0].permissionId)
  assert.deepEqual(replies, [true])
  assert.equal(harness.check(contents), true)
  harness.closeWindows()
  const messages = harness.messages.length
  contents.emit('destroyed')
  assert.equal(harness.messages.length, messages)
  assert.equal(harness.check(contents), false)
  harness.openWindows()
  harness.request(harness.contents('b'))
  assert.equal(harness.latest().length, 1)
  assert.equal(harness.latest()[0].granted, undefined)
})

test('destroying contents with no windows also removes pending callbacks and duplicate suppression', function () {
  const harness = createHarness()
  const contents = harness.contents('a')
  let responses = 0
  harness.request(contents, 'notifications', () => { responses++ })
  const oldId = harness.latest()[0].permissionId
  harness.closeWindows()
  contents.emit('destroyed')
  harness.openWindows()
  harness.grant(oldId)
  assert.equal(responses, 0, 'a callback for destroyed content must not be called')
  harness.request(harness.contents('b'))
  assert.equal(harness.latest().length, 1)
  assert.equal(harness.latest()[0].tabId, 'b')
})

test('only cross-document main-frame navigation clears pending and granted permissions', function () {
  const harness = createHarness()
  const contents = harness.contents('a')
  const pendingReplies = []
  harness.request(contents)
  harness.grant(harness.latest()[0].permissionId)
  harness.request(contents, 'media', result => pendingReplies.push(result), { mediaTypes: ['audio'] })
  const pending = harness.latest().find(item => !item.granted)
  contents.emit('did-start-navigation', {}, 'https://example.test/#hash', true, true)
  contents.emit('did-start-navigation', {}, 'https://frame.test/', false, false)
  assert.equal(harness.latest().length, 2)
  contents.emit('did-start-navigation', {}, 'https://other.test/', false, true)
  assert.deepEqual(harness.latest(), [])
  assert.equal(harness.check(contents), false)
  harness.grant(pending.permissionId)
  assert.deepEqual(pendingReplies, [])
})

test('permission reuse and revocation preserve media types, tab ownership and IPC authorization', function () {
  const harness = createHarness()
  const first = harness.contents('a')
  const second = harness.contents('b')
  harness.request(first, 'media', () => {}, { mediaTypes: ['audio'] })
  const id = harness.latest()[0].permissionId
  harness.grant(id, {})
  assert.equal(harness.check(first, 'media', { mediaType: 'audio' }), false)
  harness.grant(id)
  assert.equal(harness.check(first, 'media', { mediaType: 'audio' }), true)
  assert.equal(harness.check(first, 'media', { mediaType: 'video' }), false)
  let allowed = 0
  for (let i = 0; i < 100; i++) {
    harness.request(second, 'media', result => { if (result) allowed++ }, { mediaTypes: ['audio'] })
  }
  assert.equal(allowed, 100)
  assert.equal(harness.latest().length, 2)
  assert.equal(second.listenerCount('did-start-navigation'), 1)
  harness.revoke(id, {})
  assert.equal(harness.latest().length, 2)
  harness.revoke(id)
  assert.equal(harness.latest().length, 1)
  assert.equal(harness.check(second, 'media', { mediaType: 'audio' }), true)
  second.emit('destroyed')
  assert.equal(harness.check(first, 'media', { mediaType: 'audio' }), false)
})

test('pointer lock still focuses before a one-shot grant callback', function () {
  const harness = createHarness()
  const contents = harness.contents('a')
  const actions = []
  contents.focus = () => actions.push('focus')
  harness.request(contents, 'pointerLock', result => actions.push(result))
  const id = harness.latest()[0].permissionId
  harness.grant(id)
  harness.grant(id)
  assert.deepEqual(actions, ['focus', true])
  assert.equal(harness.check(contents, 'pointerLock'), true)
  harness.revoke(id)
  assert.equal(harness.check(contents, 'pointerLock'), false)
})

test('a grant response that destroys or navigates contents cannot reinstall its permission record', function () {
  for (const event of ['destroyed', 'did-start-navigation']) {
    const harness = createHarness()
    const contents = harness.contents('a')
    harness.request(contents, 'notifications', () => contents.emit(event, {}, 'https://other.test/', false, true))
    harness.grant(harness.latest()[0].permissionId)
    assert.deepEqual(harness.latest(), [])
    assert.equal(harness.check(contents), false)
  }
})

test('automatically approved permissions also observe destruction during their response', function () {
  const harness = createHarness()
  const first = harness.contents('a')
  const second = harness.contents('b')
  harness.request(first)
  harness.grant(harness.latest()[0].permissionId)
  harness.request(second, 'notifications', () => second.emit('destroyed'))
  assert.equal(harness.latest().length, 1)
  assert.equal(harness.latest()[0].tabId, 'a')
})

test('immediate and unsupported decisions do not create permission records or listeners', function () {
  const harness = createHarness()
  const contents = harness.contents('a')
  const replies = []
  const respond = result => replies.push(result)
  harness.request(contents, 'fullscreen', respond)
  harness.request(contents, 'clipboard-sanitized-write', respond)
  harness.request(contents, 'geolocation', respond)
  harness.request(contents, 'media', respond, { isMainFrame: false })
  harness.request(contents, 'media', respond, { requestingUrl: '' })
  assert.deepEqual(replies, [true, true, false, false, false])
  assert.deepEqual(contents.eventNames(), [])
  assert.deepEqual(harness.messages, [])
  const handlers = {}
  harness.install({
    setPermissionRequestHandler: handler => { handlers.request = handler },
    setPermissionCheckHandler: handler => { handlers.check = handler }
  })
  assert.equal(handlers.request, harness.pagePermissionRequestHandler)
  assert.equal(handlers.check, harness.pagePermissionCheckHandler)
})
