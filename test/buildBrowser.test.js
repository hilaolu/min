const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { after, test } = require('node:test')

const temporaryDirectories = []

after(function () {
  temporaryDirectories.forEach(function (directory) {
    fs.rmSync(directory, { recursive: true, force: true })
  })
})

function writeModule (rootDirectory, name, source) {
  const moduleDirectory = path.join(rootDirectory, 'node_modules', name)
  fs.mkdirSync(moduleDirectory, { recursive: true })
  fs.writeFileSync(path.join(moduleDirectory, 'index.js'), source)
}

test('buildBrowser creates its output directory in a clean checkout', function () {
  const rootDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'min-build-browser-'))
  temporaryDirectories.push(rootDirectory)

  fs.mkdirSync(path.join(rootDirectory, 'scripts'))
  fs.mkdirSync(path.join(rootDirectory, 'js'))
  fs.copyFileSync(
    path.resolve(__dirname, '../scripts/buildBrowser.js'),
    path.join(rootDirectory, 'scripts/buildBrowser.js')
  )
  fs.writeFileSync(path.join(rootDirectory, 'js/default.js'), 'window.min = true\n')

  writeModule(rootDirectory, 'browserify', `
    const fs = require('node:fs')
    const { Readable } = require('node:stream')

    module.exports = function (inputFile) {
      if (!fs.existsSync(inputFile)) {
        throw new Error('browserify input does not exist')
      }

      return {
        exclude: function () {},
        transform: function () {},
        bundle: function () {
          return Readable.from(['browser bundle'])
        }
      }
    }
  `)
  writeModule(rootDirectory, 'electron-renderify', 'module.exports = function () {}\n')

  const result = spawnSync(process.execPath, ['scripts/buildBrowser.js'], {
    cwd: rootDirectory,
    encoding: 'utf-8'
  })

  assert.equal(result.status, 0, result.stderr)
  assert.equal(
    fs.readFileSync(path.join(rootDirectory, 'dist/build.js'), 'utf-8'),
    'window.min = true\n;\n'
  )
  assert.equal(
    fs.readFileSync(path.join(rootDirectory, 'dist/bundle.js'), 'utf-8'),
    'browser bundle'
  )
})
