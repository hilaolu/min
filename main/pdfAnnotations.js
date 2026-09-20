const { createStore, validateAnnotations } = require('./annotationStore.js')
const parseLegacy = require('./annotationLegacy.js')
const fs = require('fs')
const { fileURLToPath } = require('url')

const viewerURL = 'min://app/pages/pdfViewer/index.html'
const { sourceIdentity, discover } = require('./annotatedPdfSearch.js')

function installPdfAnnotations ({ ipc, context }) {
  const bindings = new WeakMap()
  ipc.handle('pdf-annotations', async (event, operation, payload) => {
    try {
      const captured = context(event, operation)
      const source = sourceIdentity(captured.source)
      const current = () => {
        try {
          const next = context(event, operation)
          return next.root === captured.root && next.generation === captured.generation && next.source === captured.source
        } catch (_) { return false }
      }
      if (operation === 'read-file') {
        // The browser cannot fetch file: from min:. Only this internal PDF
        // page's represented .pdf may be read; no caller-supplied path argument.
        if (!source.startsWith('file:') || !new URL(source).pathname.toLowerCase().endsWith('.pdf')) throw new Error('Not a local PDF')
        const handle = await fs.promises.open(fileURLToPath(source), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
        try {
          const stat = await handle.stat()
          if (!stat.isFile() || stat.size > 256 * 1024 * 1024) throw new Error('Local PDF is unavailable or exceeds 256 MiB')
          const magic = Buffer.alloc(5)
          await handle.read(magic, 0, 5, 0)
          if (magic.toString() !== '%PDF-') throw new Error('Not a PDF document')
          const bytes = Buffer.alloc(stat.size)
          let offset = 0
          while (offset < bytes.length) {
            const read = await handle.read(bytes, offset, bytes.length - offset, offset)
            if (!read.bytesRead) throw new Error('PDF changed during read')
            offset += read.bytesRead
          }
          if (!current()) throw new Error('Document changed')
          return { ok: true, bytes: new Uint8Array(bytes) }
        } finally { await handle.close() }
      }
      if (!captured.root) throw new Error('Configure a vault in Settings to save annotations')
      if (!event.sender.session?.isPersistent()) throw new Error('Vault annotations are disabled in private tabs')
      if (operation !== 'load') {
        const binding = bindings.get(event.sender)
        if (!binding || binding.frame !== event.senderFrame || binding.root !== captured.root || binding.generation !== captured.generation || binding.source !== source) throw new Error('Reload PDF annotations after the document or vault changes')
      }
      const store = createStore(captured.root, source)
      let result
      if (operation === 'load') {
        result = await store.read()
        if (!current()) throw new Error('Document or vault changed')
        if (result.revision === null) {
          const legacy = await discover(captured.root, current)
          const resource = legacy.resources.find(item => item.source === source)
          if (resource) result.annotations = resource.annotations
          else if (legacy.truncated || legacy.invalidSources.has(source)) throw new Error('Annotation discovery incomplete; check legacy records in the vault')
        }
      } else if (operation === 'save') result = await store.save(payload?.annotations, payload?.revision, current)
      else if (operation === 'import') {
        if (typeof payload !== 'string' || Buffer.byteLength(payload) > 1024 * 1024) throw new Error('Import size limit exceeded')
        const legacy = payload.trim().startsWith('{') ? JSON.parse(payload) : parseLegacy(payload)
        if (payload.trim().startsWith('{') && legacy.version !== 1) throw new Error('Unsupported annotation version')
        if (sourceIdentity(legacy.source) !== source) throw new Error('Legacy annotation URL does not match this PDF')
        result = { annotations: validateAnnotations(legacy.annotations) }
      } else throw new Error('Unknown annotation operation')
      if (!current()) throw new Error('Document or vault changed')
      if (operation === 'load') bindings.set(event.sender, { frame: event.senderFrame, root: captured.root, generation: captured.generation, source })
      return { ok: true, ...result }
    } catch (error) {
      return { ok: false, error: error.message }
    }
  })
}

module.exports = { installPdfAnnotations, sourceIdentity, viewerURL }
