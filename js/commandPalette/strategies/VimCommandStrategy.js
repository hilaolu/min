/**
 * Vim Command State Strategy
 * 
 * Handles ">" prefix - shows available vim commands
 */

const { CommandStateStrategy } = require('../CommandStateStrategy.js')

class VimCommandStrategy extends CommandStateStrategy {
  constructor() {
    super('VIM_COMMAND', 70) // High priority for exact matches
  }

  /**
   * @param {string} input - Current input value
   * @returns {{matches: boolean, data?: Object, priority?: number}}
   */
  matches(input) {
    const trimmed = input.trim()
    // Matches exactly ">"
    const matches = trimmed === '>'
    
    return {
      matches,
      data: {},
      priority: this.priority
    }
  }

  /**
   * @returns {RegExp}
   */
  getPattern() {
    return /^>$/
  }

  /**
   * @param {string} input - Current input value
   * @param {Object} data - Extracted data from input matching
   * @param {Object} context - Command palette context
   * @returns {Promise<Array>} Array of candidates
   */
  async updateUI(input, data, context) {
    try {
      // Get available commands
      const availableCommands = require('../../commandPaletteCommands.js')
      
      // Limit to 10 commands for keyboard shortcuts (0-9)
      const candidates = availableCommands.slice(0, 10).map(cmd => ({
        id: cmd.id,
        title: cmd.title,
        description: cmd.description,
        icon: cmd.icon,
        shortcut: cmd.shortcut,
        action: cmd.action
      }))

      // Update UI
      if (context.suggestions) {
        this.renderCandidates(candidates, context)
      }

      return candidates
    } catch (e) {
      console.error('Error showing vim commands:', e)
      return []
    }
  }

  /**
   * @param {Object} data - Current state data
   * @returns {string}
   */
  getPlaceholder(data = {}) {
    return 'Enter vim command (w, r, o, goo)...'
  }

  /**
   * @returns {string[]}
   */
  getInputClasses() {
    return ['vim-command-mode']
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
      emptyEl.textContent = 'No vim commands available'
      context.suggestions.appendChild(emptyEl)
      return
    }

    candidates.forEach((candidate, index) => {
      const suggestionEl = this.createSuggestionElement(candidate, index, context)
      context.suggestions.appendChild(suggestionEl)
    })
  }

  /**
   * Create a suggestion element for vim commands
   * @param {Object} candidate - Candidate object
   * @param {number} index - Index of the candidate
   * @param {Object} context - Command palette context
   * @returns {HTMLElement} Suggestion element
   */
  createSuggestionElement(candidate, index, context) {
    const suggestionEl = document.createElement('button')
    suggestionEl.className = 'command-suggestion vim-command'
    
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

module.exports = VimCommandStrategy 