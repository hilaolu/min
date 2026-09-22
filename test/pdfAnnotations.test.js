const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { installPdfAnnotations } = require('../main/pdfAnnotations.js')

const source = 'https://example.com/document.pdf'

function profile (t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'min-pdf-annotations-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

function annotation (uid = 'pdf-id') {
  return {
    uid,
    sourceType: 'pdf',
    data: {
      color: '#ffeb3b',
      text: 'selected',
      notes: 'note',
      textBefore: 'before',
      textAfter: 'after',
      pageIndex: 1,
      rect: { origin: { x: 1, y: 2 }, size: { width: 3, height: 4 } },
      segmentRects: [{ origin: { x: 1, y: 2 }, size: { width: 3, height: 4 } }]
    }
  }
}

function legacy (pdfSource) {
  return `| Field | Value |
| --- | --- |
| Title | A PDF |
| URL | ${pdfSource} |
| Tags | #annotation |

## Annotations

%% annotation: imported | color: #ffeb3b | sourceType: pdf | pageIndex: 1 %%
<pre>before</pre>
<pre>selected</pre>
<pre>after</pre>
%% annotation-rect: {"origin":{"x":1,"y":2},"size":{"width":3,"height":4}} %%
%% annotation-segments: [{"origin":{"x":1,"y":2},"size":{"width":3,"height":4}}] %%

note
`
}

function harness (t, context, sender = {}) {
  const handlers = new Map()
  installPdfAnnotations({
    ipc: { handle: (name, handler) => handlers.set(name, handler) },
    context
  })
  t.after(() => handlers.clear())
  return { handler: handlers.get('pdf-annotations'), sender }
}

function contextFor (root, value = {}) {
  return () => ({ root, source, generation: 1, ...value })
}

test('IPC fake context loads and saves annotations for the current PDF', async t => {
  const root = profile(t)
  const sender = { session: { isPersistent: () => true } }
  const { handler } = harness(t, contextFor(root), sender)
  const event = { sender }

  assert.deepEqual(await handler(event, 'load'), { ok: true, revision: null, annotations: [] })
  const saved = await handler(event, 'save', { revision: null, annotations: [annotation()] })
  assert.equal(saved.ok, true)
  assert.deepEqual((await handler(event, 'load')).annotations, [annotation()])
})

test('denies private sessions and callers without a configured root', async t => {
  const root = profile(t)
  const privateSender = { session: { isPersistent: () => false } }
  const privateHarness = harness(t, contextFor(root), privateSender)
  assert.deepEqual(await privateHarness.handler({ sender: privateSender }, 'load'), {
    ok: false,
    error: 'Vault annotations are disabled in private tabs'
  })

  const sender = { session: { isPersistent: () => true } }
  const missingRoot = harness(t, contextFor(null), sender)
  assert.deepEqual(await missingRoot.handler({ sender }, 'load'), {
    ok: false,
    error: 'Configure a vault in Settings to save annotations'
  })
})

test('turns frame and context authority failures into IPC errors', async t => {
  const sender = { session: { isPersistent: () => true }, mainFrame: {} }
  const event = { sender, senderFrame: {} }
  const frameError = harness(t, () => {
    if (event.senderFrame !== event.sender.mainFrame) throw new Error('Annotation caller denied')
    return { root: profile(t), source, generation: 1 }
  }, sender)
  assert.deepEqual(await frameError.handler(event, 'load'), { ok: false, error: 'Annotation caller denied' })

  const contextError = harness(t, () => { throw new Error('bad annotation context') }, sender)
  assert.deepEqual(await contextError.handler({ sender }, 'load'), { ok: false, error: 'bad annotation context' })
})

test('rejects legacy imports whose source is not the current PDF', async t => {
  const root = profile(t)
  const sender = { session: { isPersistent: () => true } }
  const { handler } = harness(t, contextFor(root), sender)
  await handler({ sender }, 'load')
  const result = await handler({ sender }, 'import', legacy('https://other.example/document.pdf'))
  assert.deepEqual(result, { ok: false, error: 'Legacy annotation URL does not match this PDF' })
  assert.equal(fs.existsSync(path.join(root, 'Annotations')), false)
})

test('rejects a stale context observed after an asynchronous load', async t => {
  const root = profile(t)
  const sender = { session: { isPersistent: () => true } }
  let calls = 0
  const { handler } = harness(t, () => {
    calls += 1
    return { root, source, generation: calls === 1 ? 1 : 2 }
  }, sender)

  const result = await handler({ sender }, 'load')
  assert.deepEqual(result, { ok: false, error: 'Document or vault changed' })
  assert.ok(calls >= 2)
})

test('save requires a load binding and cannot cross root generations', async t => {
  const root = profile(t)
  const sender = { session: { isPersistent: () => true } }
  let generation = 1
  const { handler } = harness(t, () => ({ root, source, generation }), sender)
  const payload = { revision: null, annotations: [annotation()] }
  assert.equal((await handler({ sender }, 'save', payload)).ok, false)
  assert.equal((await handler({ sender }, 'load')).ok, true)
  generation++
  assert.match((await handler({ sender }, 'save', payload)).error, /Reload annotations/)
  assert.equal(fs.existsSync(path.join(root, 'Annotations')), false)
})

test('local PDF read is source-bound, validates PDF bytes and works privately without a vault', async t => {
  const root = profile(t)
  const file = path.join(root, 'document.pdf')
  fs.writeFileSync(file, '%PDF-1.4\nfixture')
  const sender = { session: { isPersistent: () => false } }
  let pdfSource = require('url').pathToFileURL(file).href
  const { handler } = harness(t, () => ({ root: null, source: pdfSource, generation: 1 }), sender)
  const result = await handler({ sender }, 'read-file', { path: '/not/used' })
  assert.equal(result.ok, true)
  assert.equal(Buffer.from(result.bytes).toString(), '%PDF-1.4\nfixture')
  fs.writeFileSync(file, 'private text, not a PDF')
  assert.match((await handler({ sender }, 'read-file')).error, /Not a PDF/)
  pdfSource = 'https://example.com/document.pdf'
  assert.match((await handler({ sender }, 'read-file')).error, /Not a local PDF/)
  assert.equal(fs.existsSync(path.join(root, 'Annotations')), false)
})

test('versioned backup JSON imports losslessly without writing before confirmation', async t => {
  const root = profile(t)
  const sender = { session: { isPersistent: () => true } }
  const { handler } = harness(t, contextFor(root), sender)
  await handler({ sender }, 'load')
  const backup = { version: 1, source, annotations: [annotation()] }
  assert.deepEqual(await handler({ sender }, 'import', JSON.stringify(backup)), { ok: true, annotations: [annotation()] })
  backup.version = 2
  assert.equal((await handler({ sender }, 'import', JSON.stringify(backup))).ok, false)
  assert.equal(fs.existsSync(path.join(root, 'Annotations')), false)
})
