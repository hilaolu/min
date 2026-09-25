const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

// Isolate result bookkeeping/duplicate scans: no URL parsing, DOM layout/paint,
// network or real item rendering. Inputs use already-normalized URL keys.
module.exports = function searchbarDeduplicationHarness (count) {
  const element = () => ({
    children: [],
    childNodes: [],
    classList: { add: function () {} },
    setAttribute: function () {},
    appendChild (child) { this.children.push(child) },
    insertBefore: function () {}
  })
  const searchbar = { ...element(), querySelector: element }
  const context = {
    module: { exports: {} },
    document: { getElementById: () => searchbar, createElement: element },
    empty: el => { el.children.length = 0 },
    require: name => {
      if (name === 'searchbar/searchbarUtils.js') return { createItem: element }
      if (name === 'util/urlParser.js') return { removeTextFragment: () => { throw new Error('URL normalization is outside this benchmark') } }
      throw new Error(`Unexpected import ${name}`)
    }
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../js/searchbar/searchbarPlugins.js'), 'utf8'), context)
  const plugins = context.module.exports
  const names = ['places', 'suggestions', 'answers']
  names.forEach((name, index) => plugins.register(name, { index }))
  const results = Array.from({ length: count }, (_, index) => ({ urlKey: `https://example.com/${index}` }))
  return function run () {
    plugins.clearAll()
    results.forEach((data, index) => plugins.addResult(names[index % names.length], data))
    return plugins.getResultCount()
  }
}
