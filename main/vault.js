const fs = require('fs')
const path = require('path')
const { parseVaultURL } = require('../js/util/vaultURL.js')

function failure (status) {
  const error = new Error('Vault resource unavailable')
  error.status = status
  return error
}

function ioStatus (error) {
  return error.status || ({ ENOENT: 404, ENOTDIR: 404, EACCES: 403, EPERM: 403, ELOOP: 403 }[error.code]) || 500
}

async function canonicalRoot (directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw failure(503)
  try {
    const root = await fs.promises.realpath(directory)
    if (!(await fs.promises.stat(root)).isDirectory()) throw failure(503)
    return root
  } catch (_) { throw failure(503) }
}

async function resolveVaultURL (input, root) {
  const parsed = parseVaultURL(input)
  if (!root) throw failure(503)
  // root is captured and canonicalized by the owner, never supplied by a page.
  const rootStat = await fs.promises.lstat(root).catch(() => { throw failure(503) })
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw failure(503)
  let absolutePath = root
  let stat = rootStat
  for (const segment of parsed.segments) {
    absolutePath = path.join(absolutePath, segment)
    const relative = path.relative(root, absolutePath)
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw failure(403)
    stat = await fs.promises.lstat(absolutePath)
    if (stat.isSymbolicLink()) throw failure(403)
  }
  const kind = stat.isDirectory() ? 'directory' : stat.isFile() ? (/\.(md|markdown)$/i.test(absolutePath) ? 'markdown' : 'file') : 'other'
  return {
    absolutePath,
    relativePath: parsed.segments.join('/'),
    vaultURL: parsed.segments.length ? parsed.vaultURL.replace(/\/$/, '') + (kind === 'directory' ? '/' : '') : 'vault://',
    kind,
    stat
  }
}

module.exports = { canonicalRoot, resolveVaultURL, failure, ioStatus }
