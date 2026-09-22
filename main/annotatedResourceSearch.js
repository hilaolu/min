const fs = require('fs')
const path = require('path')
const { fileURLToPath } = require('url')
const { resolveVaultURL } = require('./vault.js')
const { createStore, validateAnnotations, maximumBytes } = require('./annotationStore.js')
const annotationMarkdown = require('./annotationMarkdown.js')
const { isHiddenPath } = require('./vaultSearchPaths.js')
const visitCandidates = require('./annotationCandidates.js')
const annotationPaths = require('./annotationPaths.js')

const MAX_RESULTS = 20
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0

function sourceIdentity (input) {
  return annotationPaths.canonicalSource(input)
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
  const annotations = validateAnnotations(items)
  if (annotations.some(item => item.sourceType !== 'webpage')) throw new Error('Invalid webpage annotation')
  return annotations
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

// Decode one candidate without mutating the aggregate resource/precedence state.
async function decodeCandidate (file, root) {
  let recordSource
  try {
    if (!file.stat.isFile() || !/\.md$/i.test(file.relativePath)) return
    const text = await readRecord(file)
    if (!annotationMarkdown.isMarkdown(text) && !/%% annotation:/m.test(text)) return
    const declaredSource = text.match(/^\|\s*URL\s*\|\s*([^|]+)\|\s*$/im)?.[1].trim()
    if (declaredSource) recordSource = sourceIdentity(declaredSource)
    const parsed = annotationMarkdown.parse(text)
    const source = sourceIdentity(parsed.source)
    recordSource = source
    const pdfAnnotations = parsed.annotations.filter(annotation => annotation.sourceType === 'pdf')
    let annotations
    let sourceType
    if (pdfAnnotations.length || (!parsed.annotations.length && /^(file|vault):/.test(source))) {
      await checkSource(source, root)
      annotations = validateAnnotations(pdfAnnotations)
      sourceType = 'pdf'
    } else {
      checkWebSource(source)
      annotations = validateWebAnnotations(parsed.annotations)
      sourceType = 'webpage'
    }
    const tags = parsed.tags || ''
    return { resource: { source, sourceType, title: parsed.title || source, tags, annotations } }
  } catch (_) {
    return { failed: true, invalidSource: recordSource }
  }
}

// No writes or network requests. Discovery is confined to the Settings folder,
// including for legacy files and watcher-provided snapshots.
async function discover (root, isCurrent = () => true, snapshot, folder = annotationPaths.defaultFolder) {
  folder = annotationPaths.normalizeFolder(folder)
  const resources = new Map()
  const ambiguous = new Set()
  const invalidSources = new Set()
  const diagnostics = []

  async function inspect (file, diagnostic) {
    const decoded = await decodeCandidate(file, root)
    if (!decoded) return
    if (decoded.failed) {
      if (decoded.invalidSource) invalidSources.add(decoded.invalidSource)
      diagnostics.push(diagnostic)
    } else {
      const resource = decoded.resource
      if (resources.has(resource.source)) {
        ambiguous.add(resource.source)
        diagnostics.push(file.relativePath)
      } else resources.set(resource.source, resource)
    }
  }

  const { truncated } = await visitCandidates(root, isCurrent, snapshot, inspect, diagnostics, folder)

  // The URL-derived store (even empty) takes precedence over archived copies.
  // This prevents deleted highlights reappearing after reopening.
  for (const source of resources.keys()) {
    if (!isCurrent()) throw new Error('Vault changed')
    try {
      const stored = await createStore(root, source, folder).read()
      if (stored.revision !== null) {
        const previous = resources.get(source)
        const sourceType = stored.annotations[0]?.sourceType || previous?.sourceType || 'pdf'
        if (sourceType === 'webpage') checkWebSource(source)
        else await checkSource(source, root)
        resources.set(source, { source, sourceType, title: previous?.title || source, tags: previous?.tags || '', annotations: stored.annotations })
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
    scanLimited: Boolean(result.truncated),
    resultLimited: matches.length > MAX_RESULTS,
    errors: result.errors,
    diagnostics: result.diagnostics
  }
}

async function search (root, query, isCurrent) {
  return rank(await discover(root, isCurrent), query)
}

module.exports = { discover, search, rank, checkSource, sourceIdentity }
