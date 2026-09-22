function tabCandidate (tab) {
  return {
    id: `tab-${tab.id}`,
    title: tab.title || 'New Tab',
    description: tab.url || 'min://newtab',
    icon: 'carbon:document',
    action: () => {
      try {
        const browserUI = require('browserUI.js')
        browserUI.switchToTab(tab.id)
      } catch (e) {
        console.error('Error switching to tab:', e)
      }
    }
  }
}

module.exports = tabCandidate
