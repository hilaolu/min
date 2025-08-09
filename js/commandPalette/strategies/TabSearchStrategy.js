/**
 * Tab Search State Strategy
 * 
 * Handles searching tabs by title or URL
 */

const { CommandStateStrategy } = require('../CommandStateStrategy.js')

class TabSearchStrategy extends CommandStateStrategy {
  constructor() {
    super('TAB_SEARCH', 50) // Medium priority
  }

  /**
   * @param {string} input - Current input value
   * @returns {{matches: boolean, data?: Object, priority?: number}}
   */
  matches(input) {
    const trimmed = input.trim()
    // Matches any non-empty text that doesn't start with > or >>>
    const matches = trimmed !== '' && !trimmed.startsWith('>')
    
    return {
      matches,
      data: { query: trimmed },
      priority: this.priority
    }
  }

  /**
   * @returns {RegExp}
   */
  getPattern() {
    return /^(?!>).+/
  }

  /**
   * @param {string} input - Current input value
   * @param {Object} data - Extracted data from input matching
   * @param {Object} context - Command palette context
   * @returns {Promise<Array>} Array of candidates
   */
  async updateUI(input, data, context) {
    try {
      // Ensure tabs module is available
      if (typeof tabs === 'undefined' || !tabs.get) {
        console.warn('Tabs module not available')
        return []
      }
      
      const allTabs = tabs.get()
      const searchQuery = (data.query || '').toLowerCase()
      
      // Filter tabs by search query
      const matchedTabs = allTabs.filter(tab => {
        const title = (tab.title || '').toLowerCase()
        const url = (tab.url || '').toLowerCase()
        return title.includes(searchQuery) || url.includes(searchQuery)
      })

      const candidates = matchedTabs.map(tab => ({
        id: `tab-${tab.id}`,
        title: tab.title || 'New Tab',
        description: tab.url || 'min://newtab',
        icon: 'carbon:document',
        action: () => {
          try {
            var browserUI = require('browserUI.js')
            browserUI.switchToTab(tab.id)
          } catch (e) {
            console.error('Error switching to tab:', e)
          }
        }
      }))

      // No direct DOM updates; overlay will render candidates
      return candidates
    } catch (e) {
      console.error('Error searching tabs:', e)
      return []
    }
  }

  /**
   * @param {Object} data - Current state data
   * @returns {string}
   */
  getPlaceholder(data = {}) {
    return 'Search tabs...'
  }

  /**
   * @returns {string[]}
   */
  getInputClasses() {
    return ['tab-search-mode']
  }

  // No-op DOM methods for overlay-only architecture
  renderCandidates() { return }
  createSuggestionElement() { return null }
  highlightSearchTerm(text) { return text || '' }
}

module.exports = TabSearchStrategy 