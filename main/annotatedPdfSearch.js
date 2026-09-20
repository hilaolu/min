const fs = require('fs')
const path = require('path')
const { createHash } = require('crypto')
const { fileURLToPath } = require('url')
const { resolveVaultURL } = require('./vault.js')
const { createStore, validateAnnotations, maximumBytes } = require('./annotationStore.js')
const parseLegacy = require('./annotationLegacy.js')

const MAX_VISITED_ENTRIES = 20000
const MAX_DEPTH = 32
const MAX_RESULTS = 20
const EXCLUDED_DIRECTORIES = new Set(['.obsidian', '.git', '.trash', 'node_modules'])
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0

function sourceIdentity (input) {
  const url = new URL(input)
  if (!['https:', 'http:', 'file:', 'vault:'].includes(url.protocol) || url.username || url.password) throw new Error('Unsupported PDF source')
  url.hash = ''
  return url.href
}

async function checkSource (source, root) {
  const url = new URL(source)
  if (url.protocol === 'file:' || url.protocol === 'vault:') {
    let target = source
    if (url.protocol === 'file:') {
      const relative = path.relative(root, fileURLToPath(url))
      if (path.isAbsolute(relative) || relative.split(path.sep).includes('..')) throw new Error('PDF outside vault')
      target = 'vault://' + relative.split(path.sep).map(encodeURIComponent).join('/')
    }
    const file = await resolveVaultURL(target, root)
    if (!file.stat.isFile() || !/\.pdf$/i.test(file.relativePath)) throw new Error('Unavailable local PDF')
  }
}

async function readRecord (file) {
  const handle = await fs.promises.open(file.absolutePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > maximumBytes) throw new Error('Annotation file exceeds limit')
    const bytes = Buffer.alloc(maximumBytes + 1)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (!bytesRead) break
      offset += bytesRead
    }
    if (offset > maximumBytes) throw new Error('Annotation file exceeds limit')
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset))
  } finally { await handle.close() }
}

// No writes or network requests. Legacy Markdown may live in a moved archive,
// not just the plugin's default Annotations folder.
async function discover (root, isCurrent = () => true) {
  await resolveVaultURL('vault://', root)
  const resources = new Map()
  const ambiguous = new Set()
  const invalidSources = new Set()
  const nativeSources = new Set()
  const diagnostics = []
  const pending = [{ url: 'vault://', depth: 0 }]
  let visited = 0
  let truncated = false
  // Reaching the depth limit must not discard other queued directories.
  while (pending.length && visited <= MAX_VISITED_ENTRIES) {
    if (!isCurrent()) throw new Error('Vault changed')
    const { url, depth } = pending.shift()
    let directory
    try {
      directory = await fs.promises.opendir((await resolveVaultURL(url, root)).absolutePath)
    } catch (_) { diagnostics.push(url); continue }
    for await (const item of directory) {
      if (!isCurrent()) throw new Error('Vault changed')
      if (++visited > MAX_VISITED_ENTRIES) { truncated = true; break }
      if (item.isSymbolicLink()) continue
      let recordSource
      try {
        const file = await resolveVaultURL(url + encodeURIComponent(item.name), root)
        if (file.kind === 'directory') {
          if (EXCLUDED_DIRECTORIES.has(item.name)) continue
          if (depth >= MAX_DEPTH) truncated = true
          else pending.push({ url: file.vaultURL, depth: depth + 1 })
          continue
        }
        const native = /^\.min-annotations\/[a-f0-9]{64}\.json$/.test(file.relativePath)
        if (!file.stat.isFile() || (!native && !/\.md$/i.test(item.name))) continue
        const text = await readRecord(file)
        if (native) {
          const data = JSON.parse(text)
          recordSource = sourceIdentity(data.source)
          const digest = createHash('sha256').update(recordSource).digest('hex')
          if (data.version !== 1 || item.name !== digest + '.json') throw new Error('Annotation source or version mismatch')
          nativeSources.add(recordSource)
          continue
        }
        if (!/sourceType:\s*pdf/.test(text)) continue
        const declaredSource = text.match(/^\|\s*URL\s*\|\s*([^|]+)\|\s*$/im)?.[1].trim()
        if (declaredSource) recordSource = sourceIdentity(declaredSource)
        const parsed = parseLegacy(text)
        const source = sourceIdentity(parsed.source)
        await checkSource(source, root)
        const annotations = validateAnnotations(parsed.annotations)
        if (!annotations.length) continue
        if (resources.has(source)) { ambiguous.add(source); diagnostics.push(file.relativePath); continue }
        const tags = text.match(/^\|\s*Tags\s*\|\s*([^|]+)\|\s*$/im)?.[1].trim() || ''
        resources.set(source, { source, title: parsed.title, tags, annotations })
      } catch (_) {
        if (recordSource) invalidSources.add(recordSource)
        diagnostics.push(url + encodeURIComponent(item.name))
      }
    }
  }
  // A native store (even an empty one) takes precedence over legacy records.
  // This prevents deleted legacy highlights reappearing after reopening.
  for (const source of new Set([...resources.keys(), ...nativeSources])) {
    if (!isCurrent()) throw new Error('Vault changed')
    try {
      const stored = await createStore(root, source).read()
      if (stored.revision !== null) {
        await checkSource(source, root)
        const previous = resources.get(source)
        resources.set(source, { source, title: previous?.title || source, tags: previous?.tags || '', annotations: stored.annotations })
        ambiguous.delete(source)
        invalidSources.delete(source)
      }
    } catch (_) {
      resources.delete(source)
      invalidSources.add(source)
      diagnostics.push('Native annotation store')
    }
  }
  for (const source of ambiguous) resources.delete(source)
  for (const source of invalidSources) resources.delete(source)
  if (!isCurrent()) throw new Error('Vault changed')
  return {
    resources: [...resources.values()].filter(resource => resource.annotations.length),
    truncated,
    errors: diagnostics.length,
    diagnostics,
    invalidSources: new Set([...ambiguous, ...invalidSources])
  }
}

function score (text, query) {
  text = text.toLowerCase()
  if (!query) return 1
  if (text.includes(query)) return query.length * 10
  let index = 0
  let streak = 0
  let result = 0
  for (const char of text) {
    if (char === query[index]) {
      result += 1 + ++streak
      if (++index === query.length) return result
    } else streak = 0
  }
  return 0
}

async function search (root, query, isCurrent) {
  const result = await discover(root, isCurrent)
  const lowerQuery = query.toLowerCase()
  const matches = result.resources.map(resource => ({ resource, score: score([resource.title, resource.source, resource.tags].join(' '), lowerQuery) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || compare(a.resource.title.toLowerCase(), b.resource.title.toLowerCase()) || compare(a.resource.source, b.resource.source))
  return {
    ok: true,
    entries: matches.slice(0, MAX_RESULTS).map(({ resource }) => ({
      title: resource.title,
      source: resource.source,
      annotationCount: resource.annotations.length,
      url: resource.source.startsWith('vault:') ? resource.source : 'min://app/pages/pdfViewer/index.html?url=' + encodeURIComponent(resource.source)
    })),
    total: result.resources.length,
    truncated: result.truncated || matches.length > MAX_RESULTS,
    errors: result.errors,
    diagnostics: result.diagnostics
  }
}

module.exports = { discover, search, sourceIdentity }
