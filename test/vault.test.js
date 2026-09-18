/* global Request */
const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { parseVaultURL, resolveNoteReference } = require('../js/util/vaultURL.js')
const { canonicalRoot, resolveVaultURL } = require('../main/vault.js')
const { serveVaultResource } = require('../main/vaultProtocol.js')
const createAccess = require('../main/vaultAccess.js')
const { EventEmitter } = require('node:events')

test('canonical vault URLs, shorthand and preview-only reference resolution', () => {
  assert.equal(parseVaultURL('vault://test.jpg').vaultURL, 'vault://local/test.jpg')
  assert.equal(parseVaultURL('vault://local/%252e%20%E9%9B%AA%23.md?q=1#x').segments[0], '%2e 雪#.md')
  const base = 'vault://local/Projects/note.md'
  for (const [reference, result] of [
    ['images/detail.jpg', 'Projects/images/detail.jpg'],
    ['../assets/shared.png', 'assets/shared.png'],
    ['/test.jpg', 'test.jpg'],
    ['vault://local/test.jpg', 'test.jpg'],
    ['vault://test.jpg', 'test.jpg']
  ]) assert.equal(resolveNoteReference(reference, base), 'vault://local/' + result)
  for (const reference of ['../../outside', 'javascript:alert(1)', '//evil/x', '..\\outside']) {
    assert.throws(() => resolveNoteReference(reference, base))
  }
  for (const url of ['vault://host/path', 'vault://local:12/a', 'vault://x@local/a', 'vault://local/a%2fb', 'vault://local/a%5cb', 'vault://local/%00', 'vault://local/%zz', 'vault://local/C%3a', 'vault://local/CON']) {
    assert.throws(() => parseVaultURL(url), url)
  }
})

test('confined raw response bytes, methods, ranges and errors', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'min-vault-unit-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 42, 128, 0xff, 0xd9])
  await fs.writeFile(path.join(root, 'test.jpg'), bytes)
  await fs.writeFile(path.join(root, 'note.md'), '# source\n![image](test.jpg)')
  await fs.writeFile(path.join(root, 'unknown.bin'), bytes)
  await fs.writeFile(path.join(root, 'empty'), '')
  await fs.symlink(os.tmpdir(), path.join(root, 'escape'))
  assert.equal(await canonicalRoot(root), root)
  assert.equal((await resolveVaultURL('vault://local/note.md', root)).kind, 'markdown')
  async function request (url = 'vault://local/test.jpg', method = 'GET', range, approvedRoot = root) {
    return serveVaultResource(new Request(url, { method, headers: range ? { Range: range } : {} }), approvedRoot)
  }
  for (const url of ['vault://local/test.jpg', 'vault://test.jpg']) {
    const response = await request(url)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'image/jpeg')
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal(response.headers.get('location'), null)
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes)
  }
  const head = await request(undefined, 'HEAD', 'bytes=0-2')
  assert.equal(head.headers.get('content-length'), String(bytes.length))
  assert.equal((await head.arrayBuffer()).byteLength, 0)
  for (const [range, start, end] of [['bytes=1-3', 1, 4], ['bytes=3-', 3, 9], ['bytes=-2', 7, 9]]) {
    const response = await request(undefined, 'GET', range)
    assert.equal(response.status, 206)
    assert.equal(response.headers.get('content-range'), `bytes ${start}-${end - 1}/9`)
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes.subarray(start, end))
  }
  const unsatisfiable = await request(undefined, 'GET', 'bytes=20-')
  assert.equal(unsatisfiable.status, 416)
  assert.equal(unsatisfiable.headers.get('content-range'), 'bytes */9')
  assert.equal((await request(undefined, 'GET', 'bytes=3-1')).status, 400)
  assert.equal((await request(undefined, 'GET', 'bytes=0-1,3-4')).status, 200)
  assert.equal((await request(undefined, 'POST')).status, 405)
  assert.equal((await request(undefined, 'OPTIONS')).status, 204)
  assert.equal((await request('vault://local/')).status, 409)
  assert.equal((await request('vault://local/missing')).status, 404)
  assert.equal((await request('vault://local/escape/secret')).status, 403)
  assert.equal((await request('vault://local/a%2fb')).status, 400)
  assert.equal((await request(undefined, 'GET', null, null)).status, 503)
  assert.equal((await serveVaultResource(new Request('vault://local/test.jpg'))).status, 403)
  assert.equal((await request('vault://local/unknown.bin')).headers.get('content-type'), 'application/octet-stream')
  assert.equal(await (await request('vault://local/note.md')).text(), '# source\n![image](test.jpg)')
  assert.equal((await request('vault://local/empty')).status, 200)
  const missingHead = await request('vault://local/missing', 'HEAD')
  assert.equal(missingHead.status, 404)
  assert.equal(await missingHead.text(), '')
})

test('request tickets require main-owned top-frame authority and are single-use', async () => {
  let root = null
  const access = createAccess({ getRoot: () => root })
  let handler
  const session = { protocol: { handle: (scheme, fn) => { handler = fn } } }
  access.install(session)
  const contents = Object.assign(new EventEmitter(), {
    id: 12,
    session,
    mainFrame: { url: 'min://app/pages/markdown/index.html' },
    isDestroyed: () => false,
    getURL: () => 'min://app/pages/markdown/index.html'
  })
  const details = {
    webContentsId: 12,
    frame: contents.mainFrame,
    resourceType: 'image',
    url: 'vault://local/test.jpg',
    method: 'GET',
    requestHeaders: { 'x-min-vault-request': 'forged' }
  }
  access.prepareHeaders(details)
  assert.deepEqual(details.requestHeaders, {})
  assert.equal((await handler(new Request(details.url))).status, 403)
  access.associate(contents, { url: 'vault://local/note.md', pageURL: contents.getURL(), kind: 'markdown' })
  access.prepareHeaders({ ...details, frame: { ...contents.mainFrame } })
  assert.deepEqual(details.requestHeaders, {})
  access.prepareHeaders(details)
  const request = new Request(details.url, { headers: details.requestHeaders })
  assert.equal((await handler(request)).status, 503, 'authorized but no root')
  assert.equal((await handler(request)).status, 403, 'ticket cannot be replayed')
  access.prepareHeaders(details)
  root = '/different-root'
  assert.equal((await handler(new Request(details.url, { headers: details.requestHeaders }))).status, 403)
  access.revoke(contents)
  assert.equal(access.hasAssociations(), false)
})

test('large raw files stream in bounded chunks and cancellation closes the descriptor', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'min-vault-stream-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const filename = path.join(root, 'large.bin')
  const file = await fs.open(filename, 'w')
  await file.truncate(256 * 1024 * 1024)
  await file.close()
  const response = await serveVaultResource(new Request('vault://local/large.bin'), root)
  assert.equal(response.headers.get('content-length'), String(256 * 1024 * 1024))
  const reader = response.body.getReader()
  const { value } = await reader.read()
  assert.ok(value.length > 0 && value.length <= 64 * 1024)
  await reader.cancel()
  if (process.platform === 'linux') {
    const openDescriptors = async () => {
      const descriptors = await fs.readdir('/proc/self/fd')
      const paths = await Promise.all(descriptors.map(fd => fs.readlink('/proc/self/fd/' + fd).catch(() => null)))
      return paths.filter(value => value === filename).length
    }
    for (let attempt = 0; attempt < 20 && await openDescriptors(); attempt++) await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(await openDescriptors(), 0)
  }
  const range = await serveVaultResource(new Request('vault://local/large.bin', { headers: { Range: 'bytes=-4' } }), root)
  assert.equal(range.status, 206)
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), Buffer.alloc(4))
})

test('required MIME types preserve binary/source bytes and active documents are sandboxed', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'min-vault-mime-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const types = {
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    pdf: 'application/pdf',
    md: 'text/markdown; charset=utf-8',
    markdown: 'text/markdown; charset=utf-8',
    txt: 'text/plain; charset=utf-8',
    html: 'text/html; charset=utf-8',
    htm: 'text/html; charset=utf-8',
    mp4: 'video/mp4',
    mp3: 'audio/mpeg',
    unknown: 'application/octet-stream'
  }
  const bytes = Buffer.from([0, 128, 255, 13, 10])
  for (const [extension, type] of Object.entries(types)) {
    await fs.writeFile(path.join(root, 'fixture.' + extension), bytes)
    const response = await serveVaultResource(new Request('vault://local/fixture.' + extension), root)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), type)
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes)
    if (['html', 'htm', 'svg'].includes(extension)) assert.ok(response.headers.get('content-security-policy').startsWith('sandbox;'))
  }
})
