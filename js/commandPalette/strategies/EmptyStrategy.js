const browserSession = require('../../tabState.js')
/**
 * Empty State Strategy
 *
 * Handles empty input - shows all available tabs
 */

const { CommandStateStrategy } = require('../CommandStateStrategy.js')

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
      const candidates = allTabs.map(tab => ({
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
      console.error('Error showing tabs:', e)
      return []
    }
  }
}

module.exports = EmptyStrategy
