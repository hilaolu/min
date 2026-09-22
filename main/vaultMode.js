const fs = require('fs')
const path = require('path')
const writeFileAtomic = require('write-file-atomic')
const createAccess = require('./vaultAccess.js')
const { canonicalRoot, resolveVaultURL } = require('./vault.js')
const { parseVaultURL } = require('../js/util/vaultURL.js')
const { createNote } = require('./vaultNotes.js')
const { defaultFolder, normalizeFolder } = require('./annotationPaths.js')

function createVaultMode ({ userDataPath, ipc, dialog, isTab, isChrome = () => false }) {
  // Deliberately not a generic setting: pages cannot mutate this through
  // settings:set, and the absolute root is never broadcast to other pages.
  const configPath = path.join(userDataPath, 'vault-root.json')
  const annotationConfigPath = path.join(userDataPath, 'annotation-folder.json')
  let annotationFolder = defaultFolder
  try {
    annotationFolder = normalizeFolder(JSON.parse(fs.readFileSync(annotationConfigPath, 'utf8')).folder)
  } catch (_) {}
  let root = null
  let savedDirectory = ''
  let changing = false
  let searchGeneration = 0
  let annotationGeneration = 0
  let fileIndex = null
  async function closeFileIndex () {
    const previous = fileIndex
    fileIndex = null
    if (previous) await previous.close()
  }
  const searches = new WeakMap()
  ipc.handle('vault:search-files', async (event, kind, query) => {
    const allowed = () => isChrome(event.sender) && event.senderFrame === event.sender.mainFrame
    if (!allowed()) return { ok: false, error: 'Caller denied' }
    if (!['m', 'p', 'a'].includes(kind) || typeof query !== 'string' || query.length > 256) {
      return { ok: false, error: 'Invalid vault search' }
    }
    const token = {}
    searches.set(event.sender, token)
    const generation = searchGeneration
    const capturedRoot = root
    const current = () => allowed() && !changing && root === capturedRoot &&
      generation === searchGeneration && searches.get(event.sender) === token
    try {
      if (!current()) throw new Error('Vault changing')
      if (fileIndex?.failed) await closeFileIndex()
      if (!current()) throw new Error('Vault changing')
      if (!fileIndex) fileIndex = require('./vaultFileIndex.js')(capturedRoot, annotationFolder)
      return kind === 'm'
        ? await fileIndex.search(query.trim(), current)
        : await fileIndex.searchAnnotations(kind, query.trim(), current)
    } catch (_) {
      return { ok: false, error: 'Vault unavailable or changed. Check vault Settings and retry.' }
    }
  })
  try {
    const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    if (typeof saved.root === 'string' && path.isAbsolute(saved.root)) {
      savedDirectory = saved.root
      const candidate = fs.realpathSync(saved.root)
      if (fs.statSync(candidate).isDirectory()) root = candidate
    }
  } catch (_) {}
  const access = createAccess({ getRoot: () => root })
  const records = new Map()
  const owners = new Map()
  const watched = new WeakSet()
  const navigationVersions = new WeakMap()
  const pdfPreparations = new WeakMap()
  let host = {}
  const pages = {
    markdown: 'min://app/pages/markdown/index.html',
    browser: 'min://app/pages/vault/index.html',
    pdf: 'min://app/pages/pdfViewer/index.html'
  }

  require('./pdfAnnotations.js').installPdfAnnotations({
    ipc,
    context: (event, operation) => {
      const preparingSave = operation === 'save' && pdfPreparations.has(event.sender)
      if ((changing && !preparingSave) || !isTab(event.sender) || event.sender.isDestroyed?.() ||
          event.senderFrame !== event.sender.mainFrame) throw new Error('Annotation caller denied')
      const url = new URL(event.senderFrame.url)
      if (url.protocol !== 'min:' || url.host !== 'app' || url.pathname !== '/pages/pdfViewer/index.html') throw new Error('Annotation caller denied')
      const source = url.searchParams.get('url')
      if (!source) throw new Error('Missing PDF source')
      if (new URL(source).protocol === 'vault:') current(event, ['pdf'])
      return { root, source, generation: annotationGeneration, annotationFolder }
    }
  })

  require('./pdfAnnotations.js').installPdfAnnotations({
    ipc,
    sourceType: 'webpage',
    context: event => {
      if (changing || !isTab(event.sender) || event.sender.isDestroyed?.() || event.senderFrame !== event.sender.mainFrame) throw new Error('Annotation caller denied')
      const url = new URL(event.senderFrame.url)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Annotation caller denied')
      return { root, source: url.href, generation: annotationGeneration, annotationFolder }
    }
  })

  function release (contents) {
    const record = records.get(contents.id)
    if (record?.identity && owners.get(record.identity) === contents) owners.delete(record.identity)
    records.delete(contents.id)
    access.revoke(contents)
  }

  function watch (contents) {
    if (watched.has(contents)) return
    watched.add(contents)
    contents.once('destroyed', () => release(contents))
    // did-start-navigation precedes will-navigate. The old document must keep
    // its reservation and save authority while leave preparation can cancel.
    // Approved loads/history establish destination authority in navigate().
    contents.on('did-navigate', (event, url) => {
      const record = records.get(contents.id)
      if (record && url.split('#')[0] !== (record.pageURL || record.url)) release(contents)
    })
  }

  function current (event, kinds) {
    const record = records.get(event.sender.id)
    if (!isTab(event.sender) || event.senderFrame !== event.sender.mainFrame ||
        !record || record.root !== root || event.senderFrame.url.split('#')[0] !== record.pageURL ||
        !kinds.includes(record.kind)) throw new Error('VAULT_CALLER_DENIED')
    return record
  }

  function handle (name, kinds, fn) {
    ipc.handle('vault:' + name, async (event, ...args) => {
      try { return await fn(current(event, kinds), event.sender, ...args) } catch (error) {
        if (error.message === 'VAULT_CALLER_DENIED') {
          return { ok: false, error: 'This vault page is no longer connected. Reopen vault:// in a tab, then try again.' }
        }
        if (error.status === 503) {
          return { ok: false, error: 'The vault folder is unavailable. Select an existing folder in Settings → Vault.' }
        }
        if (name === 'list') {
          return { ok: false, error: 'This directory is unavailable. Check that it still exists and is readable, or reopen vault://.' }
        }
        return { ok: false, error: error.message.startsWith('MARKDOWN_') ? error.message : 'Vault operation failed. Check the file and vault Settings.' }
      }
    })
  }
  handle('read', ['markdown'], async record => ({ ok: true, markdown: await record.note.read(), vaultURL: record.url }))
  handle('cancel-content-search', ['browser'], (record, contents) => {
    searches.delete(contents)
    return { ok: true }
  })
  handle('search-content', ['browser'], async (record, contents, query, options = {}) => {
    if (typeof query !== 'string' || query.length > 256 || query.includes('\0')) return { ok: false, error: 'Enter a search query of at most 256 characters, without NUL characters.' }
    if (!options || typeof options !== 'object' || (options.limit !== undefined && ![25, 50, 100, 500].includes(options.limit)) || (options.exact !== undefined && typeof options.exact !== 'boolean')) return { ok: false, error: 'Invalid search options.' }
    const token = {}
    searches.set(contents, token)
    const current = () => !changing && root === record.root && records.get(contents.id) === record && searches.get(contents) === token && !contents.isDestroyed()
    try {
      return await require('./vaultContentSearch.js')(record.root, record.url, query, current, options)
    } catch (_) {
      return { ok: false, error: 'Content search unavailable or canceled. Check vault Settings and retry.' }
    }
  })
  handle('save', ['markdown'], (record, contents, text) => record.note.save(text))
  handle('open', ['markdown', 'browser'], async (record, contents, url) => {
    if (typeof url !== 'string') throw new Error('Invalid URL')
    if (/^https?:\/\//.test(url)) return host.openNewTab(contents, url)
    parseVaultURL(url)
    if (record.kind === 'browser') {
      const file = await resolveVaultURL(url, record.root)
      // Resolving the entry is asynchronous; the explorer may have left meanwhile.
      if (changing || root !== record.root || records.get(contents.id) !== record || contents.isDestroyed()) {
        throw new Error('VAULT_CALLER_DENIED')
      }
      // Keep the directory browser available when opening a note.
      if (file.kind === 'markdown') return host.openNewTab(contents, url)
    }
    return host.open(contents, url)
  })
  handle('list', ['browser'], async (record, contents, query = '', directory = record.url) => {
    if (typeof query !== 'string') throw new Error('Invalid query')
    const entries = []
    async function scan (url, recursive) {
      const folder = await resolveVaultURL(url, record.root)
      for (const name of await fs.promises.readdir(folder.absolutePath)) {
        // Skip hidden directories before recursion so their contents stay hidden too.
        if (name.startsWith('.')) continue
        try {
          const file = await resolveVaultURL(folder.vaultURL + encodeURIComponent(name), record.root)
          if (!['directory', 'markdown', 'file'].includes(file.kind)) continue
          if (!query || file.relativePath.toLowerCase().includes(query.toLowerCase())) entries.push({ name, relativePath: file.relativePath, url: file.vaultURL, kind: file.kind })
          if (recursive && file.kind === 'directory') await scan(file.vaultURL, true)
        } catch (_) { /* Inaccessible files and symlinks are not listed. */ }
      }
    }
    await scan(query ? 'vault://' : directory, Boolean(query))
    return { ok: true, url: record.url, entries }
  })

  async function prepareToLeave (contents) {
    if (contents.getURL?.().split('?')[0] === pages.pdf) {
      if (!pdfPreparations.has(contents)) {
        const preparation = preparePDF(contents).finally(() => pdfPreparations.delete(contents))
        pdfPreparations.set(contents, preparation)
      }
      return pdfPreparations.get(contents)
    }
    const record = records.get(contents.id)
    if (record?.preparing) return record.preparing
    if (!record) return true
    record.preparing = prepare(contents)
    try { return await record.preparing } finally { record.preparing = null }
  }

  async function preparePDF (contents) {
    try {
      const state = await contents.executeJavaScript('window.pdfHighlightsPrepare && window.pdfHighlightsPrepare()')
      if (state?.dirty) {
        const choice = await dialog.showMessageBox({ type: 'question', message: 'Save PDF highlight changes to the vault?', buttons: ['Save', 'Discard', 'Cancel'], defaultId: 0, cancelId: 2 })
        if (choice.response === 2) { resume(contents); return false }
        if (choice.response === 0 && !await contents.executeJavaScript('window.pdfHighlightsSave()')) { resume(contents); return false }
      }
      await contents.executeJavaScript('window.pdfHighlightsLeaving = true')
      return true
    } catch (_) { resume(contents); return false }
  }

  async function prepare (contents) {
    const record = records.get(contents.id)
    if (record?.kind !== 'markdown') return true
    if (record.leaving) return true
    try {
      const state = await contents.executeJavaScript('window.vaultEditorPrepare && window.vaultEditorPrepare()')
      if (!state) return false
      if (!state.dirty) { record.leaving = true; return true }
      const result = await dialog.showMessageBox({ type: 'question', message: 'Save changes to this note?', buttons: ['Save', 'Discard', 'Cancel'], defaultId: 0, cancelId: 2 })
      if (result.response === 2) { resume(contents); return false }
      if (result.response === 0) {
        const saved = await contents.executeJavaScript('window.vaultEditorSave()')
        if (!saved) { resume(contents); return false }
        const latest = await contents.executeJavaScript('window.vaultEditorState()')
        if (latest.dirty) { resume(contents); return false }
      }
      record.leaving = true
      return true
    } catch (_) { resume(contents); return false }
  }

  function resume (contents) {
    if (contents.getURL?.().split('?')[0] === pages.pdf) {
      contents.executeJavaScript('window.pdfHighlightsLeaving = false; document.body.inert = false').catch(() => {})
      return
    }
    const record = records.get(contents.id)
    if (record?.kind !== 'markdown') return
    record.leaving = false
    contents.executeJavaScript('document.body.inert = false').catch(() => {})
  }

  function isSettings (event) {
    return isTab(event.sender) && event.senderFrame === event.sender.mainFrame &&
      event.senderFrame.url === 'min://app/pages/settings/index.html'
  }

  ipc.handle('vault:get-root', event => {
    if (!isSettings(event)) return { ok: false, error: 'Caller denied' }
    return { ok: true, directory: savedDirectory }
  })

  ipc.handle('vault:get-annotation-folder', event => {
    if (!isSettings(event)) return { ok: false, error: 'Caller denied' }
    return { ok: true, folder: annotationFolder }
  })

  ipc.handle('vault:set-annotation-folder', async (event, folder) => {
    if (!isSettings(event)) return { ok: false, error: 'Caller denied' }
    if (changing) return { ok: false, error: 'A vault settings change is already in progress.' }
    changing = true
    try {
      folder = normalizeFolder(folder)
      if (folder === annotationFolder) return { ok: true, folder }
      await require('./annotationStore.js').drain()
      if (!isSettings(event)) throw new Error('Settings closed')
      await writeFileAtomic(annotationConfigPath, JSON.stringify({ folder }))
      annotationFolder = folder
      annotationGeneration++
      searchGeneration++
      await closeFileIndex()
      return { ok: true, folder }
    } catch (error) {
      return { ok: false, error: error.message }
    } finally { changing = false }
  })

  ipc.handle('vault:select-root', async (event, directory) => {
    if (!isSettings(event)) return { ok: false, error: 'Caller denied' }
    if (changing) return { ok: false, error: 'A vault folder change is already in progress.' }
    changing = true
    searchGeneration++
    try {
      let selected
      try { selected = await canonicalRoot(directory) } catch (_) {
        return { ok: false, error: 'Enter an absolute path to an existing, accessible directory.' }
      }
      if (!isSettings(event)) return { ok: false, error: 'Vault selection canceled: Settings closed.' }
      // Reapplying the active folder must not close editors or rewrite config.
      if (selected === root) return { ok: true, directory: savedDirectory }
      await require('./annotationStore.js').drain()
      const contents = access.getAssociations().map(association => association.contents)
      for (const tab of contents) {
        if (!await prepareToLeave(tab)) {
          contents.forEach(resume)
          return { ok: false, canceled: true }
        }
      }
      for (const tab of contents) await host.close(tab)
      if (access.hasAssociations()) throw new Error('Vault tabs remain open')
      await writeFileAtomic(configPath, JSON.stringify({ root: selected }))
      root = selected
      await closeFileIndex()
      annotationGeneration++
      savedDirectory = selected
      return { ok: true, directory: selected }
    } catch (_) {
      access.getAssociations().forEach(association => resume(association.contents))
      return { ok: false, error: 'Unable to select or persist the vault folder.' }
    } finally {
      changing = false
    }
  })

  async function navigate (contents, url, { history = false } = {}) {
    if (changing) return null
    // History within this document neither unloads nor initializes the editor.
    // In particular, do not replace its note/baseline or freeze its live buffer.
    if (history && url.split('#')[0] === contents.getURL().split('#')[0]) return url
    const version = (navigationVersions.get(contents) || 0) + 1
    navigationVersions.set(contents, version)
    if (!(await prepareToLeave(contents))) return null
    if (navigationVersions.get(contents) !== version || contents.isDestroyed()) return null
    watch(contents)
    let source = url
    for (const page of Object.values(pages)) {
      if (url.startsWith(page + '?')) source = new URL(url).searchParams.get('url') || url
    }
    if (!source.startsWith('vault://')) { release(contents); return url }
    if (changing) return null
    try {
      const capturedRoot = root
      const file = await resolveVaultURL(source, capturedRoot)
      if (root !== capturedRoot || changing || contents.isDestroyed() || navigationVersions.get(contents) !== version) return null
      const kind = file.kind === 'directory' ? 'browser' : file.kind === 'markdown' ? 'markdown' : /\.pdf$/i.test(file.absolutePath) ? 'pdf' : 'resource'
      let identity
      if (kind === 'markdown') {
        identity = await fs.promises.realpath(file.absolutePath)
        if (root !== capturedRoot || changing || contents.isDestroyed() || navigationVersions.get(contents) !== version) return null
        const owner = owners.get(identity)
        if (owner && owner !== contents && !owner.isDestroyed()) { resume(contents); if (host.focus) host.focus(owner, contents); return null }
      }
      release(contents)
      if (identity) owners.set(identity, contents)
      const pageURL = pages[kind] ? pages[kind] + '?url=' + encodeURIComponent(file.vaultURL) : null
      const record = { url: file.vaultURL, pageURL, kind, root: capturedRoot, identity, managed: true }
      if (kind === 'markdown') record.note = createNote(capturedRoot, file.vaultURL)
      records.set(contents.id, record)
      access.associate(contents, record)
      return (pageURL || file.vaultURL) + new URL(source).hash
    } catch (_) {
      if (navigationVersions.get(contents) !== version) return null
      release(contents)
      return 'min://app/pages/vault/error.html'
    }
  }

  return {
    ...access,
    destroy: closeFileIndex,
    navigate,
    prepareToLeave,
    resume,
    configure: callbacks => { host = callbacks },
    watch,
    loadFailed (contents, url) {
      if (records.get(contents.id)?.pageURL === url.split('#')[0]) release(contents)
    }
  }
}

module.exports = createVaultMode
