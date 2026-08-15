const browserify = require('browserify')
const path = require('path')
const fs = require('fs')

const rootDir = path.resolve(__dirname, '../')
const jsDir = path.resolve(__dirname, '../js')

const intermediateOutput = path.resolve(__dirname, '../dist/build.js')
const outFile = path.resolve(__dirname, '../dist/bundle.js')

const fileList = [
  'js/default.js'
]

function buildBrowser () {
  fs.mkdirSync(path.dirname(intermediateOutput), { recursive: true })

  /* concatenate legacy modules */
  let output = ''
  fileList.forEach(function (script) {
    output += fs.readFileSync(path.resolve(__dirname, '../', script)) + ';\n'
  })

  fs.writeFileSync(intermediateOutput, output, 'utf-8')

  // Browser Chrome has no Node bridge, so Browserify must bundle browser
  // implementations for core dependencies and referenced globals.
  const instance = browserify(intermediateOutput, {
    paths: [rootDir, jsDir],
    ignoreMissing: false
  })

  const stream = fs.createWriteStream(outFile, { encoding: 'utf-8' })
  instance.bundle()
    .on('error', function (e) {
      console.warn('\x1b[31m' + 'Error while building: ' + e.message + '\x1b[30m')
    })
    .pipe(stream)
}

if (module.parent) {
  module.exports = buildBrowser
} else {
  buildBrowser()
}
