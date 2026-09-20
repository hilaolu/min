const path = require('path')
const chokidar = require('chokidar')
const { resolveVaultURL } = require('./vault.js')

// Path metadata only: no Markdown contents or absolute paths leave main.
function createVaultFileIndex (root) {
  const entries = new Map()
  let watcher
  let failure
  let closed = false
  let finish
  const ready = new Promise(resolve => { finish = resolve })
  const initialized = (async () => {
    try {
      await resolveVaultURL('vault://', root)
      if (closed) return
      watcher = chokidar.watch(root, {
        persistent: false,
        followSymlinks: false,
        ignoreInitial: false,
        ignored: (file, stat) => stat && stat.isFile() && !/\.md$/i.test(file)
      })
      watcher.on('add', (file, stat) => {
        if (closed || !stat?.isFile() || !/\.md$/i.test(file)) return
        const relative = path.relative(root, file)
        if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return
        const relativePath = relative.split(path.sep).join('/')
        entries.set(relativePath, {
          relativePath,
          url: 'vault://' + relativePath.split('/').map(encodeURIComponent).join('/'),
          searchPath: relativePath.toLowerCase()
        })
      })
      watcher.on('unlink', file => entries.delete(path.relative(root, file).split(path.sep).join('/')))
      watcher.on('unlinkDir', file => {
        const relative = path.relative(root, file).split(path.sep).join('/')
        for (const key of entries.keys()) {
          if (!relative || key.startsWith(relative + '/')) entries.delete(key)
        }
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

  return {
    get failed () { return Boolean(failure) },
    async search (query, isCurrent = () => true) {
      const check = () => {
        if (closed || !isCurrent()) throw new Error('Vault changed')
        if (failure) throw failure
      }
      check()
      await ready
      check()
      await resolveVaultURL('vault://', root)
      check()
      const needle = query.toLowerCase()
      const matches = Array.from(entries.values()).filter(entry => entry.searchPath.includes(needle))
        .sort((a, b) => a.relativePath.localeCompare(b.relativePath))
      const results = []
      for (const entry of matches) {
        check()
        try {
          // Revalidate candidates: watcher events are asynchronous, not authority.
          const file = await resolveVaultURL(entry.url, root)
          if (!file.stat.isFile()) continue
          results.push({ relativePath: entry.relativePath, url: entry.url })
        } catch (_) { continue }
        if (results.length === 21) break
      }
      check()
      return { ok: true, entries: results.slice(0, 20), truncated: results.length > 20 }
    },
    async close () {
      closed = true
      entries.clear()
      finish()
      await initialized
      if (watcher) await watcher.close()
    }
  }
}

module.exports = createVaultFileIndex
