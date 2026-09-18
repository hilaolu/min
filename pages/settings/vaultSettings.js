async function initializeVaultSettings (document, api) {
  const form = document.getElementById('vault-root-form')
  const input = document.getElementById('vault-root-path')
  const button = document.getElementById('select-vault-root')
  const status = document.getElementById('vault-root-status')
  let edited = false
  let busy = true
  button.disabled = true

  input.addEventListener('input', () => {
    edited = true
    status.textContent = ''
  })
  form.addEventListener('submit', async event => {
    event.preventDefault()
    if (busy) return
    busy = true
    input.disabled = button.disabled = true
    status.textContent = 'Saving…'
    try {
      const result = await api.selectRoot(input.value)
      if (result.ok) {
        input.value = result.directory
        status.textContent = 'Saved'
      } else status.textContent = result.canceled ? 'Unchanged' : result.error
    } catch (_) {
      status.textContent = 'Unable to save folder.'
    } finally {
      busy = false
      input.disabled = button.disabled = false
    }
  })

  try {
    const result = await api.getRoot()
    if (!result.ok) throw new Error('Unable to load vault folder')
    // A slow response must not replace a path the user has started typing.
    if (!edited) input.value = result.directory
  } catch (_) {
    status.textContent = 'Unable to load folder.'
  } finally {
    busy = false
    button.disabled = false
  }
}

if (typeof module !== 'undefined') {
  module.exports = initializeVaultSettings
} else {
  initializeVaultSettings(document, window.vaultSettings)
}
