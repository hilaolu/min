const maximumBytes = 1024 * 1024
const header = '# PDF annotations\n\n'
const fields = ['textBefore', 'text', 'textAfter', 'notes']

function malformed () {
  throw new Error('Malformed annotation Markdown')
}

function escapedJSON (value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')
}

function objectWithKeys (value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key))
}

function longestBacktickRun (text) {
  let longest = 0
  for (const run of text.match(/`+/g) || []) longest = Math.max(longest, run.length)
  return longest
}

function codeBlock (value, language) {
  const fence = '`'.repeat(Math.max(3, longestBacktickRun(value) + 1))
  return `${fence}${language}\n${value}\n${fence}\n\n`
}

function stringify (record) {
  if (!record || record.version !== 1 || typeof record.source !== 'string' || !Array.isArray(record.annotations)) malformed()
  let text = header + '<!-- min-annotation-source: ' + escapedJSON({ version: 1, source: record.source }) + ' -->\n\n'
  for (const annotation of record.annotations) {
    if (!annotation || typeof annotation.uid !== 'string' || typeof annotation.sourceType !== 'string' || !annotation.data) malformed()
    const data = annotation.data
    const metadata = {
      uid: annotation.uid,
      sourceType: annotation.sourceType,
      color: data.color,
      pageIndex: data.pageIndex,
      rect: data.rect,
      segmentRects: data.segmentRects
    }
    if (fields.some(field => typeof data[field] !== 'string')) malformed()
    text += `## Highlight ${annotation.uid}\n\n`
    text += '<!-- min-annotation: ' + escapedJSON(metadata) + ' -->\n\n'
    for (const field of fields) {
      text += `### ${field}\n\n`
      text += codeBlock(data[field], field === 'notes' ? 'markdown' : 'text')
    }
  }
  if (Buffer.byteLength(text) > maximumBytes) throw new Error('Annotation size limit exceeded')
  return text
}

function parseComment (state, prefix) {
  if (!state.text.startsWith(prefix, state.offset)) malformed()
  const start = state.offset + prefix.length
  const end = state.text.indexOf(' -->\n\n', start)
  if (end < 0) malformed()
  let value
  try { value = JSON.parse(state.text.slice(start, end)) } catch (_) { malformed() }
  state.offset = end + ' -->\n\n'.length
  return value
}

function parseCodeBlock (state, language) {
  const lineEnd = state.text.indexOf('\n', state.offset)
  if (lineEnd < 0) malformed()
  const line = state.text.slice(state.offset, lineEnd)
  const match = line.match(/^(`{3,})(text|markdown)$/)
  if (!match || match[2] !== language) malformed()
  const fence = match[1]
  const start = lineEnd + 1
  const delimiter = '\n' + fence + '\n\n'
  const end = state.text.indexOf(delimiter, start)
  if (end < 0) malformed()
  const value = state.text.slice(start, end)
  if (longestBacktickRun(value) >= fence.length) malformed()
  state.offset = end + delimiter.length
  return value
}

function parse (text) {
  if (typeof text !== 'string') malformed()
  if (Buffer.byteLength(text) > maximumBytes) throw new Error('Annotation size limit exceeded')
  if (!isMarkdown(text)) malformed()
  const state = { text, offset: header.length }
  const sourceMetadata = parseComment(state, '<!-- min-annotation-source: ')
  if (!objectWithKeys(sourceMetadata, ['version', 'source']) || sourceMetadata.version !== 1 || typeof sourceMetadata.source !== 'string') malformed()
  const annotations = []
  while (state.offset < text.length) {
    const heading = '## Highlight '
    if (!text.startsWith(heading, state.offset)) malformed()
    const headingEnd = text.indexOf('\n\n', state.offset + heading.length)
    if (headingEnd < 0) malformed()
    const uid = text.slice(state.offset + heading.length, headingEnd)
    if (!uid) malformed()
    state.offset = headingEnd + 2
    const metadata = parseComment(state, '<!-- min-annotation: ')
    const metadataKeys = ['uid', 'sourceType', 'color', 'pageIndex', 'rect', 'segmentRects']
    if (!objectWithKeys(metadata, metadataKeys) || metadata.uid !== uid) malformed()
    const values = {}
    for (const field of fields) {
      const section = `### ${field}\n\n`
      if (!text.startsWith(section, state.offset)) malformed()
      state.offset += section.length
      values[field] = parseCodeBlock(state, field === 'notes' ? 'markdown' : 'text')
    }
    annotations.push({
      uid: metadata.uid,
      sourceType: metadata.sourceType,
      data: {
        color: metadata.color,
        text: values.text,
        notes: values.notes,
        textBefore: values.textBefore,
        textAfter: values.textAfter,
        pageIndex: metadata.pageIndex,
        rect: metadata.rect,
        segmentRects: metadata.segmentRects
      }
    })
  }
  return { version: 1, source: sourceMetadata.source, annotations }
}

function isMarkdown (text) {
  return typeof text === 'string' && text.startsWith(header)
}

module.exports = { stringify, parse, isMarkdown }
