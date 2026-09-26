const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const electron = require('electron')
const { app, webContents } = electron

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'min-background-tabs-'))
app.setPath('userData', temporary)
app.disableHardwareAcceleration()
process.argv.push('--debug-browser')
process.on('uncaughtException', error => { console.error(error); app.exit(1) })
const main = require('../main/index.js')({ electron })
const requests = []
const server = http.createServer((request, response) => {
  requests.push(request.url)
  response.setHeader('Content-Type', 'text/html')
  response.end('<!doctype html><title>Deferred tab fixture</title><p>Local memory fixture</p>')
})
const deadline = setTimeout(() => { console.error('Background tab timeout'); app.exit(1) }, 45000)

async function until (predicate, label) {
  for (let attempt = 0; attempt < 250; attempt++) {
    const result = await predicate()
    if (result) return result
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('Timed out: ' + label)
}

async function run () {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  await app.whenReady()
  const win = await until(() => main.windows.getAll()[0], 'window')
  const chrome = main.windows.getChromeContents(win)
  await until(() => !chrome.isLoading(), 'chrome')
  await main.settings.set('collectUsageStats', false)
  main.windows.send(win, 'addTab', { url: base + '/source' })
  const source = await until(() => webContents.getAllWebContents().find(c => c.getURL() === base + '/source' && !c.isLoading()), 'source tab')
  const sourceId = main.viewManager.getTabIDFromWebContents(source)
  main.windows.send(win, 'addTab', { url: 'min://app/pages/settings/index.html' })
  const settingsPage = await until(() => webContents.getAllWebContents().find(c => c.getURL() === 'min://app/pages/settings/index.html' && !c.isLoading()), 'settings page')
  await settingsPage.executeJavaScript(`(() => {
    const checkbox = document.getElementById('checkbox-defer-background-tabs')
    if (checkbox.checked) throw new Error('deferral must default off')
    checkbox.checked = true
    checkbox.dispatchEvent(new Event('change'))
  })()`)
  await until(() => main.settings.get('deferBackgroundTabs') === true, 'saved opt-in')
  const select = id => chrome.executeJavaScript(`document.querySelector('[data-tab="${id}"].tab-item').click()`)
  await select(sourceId)
  const tabIds = () => chrome.executeJavaScript("Array.from(document.querySelectorAll('.tab-item'), el => el.dataset.tab)")
  const initialIds = await tabIds()
  const initialContents = webContents.getAllWebContents().length
  for (let index = 0; index < 20; index++) {
    chrome.send('tab-content-event', {
      tabId: sourceId,
      type: 'new-tab-requested',
      payload: { url: base + '/page' + index, openInForeground: false }
    })
  }
  const allIds = await until(async () => {
    const ids = await tabIds()
    return ids.length === initialIds.length + 20 && ids
  }, '20 model/DOM tabs')
  const deferred = allIds.filter(id => !initialIds.includes(id))
  assert.equal(requests.filter(url => url.startsWith('/page')).length, 0)
  assert.equal(webContents.getAllWebContents().length, initialContents)
  await select(deferred[0])
  const loaded = await until(() => webContents.getAllWebContents().find(c => c.getURL().startsWith(base + '/page') && !c.isLoading()), 'selected deferred tab')
  assert.equal(webContents.getAllWebContents().length, initialContents + 1)
  await select(sourceId)
  await select(deferred[0])
  assert.equal(main.viewManager.getTabIDFromWebContents(loaded), deferred[0])
  assert.equal(webContents.getAllWebContents().length, initialContents + 1)
  await chrome.executeJavaScript(`document.querySelector('[data-tab="${deferred[1]}"] .tab-close-button').click()`)
  await until(async () => !(await tabIds()).includes(deferred[1]), 'close never-selected tab')
  assert.equal(requests.filter(url => url.startsWith('/page')).length, 1)
  assert.equal(webContents.getAllWebContents().length, initialContents + 1)
  // The built-app developer menu must also tolerate an absent idle service.
  main.places.destroy()
  assert.equal(main.places.getWindow(), null)
  const developer = electron.Menu.getApplicationMenu().items.find(item => item.label === 'Developer')
  const inspectPlaces = developer.submenu.items.find(item => item.label === 'Inspect Places Service')
  inspectPlaces.click(inspectPlaces, win)
  const recreated = main.places.getWindow()
  assert.ok(recreated)
  await until(() => recreated.webContents.isDevToolsOpened(), 'on-demand Places inspector')
  recreated.webContents.closeDevTools()
  console.log(JSON.stringify({ backgroundTabs: 20, initiallyCreatedContents: 0, createdAfterSelection: 1, pageRequests: 1, settingsCheckbox: 'passed', placesInspector: 'passed' }))
}

run().then(async () => {
  clearTimeout(deadline)
  main.places.destroy()
  main.filtering.destroy()
  main.rendererHostFiles.destroy()
  for (const contents of webContents.getAllWebContents()) contents.destroy()
  await new Promise(resolve => server.close(resolve))
  fs.rmSync(temporary, { recursive: true, force: true })
  app.exit(0)
}).catch(error => {
  console.error(error)
  clearTimeout(deadline)
  server.close()
  app.exit(1)
})
