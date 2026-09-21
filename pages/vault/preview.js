/* global AbortController */

function createVaultPreview ({ target, listDirectory, open, row, sorted, message }) {
  let previewGeneration = 0
  let previewController = null

  async function show (entry) {
    const mine = ++previewGeneration
    if (previewController) previewController.abort()
    previewController = null
    message(target, entry ? (entry.kind === 'directory' ? 'Loading…' : entry.name + ' — Enter to open') : 'No entry selected')
    if (!entry) return
    if (entry.passage) {
      const passage = entry.passage
      const label = document.createElement('p')
      label.className = 'placeholder'
      label.textContent = 'Content match · line ' + passage.line + ' (search snapshot)'
      const pre = document.createElement('pre')
      pre.className = 'preview-text'
      if (passage.clippedStart) pre.append(document.createTextNode('…'))
      let end = 0
      for (const [start, stop] of passage.ranges) {
        pre.append(document.createTextNode(passage.text.slice(end, start)))
        const mark = document.createElement('mark')
        mark.textContent = passage.text.slice(start, stop)
        pre.append(mark)
        end = stop
      }
      pre.append(document.createTextNode(passage.text.slice(end) + (passage.clippedEnd ? '…' : '')))
      target.append(label, pre)
      const firstMatch = pre.querySelector('mark')
      if (firstMatch) firstMatch.scrollIntoView({ block: 'center' })
      return
    }
    if (entry.kind !== 'directory') {
      const extension = entry.name.split('.').pop().toLowerCase()
      if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg'].includes(extension)) {
        const image = document.createElement('img')
        image.className = 'preview-image'
        image.alt = entry.name
        image.decoding = 'async'
        image.onerror = () => {
          if (mine === previewGeneration) message(target, 'Could not preview image — Enter to open')
        }
        image.src = entry.url
        target.append(image)
      } else if (['txt', 'md', 'markdown', 'json', 'csv', 'log', 'js', 'ts', 'css', 'html', 'xml', 'yaml', 'yml', 'toml', 'ini', 'sh', 'py', 'rs', 'c', 'h', 'cpp'].includes(extension)) {
        const controller = new AbortController()
        previewController = controller
        try {
          // The vault protocol supports ranges; never load an entire large text file.
          const limit = 64 * 1024
          const response = await fetch(entry.url, { headers: { Range: 'bytes=0-' + limit }, signal: controller.signal })
          const empty = response.status === 416 && response.headers.get('Content-Range') === 'bytes */0'
          if (!response.ok && !empty) throw new Error('Preview unavailable')
          const bytes = empty ? new Uint8Array() : new Uint8Array(await response.arrayBuffer())
          if (mine !== previewGeneration) return
          if (bytes.includes(0)) return message(target, 'Binary file — Enter to open')
          // Omit an incomplete UTF-8 character at the preview boundary.
          const text = new TextDecoder().decode(bytes.slice(0, limit), { stream: bytes.length > limit })
          const pre = document.createElement('pre')
          pre.className = 'preview-text'
          pre.textContent = text || '(Empty file)'
          target.append(pre)
          if (bytes.length > limit) {
            const notice = document.createElement('p')
            notice.className = 'placeholder'
            notice.textContent = 'Preview truncated at 64 KiB — Enter to open full file'
            target.append(notice)
          }
        } catch (_) {
          if (mine === previewGeneration) message(target, 'Could not preview file — Enter to open')
        } finally {
          if (previewController === controller) previewController = null
        }
      }
      return
    }
    try {
      const result = await listDirectory(entry.url)
      if (mine !== previewGeneration) return
      if (!result.ok) return message(target, result.error)
      target.replaceChildren()
      sorted(result.entries).forEach(child => {
        const element = row(child)
        element.onclick = () => open(child.url)
        target.append(element)
      })
      if (!result.entries.length) message(target, 'Empty directory')
    } catch (_) {
      if (mine === previewGeneration) message(target, 'Could not read directory.')
    }
  }

  function clear () {
    ++previewGeneration
    if (previewController) previewController.abort()
    previewController = null
  }

  return { show, clear }
}

window.createVaultPreview = createVaultPreview
