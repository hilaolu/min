/* global vaultPage */
let generation = 0
function renderEntries (entries, target) {
  entries.sort((a, b) => a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'directory' ? -1 : 1).forEach(entry => {
    const li = document.createElement('li')
    const link = document.createElement('a')
    link.href = entry.url
    link.textContent = entry.relativePath
    link.onclick = event => { event.preventDefault(); vaultPage.open(entry.url) }
    if (entry.kind === 'directory') {
      const details = document.createElement('details')
      const summary = document.createElement('summary')
      summary.append(link)
      const children = document.createElement('ul')
      details.append(summary, children)
      details.ontoggle = async () => {
        if (!details.open) return
        const result = await vaultPage.listDirectory(entry.url)
        children.replaceChildren()
        if (result.ok) renderEntries(result.entries, children)
        else children.textContent = result.error
      }
      li.append(details)
    } else li.append(link)
    target.append(li)
  })
}
async function refresh () {
  const mine = ++generation
  const result = await vaultPage.listCurrent(document.getElementById('search').value)
  if (mine !== generation) return
  document.getElementById('status').textContent = result.ok ? '' : result.error
  if (!result.ok) return
  const breadcrumb = document.getElementById('breadcrumb')
  breadcrumb.replaceChildren()
  const segments = new URL(result.url).pathname.split('/').filter(Boolean)
  for (let i = 0; i <= segments.length; i++) {
    const button = document.createElement('button')
    button.textContent = i ? decodeURIComponent(segments[i - 1]) : 'Vault'
    button.onclick = () => vaultPage.open('vault://local/' + segments.slice(0, i).join('/') + (i ? '/' : ''))
    breadcrumb.append(button)
  }
  const files = document.getElementById('files')
  files.replaceChildren()
  renderEntries(result.entries, files)
}
document.getElementById('refresh').onclick = refresh
document.getElementById('search').oninput = refresh
refresh()
