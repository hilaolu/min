const parseLegacy = require('./annotationLegacy.js')

const maximumBytes = 1024 * 1024
const tableHeader = '| Field | Value |\n| --- | --- |\n'

function malformed () {
  throw new Error('Malformed annotation Markdown')
}

function unsafe () {
  throw new Error('Unsafe annotation Markdown content')
}

function tableValue (value, allowPipes = true) {
  if (typeof value !== 'string' || !value || /[\r\n]/.test(value)) unsafe()
  if (!allowPipes && value.includes('|')) unsafe()
  return allowPipes ? value.replace(/\|/g, '\\|') : value
}

function annotationText (value, notes = false) {
  if (typeof value !== 'string' || value.includes('\r') || value.includes('%%') || /<\/?pre\b/i.test(value)) unsafe()
  // Plugin readers trim the raw notes surrounding an annotation block. Refuse
  // input that they could not round trip rather than silently changing it.
  if (notes && value && value !== value.trim()) unsafe()
  return value
}

function stringify (record) {
  if (!record || record.version !== 1 || typeof record.source !== 'string' || !Array.isArray(record.annotations)) malformed()

  const source = tableValue(record.source)
  const title = tableValue(record.title === undefined || record.title === '' ? record.source : record.title)
  const tags = tableValue(record.tags === undefined || record.tags === '' ? '#annotation' : record.tags, false)
  const chunks = []
  let bytes = 0
  const append = value => {
    bytes += Buffer.byteLength(value)
    if (bytes > maximumBytes) throw new Error('Annotation size limit exceeded')
    chunks.push(value)
  }

  append(tableHeader)
  append(`| Title | ${title} |\n`)
  append(`| URL | ${source} |\n`)
  append(`| Tags | ${tags} |\n\n`)
  append('## Annotations\n\n')

  const ids = new Set()
  for (const annotation of record.annotations) {
    if (!annotation || !/^[A-Za-z0-9-]+$/.test(annotation.uid || '') || ids.has(annotation.uid) || !['webpage', 'pdf'].includes(annotation.sourceType) || !annotation.data) malformed()
    ids.add(annotation.uid)
    const data = annotation.data
    if (!/^#[0-9a-f]{6}$/i.test(data.color || '')) malformed()
    const before = annotationText(data.textBefore)
    const text = annotationText(data.text)
    const after = annotationText(data.textAfter)
    const notes = annotationText(data.notes, true)
    const color = data.color.slice(1)

    if (annotation.sourceType === 'pdf') {
      if (!Number.isSafeInteger(data.pageIndex) || data.pageIndex < 0) malformed()
      append(`%% annotation: ${annotation.uid} | color: ${color} | sourceType: pdf | pageIndex: ${data.pageIndex} %%\n`)
    } else {
      append(`%% annotation: ${annotation.uid} | color: ${color} %%\n`)
    }
    append(`<pre>${before}</pre>\n<pre>${text}</pre>\n<pre>${after}</pre>\n\n`)

    if (annotation.sourceType === 'pdf') {
      if (data.rect !== undefined) append(`%% annotation-rect: ${JSON.stringify(data.rect)} %%\n`)
      if (data.segmentRects !== undefined) append(`%% annotation-segments: ${JSON.stringify(data.segmentRects)} %%\n`)
    }
    if (notes) append(`${notes}\n\n`)
  }

  const result = chunks.join('')
  // Keep the writer and the strict plugin-format reader in lockstep, including
  // geometry validation and delimiter handling.
  parseLegacy(result)
  return result
}

function parse (text) {
  if (typeof text !== 'string' || !isMarkdown(text)) malformed()
  const parsed = parseLegacy(text)
  return { version: 1, ...parsed }
}

function isMarkdown (text) {
  return typeof text === 'string' && /^\|\s*Field\s*\|\s*Value\s*\|\r?\n\|\s*-{3,}\s*\|\s*-{3,}\s*\|\r?\n/i.test(text)
}

module.exports = { stringify, parse, isMarkdown }
