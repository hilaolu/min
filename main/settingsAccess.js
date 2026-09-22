const readOnlyPages = new Set([
  '/pages/error/index.html',
  '/pages/sessionRestoreError/index.html'
])
const readerSettings = new Set(['readerData', 'readerDayTheme', 'readerNightTheme'])

// URLs alone are not authority: the contents must belong to the live chrome or
// tab registry, and only the current main frame may use the settings transport.
function createSettingsAccess ({ isChrome, isTab }) {
  return function authorize (event, operation, key) {
    try {
      const { sender, senderFrame } = event
      if (!sender || sender.isDestroyed() || !senderFrame || senderFrame !== sender.mainFrame) return false
      const url = new URL(senderFrame.url)
      if (url.protocol !== 'min:' || url.host !== 'app' || url.username || url.password) return false
      if (operation !== 'read' && operation !== 'write') return false
      if (isChrome(sender)) return url.pathname === '/index.html'
      if (!isTab(sender)) return false
      if (url.pathname === '/pages/settings/index.html') return true
      if (url.pathname === '/reader/index.html') return operation === 'read' || readerSettings.has(key)
      return operation === 'read' && readOnlyPages.has(url.pathname)
    } catch (_) {
      // Detached/destroyed frames can throw while their URL is being read.
      return false
    }
  }
}

module.exports = createSettingsAccess
