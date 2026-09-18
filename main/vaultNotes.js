const fs = require('fs')
const writeFileAtomic = require('write-file-atomic')
const { resolveVaultURL } = require('./vault.js')

// UTF-8 source limit applies to editors only, never the resource protocol.
const maximumBytes = 8 * 1024 * 1024
function createNote (root, url) {
  let baseline
  let queue = Promise.resolve()
  async function read () {
    const file = await resolveVaultURL(url, root)
    if (file.kind !== 'markdown' || file.stat.size > maximumBytes) throw new Error('MARKDOWN_SIZE_OR_TYPE')
    const bytes = await fs.promises.readFile(file.absolutePath)
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    return { file, text }
  }
  return {
    async read () {
      if (baseline === undefined) baseline = (await read()).text
      return baseline
    },
    save (text) {
      const result = queue.then(async () => {
        if (typeof text !== 'string' || Buffer.byteLength(text) > maximumBytes) throw new Error('MARKDOWN_SIZE_OR_TYPE')
        const current = await read()
        if (baseline === undefined || current.text !== baseline) throw new Error('MARKDOWN_EXTERNAL_CHANGE')
        if (text !== baseline) {
          const checked = await resolveVaultURL(url, root)
          if (checked.absolutePath !== current.file.absolutePath || checked.kind !== 'markdown') throw new Error('MARKDOWN_PATH_CHANGED')
          await writeFileAtomic(checked.absolutePath, text, { encoding: 'utf8' })
          baseline = text
        }
        return { ok: true }
      })
      queue = result.catch(() => {})
      return result
    }
  }
}
module.exports = { createNote, maximumBytes }
