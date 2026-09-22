const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const pkg = require('../package.json')

test('development and packaged Electron versions match', function () {
  assert.match(pkg.devDependencies.electron, /^\d+\.\d+\.\d+$/)
  assert.equal(pkg.electronVersion, pkg.devDependencies.electron)
})

test('local Node major matches the build workflows', function () {
  const major = fs.readFileSync(path.join(__dirname, '../.nvmrc'), 'utf8').trim()
  assert.match(major, /^\d+$/)
  for (const name of ['build-deb.yml', 'build-packages.yml']) {
    const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows', name), 'utf8')
    assert.equal(workflow.match(/node-version:\s*(\d+)/)[1], major)
  }
})
