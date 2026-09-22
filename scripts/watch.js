const chokidar = require('chokidar')
const path = require('path')

const mainDir = path.resolve(__dirname, '../main')
const jsDir = path.resolve(__dirname, '../js')
const preloadDir = path.resolve(__dirname, '../js/preload')
const browserStylesDir = path.resolve(__dirname, '../css')

const buildMain = require('./buildMain.js')
const buildBrowser = require('./buildBrowser.js')
const buildPreload = require('./buildPreload.js')
const buildBrowserStyles = require('./buildBrowserStyles.js')
const buildPDFViewer = require('./buildPDFViewer.js')
const createBuildQueue = require('./buildQueue.js')

const rebuildBrowser = createBuildQueue(function () {
  console.log('rebuilding browser')
  return buildBrowser()
}, function (error) {
  console.error('Error while building browser:', error)
})

const rebuildPDFViewer = createBuildQueue(buildPDFViewer, function (error) {
  console.error('Error while building PDF viewer:', error)
})
chokidar.watch(path.resolve(__dirname, '../pages/pdfViewer/embedViewer.js'), { ignoreInitial: true })
  .on('change', rebuildPDFViewer)

chokidar.watch(mainDir).on('change', function () {
  console.log('rebuilding main')
  buildMain()
})

chokidar.watch(jsDir, { ignored: preloadDir, ignoreInitial: true })
  .on('add', rebuildBrowser)
  .on('change', rebuildBrowser)
  .on('unlink', rebuildBrowser)

chokidar.watch(preloadDir).on('change', function () {
  console.log('rebuilding preload script')
  buildPreload()
})

chokidar.watch(browserStylesDir).on('change', function () {
  console.log('rebuilding browser styles')
  buildBrowserStyles()
})
