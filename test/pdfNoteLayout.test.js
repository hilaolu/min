/* global structuredClone */
const test = require('node:test')
const assert = require('node:assert/strict')
const layout = require('../pages/pdfViewer/noteLayout.js')

const short = { origin: { x: 10, y: 20 }, size: { width: 220, height: 23 } }
const long = { origin: { x: 10, y: 15 }, size: { width: 220, height: 100 } }

test('automatic PDF notes grow and shrink after edits', () => {
  const first = layout(short)
  const grown = layout(long, first, first.rect)
  assert.deepEqual(grown.rect, long)
  assert.deepEqual(layout(short, grown, grown.rect).rect, short)
})

test('moving a PDF note preserves position but still sizes edited text', () => {
  const first = layout(short)
  const moved = { origin: { x: 80, y: 90 }, size: { ...short.size } }
  const grown = layout(long, first, moved)
  assert.deepEqual(grown.rect, { origin: moved.origin, size: long.size })
  assert.deepEqual(layout(short, grown, grown.rect).rect, moved)
})

test('manual PDF note size persists across multiple edits, only within the session', () => {
  const first = layout(short)
  const resized = { origin: { x: 80, y: 90 }, size: { width: 150, height: 60 } }
  const edited = layout(long, first, resized)
  assert.deepEqual(edited.rect, resized)
  assert.deepEqual(layout(short, edited, edited.rect).rect, resized)
  assert.deepEqual(layout(long).rect, long)
})

test('PDF layout snapshots do not alias input geometry', () => {
  const automatic = structuredClone(short)
  const first = layout(automatic)
  automatic.size.height = 999
  assert.equal(first.rect.size.height, 23)
  const current = structuredClone(first.rect)
  const next = layout(long, first, current)
  current.origin.x = 999
  assert.equal(next.rect.origin.x, 10)
})

test('PDF notes retain manual layout if the backend rectangle is temporarily unavailable', () => {
  const first = layout(short)
  const current = { origin: { x: 80, y: 90 }, size: { width: 150, height: 60 } }
  const edited = layout(long, first, current)
  assert.deepEqual(layout(short, edited).rect, current)
  current.size.height = 999
  assert.equal(edited.rect.size.height, 60)
})
