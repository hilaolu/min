const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const EventEmitter = require('node:events')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { createBrowserChromeHost } = require('../main/browserChromePreload.js')
const { createRuntimeArgument } = require('../main/browserChromeRuntime.js')
const createVaultFileIndex = require('../main/vaultFileIndex.js')
const createVaultMode = require('../main/vaultMode.js')
const VaultFileStrategy = require('../js/commandPalette/strategies/VaultFileStrategy.js')
const StrategyManager = require('../js/commandPalette/StrategyManager.js')

function profile (t, prefix = 'min-stage2-') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

function write (file, contents = '') {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, contents)
}

async function searchVaultFiles (root, kind, query, isCurrent) {
  const index = createVaultFileIndex(root)
  try {
    return kind === 'm'
      ? await index.search(query, isCurrent)
      : await index.searchAnnotations(kind, query, isCurrent)
  } finally {
    await index.close()
  }
}

test('vault search finds nested markdown but excludes unannotated PDF files', async t => {
  const root = profile(t, 'min-vault-search-')
  write(path.join(root, 'nested', 'Encoded name.md'))
  write(path.join(root, 'nested', 'Quarterly REPORT.PDF'))
  write(path.join(root, 'nested', 'other.txt'))
  write(path.join(root, 'top.MD'))
  fs.symlinkSync(path.join(root, 'nested', 'Encoded name.md'), path.join(root, 'linked.md'))

  const markdown = await searchVaultFiles(root, 'm', 'ENCODED NAME')
  assert.equal(markdown.ok, true)
  assert.deepEqual(markdown.entries.map(entry => entry.relativePath), ['nested/Encoded name.md'])
  assert.match(markdown.entries[0].url, /nested\/Encoded%20name\.md$/)

  const pdf = await searchVaultFiles(root, 'p', 'report')
  assert.deepEqual(pdf.entries, [])

  const symlink = await searchVaultFiles(root, 'm', 'linked')
  assert.deepEqual(symlink.entries, [])
})

test('indexed Markdown search excludes hidden paths relative to a hidden vault root', async t => {
  const root = profile(t, '.min-vault-search-')
  write(path.join(root, 'visible.note.md'))
  write(path.join(root, '.hidden.md'))
  write(path.join(root, '.hidden-folder', 'descendant.md'))
  write(path.join(root, 'visible', '.hidden-folder', 'descendant.md'))

  const result = await searchVaultFiles(root, 'm', '')
  assert.deepEqual(result.entries.map(entry => entry.relativePath), ['visible.note.md'])
})

test('vault search reports a missing root and honors its result limit', async t => {
  const root = profile(t, 'min-vault-search-')
  await assert.rejects(searchVaultFiles(path.join(root, 'missing'), 'm', ''), /Vault resource unavailable/)
  for (let index = 0; index < 21; index++) {
    write(path.join(root, 'limited', `limit-target-${String(index).padStart(2, '0')}.md`))
  }

  const result = await searchVaultFiles(root, 'm', 'LIMIT-TARGET')
  assert.equal(result.entries.length, 20)
  assert.equal(result.truncated, true)
  assert.equal(result.entries.every(entry => /^limited\/limit-target-\d\d\.md$/.test(entry.relativePath)), true)
  assert.equal(new Set(result.entries.map(entry => entry.relativePath)).size, 20)
})

test('vault search cancels when its generation is no longer current', async t => {
  const root = profile(t, 'min-vault-search-')
  write(path.join(root, 'cancel.md'))
  let checks = 0
  await assert.rejects(
    searchVaultFiles(root, 'm', '', () => ++checks < 2),
    /Vault changed/
  )
})

function searchMode (userDataPath, root) {
  const handlers = new Map()
  const frame = { url: 'min://app/pages/settings/index.html' }
  const chrome = Object.assign(new EventEmitter(), { id: 1, mainFrame: frame })
  fs.writeFileSync(path.join(userDataPath, 'vault-root.json'), JSON.stringify({ root }))
  const mode = createVaultMode({
    userDataPath,
    ipc: { handle: (name, handler) => handlers.set(name, handler) },
    dialog: {},
    isTab: contents => contents === chrome,
    isChrome: contents => contents === chrome
  })
  return { handlers, chrome, frame, mode }
}

test('vault search IPC validates frames and parameters before allowing chrome', async t => {
  const userDataPath = profile(t, 'min-vault-ipc-')
  const root = path.join(userDataPath, 'vault')
  write(path.join(root, 'Nested', 'Read me.md'))
  const instance = searchMode(userDataPath, fs.realpathSync(root))
  t.after(() => instance.mode.destroy())
  const search = instance.handlers.get('vault:search-files')
  const mainEvent = { sender: instance.chrome, senderFrame: instance.frame }

  assert.deepEqual(await search({ sender: {}, senderFrame: instance.frame }, 'm', ''), { ok: false, error: 'Caller denied' })
  assert.deepEqual(await search({ sender: instance.chrome, senderFrame: {} }, 'm', ''), { ok: false, error: 'Caller denied' })
  assert.deepEqual(await search(mainEvent, 'x', ''), { ok: false, error: 'Invalid vault search' })
  assert.deepEqual(await search(mainEvent, 'm', 42), { ok: false, error: 'Invalid vault search' })
  assert.deepEqual(await search(mainEvent, 'm', 'x'.repeat(257)), { ok: false, error: 'Invalid vault search' })

  const allowed = await search(mainEvent, 'm', 'READ ME')
  assert.equal(allowed.ok, true)
  assert.deepEqual(allowed.entries.map(entry => entry.relativePath), ['Nested/Read me.md'])
})

test('palette uses the default renderer export through preload IPC with the saved root on first search', async t => {
  const userDataPath = profile(t, 'min-vault-bridge-')
  const root = path.join(userDataPath, 'vault')
  write(path.join(root, 'Nested', 'Read me.md'))
  write(path.join(root, 'Report.pdf'))
  const { handlers, chrome, frame, mode } = searchMode(userDataPath, fs.realpathSync(root))
  t.after(() => mode.destroy())
  const calls = []
  const ipc = {
    invoke: (channel, ...args) => {
      calls.push([channel, ...args])
      return handlers.get(channel)({ sender: chrome, senderFrame: frame }, ...args)
    }
  }
  const runtime = createRuntimeArgument({
    appName: 'Min',
    appVersion: '1.39.11',
    platform: 'linux',
    windowId: 'test',
    developmentMode: false,
    initialTask: '',
    initialWindow: true,
    launchWindow: true
  })
  // Load the same module facade the production palette receives, not a
  // createRendererHost() instance (which previously hid a missing export).
  const filename = require.resolve('../js/rendererHost.js')
  const context = {
    module: { exports: {} },
    require: createRequire(filename),
    window: { browserChromeHost: createBrowserChromeHost(['electron', runtime], ipc) }
  }
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename })
  const host = context.module.exports
  const opened = []
  const strategy = new VaultFileStrategy((kind, query) => host.searchVaultFiles(kind, query), url => opened.push(url))
  for (const [command, query, expected] of [['m', 'READ ME', 'Nested/Read me.md']]) {
    const results = await strategy.updateUI(`>${command} ${query}`, { command, query })
    assert.deepEqual(results.map(result => result.title), [expected])
    results[0].action()
  }
  const pdfResults = await strategy.updateUI('>p report', { command: 'p', query: 'report' })
  assert.equal(pdfResults[0].title, 'No annotated PDFs found')
  assert.equal(pdfResults[0].action, undefined)
  assert.deepEqual(calls, [['vault:search-files', 'm', 'READ ME'], ['vault:search-files', 'p', 'report']])
  assert.deepEqual(opened, ['vault://Nested/Read%20me.md'])
})

test('VaultFileStrategy loads silently and exposes empty, error, and open results', async () => {
  const opened = []
  const entry = { url: 'vault://notes/Report.md', relativePath: 'notes/Report.md' }
  const strategy = new VaultFileStrategy(
    async () => ({ ok: true, entries: [entry], truncated: false }),
    url => opened.push(url)
  )

  assert.equal(strategy.retainCandidatesWhileSearching, true)
  assert.deepEqual(strategy.loadingCandidates(), [])
  const results = await strategy.updateUI('>m report', { command: 'm', query: 'report' })
  const report = results.find(candidate => candidate.title === entry.relativePath)
  assert.ok(report)
  report.action()
  assert.deepEqual(opened, [entry.url])

  const empty = new VaultFileStrategy(async () => ({ ok: true, entries: [], truncated: false }), () => {})
  assert.deepEqual(await empty.updateUI('>m', { command: 'm', query: '' }), [
    { id: 'vault-empty', title: 'No matching vault files', icon: 'carbon:search' }
  ])

  const failed = new VaultFileStrategy(async () => { throw new Error('offline') }, () => {})
  assert.deepEqual(await failed.updateUI('>m report', { command: 'm', query: 'report' }), [
    { id: 'vault-error', title: 'Vault search failed. Check vault Settings and retry.', icon: 'carbon:warning' }
  ])
})

test('changing the vault invalidates an in-flight search and subsequent searches use the new root', async t => {
  const profileDir = profile(t)
  const first = path.join(profileDir, 'first')
  const second = path.join(profileDir, 'second')
  write(path.join(first, 'old.md'))
  write(path.join(second, 'new.md'))
  const instance = searchMode(profileDir, first)
  t.after(() => instance.mode.destroy())
  const event = { sender: instance.chrome, senderFrame: instance.frame }
  const search = instance.handlers.get('vault:search-files')
  const pending = search(event, 'm', '')
  assert.equal((await instance.handlers.get('vault:select-root')(event, second)).ok, true)
  assert.equal((await pending).ok, false)
  assert.deepEqual((await search(event, 'm', '')).entries.map(entry => entry.relativePath), ['new.md'])
  assert.equal((await search(event, 'a', '')).ok, true)
  assert.equal((await search(event, 'p', '')).ok, true)
})

test('web annotation picker uses its own command, opens the source, and has no URL fallback', async () => {
  const opened = []
  const strategy = new VaultFileStrategy(async () => ({ ok: true, entries: [{ title: 'Article', source: 'https://example.com/a?b=1', url: 'https://example.com/a?b=1', annotationCount: 1 }] }), url => opened.push(url))
  assert.equal(strategy.matches('>A reading').data.command, 'a')
  assert.equal(strategy.matches('>article').matches, false)
  const rows = await strategy.updateUI('>a reading', { command: 'a', query: 'reading' })
  rows[0].action()
  assert.deepEqual(opened, ['https://example.com/a?b=1'])
  const empty = new VaultFileStrategy(async () => ({ ok: true, entries: [], total: 0 }), () => {})
  assert.equal((await empty.updateUI('>a https://unknown.test', { command: 'a', query: 'https://unknown.test' })).some(row => row.action), false)
})

function deferred () {
  let resolvePromise
  let rejectPromise
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return { promise, resolve: resolvePromise, reject: rejectPromise }
}

function strategyContext (value) {
  return { input: { value } }
}

function result (id) {
  return { ok: true, entries: [{ url: `vault://${id}.md`, relativePath: `${id}.md` }], truncated: false }
}

test('all vault picker modes retain rows while reporting pending searches', async () => {
  for (const command of ['m', 'p', 'a']) {
    const pending = []
    const strategy = new VaultFileStrategy(() => {
      const request = deferred()
      pending.push(request)
      return request.promise
    }, () => {})
    const manager = new StrategyManager()
    manager.registerStrategy(strategy)
    const updates = []
    const events = []
    manager.on('candidates-pending', () => events.push({ type: 'pending' }))
    manager.on('candidates-updated', event => {
      events.push({ type: 'updated', event })
      updates.push(event.candidates)
    })
    manager.on('state-changed', event => updates.push(event.candidates))

    const initialInput = `>${command} initial`
    const initial = manager.processInput(initialInput, strategyContext(initialInput))
    assert.deepEqual(updates, [[]], command + ' enters silently')
    if (command === 'm') await new Promise(resolve => setTimeout(resolve, 150))
    pending.shift().resolve(result('initial'))
    await initial
    assert.equal(updates[updates.length - 1][0].title, 'initial.md')

    const nextInput = `>${command} next`
    events.length = 0
    const next = manager.processInput(nextInput, strategyContext(nextInput))
    assert.deepEqual(events, [{ type: 'pending' }])
    assert.equal(updates[updates.length - 1][0].title, 'initial.md', command + ' retains rows')
    if (command === 'm') await new Promise(resolve => setTimeout(resolve, 150))
    pending.shift().resolve(result('next'))
    await next
    assert.equal(updates[updates.length - 1][0].title, 'next.md')
    assert.equal(events[events.length - 1].type, 'updated')
    assert.equal(events[events.length - 1].event.preserveSelection, true)
    assert.equal(updates.flat().some(candidate => candidate.id === 'vault-loading'), false)
  }
})

test('StrategyManager finishes retained pending searches with empty and error updates', async () => {
  let result = [{ id: 'initial', title: 'initial' }]
  const strategy = new VaultFileStrategy(async () => ({ ok: true, entries: [] }), () => {})
  strategy.updateUI = async function () {
    if (result instanceof Error) throw result
    return result
  }
  const manager = new StrategyManager()
  manager.registerStrategy(strategy)
  await manager.processInput('>p initial', strategyContext('>p initial'))

  const events = []
  manager.on('candidates-pending', () => events.push({ type: 'pending' }))
  manager.on('candidates-updated', event => events.push({ type: 'updated', event }))

  result = []
  await manager.processInput('>p empty', strategyContext('>p empty'))
  assert.deepEqual(events, [
    { type: 'pending' },
    { type: 'updated', event: { candidates: [], preserveSelection: true } }
  ])

  events.length = 0
  result = new Error('expected search failure')
  const originalConsoleError = console.error
  const errors = []
  console.error = (...args) => errors.push(args)
  try {
    await manager.processInput('>p error', strategyContext('>p error'))
  } finally {
    console.error = originalConsoleError
  }
  assert.deepEqual(events, [
    { type: 'pending' },
    { type: 'updated', event: { candidates: [] } }
  ])
  assert.equal(errors.length, 1)
  assert.equal(errors[0][1], result)
})

test('StrategyManager drops stale replies from the current strategy', async () => {
  const pending = []
  const strategy = new VaultFileStrategy((command, query) => {
    const request = deferred()
    pending.push({ query, request })
    return request.promise
  }, () => {})
  const manager = new StrategyManager()
  manager.registerStrategy(strategy)
  const updates = []
  manager.on('candidates-updated', event => updates.push(event.candidates))

  const initial = manager.processInput('>m initial', strategyContext('>m initial'))
  await new Promise(resolve => setTimeout(resolve, 150))
  pending.shift().request.resolve(result('initial'))
  await initial

  const old = manager.processInput('>m old', strategyContext('>m old'))
  await new Promise(resolve => setTimeout(resolve, 150))
  const newer = manager.processInput('>m new', strategyContext('>m new'))
  await new Promise(resolve => setTimeout(resolve, 150))
  const oldRequest = pending.find(request => request.query === 'old').request
  const newRequest = pending.find(request => request.query === 'new').request
  newRequest.resolve(result('new'))
  await newer
  oldRequest.resolve(result('old'))
  await old

  assert.equal(updates.some(candidates => candidates.some(candidate => candidate.id === 'vault://old.md')), false)
  assert.equal(updates.some(candidates => candidates.some(candidate => candidate.id === 'vault://new.md')), true)
})

test('StrategyManager drops a stale reply after changing strategy', async () => {
  const firstPending = deferred()
  const secondPending = deferred()
  const first = new VaultFileStrategy(async () => firstPending.promise, () => {})
  const second = new VaultFileStrategy(async () => secondPending.promise, () => {})
  first.stateName = 'FIRST'
  second.stateName = 'SECOND'
  first.matches = input => ({ matches: input.startsWith('>m'), data: { command: 'm', query: input.slice(3) } })
  second.matches = input => ({ matches: input.startsWith('>p'), data: { command: 'p', query: input.slice(3) } })

  const manager = new StrategyManager()
  manager.registerStrategy(first)
  manager.registerStrategy(second)
  const states = []
  manager.on('state-changed', event => states.push(event.candidates))

  const old = manager.processInput('>m old', strategyContext('>m old'))
  const newer = manager.processInput('>p new', strategyContext('>p new'))
  secondPending.resolve(result('new'))
  await newer
  firstPending.resolve(result('old'))
  await old

  assert.equal(states.some(candidates => candidates.some(candidate => candidate.id === 'vault://old.md')), false)
  assert.equal(states.some(candidates => candidates.some(candidate => candidate.id === 'vault://new.md')), true)
})
