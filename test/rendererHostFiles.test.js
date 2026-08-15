const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const writeFileAtomic = require('write-file-atomic')

const { ASYNC_CHANNEL, createRendererHostFiles, SYNC_CHANNEL, USER_SCRIPTS_CHANGED_CHANNEL } = require('../main/rendererHostFiles.js')

function createRecordingFiles (t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'min-renderer-host-'))
  t.after(() => fs.rmSync(directory, { force: true, recursive: true }))
  const sender = {
    messages: [],
    isDestroyed: () => false,
    send: function (channel) {
      this.messages.push(channel)
    }
  }
  const window = {}
  const ipcHandlers = new Map()
  const ipcListeners = new Map()
  const openResults = []
  const saveResults = []
  const openedPaths = []
  const savedPages = []
  let watcherCallback
  let watcherCloseCount = 0
  const files = createRendererHostFiles({
    atomicWriter: writeFileAtomic,
    dialog: {
      showOpenDialog: async () => openResults.shift(),
      showSaveDialog: async () => saveResults.shift()
    },
    fs,
    getBrowserChromeContents: () => [sender],
    hostsFile: path.join(directory, 'hosts'),
    ipc: {
      handle: (channel, handler) => ipcHandlers.set(channel, handler),
      on: (channel, handler) => ipcListeners.set(channel, handler)
    },
    now: () => 1234,
    path,
    saveTabContentPage: async (contents, tabId, filePath) => savedPages.push({ contents, filePath, tabId }),
    schedule: callback => {
      callback()
      return 1
    },
    shell: {
      openPath: async value => openedPaths.push(value)
    },
    userDataPath: directory,
    watch: () => ({
      close: () => { watcherCloseCount++ },
      on: (event, callback) => { watcherCallback = callback }
    }),
    windows: {
      getChromeContents: owner => owner === window ? sender : null,
      windowFromContents: contents => contents === sender ? { win: window } : null
    }
  })

  return {
    directory,
    execute: (operation, payload) => files.execute(sender, { operation, payload }),
    executeSync: (operation, payload) => files.executeSync(sender, { operation, payload }),
    files,
    getWatcherCloseCount: () => watcherCloseCount,
    getWatcherCallback: () => watcherCallback,
    ipcHandlers,
    ipcListeners,
    openedPaths,
    openResults,
    saveResults,
    savedPages,
    sender
  }
}

test('Renderer Host owns new-tab background selection, storage, and removal', async function (t) {
  const recording = createRecordingFiles(t)
  const source = path.join(recording.directory, 'chosen.png')
  fs.writeFileSync(source, Buffer.from([1, 2, 3]))

  assert.deepEqual(await recording.execute('new-tab-background.load'), { ok: true, value: null })
  recording.openResults.push({ canceled: false, filePaths: [source] })
  assert.deepEqual(await recording.execute('new-tab-background.choose'), { ok: true, value: true })
  const loaded = await recording.execute('new-tab-background.load')
  assert.deepEqual(Array.from(loaded.value), [1, 2, 3])
  assert.deepEqual(await recording.execute('new-tab-background.remove'), { ok: true, value: true })
  assert.deepEqual(await recording.execute('new-tab-background.load'), { ok: true, value: null })
})

test('Renderer Host owns bookmark dialogs, transfer, and automatic backup paths', async function (t) {
  const recording = createRecordingFiles(t)
  const importPath = path.join(recording.directory, 'import.html')
  const exportPath = path.join(recording.directory, 'export.html')
  fs.writeFileSync(importPath, '<a>Imported</a>')

  recording.openResults.push({ canceled: false, filePaths: [importPath] })
  assert.deepEqual(await recording.execute('bookmarks.import'), { ok: true, value: '<a>Imported</a>' })
  recording.saveResults.push({ canceled: false, filePath: exportPath })
  assert.deepEqual(await recording.execute('bookmarks.export', { data: '<a>Exported</a>' }), { ok: true, value: true })
  assert.equal(fs.readFileSync(exportPath, 'utf8'), '<a>Exported</a>')
  assert.deepEqual(await recording.execute('bookmarks.backup', { data: '<a>Backup</a>' }), { ok: true, value: true })
  assert.equal(fs.readFileSync(path.join(recording.directory, 'bookmarksBackup.html'), 'utf8'), '<a>Backup</a>')

  recording.openResults.push({ canceled: true, filePaths: [] })
  recording.saveResults.push({ canceled: true })
  assert.deepEqual(await recording.execute('bookmarks.import'), { ok: true, value: null })
  assert.deepEqual(await recording.execute('bookmarks.export', { data: 'unused' }), { ok: true, value: false })
})

test('Renderer Host keeps page-save paths between the dialog and Tab Content implementation', async function (t) {
  const recording = createRecordingFiles(t)
  recording.saveResults.push({ canceled: false, filePath: path.join(recording.directory, 'page') })

  assert.deepEqual(await recording.execute('page.save', {
    suggestedName: 'title/with\\separators',
    tabId: 'tab-1'
  }), { ok: true, value: true })
  assert.deepEqual(recording.savedPages, [{
    contents: recording.sender,
    filePath: path.join(recording.directory, 'page.html'),
    tabId: 'tab-1'
  }])
})

test('Renderer Host preserves synchronous Browser Session durability and recovery naming', async function (t) {
  const recording = createRecordingFiles(t)

  assert.deepEqual(recording.executeSync('session.load'), { ok: true, value: null })
  assert.deepEqual(recording.executeSync('session.save', { data: 'sync state' }), { ok: true, value: true })
  assert.deepEqual(recording.executeSync('session.load'), { ok: true, value: 'sync state' })
  assert.deepEqual(await recording.execute('session.save', { data: 'async state' }), { ok: true, value: true })
  assert.equal(fs.readFileSync(path.join(recording.directory, 'sessionRestore.json'), 'utf8'), 'async state')
  assert.deepEqual(recording.executeSync('session.backup-corrupt', { data: 'broken state' }), {
    ok: true,
    value: 'sessionRestoreBackup-1234.json'
  })
  assert.equal(fs.readFileSync(path.join(recording.directory, 'sessionRestoreBackup-1234.json'), 'utf8'), 'broken state')
})

test('Renderer Host loads system hosts and owns userscript paths and change notifications', async function (t) {
  const recording = createRecordingFiles(t)
  fs.writeFileSync(path.join(recording.directory, 'hosts'), [
    '# comment',
    '127.0.0.1 localhost duplicate',
    '127.0.0.2 duplicate broadcasthost'
  ].join('\n'))
  assert.deepEqual(await recording.execute('system-hosts.load'), {
    ok: true,
    value: ['127.0.0.1', 'localhost', 'duplicate', '127.0.0.2']
  })

  const userscriptDirectory = path.join(recording.directory, 'userscripts')
  fs.mkdirSync(userscriptDirectory)
  fs.writeFileSync(path.join(userscriptDirectory, 'example.js'), 'example script')
  fs.writeFileSync(path.join(userscriptDirectory, 'ignored.txt'), 'ignored')
  assert.deepEqual(await recording.execute('user-scripts.load'), {
    ok: true,
    value: [{ content: 'example script', filename: 'example.js' }]
  })
  assert.equal(recording.getWatcherCallback(), undefined)
  assert.deepEqual(await recording.execute('user-scripts.set-watching', { enabled: true }), { ok: true, value: true })
  assert.equal(typeof recording.getWatcherCallback(), 'function')
  recording.getWatcherCallback()()
  assert.deepEqual(recording.sender.messages, [USER_SCRIPTS_CHANGED_CHANNEL])
  assert.deepEqual(await recording.execute('user-scripts.open-directory'), { ok: true, value: true })
  assert.deepEqual(recording.openedPaths, [userscriptDirectory])

  assert.deepEqual(await recording.execute('user-scripts.set-watching', { enabled: false }), { ok: true, value: true })
  assert.equal(recording.getWatcherCloseCount(), 1)

  recording.files.destroy()
  assert.equal(recording.getWatcherCloseCount(), 1)
})

test('Renderer Host file transport validates Browser Chrome ownership and operation names', async function (t) {
  const recording = createRecordingFiles(t)
  assert.equal(recording.ipcHandlers.has(ASYNC_CHANNEL), true)
  assert.equal(recording.ipcListeners.has(SYNC_CHANNEL), true)
  assert.deepEqual(await recording.execute('raw.read-file', { path: '/etc/passwd' }), {
    ok: false,
    error: {
      code: 'INVALID_RENDERER_HOST_FILE_REQUEST',
      message: 'Unsupported Renderer Host file operation: raw.read-file'
    }
  })

  const result = await recording.files.execute({}, { operation: 'system-hosts.load' })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'BROWSER_CHROME_NOT_OWNER')
})
