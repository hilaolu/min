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

      // Update UI
      if (context.suggestions) {
        this.renderCandidates(candidates, context)
      }

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
   * @param {Array} candidates - Candidates to render
   * @param {Object} context - Command palette context
   */
  renderCandidates(candidates, context) {
    context.suggestions.innerHTML = ''

    if (candidates.length === 0) {
      const emptyEl = document.createElement('div')
      emptyEl.className = 'command-palette-empty'
      emptyEl.textContent = 'No tabs available'
      context.suggestions.appendChild(emptyEl)
      return
    }

    candidates.forEach((candidate, index) => {
      const suggestionEl = this.createSuggestionElement(candidate, index, context)
      context.suggestions.appendChild(suggestionEl)
    })
  }

  /**
   * Create a suggestion element for the UI
   * @param {Object} candidate - Candidate object
   * @param {number} index - Index of the candidate
   * @param {Object} context - Command palette context
   * @returns {HTMLElement} Suggestion element
   */
  createSuggestionElement(candidate, index, context) {
    const suggestionEl = document.createElement('button')
    suggestionEl.className = 'command-suggestion'
    
    let description = candidate.description
    if (description && description.length > 60) {
      description = description.substring(0, 60) + '...'
    }

    // Show keyboard shortcut number for candidates (0-9)
    const shortcutNumber = index < 10 ? `<div class="command-suggestion-number">${index}</div>` : ''

    suggestionEl.innerHTML = `
      ${shortcutNumber}
      <i class="i ${candidate.icon} command-suggestion-icon"></i>
      <div class="command-suggestion-content">
        <div class="command-suggestion-title">${candidate.title}</div>
        <div class="command-suggestion-description">${description}</div>
      </div>
      ${candidate.shortcut ? `<div class="command-suggestion-shortcut">${candidate.shortcut}</div>` : ''}
    `

    // Add selected class if this is the currently selected item
    if (index === (context.selectedIndex || 0)) {
      suggestionEl.classList.add('selected')
    }

    // Disable mouse interactions to prevent interference with keyboard navigation
    const preventMouseInteraction = (e) => {
      e.preventDefault()
      e.stopPropagation()
    }
    
    suggestionEl.addEventListener('click', preventMouseInteraction)
    suggestionEl.addEventListener('mousedown', preventMouseInteraction)
    suggestionEl.addEventListener('mouseenter', preventMouseInteraction)

    return suggestionEl
  }
}

module.exports = EmptyStrategy 