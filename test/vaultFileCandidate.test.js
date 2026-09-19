const { test } = require('node:test')
const assert = require('node:assert/strict')
const candidate = require('../js/commandPalette/vaultFileCandidate.js')

test('vault file commands encode literal paths and open only on selection', () => {
  for (const [command, path, expected] of [
    ['m', 'notes/my #note%.md', 'vault://local/notes/my%20%23note%25.md'],
    ['p', 'papers/中文.PDF', 'vault://local/papers/%E4%B8%AD%E6%96%87.PDF']
  ]) {
    const opened = []
    const result = candidate(command, path, url => opened.push(url))
    assert.deepEqual(opened, [])
    result.action()
    assert.deepEqual(opened, [expected])
  }
})

test('empty, wrong-type, absolute and traversal paths cannot open or search the web', () => {
  for (const path of ['', 'file.pdf', '/file.md', '../file.md', 'a/../file.md',
    'a/./file.md', 'a//file.md', 'C:\\file.md', 'https://host/file.md', 'a\u0000.md']) {
    assert.equal(candidate('m', path, () => assert.fail('must not open')).action, undefined)
  }
  assert.equal(candidate('p', 'file.md', () => {}).action, undefined)
})
