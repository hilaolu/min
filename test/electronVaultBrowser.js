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
    fetchCalls: [],
    fetchRejection: null,
    fetchText: 'Mocked file contents',
    opens: [],
    listCalls: 0,
    searchCalls: [],
    cancellations: 0,
    pendingSearch: null
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
    clearFetchCalls: () => { state.fetchCalls.length = 0 },
    clearOpens: () => { state.opens.length = 0 },
    deferDirectory: url => { state.deferred[url] = [] },
    directoryCalls: () => state.directoryCalls.slice(),
    fetchCalls: () => state.fetchCalls.slice(),
    listCalls: () => state.listCalls,
    opens: () => state.opens.slice(),
    searchCalls: () => state.searchCalls.slice(),
    cancellations: () => state.cancellations,
    searchPending: () => Boolean(state.pendingSearch),
    resolveSearch: () => {
      state.pendingSearch({ ok: true, entries: [${JSON.stringify(initial.entries[0])}], total: 1 })
      state.pendingSearch = null
    },
    pending: url => state.deferred[url] ? state.deferred[url].length : 0,
    rejectCurrent: message => { state.currentRejection = message },
    rejectFetch: message => { state.fetchRejection = message },
    resolveDirectory: (url, result) => {
      const waiters = state.deferred[url] || []
      delete state.deferred[url]
      waiters.forEach(resolve => resolve(result))
    },
    setCurrent: result => {
      state.current = result
      state.currentRejection = null
    },
    setDirectory: (url, result) => { state.directories[url] = result },
    setFetchText: text => {
      state.fetchText = text
      state.fetchRejection = null
    }
  }
  window.fetch = async (url, options = {}) => {
    const headers = options.headers
    const range = headers && (typeof headers.get === 'function' ? headers.get('Range') : headers.Range || headers.range)
    state.fetchCalls.push({ url: String(url), range: range || null })
    if (state.fetchRejection !== null) throw new Error(state.fetchRejection)
    return {
      ok: state.fetchText !== '',
      status: state.fetchText === '' ? 416 : 206,
      headers: { get: name => name === 'Content-Range' && state.fetchText === '' ? 'bytes */0' : null },
      arrayBuffer: async () => new TextEncoder().encode(state.fetchText).buffer
    }
  }
  window.vaultPage = {
    cancelContentSearch: async () => { state.cancellations++; return { ok: true } },
    searchContents: async (query, options) => {
      state.searchCalls.push({ query, options })
      if (query === 'slow') return new Promise(resolve => { state.pendingSearch = resolve })
      if (query === 'missing') return { ok: true, entries: [], total: 0 }
      if (query === 'error') return { ok: false, error: 'Content search failed.' }
      return {
        ok: true,
        total: 2,
        entries: ${JSON.stringify([
          {
            ...initial.entries[0],
            passage: { text: 'Before <img src=x> NEEDLE after', ranges: [[19, 25]], line: 7, clippedStart: true, clippedEnd: false }
          },
          {
            ...initial.entries[2],
            passage: { text: 'Second ranked NEEDLE result', ranges: [[14, 20]], line: 11, clippedStart: false, clippedEnd: true }
          }
        ])}
      }
    },
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

  const selectionMutations = await evaluate(`(() => {
    const files = document.getElementById('files')
    const observer = new MutationObserver(() => {})
    observer.observe(files, { subtree: true, attributes: true, attributeFilter: ['class', 'aria-selected'] })
    const press = key => files.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
    press('j')
    const changedRows = [...new Set(observer.takeRecords().map(record => record.target.id))]
    press('Home')
    observer.takeRecords()
    press('k')
    const boundaryWrites = observer.takeRecords().length
    observer.disconnect()
    return { changedRows, boundaryWrites }
  })()`)
  assert.deepEqual(selectionMutations, { changedRows: ['entry-0', 'entry-1'], boundaryWrites: 0 })
  console.log('PASS selection only mutates old/new rows and boundary movement leaves rows untouched')

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
  await evaluate("window.__vaultTest.setFetchText('Newest file contents')")
  await evaluate("document.querySelectorAll('#files .entry')[1].click()")
  await until(() => evaluate("document.querySelector('#preview .preview-text')?.textContent === 'Newest file contents'"), 'newer text preview')
  assert.equal(await evaluate("document.getElementById('preview').textContent"), 'newer.md — Enter to openNewest file contents')
  await evaluate(`window.__vaultTest.resolveDirectory(${JSON.stringify(slowURL)}, {
    ok: true,
    entries: [{ kind: 'file', name: 'stale.md', relativePath: 'stale.md', url: 'vault://Race/Slow%20Folder/stale.md' }]
  })`)
  await sleep(50)
  assert.equal(await evaluate("document.getElementById('preview').textContent"), 'newer.md — Enter to openNewest file contents')
  assert.equal(await evaluate("Array.from(document.querySelectorAll('#preview .entry'), element => element.textContent).includes('· stale.md')"), false)
  console.log('PASS stale directory preview cannot replace a newer selection')

  const literalHTML = '<img src=x onerror="window.__previewInjected=true"><script>window.__previewInjected=true</script>'
  await evaluate(`window.__vaultTest.setFetchText(${JSON.stringify(literalHTML)}); window.__vaultTest.clearFetchCalls()`)
  await setCurrentAndRefresh({
    ok: true,
    url: 'vault://Previews/',
    entries: [{ kind: 'file', name: 'literal.html', relativePath: 'Previews/literal.html', url: 'vault://Previews/literal.html' }]
  }, 'document.querySelector("#preview .preview-text") !== null', 'literal HTML text preview')
  assert.deepEqual(await evaluate(`({
    header: document.querySelector('#preview .placeholder').textContent,
    text: document.querySelector('#preview .preview-text').textContent,
    unsafeChildren: document.querySelectorAll('#preview img, #preview script').length,
    injected: window.__previewInjected === true
  })`), { header: 'literal.html — Enter to open', text: literalHTML, unsafeChildren: 0, injected: false })

  await evaluate("window.__vaultTest.setFetchText('')")
  await setCurrentAndRefresh({
    ok: true,
    url: 'vault://Previews/',
    entries: [{ kind: 'file', name: 'empty.txt', relativePath: 'Previews/empty.txt', url: 'vault://Previews/empty.txt' }]
  }, "document.querySelector('#preview .preview-text')?.textContent === '(Empty file)'", 'empty text preview')
  assert.equal(await evaluate("document.getElementById('preview').textContent"), 'empty.txt — Enter to open(Empty file)')

  await evaluate("window.__vaultTest.setFetchText('x'.repeat(64 * 1024) + 'tail'); window.__vaultTest.clearFetchCalls()")
  await setCurrentAndRefresh({
    ok: true,
    url: 'vault://Previews/',
    entries: [{ kind: 'file', name: 'large.log', relativePath: 'Previews/large.log', url: 'vault://Previews/large.log' }]
  }, "document.querySelector('#preview .placeholder:last-child')?.textContent === 'Preview truncated at 64 KiB — Enter to open full file'", 'truncated text preview')
  assert.deepEqual(await evaluate(`({
    textLength: document.querySelector('#preview .preview-text').textContent.length,
    allX: /^x+$/.test(document.querySelector('#preview .preview-text').textContent),
    calls: window.__vaultTest.fetchCalls()
  })`), {
    textLength: 64 * 1024,
    allX: true,
    calls: [{ url: 'vault://Previews/large.log', range: 'bytes=0-65536' }]
  })

  await evaluate("window.__vaultTest.setFetchText('x'.repeat(65535) + '雪tail'); document.getElementById('preview').scrollTop = 100")
  await setCurrentAndRefresh({
    ok: true,
    url: 'vault://Previews/',
    entries: [{ kind: 'file', name: 'unicode.txt', url: 'vault://Previews/unicode.txt' }]
  }, "document.querySelector('#preview .preview-text')?.textContent.length === 65535", 'UTF-8 truncation boundary')
  assert.equal(await evaluate("document.querySelector('#preview .preview-text').textContent"), 'x'.repeat(65535))
  assert.equal(await evaluate("document.getElementById('preview').scrollTop"), 0)

  await evaluate("window.__vaultTest.setFetchText('text\\u0000binary')")
  await setCurrentAndRefresh({
    ok: true,
    url: 'vault://Previews/',
    entries: [{ kind: 'file', name: 'binary.md', relativePath: 'Previews/binary.md', url: 'vault://Previews/binary.md' }]
  }, "document.getElementById('preview').textContent === 'Binary file — Enter to open'", 'binary text fallback')

  await evaluate("window.__vaultTest.rejectFetch('Fixture fetch rejection')")
  await setCurrentAndRefresh({
    ok: true,
    url: 'vault://Previews/',
    entries: [{ kind: 'file', name: 'failed.txt', relativePath: 'Previews/failed.txt', url: 'vault://Previews/failed.txt' }]
  }, "document.getElementById('preview').textContent === 'Could not preview file — Enter to open'", 'rejected fetch fallback')

  await evaluate("window.__vaultTest.setFetchText('unused'); window.__vaultTest.clearFetchCalls()")
  await setCurrentAndRefresh({
    ok: true,
    url: 'vault://Previews/',
    entries: [{ kind: 'file', name: 'archive.zip', relativePath: 'Previews/archive.zip', url: 'vault://Previews/archive.zip' }]
  }, "document.getElementById('preview').textContent === 'archive.zip — Enter to open'", 'unsupported file fallback')
  assert.deepEqual(await evaluate('window.__vaultTest.fetchCalls()'), [])
  console.log('PASS safe, empty, truncated, binary, rejected, and unsupported text preview states')

  const imageURL = '../../icons/icon256.png'
  await setCurrentAndRefresh({
    ok: true,
    url: 'vault://Previews/',
    entries: [{ kind: 'file', name: 'icon.png', relativePath: 'Previews/icon.png', url: imageURL }]
  }, 'document.querySelector("#preview img.preview-image") !== null', 'image preview')
  assert.deepEqual(await evaluate(`({
    src: document.querySelector('#preview img').getAttribute('src'),
    alt: document.querySelector('#preview img').alt
  })`), { src: imageURL, alt: 'icon.png' })
  await evaluate("window.__previousPreviewImage = document.querySelector('#preview img')")
  await setCurrentAndRefresh({ ok: true, url: 'vault://', entries: [] }, "document.getElementById('preview').textContent === 'No entry selected'", 'image preview cleanup')
  assert.equal(await evaluate("window.__previousPreviewImage.hasAttribute('src')"), false)
  console.log('PASS image preview uses the entry URL and filename')

  await setCurrentAndRefresh(initial, "document.querySelectorAll('#files .entry').length === 4", 'restore listing before content search')
  await sendKey('End')
  assert.equal(await evaluate("document.querySelector('#files .selected').title"), initial.entries[0].relativePath)
  await evaluate(`
    window.__vaultTest.clearOpens()
    document.getElementById('files').dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true }))
  `)
  assert.equal(await evaluate('document.activeElement.id'), 'fuzzy-query')
  assert.equal(await evaluate("document.getElementById('fuzzy-dialog').matches(':modal')"), true)
  assert.deepEqual(await evaluate(`({
    backdrop: getComputedStyle(document.getElementById('fuzzy-dialog'), '::backdrop').backgroundColor,
    radius: getComputedStyle(document.getElementById('fuzzy-dialog')).borderRadius,
    shadow: getComputedStyle(document.getElementById('fuzzy-dialog')).boxShadow
  })`), { backdrop: 'rgba(0, 0, 0, 0)', radius: '0px', shadow: 'none' })
  await sendKey('Escape')
  assert.equal(await evaluate("document.getElementById('fuzzy-dialog').open"), false)
  assert.equal(await evaluate("document.querySelectorAll('#files .entry').length"), 4)
  await evaluate("document.getElementById('search-open').focus(); document.getElementById('search-open').click()")
  assert.equal(await evaluate('document.activeElement.id'), 'fuzzy-query')
  await evaluate("document.getElementById('fuzzy-query').value = '   '; document.getElementById('fuzzy-form').requestSubmit()")
  assert.equal(await evaluate("document.getElementById('fuzzy-dialog').open"), true)
  assert.equal(await evaluate('window.__vaultTest.searchCalls().length'), 0)
  await evaluate("document.getElementById('fuzzy-close').focus()")
  await sendKey('j')
  assert.equal(await evaluate('document.activeElement.id'), 'fuzzy-close', 'dialog keys do not navigate files')
  await evaluate("document.getElementById('fuzzy-close').click()")
  assert.equal(await evaluate('document.activeElement.id'), 'search-open', 'cancel restores focus')
  await evaluate("document.getElementById('search-open').click()")
  await evaluate("document.getElementById('fuzzy-query').value = 'needle'; document.getElementById('fuzzy-exact').checked = true; document.getElementById('fuzzy-limit').value = '25'; document.getElementById('fuzzy-form').requestSubmit()")
  await until(() => evaluate("document.querySelector('#preview mark')?.textContent === 'NEEDLE' && document.getElementById('status').textContent === 'Showing 2 of 2 matching files'"), 'content result preview')
  assert.deepEqual(await evaluate('window.__vaultTest.searchCalls().pop()'), { query: 'needle', options: { exact: true, limit: 25 } })
  assert.equal(await evaluate("document.getElementById('fuzzy-dialog').open"), false)
  assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('#files .entry'), row => row.title)"), [
    initial.entries[0].relativePath,
    initial.entries[2].relativePath
  ], 'content search preserves service rank order')
  assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('#files .result-snippet'), snippet => snippet.textContent)"), [
    'Line 7: Before <img src=x> NEEDLE after',
    'Line 11: Second ranked NEEDLE result'
  ])
  assert.deepEqual(await evaluate(`({
    selected: Array.from(document.querySelectorAll('#files .entry'), row => row.getAttribute('aria-selected')),
    preview: document.querySelector('#preview .preview-text').textContent,
    marks: Array.from(document.querySelectorAll('#preview mark'), mark => mark.textContent),
    unsafe: document.querySelectorAll('#files img, #preview img, #files script, #preview script').length,
    injected: window.__previewInjected === true
  })`), {
    selected: ['true', 'false'],
    preview: '…Before <img src=x> NEEDLE after',
    marks: ['NEEDLE'],
    unsafe: 0,
    injected: false
  })
  await sendKey('Down')
  assert.deepEqual(await evaluate(`({
    position: document.getElementById('position').textContent,
    selected: Array.from(document.querySelectorAll('#files .entry'), row => row.getAttribute('aria-selected')),
    preview: document.querySelector('#preview .preview-text').textContent,
    line: document.querySelector('#preview .placeholder:last-of-type').textContent
  })`), {
    position: '2 / 2',
    selected: ['false', 'true'],
    preview: 'Second ranked NEEDLE result…',
    line: 'Content match · line 11 (search snapshot)'
  })
  await sendKey('Enter')
  assert.equal((await evaluate('window.__vaultTest.opens()')).pop(), initial.entries[2].url)
  // The preview uses the submitted result snapshot, not the edited input value.
  await evaluate("document.getElementById('fuzzy-query').value = 'changed but not submitted'")
  await sendKey('Home')
  assert.equal(await evaluate("document.querySelector('#preview mark')?.textContent"), 'NEEDLE')
  await evaluate("document.getElementById('fuzzy-query').value = 'missing'; document.getElementById('fuzzy-form').requestSubmit()")
  await until(() => evaluate("document.getElementById('status').textContent === 'No matches'"), 'no content matches')
  assert.equal(await evaluate("document.getElementById('preview').textContent"), 'No entry selected')
  await evaluate("document.getElementById('fuzzy-query').value = 'error'; document.getElementById('fuzzy-form').requestSubmit()")
  await until(() => evaluate("document.getElementById('status').textContent === 'Content search failed.'"), 'content search error')
  await sendKey('Escape')
  await until(() => evaluate("!document.getElementById('fuzzy-dialog').open && document.querySelectorAll('#files .entry').length === 4 && document.getElementById('files').getAttribute('aria-busy') === 'false'"), 'close content search and restore listing')
  assert.equal(await evaluate("document.querySelector('#files .result-snippet')"), null)
  assert.equal(await evaluate("document.querySelector('#files .selected').title"), initial.entries[0].relativePath, 'leaving refined/empty/error searches restores the browsing selection')
  const cancellations = await evaluate('window.__vaultTest.cancellations()')
  await evaluate(`
    document.getElementById('files').dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true }))
    document.getElementById('fuzzy-query').value = 'slow'
    document.getElementById('fuzzy-form').requestSubmit()
  `)
  await until(() => evaluate('window.__vaultTest.searchPending()'), 'pending content search')
  await sendKey('Escape')
  await until(() => evaluate("document.querySelectorAll('#files .entry').length === 4"), 'cancel restores browse')
  assert.equal(await evaluate('window.__vaultTest.cancellations()'), cancellations + 1)
  await evaluate('window.__vaultTest.resolveSearch()')
  await sleep(50)
  assert.equal(await evaluate("document.querySelectorAll('#files .entry').length"), 4, 'late search cannot replace restored listing')
  console.log('PASS content prompt, rank order, safe snippets and highlights, navigation, empty/error states, and Escape restore')
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
