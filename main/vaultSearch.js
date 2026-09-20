const fs = require('fs')
const { resolveVaultURL } = require('./vault.js')

async function searchVaultFiles (root, kind, query, isCurrent = () => true) {
  if (kind === 'p') return require('./annotatedPdfSearch.js').search(root, query, isCurrent)
  const entries = []
  const pending = [{ url: 'vault://', depth: 0 }]
  let visited = 0
  let truncated = false
  await resolveVaultURL('vault://', root)
  while (pending.length && !truncated) {
    if (!isCurrent()) throw new Error('Vault changed')
    const { url, depth } = pending.shift()
    let directory
    try {
      const folder = await resolveVaultURL(url, root)
      directory = await fs.promises.opendir(folder.absolutePath)
    } catch (_) { continue }
    for await (const item of directory) {
      if (!isCurrent()) throw new Error('Vault changed')
      if (++visited > 2000) { truncated = true; break }
      try {
        const file = await resolveVaultURL(url + encodeURIComponent(item.name), root)
        if (file.kind === 'directory') {
          if (depth < 32) pending.push({ url: file.vaultURL, depth: depth + 1 })
          else truncated = true
        } else if (file.stat.isFile() &&
          (kind === 'm' ? /\.md$/i : /\.pdf$/i).test(file.relativePath) &&
          file.relativePath.toLowerCase().includes(query.toLowerCase())) {
          entries.push({ relativePath: file.relativePath, url: file.vaultURL })
          if (entries.length === 20) { truncated = true; break }
        }
      } catch (_) { /* Skip symlinks and inaccessible files. */ }
    }
  }
  if (!isCurrent()) throw new Error('Vault changed')
  entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
  return { ok: true, entries, truncated }
}

module.exports = searchVaultFiles
