const { validRect: validGeometry } = require('./annotationGeometry.js')
const MAX_INPUT_BYTES = 1024 * 1024

function invalid (message) {
  throw new Error(`Invalid legacy annotation Markdown: ${message}`)
}

function readMetadata (line, field) {
  const match = line.match(new RegExp(`^\\|\\s*${field}\\s*\\|\\s*([^|]+)\\s*\\|\\s*$`, 'i'))
  if (!match || !match[1].trim()) invalid(`missing or malformed ${field} metadata`)
  return match[1].trim()
}

function parseMarker (line) {
  const match = line.match(/^%% annotation: ([A-Za-z0-9-]+) \| color: ([^%|]+?)(?: \| sourceType: (webpage|pdf))?(?: \| pageIndex: ([0-9]+))? %%$/)
  if (!match) invalid('malformed annotation marker')

  const sourceType = match[3] || 'webpage'
  const pageIndex = match[4] === undefined ? undefined : Number(match[4])
  if (pageIndex !== undefined && (!Number.isSafeInteger(pageIndex) || sourceType !== 'pdf')) {
    invalid('invalid page metadata')
  }
  if (sourceType === 'pdf' && pageIndex === undefined) invalid('PDF annotation is missing page metadata')

  return {
    uid: match[1],
    color: match[2].trim().startsWith('#') ? match[2].trim() : `#${match[2].trim()}`,
    sourceType,
    pageIndex
  }
}

function readPre (lines, start) {
  if (!lines[start] || !lines[start].startsWith('<pre>')) invalid('annotation is missing a pre block')

  const parts = [lines[start].slice(5)]
  let index = start
  while (true) {
    const part = parts[parts.length - 1]
    const closing = part.indexOf('</pre>')
    if (closing !== -1) {
      if (part.slice(closing + 6) !== '') invalid('pre block has trailing content')
      const value = parts.slice(0, -1).concat(part.slice(0, closing)).join('\n')
      if (/<\/?pre\b/i.test(value) || value.includes('%%')) invalid('embedded markup in pre block')
      return { value, next: index + 1 }
    }
    if (/<\/?pre\b/i.test(part) || part.includes('%%')) invalid('unterminated pre block')
    index += 1
    if (index >= lines.length) invalid('unterminated pre block')
    parts.push(lines[index])
  }
}

function isObject (value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasOnlyKeys (value, keys) {
  return Object.keys(value).length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key))
}

function validRect (value) {
  if (!isObject(value) || !hasOnlyKeys(value, ['origin', 'size'])) return false
  if (!isObject(value.origin) || !hasOnlyKeys(value.origin, ['x', 'y'])) return false
  if (!isObject(value.size) || !hasOnlyKeys(value.size, ['width', 'height'])) return false
  return validGeometry(value)
}

function readGeometry (line, name) {
  const match = line.match(new RegExp(`^%% annotation-${name}: (.+) %%$`))
  if (!match) invalid(`malformed ${name} geometry`)

  let value
  try {
    value = JSON.parse(match[1])
  } catch {
    invalid(`malformed ${name} geometry`)
  }

  if (name === 'rect') {
    if (!validRect(value)) invalid('invalid rect geometry')
  } else if (!Array.isArray(value) || value.length === 0 || value.some(rect => !validRect(rect))) {
    invalid('invalid segment geometry')
  }
  return value
}

function parseLegacy (text) {
  if (typeof text !== 'string') throw new TypeError('Legacy annotation Markdown must be a string')
  if (Buffer.byteLength(text, 'utf8') > MAX_INPUT_BYTES) invalid('input exceeds 1 MiB')

  const normalized = text.replace(/\r\n/g, '\n')
  if (normalized.includes('\r')) invalid('unsupported line ending')
  const lines = normalized.split('\n')
  if (!/^\|\s*Field\s*\|\s*Value\s*\|\s*$/i.test(lines[0]) || !/^\|\s*-{3,}\s*\|\s*-{3,}\s*\|\s*$/.test(lines[1])) invalid('malformed metadata table')

  const title = readMetadata(lines[2] || '', 'Title')
  const source = readMetadata(lines[3] || '', 'URL')
  readMetadata(lines[4] || '', 'Tags')
  if (lines[5] !== '' || lines[6] !== '## Annotations' || lines[7] !== '') invalid('malformed annotation heading')

  const annotations = []
  const ids = new Set()
  let index = 8
  while (index < lines.length) {
    if (lines[index] === '') {
      index += 1
      continue
    }
    if (!lines[index].startsWith('%% annotation: ')) invalid('stray or unrecognized content')

    const marker = parseMarker(lines[index])
    if (ids.has(marker.uid)) invalid(`duplicate annotation ID: ${marker.uid}`)
    ids.add(marker.uid)
    index += 1

    const pre = []
    for (let count = 0; count < 3; count++) {
      const result = readPre(lines, index)
      pre.push(result.value)
      index = result.next
    }

    let rect
    let segmentRects
    while (lines[index] === '') index += 1
    while (index < lines.length) {
      if (lines[index].startsWith('%% annotation-rect: ')) {
        if (marker.sourceType !== 'pdf') invalid('unexpected rect geometry')
        const value = readGeometry(lines[index], 'rect')
        if (rect !== undefined && JSON.stringify(rect) !== JSON.stringify(value)) invalid('conflicting rect geometry')
        rect = value
        index += 1
      } else if (lines[index].startsWith('%% annotation-segments: ')) {
        if (marker.sourceType !== 'pdf') invalid('unexpected segment geometry')
        const value = readGeometry(lines[index], 'segments')
        if (segmentRects !== undefined && JSON.stringify(segmentRects) !== JSON.stringify(value)) invalid('conflicting segment geometry')
        segmentRects = value
        index += 1
      } else {
        break
      }
    }

    const noteLines = []
    while (index < lines.length && !lines[index].startsWith('%% annotation: ')) {
      const line = lines[index]
      if (line.includes('%% annotation:') || line.includes('%%') || /<\/?pre\b/i.test(line)) {
        invalid('embedded or unrecognized annotation content')
      }
      noteLines.push(line)
      index += 1
    }

    const data = {
      color: marker.color,
      notes: noteLines.join('\n').trim(),
      text: pre[1],
      textBefore: pre[0],
      textAfter: pre[2]
    }
    if (marker.sourceType === 'pdf') {
      data.pageIndex = marker.pageIndex
      if (rect !== undefined) data.rect = rect
      if (segmentRects !== undefined) data.segmentRects = segmentRects
    }
    annotations.push({ uid: marker.uid, sourceType: marker.sourceType, data })
  }

  return { source, title, annotations }
}

module.exports = parseLegacy
module.exports.parseLegacy = parseLegacy
