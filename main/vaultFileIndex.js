const path = require('path')
const chokidar = require('chokidar')
const { resolveVaultURL } = require('./vault.js')
const { isHiddenPath } = require('./vaultSearchPaths.js')
const { isInFolder, nativeMatch, normalizeFolder, defaultFolder } = require('./annotationPaths.js')

// One watcher shared by path and annotation metadata indexes. No contents or
// absolute paths leave main through picker results.
function createVaultFileIndex (root, annotationFolder = defaultFolder) {
  annotationFolder = normalizeFolder(annotationFolder)
  const entries = new Map()
  let watcher
  let failure
  let closed = false
  let finish
  let version = 0
  let pathVersion = 0
  let sortedVersion = -1
  let sortedPaths = []
  let previousSearch
  let annotationSnapshot
  let annotationVersion = -1
  const ready = new Promise(resolve => { finish = resolve })
  const initialized = (async () => {
    try {
      await resolveVaultURL('vault://', root)
      if (closed) return
      watcher = chokidar.watch(root, {
        persistent: false,
        followSymlinks: false,
        ignoreInitial: false,
        ignored: (file, stat) => {
          const relative = path.relative(root, file).split(path.sep).join('/')
          if (isHiddenPath(relative)) return true
          return stat && stat.isFile() && !/\.(md|pdf)$/i.test(file) && !nativeMatch(relative, annotationFolder)
        }
      })
      const update = (file, stat) => {
        if (closed || !stat?.isFile()) return
        const relative = path.relative(root, file)
        if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return
        const relativePath = relative.split(path.sep).join('/')
        if (!entries.has(relativePath)) pathVersion++
        entries.set(relativePath, {
          relativePath,
          url: 'vault://' + relativePath.split('/').map(encodeURIComponent).join('/'),
          searchPath: relativePath.toLowerCase()
        })
        version++
      }
      watcher.on('add', update)
      watcher.on('change', update)
      watcher.on('unlink', file => {
        if (entries.delete(path.relative(root, file).split(path.sep).join('/'))) pathVersion++
        version++
      })
      watcher.on('unlinkDir', file => {
        const relative = path.relative(root, file).split(path.sep).join('/')
        for (const key of entries.keys()) {
          if (!relative || key.startsWith(relative + '/')) {
            entries.delete(key)
            pathVersion++
          }
        }
        version++
      })
      watcher.on('error', error => {
        failure = error
        entries.clear()
        finish()
      })
      watcher.once('ready', finish)
    } catch (error) {
      failure = error
      finish()
    }
  })()

  function check (isCurrent = () => true) {
    if (closed || !isCurrent()) throw new Error('Vault changed')
    if (failure) throw failure
  }

  async function wait (isCurrent) {
    check(isCurrent)
    await ready
    check(isCurrent)
    await resolveVaultURL('vault://', root)
    check(isCurrent)
  }

  return {
    get failed () { return Boolean(failure) },
    async searchAnnotations (kind, query, isCurrent = () => true) {
      const { discover, rank, checkSource } = require('./annotatedResourceSearch.js')
      await wait(isCurrent)
      // Coalesce concurrent queries and change bursts. Rebuild metadata on the
      // next query after an event, never on every keystroke or by walking again.
      for (let attempt = 0; attempt < 3; attempt++) {
        const captured = version
        if (!annotationSnapshot || annotationVersion !== captured) {
          annotationVersion = captured
          const files = Array.from(entries.values()).filter(entry => /\.(md|json)$/i.test(entry.relativePath))
          annotationSnapshot = discover(root, () => !closed && !failure, files, annotationFolder).then(result => ({
            ...result,
            // The picker needs metadata, not retained highlight text/geometry.
            resources: result.resources.map(({ annotations, ...resource }) => ({ ...resource, annotationCount: annotations.length }))
          }))
        }
        let snapshot
        try { snapshot = await annotationSnapshot } catch (error) {
          if (annotationVersion === captured) annotationSnapshot = null
          throw error
        }
        check(isCurrent)
        if (version !== captured) continue
        const result = rank(snapshot, query, kind)
        for (const entry of result.entries) await checkSource(entry.source, root)
        check(isCurrent)
        if (version !== captured) continue
        return result
      }
      throw new Error('Vault is changing; retry search')
    },
    async search (query, isCurrent = () => true) {
      await wait(isCurrent)
      const needle = query.toLowerCase()
      // Content edits invalidate annotation metadata, not filename membership.
      if (sortedVersion !== pathVersion) {
        sortedPaths = Array.from(entries.values())
          .filter(entry => !isHiddenPath(entry.relativePath) && !isInFolder(entry.relativePath, annotationFolder) && /\.md$/i.test(entry.relativePath))
          .sort((a, b) => a.relativePath.localeCompare(b.relativePath))
        sortedVersion = pathVersion
        previousSearch = null
      }
      // Retain ALL matches, not the displayed 20: an extension may match only
      // files beyond the first page. Backspace/replacement searches start fresh.
      const source = previousSearch && needle.startsWith(previousSearch.needle)
        ? previousSearch.matches
        : sortedPaths
      const matches = previousSearch && needle === previousSearch.needle
        ? previousSearch.matches
        : source.filter(entry => entry.searchPath.includes(needle))
      previousSearch = { needle, matches }
      const results = []
      for (const entry of matches) {
        check(isCurrent)
        try {
          // Revalidate candidates: watcher events are asynchronous, not authority.
          const file = await resolveVaultURL(entry.url, root)
          if (!file.stat.isFile()) continue
          results.push({ relativePath: entry.relativePath, url: entry.url })
        } catch (_) { continue }
        if (results.length === 21) break
      }
      check(isCurrent)
      return { ok: true, entries: results.slice(0, 20), truncated: results.length > 20 }
    },
    async close () {
      closed = true
      entries.clear()
      sortedPaths = []
      previousSearch = null
      annotationSnapshot = null
      finish()
      await initialized
      if (watcher) await watcher.close()
    }
  }
}

module.exports = createVaultFileIndex
