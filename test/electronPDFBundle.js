/* global Response */
// Run after buildPDFViewer. Optional --app-root=packaged/resources/app argument.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { app, BrowserWindow, session, protocol, net } = require('electron')
const createProtocol = require('../main/minInternalProtocol.js')

const rootArgument = process.argv.find(arg => arg.startsWith('--app-root='))
const rootDir = path.resolve(rootArgument ? rootArgument.slice('--app-root='.length) : path.join(__dirname, '..'))
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'min-pdf-bundle-'))
app.setPath('userData', path.join(temp, 'profile'))
app.disableHardwareAcceleration()
const bundle = createProtocol({ net, path, protocol, rootDir, Response })
let win
const unexpected = []
const deadline = setTimeout(() => finish(new Error('PDF bundle smoke timeout')), 60000)

function fixture () {
  const stream = '0 0 1 rg 20 20 100 100 re f\n0 0 0 rg BT /F1 12 Tf 20 160 Td (Highlight this text) Tj ET\n'
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>', `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
  let text = '%PDF-1.4\n'
  const offsets = []
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(text)); text += `${i + 1} 0 obj\n${object}\nendobj\n` })
  const xref = Buffer.byteLength(text)
  text += 'xref\n0 6\n0000000000 65535 f \n' + offsets.map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('')
  return text + `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
}

async function until (script) {
  for (let i = 0; i < 400; i++) {
    if (await win.webContents.executeJavaScript(script)) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error('PDF not ready: ' + await win.webContents.executeJavaScript('document.getElementById("status").textContent'))
}

async function run () {
  // Only the file-reading bridge is stubbed; rendering/search use real bundled PDFium.
  fs.writeFileSync(path.join(temp, 'preload.js'), `
    require('electron').contextBridge.exposeInMainWorld('pdfAnnotations', {
      readFile: async () => ({ ok: true, bytes: new Uint8Array(${JSON.stringify([...Buffer.from(fixture())])}) }),
      load: async () => ({ ok: false, error: 'Read-only smoke test' })
    })
  `)
  await app.whenReady()
  bundle.install(session.defaultSession)
  session.defaultSession.webRequest.onBeforeRequest((details, respond) => {
    const blocked = /^https?:/.test(details.url) || details.url.includes('/node_modules/')
    if (blocked) unexpected.push(details.url)
    respond({ cancel: blocked })
  })
  win = new BrowserWindow({ show: false, width: 1000, height: 800, webPreferences: { preload: path.join(temp, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } })
  await win.loadURL('min://app/pages/pdfViewer/index.html?url=file:///fixture.pdf')
  await until("document.body.dataset.pdfReady === 'true'")
  const chrome = await win.webContents.executeJavaScript(`(() => {
    const bounds = document.getElementById('viewer').getBoundingClientRect()
    return {
      hasFooter: Boolean(document.querySelector('footer')),
      removedControls: ['import', 'export', 'download', 'highlight'].filter(id => document.getElementById(id)),
      viewerTop: bounds.top,
      viewerHeight: bounds.height,
      windowHeight: window.innerHeight,
      hasAnnotationEditor: Boolean(document.getElementById('annotation-editor'))
    }
  })()`)
  assert.equal(chrome.hasFooter, false, 'viewer has no footer')
  assert.deepEqual(chrome.removedControls, [], 'removed PDF controls are absent')
  assert.equal(chrome.viewerTop, 0, 'viewer starts at the top of the window')
  assert.equal(chrome.viewerHeight, chrome.windowHeight, 'viewer fills the window height')
  assert.equal(chrome.hasAnnotationEditor, true, 'annotation editor remains available')
  assert.equal(await win.webContents.executeJavaScript("document.getElementById('viewer-message').hidden"), false, 'annotation load errors remain visible without a footer')
  assert.match(await win.webContents.executeJavaScript("document.getElementById('status').textContent"), /Read-only smoke test/)
  assert.equal(await win.webContents.executeJavaScript("document.getElementById('retry').hidden"), true, 'read-only errors do not offer a save retry')
  const download = await win.webContents.executeJavaScript(`new Promise(resolve => {
    function onMessage (event) {
      if (event.source !== window || event.data?.message !== 'downloadFile') return
      window.removeEventListener('message', onMessage)
      resolve(event.data)
    }
    window.addEventListener('message', onMessage)
    window.parentProcessActions.downloadPDF()
  })`)
  assert.deepEqual(download, { message: 'downloadFile', url: 'file:///fixture.pdf' }, 'browser download command works without a footer button')
  await until(`Array.from(document.querySelector('embedpdf-container').shadowRoot.querySelectorAll('img')).some(img => {
    if (!img.complete || !img.naturalWidth) return false
    const canvas = document.createElement('canvas'); canvas.width = img.naturalWidth; canvas.height = img.naturalHeight
    const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0)
    return ctx.getImageData(0, 0, canvas.width, canvas.height).data.some((v, i, d) => i % 4 === 2 && v > d[i - 2])
  })`)
  const result = await win.webContents.executeJavaScript("window.parentProcessActions.findPDF('Highlight')")
  assert.equal(result.matches, 1, 'bundled PDFium searches real PDF text')
  assert.deepEqual(unexpected, [], 'viewer needs no network or original npm packages')
  console.log('PDF bundle smoke passed: offline rendering and text search; root=' + rootDir)
}

function finish (error) {
  clearTimeout(deadline)
  if (error) console.error(error)
  if (win) win.destroy()
  fs.rmSync(temp, { recursive: true, force: true })
  app.exit(error ? 1 : 0)
}

run().then(() => finish(), finish)
