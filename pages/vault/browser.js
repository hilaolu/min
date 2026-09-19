/* global vaultPage, AbortController */
const files = document.getElementById('files')
const status = document.getElementById('status')
let entries = []
let selected = -1
let parentURL = null
let generation = 0
let previewGeneration = 0
let previewController = null
let lastG = 0

function sorted (items) {
  return items.slice().sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory') || a.name.localeCompare(b.name))
}

async function open (url) {
  try {
    const result = await vaultPage.open(url)
    if (result && result.ok === false) status.textContent = result.error
  } catch (_) { status.textContent = 'Could not open this entry.' }
}

function row (entry) {
  const element = document.createElement('button')
  element.className = 'entry ' + (entry.kind === 'directory' ? 'directory' : 'file')
  element.textContent = (entry.kind === 'directory' ? '▸ ' : '· ') + entry.name + (entry.kind === 'directory' ? '/' : '')
  element.title = entry.relativePath || entry.name
  return element
}

function message (target, text) {
  // Stop decoding/loading the previous image when the selection changes.
  target.querySelectorAll('img').forEach(image => {
    image.onerror = null
    image.removeAttribute('src')
  })
  target.replaceChildren()
  target.scrollTop = 0
  const p = document.createElement('p')
  p.className = 'placeholder'
  p.textContent = text
  target.append(p)
}

async function preview (entry) {
  const mine = ++previewGeneration
  if (previewController) previewController.abort()
  previewController = null
  const target = document.getElementById('preview')
  message(target, entry ? (entry.kind === 'directory' ? 'Loading…' : entry.name + ' — Enter to open') : 'No entry selected')
  if (!entry) return
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
    const result = await vaultPage.listDirectory(entry.url)
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

function select (index) {
  const next = entries.length ? Math.max(0, Math.min(entries.length - 1, index)) : -1
  const changed = next !== selected
  selected = next
  Array.from(files.children).forEach((element, i) => {
    element.classList.toggle('selected', i === selected)
    element.setAttribute('aria-selected', String(i === selected))
  })
  if (selected >= 0) {
    files.setAttribute('aria-activedescendant', 'entry-' + selected)
    files.children[selected].scrollIntoView({ block: 'nearest' })
  } else files.removeAttribute('aria-activedescendant')
  document.getElementById('position').textContent = (selected + 1) + ' / ' + entries.length
  if (changed || selected === -1) preview(entries[selected])
}

async function refresh () {
  const mine = ++generation
  const previous = entries[selected]?.url
  ++previewGeneration
  if (previewController) previewController.abort()
  previewController = null
  entries = []
  selected = -1
  parentURL = null
  lastG = 0
  files.setAttribute('aria-busy', 'true')
  files.replaceChildren()
  files.removeAttribute('aria-activedescendant')
  document.getElementById('parent').replaceChildren()
  message(document.getElementById('preview'), 'Loading…')
  document.getElementById('position').textContent = ''
  status.textContent = 'Loading…'
  try {
    const result = await vaultPage.listCurrent('')
    if (mine !== generation) return
    files.setAttribute('aria-busy', 'false')
    if (!result.ok) {
      message(document.getElementById('preview'), 'Directory unavailable')
      status.textContent = result.error
      return
    }
    const segments = result.url.slice('vault://'.length).split('/').filter(Boolean)
    const urlAt = i => 'vault://' + segments.slice(0, i).join('/') + (i ? '/' : '')
    parentURL = segments.length ? urlAt(segments.length - 1) : null
    const breadcrumb = document.getElementById('breadcrumb')
    breadcrumb.replaceChildren()
    for (let i = 0; i <= segments.length; i++) {
      const button = document.createElement('button')
      button.textContent = i ? decodeURIComponent(segments[i - 1]) + '/' : 'vault://'
      if (i === segments.length) button.setAttribute('aria-current', 'page')
      button.onclick = () => open(urlAt(i))
      breadcrumb.append(button)
    }
    breadcrumb.title = result.url
    breadcrumb.scrollLeft = breadcrumb.scrollWidth
    document.title = (segments.length ? decodeURIComponent(segments[segments.length - 1]) + ' — ' : '') + 'Vault'
    entries = sorted(result.entries)
    entries.forEach((entry, i) => {
      const element = row(entry)
      element.id = 'entry-' + i
      element.tabIndex = -1
      element.setAttribute('role', 'option')
      element.onclick = () => { select(i); files.focus() }
      element.ondblclick = () => open(entry.url)
      files.append(element)
    })
    status.textContent = entries.length ? '' : 'Empty directory'
    select(Math.max(0, entries.findIndex(entry => entry.url === previous)))
    files.focus()
    const parent = document.getElementById('parent')
    if (!parentURL) return message(parent, 'Vault root')
    const siblings = await vaultPage.listDirectory(parentURL)
    if (mine !== generation) return
    if (!siblings.ok) return message(parent, siblings.error)
    sorted(siblings.entries).forEach(entry => {
      const element = row(entry)
      element.classList.toggle('current', entry.url === result.url)
      element.onclick = () => open(entry.url)
      parent.append(element)
    })
    const current = parent.querySelector('.current')
    if (current) current.scrollIntoView({ block: 'nearest' })
  } catch (_) {
    if (mine === generation) {
      files.setAttribute('aria-busy', 'false')
      status.textContent = 'Could not read directory. Try refreshing.'
      if (!entries.length) message(document.getElementById('preview'), 'Directory unavailable')
    }
  }
}

document.addEventListener('keydown', event => {
  if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName) || event.target.isContentEditable) return
  if (event.key === 'Enter' && event.target.closest('button')) return
  const key = event.key
  if (!['j', 'k', 'h', 'l', 'g', 'G', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter'].includes(key)) {
    lastG = 0
    return
  }
  event.preventDefault()
  files.focus({ preventScroll: true })
  if (key !== 'g') lastG = 0
  if (key === 'j' || key === 'ArrowDown') select(selected + 1)
  if (key === 'k' || key === 'ArrowUp') select(selected - 1)
  if (key === 'h' || key === 'ArrowLeft') { if (parentURL) open(parentURL) }
  if (key === 'l' || key === 'ArrowRight' || key === 'Enter') { if (entries[selected]) open(entries[selected].url) }
  if (key === 'G' || key === 'End') select(entries.length - 1)
  if (key === 'Home') select(0)
  if (key === 'g') {
    if (lastG && Date.now() - lastG < 700) { select(0); lastG = 0 } else lastG = Date.now()
  }
})
document.getElementById('refresh').onclick = refresh
refresh()
