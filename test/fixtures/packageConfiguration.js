const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

// Read the actual packaging options without downloading Electron or packaging.
module.exports = async function packageConfiguration () {
  let config
  const dependencies = {
    path,
    '@electron/fuses': {},
    './minifyReleaseJavaScript.js': () => { throw new Error('Not a packaging run') },
    'electron-builder': {
      Arch: { x64: 'x64' },
      Platform: { LINUX: { createTarget: () => [] } },
      build: async options => { config = options.config }
    }
  }
  const context = {
    module: { exports: {} },
    require: name => {
      if (!Object.hasOwn(dependencies, name)) throw new Error(`Unexpected import ${name}`)
      return dependencies[name]
    }
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../scripts/createPackage.js'), 'utf8'), context)
  await context.module.exports('linux', { arch: 'x64' })
  return config
}
