const browserSession = require('../../tabState.js')
/**
 * Empty State Strategy
 *
 * Handles empty input - shows all available tabs
 */

const { CommandStateStrategy } = require('../CommandStateStrategy.js')
const tabCandidate = require('../tabCandidate.js')

class EmptyStrategy extends CommandStateStrategy {
  constructor () {
    super('EMPTY', 100) // High priority as fallback
  }

  /**
   * @param {string} input - Current input value
   * @returns {{matches: boolean, data?: Object, priority?: number}}
   */
  matches (input) {
    const trimmed = input.trim()
    return {
      matches: trimmed === '',
      data: {},
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
      return allTabs.map(tabCandidate)
    } catch (e) {
      console.error('Error showing tabs:', e)
      return []
    }
  }
}

module.exports = EmptyStrategy
