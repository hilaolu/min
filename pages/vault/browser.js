/* global vaultPage, createVaultPreview, createVaultContentSearch */
const files = document.getElementById('files')
const status = document.getElementById('status')
let entries = []
let selected = -1
let parentURL = null
let generation = 0
let lastG = 0
const contentSearch = createVaultContentSearch({
  files,
  status,
  renderEntries,
  getSelection: () => entries[selected]?.url,
  onStart: () => { generation++; lastG = 0 },
  api: vaultPage
})

function showSearch () {
  lastG = 0
  contentSearch.show()
}

document.getElementById('search-open').onclick = showSearch

function renderEntries (items, previous, fuzzy = false) {
  entries = items
  selected = -1
  files.replaceChildren()
  entries.forEach((entry, i) => {
    const element = row(fuzzy ? { ...entry, name: entry.relativePath } : entry)
    if (entry.passage) {
      const snippet = document.createElement('small')
      snippet.className = 'result-snippet'
      snippet.textContent = 'Line ' + entry.passage.line + ': ' + entry.passage.text.replace(/\s+/g, ' ')
      element.append(snippet)
    }
    element.id = 'entry-' + i
    element.tabIndex = -1
    element.setAttribute('role', 'option')
    element.onclick = () => { select(i); files.focus() }
    element.ondblclick = () => open(entry.url)
    files.append(element)
  })
  select(Math.max(0, entries.findIndex(entry => entry.url === previous)))
}

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

const preview = createVaultPreview({
  target: document.getElementById('preview'),
  listDirectory: vaultPage.listDirectory,
  open,
  row,
  sorted,
  message
})

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
  if (changed || selected === -1) preview.show(entries[selected])
}

async function refresh () {
  const previous = contentSearch.cancel()
  const mine = ++generation
  preview.clear()
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
    renderEntries(sorted(result.entries), previous)
    status.textContent = entries.length ? '' : 'Empty directory'
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
  // Let the native dialog handle focus trapping and Escape to cancel input.
  if (contentSearch.dialogOpen) return
  if (event.key === 'Escape' && contentSearch.active) {
    event.preventDefault()
    refresh()
    return
  }
  if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName) || event.target.isContentEditable) return
  if (event.key === 'Enter' && event.target.closest('button')) return
  const key = event.key
  if (key === '/') {
    event.preventDefault()
    showSearch()
    return
  }
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
