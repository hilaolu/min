const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { after, test } = require('node:test')
const { domainToASCII: nodeDomainToASCII } = require('node:url')

const domainToASCII = require('../js/util/domainToASCII.js')

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

    module.exports = function (inputFile, options) {
      if (!fs.existsSync(inputFile)) {
        throw new Error('browserify input does not exist')
      }
      if (options.node === true || options.detectGlobals === false) {
        throw new Error('Browser Chrome must be bundled for an isolated browser environment')
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

test('Browser Chrome bundle does not depend on the removed Node bridge', function () {
  const rootDirectory = path.resolve(__dirname, '..')
  const result = spawnSync(process.execPath, ['scripts/buildBrowser.js'], {
    cwd: rootDirectory,
    encoding: 'utf-8'
  })

  assert.equal(result.status, 0, result.stderr)
  const bundle = fs.readFileSync(path.join(rootDirectory, 'dist/bundle.js'), 'utf-8')
  const removedNodeBridgeCalls = bundle.match(/window\.require\s*\(/g) || []
  const unresolvedDependencies = bundle.match(/"[^"]+":undefined/g) || []
  assert.equal(removedNodeBridgeCalls.length, 0, 'Browser Chrome cannot call window.require with Node integration disabled')
  assert.deepEqual(unresolvedDependencies, [], 'Browser Chrome cannot load unresolved bundle dependencies')
})

test('browser-native domain conversion preserves Node URL behavior', function () {
  const domains = [
    'münich.example',
    '例子.测试',
    'BÜCHER.EXAMPLE.',
    '[::1]',
    '[::1]:80',
    'user@example.com',
    'münich.example:80',
    ''
  ]

  domains.forEach(function (domain) {
    assert.equal(domainToASCII(domain), nodeDomainToASCII(domain), domain)
  })
})
