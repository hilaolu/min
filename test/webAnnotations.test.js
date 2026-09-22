const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { installPdfAnnotations } = require('../main/pdfAnnotations.js')
const { discover } = require('../main/annotatedResourceSearch.js')

test('web annotations persist, are discoverable, reject stale writes and retain deletion snapshots', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'min-web-annotations-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  let source = 'https://example.com/article'
  let handler
  installPdfAnnotations({
    sourceType: 'webpage',
    ipc: { handle: (name, callback) => { assert.equal(name, 'web-annotations'); handler = callback } },
    context: () => ({ root, source, title: 'Web article', generation: 1 })
  })
  const event = { sender: { session: { isPersistent: () => true } }, senderFrame: {} }
  const annotation = { uid: 'web-id', sourceType: 'webpage', data: { color: '#ffcd45', text: 'quote', notes: '<script>not HTML</script>', textBefore: 'before', textAfter: 'after' } }
  assert.equal((await handler(event, 'save', { revision: null, annotations: [annotation] })).ok, false)
  assert.equal((await handler(event, 'load')).ok, true)
  const saved = await handler(event, 'save', { revision: null, annotations: [annotation] })
  assert.equal(saved.ok, true)
  assert.deepEqual((await handler(event, 'load')).annotations, [annotation])
  const found = await discover(root)
  assert.equal(found.resources[0].sourceType, 'webpage')
  assert.equal(found.resources[0].title, 'Web article')
  const markdown = fs.readFileSync(path.join(root, 'Archives/Annotations/example.com/%2Farticle.md'), 'utf8')
  assert.match(markdown, /\| Title \| Web article \|/)
  assert.match(markdown, /%% annotation: web-id \| color: ffcd45 %%/)
  assert.doesNotMatch(markdown, /min-annotation|sourceType: pdf/)
  assert.deepEqual(found.resources[0].annotations, [annotation])
  assert.equal((await handler(event, 'save', { revision: null, annotations: [] })).ok, false)
  source = 'https://example.com/other'
  assert.equal((await handler(event, 'save', { revision: saved.revision, annotations: [] })).ok, false)
  source = 'https://example.com/article'
  assert.equal((await handler(event, 'save', { revision: saved.revision, annotations: [] })).ok, true)
  assert.deepEqual((await handler(event, 'load')).annotations, [])
  assert.deepEqual((await discover(root)).resources, [])
  assert.equal((await handler(event, 'read-file')).ok, false)
  event.sender.session.isPersistent = () => false
  assert.equal((await handler(event, 'load')).ok, false)
})
