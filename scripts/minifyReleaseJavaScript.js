const esbuild = require('esbuild')
const fs = require('fs/promises')
const path = require('path')

// Only call on electron-builder's staged resources/app, never the source tree.
async function minifyReleaseJavaScript (directory) {
  const totals = { files: 0, before: 0, after: 0 }
  async function visit (directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        await visit(filename)
      } else if (entry.isFile() && /\.(?:js|cjs|mjs)$/.test(entry.name)) {
        const source = await fs.readFile(filename, 'utf8')
        const result = await esbuild.transform(source, {
          sourcefile: filename,
          loader: 'js',
          // No format conversion or bundling: preserve classic-script globals,
          // CommonJS exports, ESM imports, and the existing file layout.
          minifyWhitespace: true,
          // Syntax folding can remove function names even without identifier
          // mangling. Legacy/vendor code may inspect those names at runtime.
          minifySyntax: false,
          minifyIdentifiers: false,
          legalComments: 'inline',
          sourcemap: false,
          target: 'esnext'
        })
        const before = Buffer.byteLength(source)
        const after = Buffer.byteLength(result.code)
        totals.files++
        totals.before += before
        // Already-minified vendor files can grow when reformatted by esbuild.
        // Still parse them to catch errors, but never increase release size.
        if (after >= before) {
          totals.after += before
          continue
        }
        const mode = (await fs.stat(filename)).mode
        const temporary = await fs.mkdtemp(path.join(directory, '.minify-'))
        try {
          const output = path.join(temporary, entry.name)
          await fs.writeFile(output, result.code, { mode })
          await fs.chmod(output, mode)
          // Replace rather than truncate: staging may share hardlinks with npm.
          await fs.rename(output, filename)
        } finally {
          await fs.rm(temporary, { recursive: true, force: true })
        }
        totals.after += after
      }
      // Don't follow symlinks out of the staged app.
    }
  }
  await visit(directory)
  return totals
}

module.exports = minifyReleaseJavaScript
