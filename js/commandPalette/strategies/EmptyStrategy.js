/**
 * Empty State Strategy
 * 
 * Handles empty input - shows all available tabs
 */

const { CommandStateStrategy } = require('../CommandStateStrategy.js')

class EmptyStrategy extends CommandStateStrategy {
  constructor() {
    super('EMPTY', 100) // High priority as fallback
  }

  /**
   * @param {string} input - Current input value
   * @returns {{matches: boolean, data?: Object, priority?: number}}
   */
  matches(input) {
    const trimmed = input.trim()
    return {
      matches: trimmed === '',
      data: {},
      priority: this.priority
    }
  }

  /**
   * @returns {RegExp}
   */
  getPattern() {
    return /^$/
  }

  /**
   * @param {string} input - Current input value
   * @param {Object} data - Extracted data from input matching
   * @param {Object} context - Command palette context
   * @returns {Promise<Array>} Array of candidates
   */
  async updateUI(input, data, context) {
    try {
      // Get all tabs - ensure tabs module is available
      if (typeof tabs === 'undefined' || !tabs.get) {
        console.warn('Tabs module not available')
        return []
      }
      
      const allTabs = tabs.get()
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

  /**
   * @param {Object} data - Current state data
   * @returns {string}
   */
  getPlaceholder(data = {}) {
    return 'Search tabs or type >w, >r...'
  }

  /**
   * @returns {string[]}
   */
  getInputClasses() {
    return []
  }

  /**
   * Render candidates in the UI
   * (overlay handles UI, so this is a no-op)
   */
  renderCandidates(candidates, context) {
    return
  }

  /**
   * Create a suggestion element for the UI
   * (overlay handles UI, so this returns null)
   */
  createSuggestionElement(candidate, index, context) {
    return null
  }
}

module.exports = EmptyStrategy 