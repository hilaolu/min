const fs = require('fs')
const path = require('path')

const outFile = path.resolve(__dirname, '../main.build.js')
const bootstrap = "require('./main/entry.js')\n"

function buildMain () {
  fs.writeFileSync(outFile, bootstrap, 'utf-8')
}

if (module.parent) {
  module.exports = buildMain
} else {
  buildMain()
}
