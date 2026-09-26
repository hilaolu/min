const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const pkg = require('../package.json')
const electronPackage = require('electron/package.json')
const compareVersions = require('../js/util/compareVersions.js')

function minimumNodeVersion (range) {
  assert.match(range, /^>=\s*\d+\.\d+\.\d+$/, 'Node engine must declare an explicit minimum version')
  return range.replace(/^>=\s*/, '')
}

test('development and packaged Electron versions match', function () {
  assert.match(pkg.devDependencies.electron, /^\d+\.\d+\.\d+$/)
  assert.equal(pkg.electronVersion, pkg.devDependencies.electron)
})

test('installed Electron matches the declared runtime', function () {
  assert.equal(electronPackage.version, pkg.devDependencies.electron)
})

test('declared and running Node versions meet the Electron toolchain requirements', function () {
  const minimum = minimumNodeVersion(pkg.engines.node)
  const electronMinimum = minimumNodeVersion(electronPackage.engines.node)
  assert.ok(compareVersions(minimum, electronMinimum) <= 0,
    `Node engine floor ${minimum} is below Electron's requirement ${electronMinimum}`)
  assert.ok(compareVersions(process.versions.node, minimum) <= 0,
    `Node ${minimum} or newer is required; running ${process.versions.node}`)
})

test('local Node major matches build workflows, Nix and the declared engine floor', function () {
  const major = fs.readFileSync(path.join(__dirname, '../.nvmrc'), 'utf8').trim()
  assert.match(major, /^\d+$/)
  assert.equal(minimumNodeVersion(pkg.engines.node).split('.')[0], major)
  const flake = fs.readFileSync(path.join(__dirname, '../flake.nix'), 'utf8')
  assert.match(flake, new RegExp(`\\bnodejs_${major}\\b`))
  for (const name of ['build-deb.yml', 'build-packages.yml']) {
    const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows', name), 'utf8')
    assert.equal(workflow.match(/node-version:\s*(\d+)/)[1], major)
  }
})
