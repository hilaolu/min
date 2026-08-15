const assert = require('node:assert/strict')
const test = require('node:test')

const { createBrowserChromeHost, installBrowserChromeHost } = require('../main/browserChromePreload.js')
const { createRuntimeArgument, readRuntimeArgument } = require('../main/browserChromeRuntime.js')
const { ASYNC_CHANNEL: FILE_ASYNC_CHANNEL, SYNC_CHANNEL: FILE_SYNC_CHANNEL, USER_SCRIPTS_CHANGED_CHANNEL } = require('../main/rendererHostFiles.js')
const { createInMemoryRendererHost, createRendererHost } = require('../js/rendererHost.js')

const runtimeConfiguration = {
  appName: 'Min',
  appVersion: '1.39.11',
  developmentMode: true,
  initialTask: 'task=one & two',
  initialWindow: false,
  launchWindow: true,
  platform: 'linux',
  windowId: 'window-2'
}

function assertRendererHostContract (host) {
  const first = host.getRuntimeConfiguration()
  const second = host.getRuntimeConfiguration()

  assert.deepEqual(first, runtimeConfiguration)
  assert.equal(first, second)
  assert.equal(Object.isFrozen(first), true)
  assert.equal(Object.isFrozen(host), true)
  assert.throws(() => Object.defineProperty(first, 'windowId', { value: 'changed' }), TypeError)
  assert.equal(first.windowId, runtimeConfiguration.windowId)
}

test('Browser Chrome runtime configuration round-trips as one typed argument', function () {
  const argument = createRuntimeArgument(runtimeConfiguration)
  const result = readRuntimeArgument(['electron', argument])

  assert.deepEqual(result, runtimeConfiguration)
  assert.equal(Object.isFrozen(result), true)
  assert.equal(Object.hasOwn(result, 'userDataPath'), false)
  assert.throws(
    () => readRuntimeArgument(['electron']),
    { code: 'INVALID_BROWSER_CHROME_RUNTIME_CONFIGURATION' }
  )
})

test('production and in-memory Renderer Host Adapters share one contract', function () {
  const argument = createRuntimeArgument(runtimeConfiguration)
  const preloadAdapter = createBrowserChromeHost(['electron', argument])

  assertRendererHostContract(createRendererHost(preloadAdapter))
  assertRendererHostContract(createInMemoryRendererHost(runtimeConfiguration))
})

test('Browser Chrome preload supports the current and future isolated worlds', function () {
  const argument = createRuntimeArgument(runtimeConfiguration)
  const target = {}
  const currentHost = installBrowserChromeHost({
    argv: ['electron', argument],
    contextBridge: null,
    contextIsolated: false,
    ipc: {},
    target
  })

  assert.equal(target.browserChromeHost, currentHost)
  assert.equal(Object.getOwnPropertyDescriptor(target, 'browserChromeHost').writable, false)

  const exposures = []
  const isolatedHost = installBrowserChromeHost({
    argv: ['electron', argument],
    contextBridge: {
      exposeInMainWorld: (name, value) => exposures.push({ name, value })
    },
    contextIsolated: true,
    ipc: {},
    target: null
  })
  assert.deepEqual(exposures, [{ name: 'browserChromeHost', value: isolatedHost }])
})

test('production and in-memory Renderer Host Adapters expose Browser Window behavior', async function () {
  const productionCalls = []
  const ipc = {
    invoke: function (channel, value) {
      productionCalls.push({ channel, type: 'invoke', value })
      return Promise.resolve(channel)
    },
    send: function (channel, value) {
      productionCalls.push({ channel, type: 'send', value })
    }
  }
  const argument = createRuntimeArgument(runtimeConfiguration)
  const production = createRendererHost(createBrowserChromeHost(['electron', argument], ipc))

  await production.closeWindow()
  production.createWindow({ initialTask: 'task-3', ignored: true })
  production.focusBrowserChrome()
  await production.maximizeWindow()
  await production.minimizeWindow()
  await production.setWindowFullScreen('yes')
  await production.unmaximizeWindow()

  assert.deepEqual(productionCalls, [
    { channel: 'close', type: 'invoke', value: undefined },
    { channel: 'newWindow', type: 'send', value: { initialTask: 'task-3' } },
    { channel: 'focusMainWebContents', type: 'send', value: undefined },
    { channel: 'maximize', type: 'invoke', value: undefined },
    { channel: 'minimize', type: 'invoke', value: undefined },
    { channel: 'setFullScreen', type: 'invoke', value: false },
    { channel: 'unmaximize', type: 'invoke', value: undefined }
  ])

  const memoryCalls = []
  const inMemory = createInMemoryRendererHost(runtimeConfiguration, {
    closeWindow: () => memoryCalls.push('close'),
    createWindow: options => memoryCalls.push(['create', options]),
    focusBrowserChrome: () => memoryCalls.push('focus'),
    maximizeWindow: () => memoryCalls.push('maximize'),
    minimizeWindow: () => memoryCalls.push('minimize'),
    setWindowFullScreen: value => memoryCalls.push(['fullscreen', value]),
    unmaximizeWindow: () => memoryCalls.push('unmaximize')
  })
  inMemory.closeWindow()
  inMemory.createWindow({ initialTask: 'task-3' })
  inMemory.focusBrowserChrome()
  inMemory.maximizeWindow()
  inMemory.minimizeWindow()
  inMemory.setWindowFullScreen(true)
  inMemory.unmaximizeWindow()
  assert.deepEqual(memoryCalls, [
    'close',
    ['create', { initialTask: 'task-3' }],
    'focus',
    'maximize',
    'minimize',
    ['fullscreen', true],
    'unmaximize'
  ])
})

test('Renderer Host subscriptions expose semantic events and defined teardown', function () {
  const listeners = new Map()
  const ipc = {
    on: function (channel, listener) {
      if (!listeners.has(channel)) listeners.set(channel, new Set())
      listeners.get(channel).add(listener)
    },
    removeListener: function (channel, listener) {
      const channelListeners = listeners.get(channel)
      if (channelListeners) channelListeners.delete(listener)
    }
  }
  function emit (channel, value) {
    const channelListeners = listeners.get(channel)
    if (channelListeners) channelListeners.forEach(listener => listener({}, value))
  }

  const argument = createRuntimeArgument(runtimeConfiguration)
  const host = createRendererHost(createBrowserChromeHost(['electron', argument], ipc))
  const states = []
  const commands = []
  const inputs = []
  let activationCount = 0

  const unsubscribeState = host.onWindowStateChanged(state => states.push(state))
  const unsubscribeCommands = host.onBrowserCommand(command => commands.push(command))
  const unsubscribeInput = host.onBrowserChromeInput(input => inputs.push(input))
  const unsubscribeActivation = host.onBrowserChromeActivated(() => { activationCount++ })

  emit('blur')
  emit('maximize')
  emit('enter-full-screen')
  emit('addTab', { url: 'https://example.com', ignored: true })
  emit('goBack')
  emit('before-input-event', {
    alt: 1,
    code: 'KeyK',
    control: true,
    key: 'k',
    meta: false,
    shift: true,
    type: 'keyUp',
    unexpected: true
  })
  emit('windowFocus')

  assert.deepEqual(states, [
    { focused: true, fullScreen: false, maximized: false },
    { focused: false, fullScreen: false, maximized: false },
    { focused: false, fullScreen: false, maximized: true },
    { focused: false, fullScreen: true, maximized: true }
  ])
  assert.equal(states.every(Object.isFrozen), true)
  assert.deepEqual(commands, [
    { type: 'add-tab', url: 'https://example.com' },
    { type: 'go-back' }
  ])
  assert.equal(commands.every(Object.isFrozen), true)
  assert.deepEqual(inputs, [{
    alt: false,
    code: 'KeyK',
    control: true,
    isAutoRepeat: false,
    key: 'k',
    meta: false,
    shift: true,
    type: 'keyUp'
  }])
  assert.equal(activationCount, 1)

  unsubscribeState()
  unsubscribeCommands()
  unsubscribeInput()
  unsubscribeActivation()
  emit('focus')
  emit('addTab')
  emit('before-input-event', { key: 'x' })
  emit('windowFocus')
  assert.equal(states.length, 4)
  assert.equal(commands.length, 2)
  assert.equal(inputs.length, 1)
  assert.equal(activationCount, 1)
})

test('Renderer Host names Browser Session, Settings, presentation, menu, and app behaviors', async function () {
  const calls = []
  const listeners = new Map()
  const ipc = {
    invoke: function (channel, value) {
      calls.push({ channel, type: 'invoke', value })
      return Promise.resolve({ ok: true })
    },
    on: (channel, listener) => listeners.set(channel, listener),
    removeListener: (channel, listener) => {
      if (listeners.get(channel) === listener) listeners.delete(channel)
    },
    send: function (channel, value) {
      calls.push({ channel, type: 'send', value })
    },
    sendSync: function (channel, value) {
      calls.push({ channel, type: 'sync', value })
      if (channel === 'settings:connect') return { revision: 2, values: {} }
      return { tasks: [] }
    }
  }
  const argument = createRuntimeArgument(runtimeConfiguration)
  const host = createRendererHost(createBrowserChromeHost(['electron', argument], ipc))

  let settingsChange
  assert.deepEqual(host.connectSettings(change => { settingsChange = change }), { revision: 2, values: {} })
  assert.deepEqual(host.requestBrowserSessionSnapshot(), { tasks: [] })
  host.publishBrowserSessionChanges([{ type: 'task-created' }])
  host.provideBrowserSessionSnapshot({ tasks: [] })
  host.showApplicationMenu({ x: 4.5, y: 9 })
  host.setHandoffURL('https://example.com')
  host.setHandoffURL(null)
  host.quitApplication()
  await host.setSetting('darkMode', true)
  await host.presentCommandPalette({ open: true })
  await host.showFocusModeWarning()

  assert.deepEqual(calls, [
    { channel: 'settings:connect', type: 'sync', value: undefined },
    { channel: 'request-tab-state', type: 'sync', value: undefined },
    { channel: 'tab-state-change', type: 'send', value: [{ type: 'task-created' }] },
    { channel: 'return-tab-state', type: 'send', value: { tasks: [] } },
    { channel: 'showSecondaryMenu', type: 'send', value: { x: 4.5, y: 9 } },
    { channel: 'handoffUpdate', type: 'send', value: { url: 'https://example.com' } },
    { channel: 'handoffUpdate', type: 'send', value: { url: '' } },
    { channel: 'quit', type: 'send', value: undefined },
    { channel: 'settings:set', type: 'invoke', value: { key: 'darkMode', value: true } },
    { channel: 'command-palette:present', type: 'invoke', value: { open: true } },
    { channel: 'showFocusModeDialog2', type: 'invoke', value: undefined }
  ])

  let browserSessionChanges
  let snapshotRequests = 0
  let focusRequests = 0
  host.onBrowserSessionChanges(data => { browserSessionChanges = data })
  host.onBrowserSessionSnapshotRequested(() => { snapshotRequests++ })
  host.onCommandPaletteFocusRequested(() => { focusRequests++ })
  listeners.get('settings:changed')({}, { key: 'darkMode', value: true })
  listeners.get('tab-state-change-receive')({}, { sourceWindowId: '1', changes: [] })
  listeners.get('read-tab-state')({})
  listeners.get('command-palette:focus-input')({})
  assert.deepEqual(settingsChange, { key: 'darkMode', value: true })
  assert.deepEqual(browserSessionChanges, { sourceWindowId: '1', changes: [] })
  assert.equal(snapshotRequests, 1)
  assert.equal(focusRequests, 1)
})

test('Browser Chrome preload exposes pathless file workflows and defined failures', async function () {
  const calls = []
  const listeners = new Map()
  const ipc = {
    invoke: function (channel, request) {
      calls.push({ channel, request, type: 'invoke' })
      return Promise.resolve({ ok: true, value: request.operation })
    },
    on: (channel, callback) => listeners.set(channel, callback),
    sendSync: function (channel, request) {
      calls.push({ channel, request, type: 'sync' })
      return { ok: true, value: request.operation }
    }
  }
  const argument = createRuntimeArgument(runtimeConfiguration)
  const host = createRendererHost(createBrowserChromeHost(['electron', argument], ipc))

  assert.equal(await host.backupBookmarks('bookmarks'), 'bookmarks.backup')
  assert.equal(host.backupCorruptBrowserSession('broken'), 'session.backup-corrupt')
  assert.equal(await host.chooseNewTabBackground(), 'new-tab-background.choose')
  assert.equal(await host.exportBookmarks('bookmarks'), 'bookmarks.export')
  assert.equal(await host.importBookmarks(), 'bookmarks.import')
  assert.equal(host.loadBrowserSession(), 'session.load')
  assert.equal(await host.loadNewTabBackground(), 'new-tab-background.load')
  assert.equal(await host.loadSystemHosts(), 'system-hosts.load')
  assert.equal(await host.loadUserScripts(), 'user-scripts.load')
  assert.equal(await host.openUserScriptsDirectory(), 'user-scripts.open-directory')
  assert.equal(await host.removeNewTabBackground(), 'new-tab-background.remove')
  assert.equal(host.saveBrowserSession('sync', { sync: true }), 'session.save')
  assert.equal(await host.saveBrowserSession('async'), 'session.save')
  assert.equal(await host.savePage('tab-1', 'Title'), 'page.save')
  assert.equal(await host.setUserScriptsWatching(true), 'user-scripts.set-watching')

  let changeCount = 0
  host.onUserScriptsChanged(() => { changeCount++ })
  listeners.get(USER_SCRIPTS_CHANGED_CHANNEL)()
  assert.equal(changeCount, 1)
  assert.equal(calls.every(call => call.channel === FILE_ASYNC_CHANNEL || call.channel === FILE_SYNC_CHANNEL), true)
  assert.equal(calls.some(call => JSON.stringify(call.request).includes('/tmp/')), false)

  ipc.invoke = () => Promise.resolve({
    ok: false,
    error: { code: 'RENDERER_HOST_FILE_WORKFLOW_FAILED', message: 'failed' }
  })
  await assert.rejects(host.importBookmarks(), {
    code: 'RENDERER_HOST_FILE_WORKFLOW_FAILED',
    message: 'failed'
  })
})

test('Renderer Host keeps download paths inside the production Adapter', async function () {
  const listeners = new Map()
  const calls = []
  const opened = []
  const ipc = {
    invoke: function (channel, value) {
      calls.push({ channel, type: 'invoke', value })
      return Promise.resolve(channel === 'tab-content-command'
        ? { ok: true, value: 'tab-result' }
        : true)
    },
    on: (channel, listener) => listeners.set(channel, listener),
    removeListener: () => {},
    send: function (channel, value) {
      calls.push({ channel, type: 'send', value })
    }
  }
  const utilities = {
    shell: { openPath: value => opened.push(value) }
  }
  const argument = createRuntimeArgument(runtimeConfiguration)
  const host = createRendererHost(createBrowserChromeHost(['electron', argument], ipc, utilities))
  const changes = []
  host.onDownloadChanged(change => changes.push(change))

  listeners.get('download-info')({}, {
    name: 'report.pdf',
    path: '/tmp/private/report.pdf',
    size: { received: 5, total: 10 },
    status: 'progressing'
  })
  listeners.get('download-info')({}, {
    name: 'report.pdf',
    path: '/tmp/private/report.pdf',
    size: { received: 10, total: 10 },
    status: 'completed'
  })

  assert.deepEqual(changes, [
    { id: 'download-1', name: 'report.pdf', size: { received: 5, total: 10 }, status: 'progressing' },
    { id: 'download-1', name: 'report.pdf', size: { received: 10, total: 10 }, status: 'completed' }
  ])
  assert.equal(JSON.stringify(changes).includes('/tmp/private'), false)
  host.cancelDownload('download-1')
  await host.revealDownload('download-1')
  await host.startDownloadDrag('download-1')
  host.openDownload('download-1')
  assert.deepEqual(opened, ['/tmp/private/report.pdf'])
  assert.deepEqual(calls, [
    { channel: 'cancelDownload', type: 'send', value: '/tmp/private/report.pdf' },
    { channel: 'showItemInFolder', type: 'invoke', value: '/tmp/private/report.pdf' },
    { channel: 'startFileDrag', type: 'invoke', value: '/tmp/private/report.pdf' }
  ])

  host.releaseDownload('download-1')
  assert.throws(() => host.openDownload('download-1'), { code: 'DOWNLOAD_UNAVAILABLE' })
  assert.equal(await host.invokeTabContent('tab-1', 'navigation.back'), 'tab-result')
})

test('Renderer Host normalizes permissions, clipboard, dropped files, prompt, and Places', async function () {
  const listeners = new Map()
  const calls = []
  const clipboardWrites = []
  const placesListeners = new Map()
  const placesMessages = []
  const port1 = {}
  const port2 = {
    addEventListener: (name, listener) => placesListeners.set(name, listener),
    close: () => {},
    postMessage: message => placesMessages.push(message),
    start: () => {}
  }
  const ipc = {
    invoke: () => Promise.resolve(true),
    on: (channel, listener) => listeners.set(channel, listener),
    postMessage: (channel, value, ports) => calls.push({ channel, ports, value }),
    removeListener: () => {},
    send: (channel, value) => calls.push({ channel, value }),
    sendSync: channel => channel === 'prompt' ? { name: 'renamed' } : {}
  }
  const utilities = {
    clipboard: {
      readText: () => 'clipboard text',
      write: value => clipboardWrites.push(value),
      writeText: value => clipboardWrites.push(value)
    },
    MessageChannel: function () { return { port1, port2 } },
    pathToFileURL: value => ({ href: `file://${value}` }),
    webUtils: { getPathForFile: () => '/tmp/example file.txt' }
  }
  const argument = createRuntimeArgument(runtimeConfiguration)
  const host = createRendererHost(createBrowserChromeHost(['electron', argument], ipc, utilities))

  let permissions
  host.onPermissionsChanged(value => { permissions = value })
  listeners.get('updatePermissions')({}, [{
    details: { mediaTypes: ['audio'], unexpected: '/secret' },
    granted: 1,
    origin: 'example.com',
    permission: 'media',
    permissionId: 4,
    tabId: 'tab-1',
    unexpected: true
  }])
  assert.deepEqual(permissions, [{
    details: { mediaTypes: ['audio'] },
    granted: false,
    origin: 'example.com',
    permission: 'media',
    permissionId: 4,
    tabId: 'tab-1'
  }])

  host.grantPermission(4)
  host.revokePermission(4)
  const menuResult = host.showContextMenu({ id: 7, template: [] })
  listeners.get('context-menu-item-selected')({}, { itemId: 3, menuId: 7 })
  assert.equal(await menuResult, 3)
  host.copyText(42)
  host.copyPageLink({ html: '<a>Example</a>', title: 'Example', url: 'https://example.com' })
  assert.equal(host.readClipboardText(), 'clipboard text')
  assert.equal(host.getDroppedFileURL({}), 'file:///tmp/example file.txt')
  assert.equal(host.promptForTagRename(), 'renamed')
  assert.deepEqual(clipboardWrites, [
    '42',
    { bookmark: 'Example', html: '<a>Example</a>', text: 'https://example.com' }
  ])

  const connection = host.connectPlaces()
  placesListeners.get('message')({ data: { ok: true, type: 'ready' } })
  await connection
  await host.sendPlacesMessage({ action: 'updatePlace' })
  const resultPromise = host.requestPlaces({ action: 'getAllPlaces' })
  await Promise.resolve()
  const request = placesMessages[1]
  placesListeners.get('message')({ data: { callbackId: request.callbackId, ok: true, result: ['place'], type: 'response' } })
  assert.deepEqual(await resultPromise, ['place'])
  assert.deepEqual(placesMessages, [
    { action: 'updatePlace' },
    { action: 'getAllPlaces', callbackId: 1 }
  ])
  assert.deepEqual(calls, [
    { channel: 'permissionGranted', value: 4 },
    { channel: 'revokePermission', value: 4 },
    { channel: 'open-context-menu', value: { id: 7, template: [] } },
    { channel: 'places-connect', ports: [port1], value: null }
  ])
})

test('Renderer Host bounds Places requests and rejects failures and teardown', async function () {
  const listeners = new Map()
  const timers = []
  let teardown
  const messages = []
  const port = {
    addEventListener: (name, listener) => listeners.set(name, listener),
    close: function () {},
    postMessage: message => messages.push(message),
    start: function () {}
  }
  const utilities = {
    addTeardownListener: listener => { teardown = listener },
    clearTimeout: timer => { timer.cleared = true },
    MessageChannel: function () { return { port1: {}, port2: port } },
    setTimeout: function (callback) {
      const timer = { callback, cleared: false }
      timers.push(timer)
      return timer
    }
  }
  const ipc = { postMessage: function () {} }
  const argument = createRuntimeArgument(runtimeConfiguration)
  const host = createRendererHost(createBrowserChromeHost(['electron', argument], ipc, utilities))
  const connection = host.connectPlaces()
  listeners.get('message')({ data: { ok: true, type: 'ready' } })
  await connection

  const failedRequest = host.requestPlaces({ action: 'getAllPlaces' })
  await Promise.resolve()
  const failedMessage = messages[0]
  listeners.get('message')({
    data: {
      callbackId: failedMessage.callbackId,
      error: { code: 'PLACES_PERSISTENCE_FAILED', message: 'database unavailable' },
      ok: false,
      type: 'response'
    }
  })
  await assert.rejects(failedRequest, { code: 'PLACES_PERSISTENCE_FAILED' })

  const timedOutRequest = host.requestPlaces({ action: 'searchPlaces' })
  await Promise.resolve()
  timers.find(timer => !timer.cleared).callback()
  await assert.rejects(timedOutRequest, { code: 'PLACES_REQUEST_TIMEOUT' })

  const pendingRequest = host.requestPlaces({ action: 'getPlace' })
  await Promise.resolve()
  teardown()
  await assert.rejects(pendingRequest, { code: 'PLACES_CONNECTION_CLOSED' })
})

test('Renderer Host rejects malformed Places response envelopes', async function () {
  const listeners = new Map()
  const messages = []
  const port = {
    addEventListener: (name, listener) => listeners.set(name, listener),
    close: function () {},
    postMessage: message => messages.push(message),
    start: function () {}
  }
  const argument = createRuntimeArgument(runtimeConfiguration)
  const host = createRendererHost(createBrowserChromeHost(['electron', argument], {
    postMessage: function () {}
  }, {
    MessageChannel: function () { return { port1: {}, port2: port } }
  }))

  const connection = host.connectPlaces()
  listeners.get('message')({ data: { ok: true, type: 'ready' } })
  await connection
  const request = host.requestPlaces({ action: 'getAllPlaces' })
  await Promise.resolve()
  listeners.get('message')({ data: { callbackId: messages[0].callbackId, result: [] } })

  await assert.rejects(request, { code: 'PLACES_CONNECTION_FAILED' })
})

test('Renderer Host rejects a Places connection that never becomes ready', async function () {
  let connectionTimer
  const port = {
    addEventListener: function () {},
    close: function () {},
    start: function () {}
  }
  const utilities = {
    clearTimeout: function () {},
    MessageChannel: function () { return { port1: {}, port2: port } },
    setTimeout: function (callback) {
      connectionTimer = callback
      return 1
    }
  }
  const argument = createRuntimeArgument(runtimeConfiguration)
  const host = createRendererHost(createBrowserChromeHost(['electron', argument], {
    postMessage: function () {}
  }, utilities))

  const connection = host.connectPlaces()
  connectionTimer()

  await assert.rejects(connection, { code: 'PLACES_CONNECTION_TIMEOUT' })
})

test('Renderer Host rejects malformed Places readiness and normalizes send failures', async function () {
  const listeners = new Map()
  let channelCount = 0
  let port
  const utilities = {
    MessageChannel: function () {
      channelCount++
      port = {
        addEventListener: (name, listener) => listeners.set(name, listener),
        close: function () {},
        postMessage: function () { throw new Error('port is gone') },
        start: function () {}
      }
      return { port1: {}, port2: port }
    }
  }
  const argument = createRuntimeArgument(runtimeConfiguration)
  const host = createRendererHost(createBrowserChromeHost(['electron', argument], {
    postMessage: function () {}
  }, utilities))

  const malformedConnection = host.connectPlaces()
  listeners.get('message')({ data: { type: 'ready' } })
  await assert.rejects(malformedConnection, { code: 'PLACES_CONNECTION_FAILED' })

  const send = host.sendPlacesMessage({ action: 'deleteHistory' })
  listeners.get('message')({ data: { ok: true, type: 'ready' } })
  await assert.rejects(send, { code: 'PLACES_CONNECTION_CLOSED' })

  const reconnected = host.connectPlaces()
  assert.equal(channelCount, 3)
  listeners.get('message')({ data: { ok: true, type: 'ready' } })
  await reconnected
})
