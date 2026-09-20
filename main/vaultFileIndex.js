const path = require('path')
const chokidar = require('chokidar')
const { resolveVaultURL } = require('./vault.js')

// One watcher shared by path and annotation metadata indexes. No contents or
// absolute paths leave main through picker results.
function createVaultFileIndex (root) {
  const entries = new Map()
  let watcher
  let failure
  let closed = false
  let finish
  let version = 0
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
        ignored: (file, stat) => stat && stat.isFile() && !/\.(md|pdf)$/i.test(file) &&
          !/^\.min-annotations\/[a-f0-9]{64}\.json$/.test(path.relative(root, file).split(path.sep).join('/'))
      })
      const update = (file, stat) => {
        if (closed || !stat?.isFile()) return
        const relative = path.relative(root, file)
        if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return
        const relativePath = relative.split(path.sep).join('/')
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
        entries.delete(path.relative(root, file).split(path.sep).join('/'))
        version++
      })
      watcher.on('unlinkDir', file => {
        const relative = path.relative(root, file).split(path.sep).join('/')
        for (const key of entries.keys()) {
          if (!relative || key.startsWith(relative + '/')) entries.delete(key)
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
      const { discover, rank, checkSource } = require('./annotatedPdfSearch.js')
      await wait(isCurrent)
      // Coalesce concurrent queries and change bursts. Rebuild metadata on the
      // next query after an event, never on every keystroke or by walking again.
      for (let attempt = 0; attempt < 3; attempt++) {
        const captured = version
        if (!annotationSnapshot || annotationVersion !== captured) {
          annotationVersion = captured
          const files = Array.from(entries.values()).filter(entry => /\.(md|json)$/i.test(entry.relativePath))
          annotationSnapshot = discover(root, () => !closed && !failure, files).then(result => ({
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
      const matches = Array.from(entries.values()).filter(entry => /\.md$/i.test(entry.relativePath) && entry.searchPath.includes(needle))
        .sort((a, b) => a.relativePath.localeCompare(b.relativePath))
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
      annotationSnapshot = null
      finish()
      await initialized
      if (watcher) await watcher.close()
    }
  }
}

module.exports = createVaultFileIndex
