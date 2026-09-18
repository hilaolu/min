/* global Response */
/* eslint-disable standard/no-callback-literal */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { app, BrowserWindow, session, protocol, net, nativeImage, webContents } = require('electron')
const createProtocol = require('../main/minInternalProtocol.js')
const createAccess = require('../main/vaultAccess.js')
const createUA = require('../main/UASwitcher.js')
const createFiltering = require('../main/filtering.js')
const { resolveNoteReference } = require('../js/util/vaultURL.js')

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'min-vault-electron-'))
app.disableHardwareAcceleration()
app.setPath('userData', path.join(temporary, 'profile'))
const bundle = createProtocol({ net, path, protocol, rootDir: path.resolve(__dirname, '..'), Response })
const root = path.join(temporary, 'vault')
const access = createAccess({ getRoot: () => root })
const settings = {
  get: () => null,
  listen: (key, callback) => callback({ blockingLevel: 0, contentTypes: [], exceptionDomains: [] })
}
const windows = []
const deadline = setTimeout(() => { console.error('Vault integration timeout'); app.exit(1) }, 45000)

async function run () {
  await app.whenReady()
  console.log('Runtime:', JSON.stringify(process.versions))
  const ua = createUA({ app, settings, vault: access })
  const filtering = createFiltering({ app, fs, path, rootDir: path.resolve(__dirname, '..'), settings, webContents })
  fs.mkdirSync(path.join(root, 'Projects/images'), { recursive: true })
  fs.mkdirSync(path.join(root, 'assets'))
  const bitmap = Buffer.alloc(4 * 4 * 4, 255)
  const image = nativeImage.createFromBitmap(bitmap, { width: 4, height: 4 })
  const jpeg = image.toJPEG(90)
  fs.writeFileSync(path.join(root, 'test.jpg'), jpeg)
  fs.writeFileSync(path.join(root, 'Projects/images/detail.jpg'), jpeg)
  fs.writeFileSync(path.join(root, 'assets/shared.png'), image.toPNG())
  fs.writeFileSync(path.join(root, 'Projects/note.md'), '# original source')
  const pageURL = 'min://app/test/vaultFixture.html'
  const source = 'vault://local/Projects/note.md'
  for (const partition of ['persist:vault-integration', 'vault-private-integration']) {
    const ses = session.fromPartition(partition)
    bundle.install(ses)
    access.install(ses)
    access.install(ses)
    filtering.install(ses)
    ua.install(ses)
    const win = new BrowserWindow({ show: false, webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false } })
    windows.push(win)
    win.webContents.on('console-message', (event) => console.log('renderer:', event.message))
    access.associate(win.webContents, { url: source, pageURL, kind: 'markdown' })
    await win.loadURL(pageURL)
    for (const url of ['vault://local/test.jpg', 'vault://test.jpg']) {
      const result = await win.webContents.executeJavaScript(`fetch(${JSON.stringify(url)}, {credentials: 'omit'}).then(async r => ({status:r.status, mime:r.headers.get('content-type'), bytes:Array.from(new Uint8Array(await r.arrayBuffer()))}))`)
      assert.equal(result.status, 200)
      assert.equal(result.mime, 'image/jpeg')
      assert.deepEqual(Buffer.from(result.bytes), jpeg)
    }
    const references = ['images/detail.jpg', '../assets/shared.png', '/test.jpg', 'vault://local/test.jpg', 'vault://test.jpg']
    const urls = references.map(reference => resolveNoteReference(reference, source))
    const dimensions = await win.webContents.executeJavaScript(`Promise.all(${JSON.stringify(urls)}.map(url => new Promise(resolve => { const image = new Image(); image.onload = () => resolve([image.complete, image.naturalWidth, image.naturalHeight, image.src]); image.onerror = () => resolve([false, 0, 0, image.src]); image.src = url; document.body.append(image) })))`)
    for (const [complete, width, height, url] of dimensions) {
      assert.ok(complete && width > 0 && height > 0, url)
      assert.ok(url.startsWith('vault://local/'))
    }
    const raw = await win.webContents.executeJavaScript(`fetch('${source}').then(r => r.text())`)
    assert.equal(raw, '# original source')
    const range = await win.webContents.executeJavaScript("fetch('vault://test.jpg', {headers:{Range:'bytes=1-3'}}).then(async r => ({status:r.status, range:r.headers.get('content-range'), bytes:Array.from(new Uint8Array(await r.arrayBuffer()))}))")
    assert.equal(range.status, 206)
    assert.deepEqual(Buffer.from(range.bytes), jpeg.subarray(1, 4))
    assert.equal(range.range, `bytes 1-3/${jpeg.length}`)
    const child = await win.webContents.executeJavaScript(`new Promise(resolve => {
      const frame = document.createElement('iframe'); frame.src = '${pageURL}';
      frame.onload = async () => { try { resolve(await frame.contentWindow.fetch('vault://test.jpg').then(r => r.status)) } catch (_) { resolve('blocked') } };
      document.body.append(frame)
    })`)
    assert.ok(child === 403 || child === 'blocked', 'child frames have no read authority')
    access.revoke(win.webContents)
    const denied = await win.webContents.executeJavaScript("fetch('vault://test.jpg').then(r => r.status).catch(() => 'blocked')")
    assert.ok(denied === 403 || denied === 'blocked')
    for (const untrustedURL of ['file://' + path.join(__dirname, 'vaultFixture.html'), 'data:text/html,<title>untrusted</title>']) {
      await win.loadURL(untrustedURL)
      const untrusted = await win.webContents.executeJavaScript(`Promise.all([
        fetch('vault://test.jpg').then(r => r.status).catch(() => 'blocked'),
        new Promise(resolve => {const image = new Image(); image.onload = () => resolve('loaded'); image.onerror = () => resolve('blocked'); image.src = 'vault://test.jpg'; document.body.append(image)})
      ])`)
      assert.ok(untrusted[0] === 403 || untrusted[0] === 'blocked')
      assert.equal(untrusted[1], 'blocked', 'an untrusted image embed must not load')
    }
    access.associate(win.webContents, { url: 'vault://test.jpg' })
    await win.loadURL('vault://test.jpg')
    const direct = await win.webContents.executeJavaScript('Array.from(document.images).map(image => [image.complete, image.naturalWidth])')
    assert.ok(direct.length && direct.every(([complete, width]) => complete && width > 0))
    console.log('PASS', partition, 'JPEG bytes/MIME; five resolved images; raw Markdown; range; denied child/file/data callers and embeds; direct image')
  }
  filtering.destroy()
}

async function finish () {
  let code = 0
  try {
    await run()
    console.log('PASS vault transport integration (not Cherry/PDF/lifecycle acceptance)')
  } catch (error) {
    console.error(error)
    code = 1
  }
  clearTimeout(deadline)
  for (const win of windows) if (!win.isDestroyed()) win.destroy()
  fs.rmSync(temporary, { recursive: true, force: true })
  app.exit(code)
}
finish()
