const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')

const { app, BrowserWindow, contentTracing, session, webContents } = require('electron')
const createFilteringPolicy = require('../main/filtering.js')

const performanceProfilePath = fs.mkdtempSync(path.join(os.tmpdir(), 'min-performance-'))
app.setPath('userData', performanceProfilePath)

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

function createFilterServer () {
  let requestCount = 0
  const server = http.createServer(function (request, response) {
    requestCount++
    if (request.url === '/') {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end('<!doctype html><title>Filtering performance</title>')
      return
    }
    response.writeHead(204)
    response.end()
  })
  return {
    close: () => new Promise(function (resolve, reject) {
      server.close(function (error) {
        if (error) reject(error)
        else resolve()
      })
    }),
    getRequestCount: () => requestCount,
    listen: () => new Promise(function (resolve, reject) {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', function () {
        server.removeListener('error', reject)
        resolve(server.address().port)
      })
    })
  }
}

async function runFilteringWorkload () {
  fs.writeFileSync(path.join(performanceProfilePath, 'customFilters.txt'), 'blocked-resource\n')
  const filterServer = createFilterServer()
  const port = await filterServer.listen()
  const filtering = createFilteringPolicy({
    app,
    fs,
    observePerformance: true,
    path,
    rootDir: path.resolve(__dirname, '..'),
    settings: {
      get: () => 0,
      listen: function (key, listener) {
        listener({ blockingLevel: 2, contentTypes: [], exceptionDomains: [] })
      },
      set: function () {}
    },
    webContents
  })
  const partition = `filter-performance-${Date.now()}`
  const filterSession = session.fromPartition(partition)
  filtering.install(filterSession)
  await filtering.whenReady()

  const window = new BrowserWindow({
    height: 300,
    show: false,
    webPreferences: {
      partition
    },
    width: 400
  })

  try {
    await window.loadURL(`http://127.0.0.1:${port}/`)
    const started = performance.now()
    const result = await window.webContents.executeJavaScript(`(async function () {
      const requests = []
      for (let index = 0; index < 120; index++) {
        requests.push(fetch('/ordinary-resource/' + index))
      }
      for (let index = 0; index < 40; index++) {
        requests.push(fetch('/tracked-resource/' + index + '?fbclid=private&keep=value'))
      }
      for (let index = 0; index < 40; index++) {
        requests.push(fetch('/blocked-resource/' + index))
      }
      const outcomes = await Promise.allSettled(requests)
      return {
        fulfilled: outcomes.filter(outcome => outcome.status === 'fulfilled').length,
        rejected: outcomes.filter(outcome => outcome.status === 'rejected').length
      }
    })()`)
    const elapsedMs = Number((performance.now() - started).toFixed(2))

    assert.deepEqual(result, { fulfilled: 160, rejected: 40 })
    assert.equal(filterServer.getRequestCount(), 161)
    return {
      ...filtering.getPerformanceSnapshot(),
      elapsedMs,
      fulfilledRequests: result.fulfilled,
      rejectedRequests: result.rejected,
      serverRequests: filterServer.getRequestCount()
    }
  } finally {
    filtering.destroy()
    window.destroy()
    await filterServer.close()
  }
}

async function run () {
  let filterWorkload
  let traceStopped = false
  await app.whenReady()
  await contentTracing.startRecording({
    included_categories: ['blink', 'net', 'node', 'renderer.scheduler', 'toplevel', 'v8']
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

  try {
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

    filterWorkload = await runFilteringWorkload()

    const tracePath = await contentTracing.stopRecording()
    traceStopped = true
    const traceBytes = fs.statSync(tracePath).size
    fs.unlinkSync(tracePath)
    console.log(JSON.stringify({
      extractedCharacters: pageData.extractedText.length,
      filtering: filterWorkload,
      previewBytes,
      previewSize: preview.getSize(),
      traceBytes
    }))
  } finally {
    if (!traceStopped) {
      try {
        await contentTracing.stopRecording()
      } catch (error) {}
    }
    window.destroy()
    fs.rmSync(performanceProfilePath, { force: true, recursive: true })
    app.quit()
  }
}

run().catch(async function (error) {
  console.error(error)
  app.exit(1)
})
