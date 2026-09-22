const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const source = fs.readFileSync(path.join(__dirname, '../js/preload/vimMode.js'), 'utf8')

for (const readyState of ['loading', 'complete']) {
  for (const [url, external] of [
    ['https://example.com/', true],
    ['http://example.com/', true],
    ['file:///tmp/example.html', true],
    ['https://example.com/?url=min://app/pages/settings/index.html', true],
    ['min://app/index.html', false],
    ['min://app/pages/settings/index.html', false],
    ['min://app/pages/markdown/index.html?file=note.md', false],
    ['min://app/pages/pdfViewer/index.html?url=https://example.com/file.pdf', false],
    ['min://app/reader/index.html', false],
    ['min://app/pages/future-page/index.html', false],
    ['vault://', false],
    ['vault://notes/example.md', false]
  ]) {
    test(`vim mode eligibility: ${url} (${readyState})`, () => {
      const listeners = {}
      const children = []
      const scrolls = []
      const context = {
        process: { argv: [] },
        window: {
          location: new URL(url),
          scrollBy: (x, y) => scrolls.push([x, y])
        },
        document: {
          readyState,
          createElement: () => ({}),
          addEventListener: (name, handler) => { listeners[name] = handler },
          body: {
            appendChild: element => children.push(element),
            addEventListener: () => {}
          }
        }
      }
      vm.runInNewContext(source, context)
      if (readyState === 'loading') {
        assert.equal(children.length, 0)
        assert.equal(listeners.keydown, undefined)
        listeners.DOMContentLoaded()
      }
      assert.equal(children.length, external ? 1 : 0)
      assert.equal(typeof listeners.keydown, external ? 'function' : 'undefined')
      assert.equal(typeof listeners.keyup, external ? 'function' : 'undefined')
      if (listeners.keydown) listeners.keydown({ key: 'k' })
      assert.deepEqual(scrolls, external ? [[0, -60]] : [])
    })
  }
}
