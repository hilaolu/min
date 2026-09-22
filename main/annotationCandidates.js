const fs = require('fs')
const { resolveVaultURL } = require('./vault.js')
const { isHiddenPath } = require('./vaultSearchPaths.js')

const MAX_VISITED_ENTRIES = 20000
const MAX_DEPTH = 32

function excluded (relativePath) {
  return isHiddenPath(relativePath) || relativePath.split('/').includes('node_modules')
}

// Enumeration only. Callers own record decoding and resource precedence.
async function visitCandidates (root, isCurrent, snapshot, inspect, diagnostics) {
  await resolveVaultURL('vault://', root)
  if (snapshot !== undefined && !Array.isArray(snapshot)) throw new TypeError('Invalid vault snapshot')
  let truncated = false
  if (snapshot !== undefined) {
    const seen = new Set()
    for (const entry of snapshot) {
      if (!isCurrent()) throw new Error('Vault changed')
      const diagnostic = entry && typeof entry.url === 'string' ? entry.url : 'Vault snapshot entry'
      try {
        if (!entry || typeof entry.relativePath !== 'string' || typeof entry.url !== 'string') throw new Error('Invalid vault snapshot entry')
        const file = await resolveVaultURL(entry.url, root)
        if (file.relativePath !== entry.relativePath) throw new Error('Vault snapshot path mismatch')
        if (excluded(file.relativePath) || seen.has(file.relativePath)) continue
        seen.add(file.relativePath)
        await inspect(file, diagnostic)
      } catch (_) { diagnostics.push(diagnostic) }
    }
  } else {
    const pending = [{ url: 'vault://', depth: 0 }]
    let visited = 0
    // Reaching the depth limit must not discard other queued directories.
    while (pending.length && visited <= MAX_VISITED_ENTRIES) {
      if (!isCurrent()) throw new Error('Vault changed')
      const { url, depth } = pending.shift()
      let directory
      let folder
      try {
        folder = await resolveVaultURL(url, root)
        directory = await fs.promises.opendir(folder.absolutePath)
      } catch (_) { diagnostics.push(url); continue }
      for await (const item of directory) {
        if (!isCurrent()) throw new Error('Vault changed')
        const relative = [folder.relativePath, item.name].filter(Boolean).join('/')
        if (excluded(relative)) continue
        if (++visited > MAX_VISITED_ENTRIES) { truncated = true; break }
        if (item.isSymbolicLink()) continue
        const diagnostic = url + encodeURIComponent(item.name)
        try {
          const file = await resolveVaultURL(diagnostic, root)
          if (file.kind === 'directory') {
            if (depth >= MAX_DEPTH) truncated = true
            else pending.push({ url: file.vaultURL, depth: depth + 1 })
          } else await inspect(file, diagnostic)
        } catch (_) { diagnostics.push(diagnostic) }
      }
    }
  }
  if (!isCurrent()) throw new Error('Vault changed')
  return { truncated }
}

module.exports = visitCandidates
