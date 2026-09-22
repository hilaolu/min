const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const atomic = require('write-file-atomic')
const annotationMarkdown = require('./annotationMarkdown.js')
const { normalizeFolder, defaultFolder } = require('./annotationPaths.js')

const maximumBytes = 1024 * 1024
const queues = new Map()
const digest = text => crypto.createHash('sha256').update(text).digest('hex')

function validateAnnotations (items) {
  if (!Array.isArray(items) || items.length > 1000 || Buffer.byteLength(JSON.stringify(items)) > maximumBytes) throw new Error('Annotation size limit exceeded')
  const ids = new Set()
  function rect (value) {
    if (!value || !value.origin || !value.size) throw new Error('Invalid PDF rectangle')
    for (const n of [value.origin.x, value.origin.y, value.size.width, value.size.height]) {
      if (!Number.isFinite(n) || Math.abs(n) > 1000000) throw new Error('Invalid PDF rectangle')
    }
    if (value.size.width < 0 || value.size.height < 0) throw new Error('Invalid PDF rectangle')
    return { origin: { x: value.origin.x, y: value.origin.y }, size: { width: value.size.width, height: value.size.height } }
  }
  return items.map(item => {
    if (!item || typeof item.uid !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(item.uid) || ids.has(item.uid) || !['pdf', 'webpage'].includes(item.sourceType)) throw new Error('Invalid or duplicate annotation')
    ids.add(item.uid)
    const data = item.data
    if (!data || !/^#[0-9a-f]{6}$/i.test(data.color)) throw new Error('Invalid annotation color')
    for (const key of ['text', 'notes', 'textBefore', 'textAfter']) {
      if (typeof data[key] !== 'string' || data[key].length > 100000) throw new Error('Invalid annotation text')
    }
    const shared = { color: data.color, text: data.text, notes: data.notes, textBefore: data.textBefore, textAfter: data.textAfter }
    if (item.sourceType === 'webpage') return { uid: item.uid, sourceType: 'webpage', data: shared }
    if (!Number.isSafeInteger(data.pageIndex) || data.pageIndex < 0 || data.pageIndex > 100000) throw new Error('Invalid PDF annotation')
    if (!Array.isArray(data.segmentRects) || !data.segmentRects.length || data.segmentRects.length > 10000) throw new Error('Invalid PDF segments')
    return {
      uid: item.uid,
      sourceType: 'pdf',
      data: {
        ...shared,
        pageIndex: data.pageIndex,
        rect: rect(data.rect),
        segmentRects: data.segmentRects.map(rect)
      }
    }
  })
}

function createStore (root, source, folder = defaultFolder) {
  folder = normalizeFolder(folder)
  const directory = path.join(root, folder)
  const basename = path.join(directory, digest(source))
  const markdownFilename = basename + '.md'
  const jsonFilename = basename + '.json'
  async function checkDirectory (create) {
    const rootStat = await fs.promises.lstat(root).catch(() => { throw new Error('Vault unavailable') })
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Vault unavailable')
    let current = root
    for (const component of folder.split('/')) {
      current = path.join(current, component)
      if (create) await fs.promises.mkdir(current).catch(error => { if (error.code !== 'EEXIST') throw error })
      const stat = await fs.promises.lstat(current)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe annotation directory')
    }
  }
  async function readFile (filename) {
    const stat = await fs.promises.lstat(filename)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximumBytes) throw new Error('Unsafe annotation file')
    const handle = await fs.promises.open(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    try {
      const opened = await handle.stat()
      if (!opened.isFile() || opened.size > maximumBytes) throw new Error('Unsafe annotation file')
      // Bound the read itself, including a file that grows after stat().
      const bytes = Buffer.alloc(maximumBytes + 1)
      let offset = 0
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
        if (!bytesRead) break
        offset += bytesRead
      }
      if (offset > maximumBytes) throw new Error('Annotation size limit exceeded')
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, offset))
    } finally { await handle.close() }
  }
  async function readRecord () {
    try {
      await checkDirectory(false)
      let text
      let format
      try {
        text = await readFile(markdownFilename)
        format = 'markdown'
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
        text = await readFile(jsonFilename)
        format = 'json'
      }
      const data = format === 'markdown' ? annotationMarkdown.parse(text) : JSON.parse(text)
      if (data.version !== 1 || data.source !== source) throw new Error('Annotation source or version mismatch')
      return { revision: digest(text), annotations: validateAnnotations(data.annotations), format }
    } catch (error) {
      if (error.code === 'ENOENT') return { revision: null, annotations: [], format: null }
      throw error
    }
  }
  async function read () {
    const { revision, annotations } = await readRecord()
    return { revision, annotations }
  }
  return {
    read,
    save (annotations, revision, current = () => true) {
      const validated = validateAnnotations(annotations)
      let text
      try {
        text = annotationMarkdown.stringify({ version: 1, source, annotations: validated })
      } catch (error) {
        if (/size limit/.test(error.message)) return Promise.reject(error)
        throw error
      }
      if (Buffer.byteLength(text) > maximumBytes) return Promise.reject(new Error('Annotation size limit exceeded'))
      const result = (queues.get(markdownFilename) || Promise.resolve()).then(async () => {
        if (!current()) throw new Error('Document or vault changed')
        const before = await readRecord()
        if (before.revision !== revision) throw new Error('Annotations changed on disk. Export your edits before reloading.')
        if (!current()) throw new Error('Document or vault changed')
        if (before.format === 'markdown' && before.revision === digest(text)) return { revision: before.revision, annotations: validated }
        await checkDirectory(true)
        if (!current()) throw new Error('Document or vault changed')
        await atomic(markdownFilename, text, { encoding: 'utf8', mode: 0o600 })
        return { revision: digest(text), annotations: validated }
      })
      const tail = result.catch(() => {})
      queues.set(markdownFilename, tail)
      tail.then(() => { if (queues.get(markdownFilename) === tail) queues.delete(markdownFilename) })
      return result
    }
  }
}

module.exports = { createStore, validateAnnotations, maximumBytes, drain: () => Promise.all([...queues.values()]) }
