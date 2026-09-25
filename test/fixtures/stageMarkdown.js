const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { getNodeModuleFileMatcher } = require('app-builder-lib/out/fileMatcher.js')
const packageConfiguration = require('./packageConfiguration.js')
const minifyReleaseJavaScript = require('../../scripts/minifyReleaseJavaScript.js')

// Stage only the Markdown page's resources using the real dependency filter and
// release minifier. This is not a full installer/cross-platform packaging test.
async function stageMarkdown () {
  const root = path.resolve(__dirname, '../..')
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'min-markdown-stage-'))
  try {
    const config = await packageConfiguration()
    const filter = getNodeModuleFileMatcher(root, directory, value => value, {}, { config, debugLogger: { isEnabled: false } }).createFilter()
    for (const resource of ['pages/markdown', 'pages/document.css', 'js/util/vaultURL.js', 'node_modules/cherry-markdown']) {
      const destination = path.join(directory, resource)
      await fs.mkdir(path.dirname(destination), { recursive: true })
      await fs.cp(path.join(root, resource), destination, {
        recursive: true,
        filter: async source => filter(source, await fs.lstat(source))
      })
    }
    const sizes = await minifyReleaseJavaScript(directory)
    return { directory, sizes }
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true })
    throw error
  }
}

module.exports = stageMarkdown
if (require.main === module) {
  stageMarkdown().then(result => console.log(JSON.stringify(result))).catch(error => {
    console.error(error)
    process.exitCode = 1
  })
}
