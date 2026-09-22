const esbuild = require('esbuild')
const fs = require('fs/promises')
const path = require('path')

const root = path.resolve(__dirname, '..')

async function buildPDFViewer () {
  const outdir = path.join(root, 'dist/pdfViewer')
  await fs.mkdir(outdir, { recursive: true })
  const result = await esbuild.build({
    absWorkingDir: root,
    entryPoints: ['pages/pdfViewer/embedViewer.js'],
    outfile: path.join(outdir, 'viewer.js'),
    bundle: true,
    minify: true,
    treeShaking: true,
    platform: 'browser',
    format: 'esm',
    target: 'chrome144',
    legalComments: 'linked',
    sourcemap: false,
    metafile: true
  })
  // The snippet's worker code is embedded in JS; PDFium is its only local asset.
  await fs.copyFile(path.join(root, 'node_modules/@embedpdf/snippet/dist/pdfium.wasm'), path.join(outdir, 'pdfium.wasm'))

  // Preserve licenses even though the original npm packages aren't shipped.
  const licenses = []
  const scope = path.join(root, 'node_modules/@embedpdf')
  const packages = (await fs.readdir(scope)).map(name => '@embedpdf/' + name)
  packages.push('preact', 'tailwind-merge')
  for (const name of packages.sort()) {
    const directory = path.join(root, 'node_modules', name)
    for (const file of (await fs.readdir(directory)).sort()) {
      if (/^licen[cs]e(?:\.|$)/i.test(file)) {
        licenses.push(`=== ${name}/${file} ===\n${await fs.readFile(path.join(directory, file), 'utf8')}`)
      }
    }
  }
  await fs.writeFile(path.join(outdir, 'LICENSES.txt'), licenses.join('\n\n'))
  // Build diagnostics stay outside the runtime directory and release package.
  await fs.writeFile(path.join(root, 'dist/pdfViewer-meta.json'), JSON.stringify(result.metafile, null, 2))
}

module.exports = buildPDFViewer
if (require.main === module) {
  buildPDFViewer().catch(error => {
    console.error(error)
    process.exitCode = 1
  })
}
