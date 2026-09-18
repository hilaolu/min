/* global Response */
const fs = require('fs')
const path = require('path')
const { Readable } = require('stream')
const { resolveVaultURL, failure, ioStatus } = require('./vault.js')

const mime = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.md': 'text/markdown; charset=utf-8',
  '.markdown': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
  '.ico': 'image/vnd.microsoft.icon'
}

function byteRange (header, size) {
  if (!header || !header.startsWith('bytes=') || header.includes(',')) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header)
  if (!match || (!match[1] && !match[2])) throw failure(400)
  const first = match[1] ? Number(match[1]) : null
  const last = match[2] ? Number(match[2]) : null
  if ((first !== null && !Number.isSafeInteger(first)) || (last !== null && !Number.isSafeInteger(last))) throw failure(400)
  if (first !== null && last !== null && first > last) throw failure(400)
  if (!size || first >= size || (first === null && last === 0)) throw failure(416)
  return first === null
    ? { start: Math.max(0, size - last), end: size - 1 }
    : { start: first, end: last === null ? size - 1 : Math.min(last, size - 1) }
}

const policyHeaders = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; img-src vault:; media-src vault:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'Access-Control-Allow-Origin': 'min://app',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Range',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
  Vary: 'Origin'
}

// approvedRoot is a main-owned, captured root, NOT a Request property or header.
async function serveVaultResource (request, approvedRoot) {
  const headers = { ...policyHeaders }
  let handle
  try {
    if (approvedRoot === undefined) throw failure(403)
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      headers.Allow = 'GET, HEAD, OPTIONS'
      throw failure(405)
    }
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers })
    const target = await resolveVaultURL(request.url, approvedRoot)
    if (!['file', 'markdown'].includes(target.kind)) throw failure(409)
    handle = await fs.promises.open(target.absolutePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
    const stat = await handle.stat()
    if (!stat.isFile()) throw failure(409)
    // Detect replacements between path validation and opening, without claiming
    // protection against an actively hostile OS user swapping ancestor directories.
    if (stat.ino !== target.stat.ino || stat.dev !== target.stat.dev) throw failure(403)
    headers['Content-Type'] = mime[path.extname(target.absolutePath).toLowerCase()] || 'application/octet-stream'
    if (/^(text\/html|image\/svg\+xml)/.test(headers['Content-Type'])) {
      headers['Content-Security-Policy'] = "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    }
    headers['Accept-Ranges'] = 'bytes'
    let range
    try { range = request.method === 'GET' ? byteRange(request.headers.get('range'), stat.size) : null } catch (error) {
      if (error.status === 416) headers['Content-Range'] = 'bytes */' + stat.size
      throw error
    }
    const length = range ? range.end - range.start + 1 : stat.size
    headers['Content-Length'] = String(length)
    if (range) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${stat.size}`
    if (request.method === 'HEAD' || !length) {
      await handle.close()
      handle = null
      return new Response(null, { status: 200, headers })
    }
    const stream = handle.createReadStream({ start: range ? range.start : 0, end: range ? range.end : stat.size - 1, highWaterMark: 64 * 1024, autoClose: true })
    handle = null // ownership transferred to stream; web cancellation destroys it
    const abort = () => stream.destroy()
    request.signal.addEventListener('abort', abort, { once: true })
    stream.once('close', () => request.signal.removeEventListener('abort', abort))
    if (request.signal.aborted) abort()
    return new Response(Readable.toWeb(stream, { strategy: { highWaterMark: 64 * 1024, size: chunk => chunk.byteLength } }), { status: range ? 206 : 200, headers })
  } catch (error) {
    if (handle) await handle.close().catch(() => {})
    const status = ioStatus(error)
    const body = `Vault resource error (${status})`
    headers['Content-Type'] = 'text/plain; charset=utf-8'
    headers['Content-Length'] = String(Buffer.byteLength(body))
    return new Response(request.method === 'HEAD' ? null : body, { status, headers })
  }
}

module.exports = { serveVaultResource, byteRange }
