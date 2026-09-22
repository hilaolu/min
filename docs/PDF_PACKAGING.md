# PDF viewer packaging

`npm run build` includes `buildPDFViewer`. This bundles the PDF page and EmbedPDF
with esbuild, with tree-shaking, minification, and no source maps. Development
watch mode rebuilds it when `pages/pdfViewer/embedViewer.js` changes.

The runtime files are in `dist/pdfViewer`: `viewer.js`, its legal notices,
`LICENSES.txt`, and one `pdfium.wasm`. EmbedPDF dependencies are development-only;
their original packages (including font packages, duplicate WASM, demo PDFs, and
alternate module builds) are not shipped. Development `node_modules` remains
large. Build diagnostics are in `dist/pdfViewer-meta.json`, excluded from releases.

The current all-in-one snippet is still used. Tree-shaking cannot remove plugins
referenced internally by its initialization code. Replacing it with a custom
plugin-based UI is a separate change, not implemented here. PDFium's embedded
worker source is also not independently minified by esbuild.

UI/signature font loading and external font fallbacks were already disabled.
Unused default stamp downloads are now disabled too. PDFs without embedded fonts,
especially CJK documents, still need compatibility testing; this build does not
add a replacement font service or change PDFium itself.

AppImage uses maximum compression (xz with this electron-builder version).
Debian and RPM explicitly use xz. Windows/macOS ZIPs already use level 9; their
settings are unchanged. Compression reduces archive/download size, not installed
size. ASAR remains disabled and is not a compression mechanism.

## Verification

All release packaging targets also run `minifyReleaseJavaScript` in `afterPack`,
before signing or archiving. It minifies staged `.js`, `.cjs`, and `.mjs` files,
including shipped dependencies, without changing development/source files.
Identifier names and module formats are preserved for legacy script compatibility;
whitespace and non-license comments are removed. Syntax folding and identifier
mangling are disabled to preserve reflective function names and cross-file globals.
License comments and separate license files
are retained. Inline scripts and JavaScript embedded in strings are not minified.
Transform errors fail packaging rather than silently shipping unprocessed files.
Already-compact files are kept unchanged if esbuild would make them larger.
Symlinks are not followed, and staged hardlinks are replaced rather than modified
in place to avoid changing the original dependencies.

```sh
npm test
npm run build
DISPLAY=:0 npm run test:electron-pdf-bundle
# After packaging, test the actual release assets without npm or network access:
DISPLAY=:0 node_modules/.bin/electron --no-sandbox test/electronPDFBundle.js \
  --app-root=dist/app/linux-unpacked/resources/app
```

The dedicated Electron smoke checks real PDFium rendering and text search while
blocking network and `node_modules` requests. Its file bridge is stubbed; it does
not replace the full vault annotation/persistence tests in `electronVaultPages.js`.
