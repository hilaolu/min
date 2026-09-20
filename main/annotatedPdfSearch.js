const fs = require('fs')
const path = require('path')
const { createHash } = require('crypto')
const { fileURLToPath } = require('url')
const { resolveVaultURL } = require('./vault.js')
const { createStore, validateAnnotations, maximumBytes } = require('./annotationStore.js')
const annotationMarkdown = require('./annotationMarkdown.js')
const parseLegacy = require('./annotationLegacy.js')
const { isHiddenPath, isAnnotationMetadata } = require('./vaultSearchPaths.js')

const MAX_VISITED_ENTRIES = 20000
const MAX_DEPTH = 32
const MAX_RESULTS = 20
const EXCLUDED_DIRECTORIES = new Set(['node_modules'])
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0

function sourceIdentity (input) {
  const url = new URL(input)
  if (!['https:', 'http:', 'file:', 'vault:'].includes(url.protocol) || url.username || url.password) throw new Error('Unsupported PDF source')
  url.hash = ''
  return url.href
}

async function checkSource (source, root) {
  source = sourceIdentity(source)
  const url = new URL(source)
  if (url.protocol === 'file:' || url.protocol === 'vault:') {
    let target = source
    if (url.protocol === 'file:') {
      const relative = path.relative(root, fileURLToPath(url))
      if (path.isAbsolute(relative) || relative.split(path.sep).includes('..')) throw new Error('PDF outside vault')
      target = 'vault://' + relative.split(path.sep).map(encodeURIComponent).join('/')
    }
    const file = await resolveVaultURL(target, root)
    if (isHiddenPath(file.relativePath) || !file.stat.isFile() || !/\.pdf$/i.test(file.relativePath)) throw new Error('Unavailable local PDF')
  }
}

function checkWebSource (source) {
  const url = new URL(source)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Unsupported webpage source')
}

function validateWebAnnotations (items) {
  if (!Array.isArray(items) || items.length > 1000 || Buffer.byteLength(JSON.stringify(items)) > maximumBytes) throw new Error('Annotation size limit exceeded')
  const ids = new Set()
  return items.map(item => {
    if (!item || item.sourceType !== 'webpage' || typeof item.uid !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(item.uid) || ids.has(item.uid)) throw new Error('Invalid or duplicate annotation')
    ids.add(item.uid)
    const data = item.data
    if (!data || !/^#[0-9a-f]{6}$/i.test(data.color)) throw new Error('Invalid webpage annotation')
    for (const key of ['text', 'notes', 'textBefore', 'textAfter']) {
      if (typeof data[key] !== 'string' || data[key].length > 100000) throw new Error('Invalid annotation text')
    }
    return {
      uid: item.uid,
      sourceType: 'webpage',
      data: { color: data.color, text: data.text, notes: data.notes, textBefore: data.textBefore, textAfter: data.textAfter }
    }
  })
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

function excluded (relativePath) {
  return (isHiddenPath(relativePath) && !isAnnotationMetadata(relativePath)) || relativePath.split('/').some(component => EXCLUDED_DIRECTORIES.has(component))
}

// No writes or network requests. Legacy Markdown may live in a moved archive,
// not just the plugin's default Annotations folder.
async function discover (root, isCurrent = () => true, snapshot) {
  await resolveVaultURL('vault://', root)
  if (snapshot !== undefined && !Array.isArray(snapshot)) throw new TypeError('Invalid vault snapshot')
  const resources = new Map()
  const ambiguous = new Set()
  const invalidSources = new Set()
  const nativeSources = new Set()
  const invalidMarkdownDigests = new Set()
  const diagnostics = []
  let truncated = false

  async function inspect (file, diagnostic) {
    let recordSource
    const nativeMatch = file.relativePath.match(/^\.min-annotations\/([a-f0-9]{64})\.(md|json)$/)
    try {
      if (!file.stat.isFile() || (!nativeMatch && !/\.md$/i.test(file.relativePath))) return
      const text = await readRecord(file)
      if (nativeMatch) {
        const data = nativeMatch[2] === 'md' ? annotationMarkdown.parse(text) : JSON.parse(text)
        recordSource = sourceIdentity(data.source)
        const digest = createHash('sha256').update(recordSource).digest('hex')
        if (data.version !== 1 || nativeMatch[1] !== digest) throw new Error('Annotation source or version mismatch')
        nativeSources.add(recordSource)
        return
      }
      const portable = annotationMarkdown.isMarkdown(text)
      if (!portable && !/%% annotation:/m.test(text)) return
      const declaredSource = text.match(/^\|\s*URL\s*\|\s*([^|]+)\|\s*$/im)?.[1].trim()
      if (declaredSource) recordSource = sourceIdentity(declaredSource)
      const parsed = portable ? annotationMarkdown.parse(text) : parseLegacy(text)
      const source = sourceIdentity(parsed.source)
      recordSource = source
      const pdfAnnotations = parsed.annotations.filter(annotation => annotation.sourceType === 'pdf')
      let annotations
      let sourceType
      if (portable || pdfAnnotations.length) {
        await checkSource(source, root)
        annotations = validateAnnotations(pdfAnnotations)
        sourceType = 'pdf'
      } else {
        checkWebSource(source)
        annotations = validateWebAnnotations(parsed.annotations)
        sourceType = 'webpage'
      }
      if (!annotations.length && !portable) return
      if (resources.has(source)) { ambiguous.add(source); diagnostics.push(file.relativePath); return }
      const tags = text.match(/^\|\s*Tags\s*\|\s*([^|]+)\|\s*$/im)?.[1].trim() || ''
      resources.set(source, { source, sourceType, title: parsed.title || source, tags, annotations })
    } catch (_) {
      if (recordSource) invalidSources.add(recordSource)
      if (nativeMatch?.[2] === 'md') invalidMarkdownDigests.add(nativeMatch[1])
      diagnostics.push(diagnostic)
    }
  }

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

  // A native store (even an empty one) takes precedence over legacy records.
  // This prevents deleted legacy highlights reappearing after reopening.
  for (const source of new Set([...resources.keys(), ...nativeSources])) {
    if (!isCurrent()) throw new Error('Vault changed')
    const digest = createHash('sha256').update(source).digest('hex')
    if (invalidMarkdownDigests.has(digest)) {
      resources.delete(source)
      invalidSources.add(source)
      continue
    }
    try {
      const stored = await createStore(root, source).read()
      if (stored.revision !== null) {
        await checkSource(source, root)
        const previous = resources.get(source)
        resources.set(source, { source, sourceType: 'pdf', title: previous?.title || source, tags: previous?.tags || '', annotations: stored.annotations })
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

function rank (result, query, kind = 'p') {
  const sourceType = kind === 'a' ? 'webpage' : 'pdf'
  const resources = result.resources.filter(resource => resource.sourceType === sourceType)
  const lowerQuery = query.toLowerCase()
  const matches = resources.map(resource => ({ resource, score: score([resource.title, resource.source, resource.tags].join(' '), lowerQuery) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || compare(a.resource.title.toLowerCase(), b.resource.title.toLowerCase()) || compare(a.resource.source, b.resource.source))
  return {
    ok: true,
    entries: matches.slice(0, MAX_RESULTS).map(({ resource }) => ({
      title: resource.title,
      source: resource.source,
      annotationCount: resource.annotationCount === undefined ? resource.annotations.length : resource.annotationCount,
      url: resource.sourceType === 'webpage' || resource.source.startsWith('vault:') ? resource.source : 'min://app/pages/pdfViewer/index.html?url=' + encodeURIComponent(resource.source)
    })),
    total: resources.length,
    truncated: result.truncated || matches.length > MAX_RESULTS,
    errors: result.errors,
    diagnostics: result.diagnostics
  }
}

async function search (root, query, isCurrent) {
  return rank(await discover(root, isCurrent), query)
}

module.exports = { discover, search, rank, checkSource, sourceIdentity }
