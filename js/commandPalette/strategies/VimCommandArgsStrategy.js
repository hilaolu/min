/**
 * Vim Command Args State Strategy
 * 
 * Handles other vim commands like ">w", ">goo query", etc.
 */

const { CommandStateStrategy } = require('../CommandStateStrategy.js')

class VimCommandArgsStrategy extends CommandStateStrategy {
  constructor() {
    super('VIM_COMMAND_ARGS', 60) // Lower priority than specific command strategies
  }

  /**
   * @param {string} input - Current input value
   * @returns {{matches: boolean, data?: Object, priority?: number}}
   */
  matches(input) {
    const trimmed = input.trim()
    // Matches ">command" with optional arguments, but not exact ">" or handled by other strategies
    const match = trimmed.match(/^>(\w+)(\s+(.*))?$/i)
    
    if (match && trimmed !== '>') {
      const command = match[1].toLowerCase()
      const args = match[3] || ''
      
      // Skip if handled by specific strategies
      if (command === 'o' || command === 'r') {
        return { matches: false }
      }
      
      return {
        matches: true,
        data: { command, args: args.trim() },
        priority: this.priority
      }
    }
    
    return { matches: false }
  }

  /**
   * @returns {RegExp}
   */
  getPattern() {
    return /^>(\w+)(\s+.*)?$/i
  }

  /**
   * @param {string} input - Current input value
   * @param {Object} data - Extracted data from input matching
   * @param {Object} context - Command palette context
   * @returns {Promise<Array>} Array of candidates
   */
  async updateUI(input, data, context) {
    try {
      const candidates = this.generateCandidates(data.command, data.args)

      // Update UI
      if (context.suggestions) {
        this.renderCandidates(candidates, context)
      }

      return candidates
    } catch (e) {
      console.error('Error showing vim command candidates:', e)
      return []
    }
  }

  /**
   * Generate candidates for vim commands
   * @param {string} command - Command name
   * @param {string} args - Command arguments
   * @returns {Array} Array of candidates
   */
  generateCandidates(command, args) {
    const availableCommands = require('../../commandPaletteCommands.js')
    
    // Handle special cases
    switch (command) {
      case 'goo':
        return this.generateGoogleSearchCandidate(args)
      case 'w':
        return this.generateCloseTabCandidate()
      default:
        // Find matching command from available commands
        const matchedCommands = availableCommands.filter(cmd => 
          cmd.id.toLowerCase() === command
        )
        return matchedCommands.map(cmd => ({
          id: cmd.id,
          title: cmd.title,
          description: cmd.description,
          icon: cmd.icon,
          shortcut: cmd.shortcut,
          action: cmd.action
        }))
    }
  }

  /**
   * Generate Google search candidate
   * @param {string} query - Search query
   * @returns {Array} Array with Google search candidate
   */
  generateGoogleSearchCandidate(query) {
    return [{
      id: 'google-search',
      title: `Google Search: ${query || '...'}`,
      description: query ? `Search Google for "${query}"` : 'Enter search query',
      icon: 'carbon:search',
      action: () => {
        if (query && query.trim()) {
          try {
            const searchbar = require('../../searchbar/searchbar.js')
            const webviews = require('../../webviews.js')
            const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`
            searchbar.events.emit('url-selected', { url: searchUrl, background: true, openInForeground: true })
            webviews.focus()
          } catch (e) {
            console.error('Error performing Google search:', e)
          }
        }
      }
    }]
  }

  /**
   * Generate close tab candidate
   * @returns {Array} Array with close tab candidate
   */
  generateCloseTabCandidate() {
    return [{
      id: 'close-tab',
      title: 'Close Tab',
      description: 'Close the current tab',
      icon: 'carbon:close',
      action: () => {
        try {
          const browserUI = require('../../browserUI.js')
          browserUI.closeTab(tabs.getSelected())
        } catch (e) {
          console.error('Error closing tab:', e)
        }
      }
    }]
  }

  /**
   * @param {Object} data - Current state data
   * @returns {string}
   */
  getPlaceholder(data = {}) {
    const command = data.command || ''
    switch (command) {
      case 'goo':
        return 'Enter Google search query...'
      case 'w':
        return 'Close current tab'
      default:
        return `${command} command...`
    }
  }

  /**
   * @returns {string[]}
   */
  getInputClasses() {
    return ['vim-command-args-mode']
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
      emptyEl.textContent = 'Command not found'
      context.suggestions.appendChild(emptyEl)
      return
    }

    candidates.forEach((candidate, index) => {
      const suggestionEl = this.createSuggestionElement(candidate, index, context)
      context.suggestions.appendChild(suggestionEl)
    })
  }

  /**
   * Create a suggestion element for vim command candidates
   * @param {Object} candidate - Candidate object
   * @param {number} index - Index of the candidate
   * @param {Object} context - Command palette context
   * @returns {HTMLElement} Suggestion element
   */
  createSuggestionElement(candidate, index, context) {
    const suggestionEl = document.createElement('button')
    suggestionEl.className = 'command-suggestion vim-command-args'
    
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

module.exports = VimCommandArgsStrategy 