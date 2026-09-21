function createVaultContentSearch ({ files, status, renderEntries, getSelection, onStart, api }) {
  const form = document.getElementById('fuzzy-form')
  const query = document.getElementById('fuzzy-query')
  const dialog = document.getElementById('fuzzy-dialog')
  let active = false
  let generation = 0
  let browsingSelection

  form.addEventListener('submit', async event => {
    event.preventDefault()
    if (!query.value.trim()) { query.focus(); return }
    // Refining a search must not replace the original browsing selection.
    if (!active) browsingSelection = getSelection()
    active = true
    onStart()
    dialog.close()
    files.focus()
    const mine = ++generation
    const options = { exact: document.getElementById('fuzzy-exact').checked, limit: Number(document.getElementById('fuzzy-limit').value) }
    status.textContent = 'Searching file contents…'
    renderEntries([])
    files.setAttribute('aria-busy', 'true')
    try {
      const result = await api.searchContents(query.value, options)
      if (mine !== generation) return
      if (!result.ok) { status.textContent = result.error; return }
      renderEntries(result.entries, null, true)
      status.textContent = result.entries.length ? 'Showing ' + result.entries.length + ' of ' + (result.total ?? result.entries.length) + ' matching files' : 'No matches'
      if (result.notes?.length) status.textContent += ' — ' + result.notes.join('; ') + '; search a subfolder to narrow the scan'
      else if (result.scanLimited) status.textContent += ' — scan incomplete; search a subfolder to narrow the scan'
      else if (result.truncated) status.textContent += ' — refine the query, enable Exact phrase, or increase Top'
      if (result.skipped) status.textContent += ' — ' + result.skipped + ' binary, non-UTF-8, or inaccessible entries skipped'
      files.focus()
    } catch (_) {
      if (mine === generation) status.textContent = 'Content search failed. Check vault Settings.'
    } finally {
      if (mine === generation) files.setAttribute('aria-busy', 'false')
    }
  })
  document.getElementById('fuzzy-close').onclick = () => dialog.close()

  return {
    get active () { return active },
    get dialogOpen () { return dialog.open },
    show () {
      dialog.showModal()
      query.focus()
      query.select()
    },
    cancel () {
      const previous = active ? browsingSelection : getSelection()
      if (active) api.cancelContentSearch().catch(() => {})
      active = false
      generation++
      browsingSelection = undefined
      dialog.close()
      return previous
    }
  }
}

window.createVaultContentSearch = createVaultContentSearch
