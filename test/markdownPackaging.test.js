const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const test = require('node:test')
const { getNodeModuleFileMatcher } = require('app-builder-lib/out/fileMatcher.js')
const packageConfiguration = require('./fixtures/packageConfiguration.js')

test('release keeps the full Cherry runtime but excludes alternative distributions', async function () {
  const root = path.resolve(__dirname, '..')
  const config = await packageConfiguration()
  const filter = getNodeModuleFileMatcher(root, root, value => value, {}, { config, debugLogger: { isEnabled: false } }).createFilter()
  const directory = path.join(root, 'node_modules/cherry-markdown/dist')
  const scripts = (await fs.readdir(directory)).filter(name => name.endsWith('.js'))
  assert.equal(scripts.length, 10, 'review distribution changes when upgrading Cherry')
  for (const name of scripts) {
    const filename = path.join(directory, name)
    assert.equal(filter(filename, await fs.stat(filename)), name === 'cherry-markdown.js', name)
  }
  for (const name of ['cherry-markdown.min.css', 'fonts/ch-icon.woff2', 'fonts/ch-icon.ttf', 'addons/cherry-code-block-mermaid-plugin.js']) {
    const filename = path.join(directory, name)
    assert.equal(filter(filename, await fs.stat(filename)), true, name)
  }
  const otherPackage = path.join(root, 'node_modules/unrelated/dist/library.core.js')
  assert.equal(filter(otherPackage, { isDirectory: () => false }), true)
})
