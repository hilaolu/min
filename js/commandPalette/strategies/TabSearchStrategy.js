const browserSession = require('../../tabState.js')
/**
 * Tab Search State Strategy
 *
 * Handles searching tabs by title or URL
 */

const { CommandStateStrategy } = require('../CommandStateStrategy.js')
const tabCandidate = require('../tabCandidate.js')

class TabSearchStrategy extends CommandStateStrategy {
  constructor () {
    super('TAB_SEARCH', 50) // Medium priority
  }

  /**
   * @param {string} input - Current input value
   * @returns {{matches: boolean, data?: Object, priority?: number}}
   */
  matches (input) {
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
   * @param {string} input - Current input value
   * @param {Object} data - Extracted data from input matching
   * @param {Object} context - Command palette context
   * @returns {Promise<Array>} Array of candidates
   */
  async updateUI (input, data, context) {
    try {
      const allTabs = browserSession.tabs.get()
      const searchQuery = (data.query || '').toLowerCase()

      // Filter tabs by search query
      const matchedTabs = allTabs.filter(tab => {
        const title = (tab.title || '').toLowerCase()
        const url = (tab.url || '').toLowerCase()
        return title.includes(searchQuery) || url.includes(searchQuery)
      })

      return matchedTabs.map(tabCandidate)
    } catch (e) {
      console.error('Error searching tabs:', e)
      return []
    }
  }
}

module.exports = TabSearchStrategy
