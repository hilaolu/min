const browserify = require('browserify')
const path = require('path')
const fs = require('fs')
const { pipeline } = require('stream/promises')

const rootDir = path.resolve(__dirname, '../')
const jsDir = path.resolve(__dirname, '../js')

const intermediateOutput = path.resolve(__dirname, '../dist/build.js')
const outFile = path.resolve(__dirname, '../dist/bundle.js')

const fileList = [
  'js/default.js'
]

async function buildBrowser () {
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

  // Publish only after both streams finish. A failed build must not truncate
  // the last working bundle, and callers must be able to await completion.
  const temporaryDirectory = await fs.promises.mkdtemp(path.join(path.dirname(outFile), '.browser-build-'))
  const temporaryOutput = path.join(temporaryDirectory, 'bundle.js')
  try {
    await pipeline(instance.bundle(), fs.createWriteStream(temporaryOutput, { encoding: 'utf-8' }))
    await fs.promises.rename(temporaryOutput, outFile)
  } finally {
    await fs.promises.rm(temporaryDirectory, { recursive: true, force: true })
  }
}

if (module.parent) {
  module.exports = buildBrowser
} else {
  buildBrowser().catch(function (error) {
    console.error('Error while building browser:', error)
    process.exitCode = 1
  })
}
