function initializeBrowsingDataSettings (options = {}) {
  const button = options.button || document.getElementById('clear-browsing-data')
  const status = options.status || document.getElementById('clear-browsing-data-status')
  const host = options.host || window.settingsHost
  const confirmAction = options.confirm || window.confirm.bind(window)
  const logger = options.logger || console

  button.addEventListener('click', async function () {
    const confirmed = confirmAction(
      'Clear cookies, site storage, and caches? Browsing history and bookmarks will not be affected.'
    )
    if (!confirmed) return

    button.disabled = true
    status.textContent = 'Clearing browsing data…'

    try {
      const result = await host.clearBrowsingData()
      if (result?.ok === false) {
        throw new Error(result.error?.message || 'Browsing data cleanup failed')
      }
      status.textContent = 'Browsing data cleared.'
    } catch (error) {
      logger.error('Failed to clear browsing data:', error)
      status.textContent = 'Could not clear browsing data. Try again.'
    } finally {
      button.disabled = false
    }
  })
}

if (typeof window !== 'undefined') {
  initializeBrowsingDataSettings()
}

if (typeof module !== 'undefined') {
  module.exports = initializeBrowsingDataSettings
}
