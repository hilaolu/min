const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'min-vault-browser-'))
const preload = path.join(temporary, 'preload.js')
const windows = []
const deadline = setTimeout(() => {
  console.error('Vault browser UI timeout')
  app.exit(1)
}, 45000)

const initial = {
  ok: true,
  url: 'vault://Parent%20Dir/Nested%23/',
  entries: [
    { kind: 'file', name: 'zeta #.md', relativePath: 'Parent Dir/Nested#/zeta #.md', url: 'vault://Parent%20Dir/Nested%23/zeta%20%23.md' },
    { kind: 'directory', name: 'Beta', relativePath: 'Parent Dir/Nested#/Beta', url: 'vault://Parent%20Dir/Nested%23/Beta/' },
    { kind: 'file', name: 'alpha %.txt', relativePath: 'Parent Dir/Nested#/alpha %.txt', url: 'vault://Parent%20Dir/Nested%23/alpha%20%25.txt' },
    { kind: 'directory', name: 'Alpha Space', relativePath: 'Parent Dir/Nested#/Alpha Space', url: 'vault://Parent%20Dir/Nested%23/Alpha%20Space/' }
  ]
}

fs.writeFileSync(preload, `
(() => {
  const state = {
    current: ${JSON.stringify(initial)},
    currentRejection: null,
    directories: Object.create(null),
    directoryCalls: [],
    deferred: Object.create(null),
    opens: [],
    listCalls: 0
  }
  state.directories['vault://Parent%20Dir/'] = {
    ok: true,
    entries: [
      { kind: 'directory', name: 'Other', relativePath: 'Parent Dir/Other', url: 'vault://Parent%20Dir/Other/' },
      { kind: 'directory', name: 'Nested#', relativePath: 'Parent Dir/Nested#', url: 'vault://Parent%20Dir/Nested%23/' }
    ]
  }
  state.directories['vault://Parent%20Dir/Nested%23/Alpha%20Space/'] = {
    ok: true,
    entries: [{ kind: 'file', name: 'inside.md', relativePath: 'inside.md', url: 'vault://Parent%20Dir/Nested%23/Alpha%20Space/inside.md' }]
  }
  window.__vaultTest = {
    clearDirectoryCalls: () => { state.directoryCalls.length = 0 },
    clearOpens: () => { state.opens.length = 0 },
    deferDirectory: url => { state.deferred[url] = [] },
    directoryCalls: () => state.directoryCalls.slice(),
    listCalls: () => state.listCalls,
    opens: () => state.opens.slice(),
    pending: url => state.deferred[url] ? state.deferred[url].length : 0,
    rejectCurrent: message => { state.currentRejection = message },
    resolveDirectory: (url, result) => {
      const waiters = state.deferred[url] || []
      delete state.deferred[url]
      waiters.forEach(resolve => resolve(result))
    },
    setCurrent: result => {
      state.current = result
      state.currentRejection = null
    },
    setDirectory: (url, result) => { state.directories[url] = result }
  }
  window.vaultPage = {
    listCurrent: async () => {
      state.listCalls++
      if (state.currentRejection !== null) throw new Error(state.currentRejection)
      return state.current
    },
    listDirectory: async url => {
      state.directoryCalls.push(url)
      if (state.deferred[url]) return new Promise(resolve => state.deferred[url].push(resolve))
      return state.directories[url] || { ok: true, entries: [] }
    },
    open: async url => {
      state.opens.push(url)
      return { ok: true }
    }
  }
})()
`)

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function until (fn, label) {
  for (let i = 0; i < 200; i++) {
    if (await fn()) return
    await sleep(25)
  }
  throw new Error('Timed out: ' + label)
}

async function run () {
  await app.whenReady()
  const win = new BrowserWindow({
    show: false,
    width: 1000,
    height: 700,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: false,
      preload
    }
  })
  windows.push(win)
  win.webContents.on('console-message', event => console.log('renderer:', event.message))
  const evaluate = script => win.webContents.executeJavaScript(script)
  const sendKey = async keyCode => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode })
    await sleep(25)
  }
  await win.loadFile(path.resolve(__dirname, '../pages/vault/index.html'))
  await until(() => evaluate("document.querySelectorAll('#files .entry').length === 4 && document.getElementById('position').textContent === '1 / 4' && document.getElementById('files').getAttribute('aria-busy') === 'false' && document.getElementById('preview').textContent !== 'Loading…'"), 'initial vault listing')

  const initialUI = await evaluate(`({
    busy: document.getElementById('files').getAttribute('aria-busy'),
    titles: Array.from(document.querySelectorAll('#files .entry'), element => element.title),
    kinds: Array.from(document.querySelectorAll('#files .entry'), element => element.classList.contains('directory') ? 'directory' : 'file'),
    selected: Array.from(document.querySelectorAll('#files .entry'), element => element.getAttribute('aria-selected')),
    breadcrumb: Array.from(document.querySelectorAll('#breadcrumb button'), element => element.textContent),
    current: document.querySelector('#breadcrumb [aria-current="page"]')?.textContent,
    parent: Array.from(document.querySelectorAll('#parent .entry'), element => [element.title, element.classList.contains('current')])
  })`)
  assert.equal(initialUI.busy, 'false')
  assert.deepEqual(initialUI.titles, ['Parent Dir/Nested#/Alpha Space', 'Parent Dir/Nested#/Beta', 'Parent Dir/Nested#/alpha %.txt', 'Parent Dir/Nested#/zeta #.md'])
  assert.deepEqual(initialUI.kinds, ['directory', 'directory', 'file', 'file'])
  assert.deepEqual(initialUI.selected, ['true', 'false', 'false', 'false'])
  assert.deepEqual(initialUI.breadcrumb, ['vault://', 'Parent Dir/', 'Nested#/'])
  assert.equal(initialUI.current, 'Nested#/')
  assert.deepEqual(initialUI.parent, [['Parent Dir/Nested#', true], ['Parent Dir/Other', false]])
  console.log('PASS directory-first alphabetical sorting and encoded breadcrumb rendering')

  const boundaryPreview = await evaluate(`(() => {
    window.__vaultTest.clearDirectoryCalls()
    document.getElementById('files').dispatchEvent(new KeyboardEvent('keydown', { key: 'k', bubbles: true, cancelable: true }))
    return {
      calls: window.__vaultTest.directoryCalls(),
      position: document.getElementById('position').textContent
    }
  })()`)
  assert.deepEqual(boundaryPreview, { calls: [], position: '1 / 4' })

  const keys = await evaluate(`(() => {
    const files = document.getElementById('files')
    const press = key => files.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
    const position = () => document.getElementById('position').textContent
    const positions = []
    press('k'); positions.push(position())
    for (let i = 0; i < 6; i++) press('j')
    positions.push(position())
    press('j'); positions.push(position())
    press('g'); press('g'); positions.push(position())
    press('G'); positions.push(position())
    return positions
  })()`)
  assert.deepEqual(keys, ['1 / 4', '4 / 4', '4 / 4', '1 / 4', '4 / 4'])

  await evaluate(`(() => {
    const files = document.getElementById('files')
    files.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }))
    window.__vaultTest.clearOpens()
    document.querySelector('#breadcrumb button').focus()
  })()`)
  assert.equal(await evaluate("document.activeElement.closest('#breadcrumb') !== null"), true)
  await sendKey('j')
  assert.deepEqual(await evaluate(`({
    focused: document.activeElement === document.getElementById('files'),
    position: document.getElementById('position').textContent
  })`), { focused: true, position: '2 / 4' })
  await sendKey('ENTER')
  await evaluate("document.getElementById('refresh').focus()")
  assert.equal(await evaluate("document.activeElement === document.getElementById('refresh')"), true)
  await sendKey('k')
  assert.deepEqual(await evaluate(`({
    focused: document.activeElement === document.getElementById('files'),
    position: document.getElementById('position').textContent
  })`), { focused: true, position: '1 / 4' })
  await sendKey('ENTER')
  assert.deepEqual(await evaluate('window.__vaultTest.opens()'), [
    'vault://Parent%20Dir/Nested%23/Beta/',
    'vault://Parent%20Dir/Nested%23/Alpha%20Space/'
  ])
  await evaluate("document.getElementById('files').dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }))")
  console.log('PASS boundary selection avoids duplicate preview and j/k take focus from header buttons')

  await evaluate(`(() => {
    const files = document.getElementById('files')
    const press = key => files.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
    window.__vaultTest.clearOpens()
    press('l')
    press('Home'); press('j'); press('j'); press('Enter')
  })()`)
  assert.deepEqual(await evaluate('window.__vaultTest.opens()'), [
    'vault://Parent%20Dir/Nested%23/zeta%20%23.md',
    'vault://Parent%20Dir/Nested%23/alpha%20%25.txt'
  ])

  const mouse = await evaluate(`(() => {
    const rows = document.querySelectorAll('#files .entry')
    window.__vaultTest.clearOpens()
    rows[2].click()
    const selected = Array.from(rows, element => element.getAttribute('aria-selected'))
    rows[3].dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
    return { selected, opens: window.__vaultTest.opens() }
  })()`)
  assert.deepEqual(mouse.selected, ['false', 'false', 'true', 'false'])
  assert.deepEqual(mouse.opens, ['vault://Parent%20Dir/Nested%23/zeta%20%23.md'])

  const paths = await evaluate(`(() => {
    window.__vaultTest.clearOpens()
    document.querySelectorAll('#breadcrumb button').forEach(button => button.click())
    const files = document.getElementById('files')
    files.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', bubbles: true, cancelable: true }))
    return window.__vaultTest.opens()
  })()`)
  assert.deepEqual(paths, [
    'vault://',
    'vault://Parent%20Dir/',
    'vault://Parent%20Dir/Nested%23/',
    'vault://Parent%20Dir/'
  ])
  console.log('PASS j/k and gg/G boundaries, h parent, l/Enter, click, and double-click URLs')

  const setCurrentAndRefresh = async (result, ready, label) => {
    const calls = await evaluate('window.__vaultTest.listCalls()')
    await evaluate(`window.__vaultTest.setCurrent(${JSON.stringify(result)}); document.getElementById('refresh').click()`)
    await until(async () => await evaluate('window.__vaultTest.listCalls()') > calls && await evaluate(ready), label)
  }

  await setCurrentAndRefresh({ ok: true, url: 'vault://', entries: [] }, "document.getElementById('status').textContent === 'Empty directory'", 'empty root')
  const empty = await evaluate(`({
    busy: document.getElementById('files').getAttribute('aria-busy'),
    files: document.querySelectorAll('#files .entry').length,
    preview: document.getElementById('preview').textContent,
    parent: document.getElementById('parent').textContent,
    position: document.getElementById('position').textContent,
    breadcrumb: Array.from(document.querySelectorAll('#breadcrumb button'), element => element.textContent)
  })`)
  assert.deepEqual(empty, { busy: 'false', files: 0, preview: 'No entry selected', parent: 'Vault root', position: '0 / 0', breadcrumb: ['vault://'] })
  await evaluate("window.__vaultTest.clearOpens(); document.getElementById('files').dispatchEvent(new KeyboardEvent('keydown', { key: 'h', bubbles: true, cancelable: true }))")
  assert.deepEqual(await evaluate('window.__vaultTest.opens()'), [], 'h is a no-op at the vault root')

  await setCurrentAndRefresh({ ok: false, error: 'Fixture directory denied' }, "document.getElementById('status').textContent === 'Fixture directory denied'", 'directory error')
  assert.deepEqual(await evaluate(`({
    busy: document.getElementById('files').getAttribute('aria-busy'),
    files: document.querySelectorAll('#files .entry').length,
    preview: document.getElementById('preview').textContent
  })`), { busy: 'false', files: 0, preview: 'Directory unavailable' })

  const rejectedCalls = await evaluate('window.__vaultTest.listCalls()')
  await evaluate("window.__vaultTest.rejectCurrent('Fixture listCurrent rejection'); document.getElementById('refresh').click()")
  await until(async () => await evaluate('window.__vaultTest.listCalls()') > rejectedCalls && await evaluate("document.getElementById('status').textContent === 'Could not read directory. Try refreshing.'"), 'rejected current listing')
  assert.deepEqual(await evaluate(`({
    busy: document.getElementById('files').getAttribute('aria-busy'),
    files: document.querySelectorAll('#files .entry').length,
    preview: document.getElementById('preview').textContent
  })`), { busy: 'false', files: 0, preview: 'Directory unavailable' })

  const emptyDirectoryURL = 'vault://Empty%20Folder/'
  await evaluate(`window.__vaultTest.setDirectory(${JSON.stringify(emptyDirectoryURL)}, { ok: true, entries: [] })`)
  await setCurrentAndRefresh({
    ok: true,
    url: 'vault://',
    entries: [{ kind: 'directory', name: 'Empty Folder', relativePath: 'Empty Folder', url: emptyDirectoryURL }]
  }, "document.getElementById('preview').textContent === 'Empty directory'", 'empty directory preview')
  console.log('PASS root no-op plus successful, error, and rejected listing states')

  const slowURL = 'vault://Race/Slow%20Folder/'
  await evaluate(`window.__vaultTest.deferDirectory(${JSON.stringify(slowURL)})`)
  await setCurrentAndRefresh({
    ok: true,
    url: 'vault://Race/',
    entries: [
      { kind: 'directory', name: 'Slow Folder', relativePath: 'Race/Slow Folder', url: slowURL },
      { kind: 'file', name: 'newer.md', relativePath: 'Race/newer.md', url: 'vault://Race/newer.md' }
    ]
  }, `window.__vaultTest.pending(${JSON.stringify(slowURL)}) === 1`, 'deferred directory preview')
  await evaluate("document.querySelectorAll('#files .entry')[1].click()")
  assert.equal(await evaluate("document.getElementById('preview').textContent"), 'newer.md — Enter to open')
  await evaluate(`window.__vaultTest.resolveDirectory(${JSON.stringify(slowURL)}, {
    ok: true,
    entries: [{ kind: 'file', name: 'stale.md', relativePath: 'stale.md', url: 'vault://Race/Slow%20Folder/stale.md' }]
  })`)
  await sleep(50)
  assert.equal(await evaluate("document.getElementById('preview').textContent"), 'newer.md — Enter to open')
  assert.equal(await evaluate("Array.from(document.querySelectorAll('#preview .entry'), element => element.textContent).includes('· stale.md')"), false)
  console.log('PASS stale directory preview cannot replace a newer selection')
}

async function finish () {
  let code = 0
  try {
    await run()
    console.log('PASS vault browser Electron UI regression')
  } catch (error) {
    console.error(error)
    code = 1
  }
  clearTimeout(deadline)
  for (const win of windows) if (!win.isDestroyed()) win.destroy()
  fs.rmSync(temporary, { recursive: true, force: true })
  app.exit(code)
}

app.disableHardwareAcceleration()
app.setPath('userData', path.join(temporary, 'profile'))
finish()
