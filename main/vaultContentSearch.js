const fs = require('fs')
const { TextDecoder } = require('util')
const { quickScore } = require('quick-score')
const { resolveVaultURL } = require('./vault.js')
const { isHiddenPath } = require('./vaultSearchPaths.js')

const FILE_BYTES = 4 * 1024 * 1024
const TOTAL_BYTES = 32 * 1024 * 1024
const MAX_ENTRIES = 20000
const TIMEOUT_MS = 10000
const rank = (a, b) => b.score - a.score || a.relativePath.localeCompare(b.relativePath)
const binaryExtension = /\.(pdf|png|jpe?g|gif|webp|avif|bmp|ico|mp[34]|ogg|wav|webm|mov|mkv|zip|gz|bz2|xz|7z|rar|woff2?|ttf|exe|dll|so|wasm)$/i
const yieldTurn = () => new Promise(resolve => setImmediate(resolve))

function passage (text, ranges, line) {
  const start = Math.max(0, ranges[0][0] - 200)
  const end = Math.min(text.length, ranges[ranges.length - 1][1] + 300)
  return {
    text: text.slice(start, end),
    ranges: ranges.map(([a, b]) => [a - start, b - start]),
    line,
    clippedStart: start > 0,
    clippedEnd: end < text.length
  }
}

// Search bounded overlapping windows so huge/minified lines cannot monopolize
// the main process. Literal matches always outrank fuzzy abbreviations.
async function matchText (text, query, exact, check) {
  const literal = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu')
  let offset = 0
  let line = 1
  let best = null
  let iterations = 0
  while (offset < text.length) {
    const newline = text.indexOf('\n', offset)
    const end = newline < 0 ? text.length : newline
    for (let at = offset; at < end; at += 768) {
      if (++iterations % 32 === 0) { await yieldTurn(); check() }
      const window = text.slice(at, Math.min(at + 1024, end))
      const found = literal.exec(window)
      const ranges = []
      let score = 0
      if (found) {
        score = 1
        ranges.push([found.index, found.index + found[0].length])
      } else if (!exact) {
        score = quickScore(window, query, ranges)
        // Avoid rewarding characters scattered across an unrelated paragraph.
        if (ranges.length && ranges[ranges.length - 1][1] - ranges[0][0] > query.length * 3) score = 0
      }
      if (score >= 0.75 && (!best || score > best.score)) {
        best = { score, passage: passage(text, ranges.map(([a, b]) => [a + at, b + at]), line) }
        if (score === 1) return best
      }
      if (at + 1024 >= end) break
    }
    offset = end + 1
    line++
    if (++iterations % 32 === 0) { await yieldTurn(); check() }
  }
  return best
}

async function searchContents (root, url, query, current = () => true, options = {}) {
  query = query.trim()
  if (!query || query.includes('\n') || query.includes('\r')) return { ok: false, error: 'Enter a single-line content query.' }
  const limit = options.limit === undefined ? 50 : options.limit
  const deadline = Date.now() + TIMEOUT_MS
  const check = () => {
    if (!current()) throw new Error('Search canceled')
    if (Date.now() > deadline) throw new Error('CONTENT_SEARCH_TIMEOUT')
  }
  const pending = [url]
  const results = []
  const notes = new Set()
  let visited = 0
  let readBytes = 0
  let skipped = 0
  let total = 0
  try {
    await resolveVaultURL(url, root)
    let stopped = false
    while (pending.length && !stopped) {
      check()
      let directory
      try {
        const folder = await resolveVaultURL(pending.pop(), root)
        if (isHiddenPath(folder.relativePath)) continue
        directory = { folder, stream: await fs.promises.opendir(folder.absolutePath) }
      } catch (_) { skipped++; continue }
      for await (const item of directory.stream) {
        check()
        if (item.name.startsWith('.')) continue
        if (++visited > MAX_ENTRIES) { notes.add('Scan limited to 20,000 entries'); stopped = true; break }
        if (readBytes >= TOTAL_BYTES) { notes.add('Scan limited to 32 MiB of file data'); stopped = true; break }
        let handle
        try {
          const file = await resolveVaultURL(directory.folder.vaultURL + encodeURIComponent(item.name), root)
          if (file.kind === 'directory') { pending.push(file.vaultURL); continue }
          if (!file.stat.isFile()) continue
          if (binaryExtension.test(item.name)) { skipped++; continue }
          handle = await fs.promises.open(file.absolutePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
          const stat = await handle.stat()
          if (!stat.isFile() || stat.ino !== file.stat.ino || stat.dev !== file.stat.dev) { skipped++; continue }
          const cap = Math.min(FILE_BYTES, TOTAL_BYTES - readBytes)
          const bytes = Buffer.alloc(Math.min(stat.size, cap))
          let used = 0
          while (used < bytes.length) {
            check()
            const read = await handle.read(bytes, used, bytes.length - used, used)
            if (!read.bytesRead) break
            used += read.bytesRead
          }
          readBytes += used
          if (stat.size > cap) notes.add(cap === FILE_BYTES ? 'Large files searched only in their first 4 MiB' : 'Scan limited to 32 MiB of file data')
          const data = bytes.subarray(0, used)
          if (data.includes(0)) { skipped++; continue }
          let text
          try { text = new TextDecoder('utf-8', { fatal: true }).decode(data, { stream: stat.size > used }) } catch (_) { skipped++; continue }
          const match = await matchText(text, query, options.exact, check)
          if (match) {
            total++
            const entry = { name: item.name, relativePath: file.relativePath, url: file.vaultURL, kind: file.kind, ...match }
            // Retain only the requested top results, not a snippet for every hit.
            if (results.length < limit || rank(entry, results[results.length - 1]) < 0) {
              // A tiny slice can retain the entire decoded file (external V8
              // memory). Copy only retained snippets. UTF-16 preserves even a
              // surrogate pair bisected by the existing clipping boundaries.
              entry.passage.text = Buffer.from(entry.passage.text, 'utf16le').toString('utf16le')
              results.push(entry)
              results.sort(rank)
              if (results.length > limit) results.pop()
            }
          }
        } catch (error) {
          if (!current() || error.message === 'CONTENT_SEARCH_TIMEOUT') throw error
          skipped++
        } finally {
          if (handle) await handle.close()
        }
      }
    }
  } catch (error) {
    if (error.message !== 'CONTENT_SEARCH_TIMEOUT') throw error
    notes.add('Scan stopped after 10 seconds')
  }
  if (!current()) throw new Error('Search canceled')
  return {
    ok: true,
    entries: results,
    total,
    truncated: notes.size > 0 || total > limit,
    scanLimited: notes.size > 0,
    resultLimited: total > limit,
    notes: Array.from(notes),
    skipped
  }
}

module.exports = searchContents
