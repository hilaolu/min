const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { app, BrowserWindow, contentTracing } = require('electron')

app.commandLine.appendSwitch('disable-gpu')

function waitForPageData (webContents) {
  return new Promise(function (resolve, reject) {
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for extracted page data')), 15000)
    webContents.on('ipc-message', function onMessage (event, channel, data) {
      if (channel !== 'pageData') return
      clearTimeout(timeout)
      webContents.removeListener('ipc-message', onMessage)
      resolve(data)
    })
  })
}

async function run () {
  await app.whenReady()
  await contentTracing.startRecording({
    included_categories: ['blink', 'renderer.scheduler', 'v8']
  })

  const window = new BrowserWindow({
    height: 600,
    show: false,
    webPreferences: {
      contextIsolation: true,
      preload: path.resolve(__dirname, '../dist/preload.js'),
      sandbox: true
    },
    width: 800
  })
  const pageDataPromise = waitForPageData(window.webContents)
  await window.loadFile(path.resolve(__dirname, 'fixtures/performancePage.html'))
  const pageData = await pageDataPromise
  const layout = await window.webContents.executeJavaScript(`({
    paragraphs: document.querySelectorAll('p').length,
    mainDisplay: getComputedStyle(document.querySelector('main')).display,
    mainVisibility: getComputedStyle(document.querySelector('main')).visibility,
    mainWidth: document.querySelector('main').offsetWidth
  })`)

  assert.ok(
    pageData.extractedText.includes('item 0 alpha beta'),
    `unexpected extraction prefix: ${pageData.extractedText.slice(0, 120)}; layout: ${JSON.stringify(layout)}`
  )
  assert.equal(pageData.extractedText.includes('ignored footer text'), false)
  assert.ok(pageData.extractedText.length <= 300000)

  const sourceImage = await window.webContents.capturePage()
  const preview = sourceImage.resize({ width: 160, height: 120, quality: 'good' })
  assert.deepEqual(preview.getSize(), { width: 160, height: 120 })
  const previewBytes = Buffer.byteLength(preview.toDataURL(), 'utf8')
  assert.ok(previewBytes <= 256 * 1024)

  const tracePath = await contentTracing.stopRecording()
  const traceBytes = fs.statSync(tracePath).size
  fs.unlinkSync(tracePath)
  console.log(JSON.stringify({
    extractedCharacters: pageData.extractedText.length,
    previewBytes,
    previewSize: preview.getSize(),
    traceBytes
  }))
  window.destroy()
  app.quit()
}

run().catch(async function (error) {
  try {
    await contentTracing.stopRecording()
  } catch (traceError) {}
  console.error(error)
  app.exit(1)
})
