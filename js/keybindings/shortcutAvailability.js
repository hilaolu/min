function createShortcutAvailability (options) {
  const { browserSession, document, logger = console, webviews } = options

  return function checkShortcutAvailability (combo, onDecision) {
    if (!/^(shift)?\+?\w$/.test(combo) && combo !== 'mod+left' && combo !== 'mod+right') {
      onDecision(true)
      return
    }

    const selectedTabId = browserSession.tabs.getSelected()
    webviews.isFocused(selectedTabId, function (error, isFocused) {
      const selectedTab = browserSession.tabs.get(selectedTabId)
      if (error || !selectedTab.url || !isFocused) {
        const activeTag = document.activeElement && document.activeElement.tagName
        onDecision(activeTag !== 'INPUT' && activeTag !== 'TEXTAREA')
        return
      }

      webviews.isInputFocused(selectedTabId, function (error, isInputFocused) {
        if (error) {
          logger.warn(error)
          onDecision(false)
          return
        }
        onDecision(isInputFocused === false)
      })
    })
  }
}

module.exports = createShortcutAvailability
