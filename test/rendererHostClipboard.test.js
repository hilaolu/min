const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')
const { CHANNEL, installRendererHostClipboard } = require('../main/rendererHostClipboard.js')

function harness (overrides = {}) {
  const calls = []
  const sender = { isDestroyed: () => false, mainFrame: { url: 'min://app/index.html' } }
  const event = { sender, senderFrame: sender.mainFrame }
  let handler
  installRendererHostClipboard({
    clipboard: {
      write: function (data) { calls.push(['write', data]) },
      writeText: function (text) { calls.push(['writeText', text]) },
      readText: function () { calls.push(['readText']); return 'clipboard text' },
      ...overrides
    },
    ipc: { handle: function (channel, callback) { assert.equal(channel, CHANNEL); handler = callback } },
    isChrome: contents => contents === sender
  })
  return { calls, event, request: (operation, value, source = event) => handler(source, operation, value) }
}

test('page links write text, HTML and native bookmarks in one Electron 43 clipboard transaction', async function () {
  const { calls, request } = harness()
  const link = { url: 'https://example.com/?q=one&other=two#section', title: 'Example', html: '<a>Example</a>' }
  await request('copy-page-link', link)
  assert.deepEqual(calls, [['write', {
    text: link.url,
    html: link.html,
    bookmark: link.title
  }]])
})

test('clipboard bridge normalizes optional link metadata and text values', async function () {
  const { calls, request } = harness()
  await request('copy-page-link', { url: 'https://example.com', title: null, html: 42 })
  await request('copy-text', 42)
  assert.equal(await request('read-text'), 'clipboard text')
  assert.deepEqual(calls, [
    ['write', {
      text: 'https://example.com',
      html: '',
      bookmark: ''
    }],
    ['writeText', '42'],
    ['readText']
  ])
})

test('invalid page links leave the existing clipboard untouched', async function () {
  const { calls, request } = harness()
  for (const value of [undefined, null, {}, [], 'https://example.com', { url: '' }, { url: 42 }, { url: null }]) {
    await assert.rejects(request('copy-page-link', value), /requires a non-empty URL/)
  }
  assert.deepEqual(calls, [])
})

test('clipboard bridge waits for pending native writes', async function () {
  let completeWrite
  const pendingWrite = new Promise(resolve => { completeWrite = resolve })
  const { request } = harness({ write: () => pendingWrite })
  let completed = false
  const copying = request('copy-page-link', { url: 'https://example.com' }).then(() => { completed = true })
  await Promise.resolve()
  assert.equal(completed, false)
  completeWrite()
  await copying
  assert.equal(completed, true)
})

test('clipboard bridge rejects synchronous native errors and asynchronous failures', async function () {
  for (const [operation, method] of [['copy-page-link', 'write'], ['copy-text', 'writeText'], ['read-text', 'readText']]) {
    const failure = new Error('Clipboard unavailable')
    for (const implementation of [() => { throw failure }, () => Promise.reject(failure)]) {
      const failed = harness({ [method]: implementation })
      await assert.rejects(failed.request(operation, { url: 'https://example.com' }), error => error === failure)
    }
  }
})

test('clipboard bridge denies foreign contents, subframes, destroyed chrome and external navigation', async function () {
  const { calls, event, request } = harness()
  const other = { isDestroyed: () => false, mainFrame: { url: 'min://app/index.html' } }
  const denied = [
    {},
    { sender: other, senderFrame: other.mainFrame },
    { sender: event.sender, senderFrame: null },
    { sender: event.sender, senderFrame: { url: 'min://app/index.html' } }
  ]
  for (const source of denied) {
    for (const operation of ['copy-page-link', 'copy-text', 'read-text']) {
      await assert.rejects(request(operation, {}, source), /only available to Browser Chrome/)
    }
  }
  event.sender.mainFrame.url = 'https://example.com/'
  await assert.rejects(request('read-text'), /only available to Browser Chrome/)
  event.sender.mainFrame.url = 'min://app/index.html'
  event.sender.isDestroyed = () => true
  await assert.rejects(request('read-text'), /only available to Browser Chrome/)
  assert.deepEqual(calls, [])
})

test('clipboard bridge rejects unknown operations without touching the clipboard', async function () {
  const { calls, request } = harness()
  await assert.rejects(request('clear'), /Unsupported clipboard operation/)
  assert.deepEqual(calls, [])
})

test('Paste and Go waits for asynchronous clipboard text before navigating', async function () {
  let contextMenuListener
  let menu
  let resolveText
  const text = new Promise(resolve => { resolveText = resolve })
  const opened = []
  const dependencies = {
    'remoteMenuRenderer.js': { open: value => { menu = value } },
    'rendererHost.js': { readClipboardText: () => text },
    'searchbar/searchbar.js': { openURL: url => opened.push(url) }
  }
  const context = {
    document: { addEventListener: (name, listener) => { contextMenuListener = listener } },
    module: { exports: {} },
    require: name => dependencies[name]
  }
  const filename = path.join(__dirname, '../js/contextMenu.js')
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename })
  context.module.exports.initialize()
  contextMenuListener({
    target: { nodeName: 'INPUT', id: 'tab-editor-input' },
    preventDefault: function () {},
    stopPropagation: function () {}
  })
  const navigating = menu[1].find(item => item.label === 'Paste and Go').click()
  assert.deepEqual(opened, [])
  resolveText('https://example.com/')
  await navigating
  assert.deepEqual(opened, ['https://example.com/'])
})
