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

      // Update UI
      if (context.suggestions) {
        this.renderCandidates(candidates, context, searchQuery)
      }

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

  /**
   * Render candidates in the UI with search highlighting
   * @param {Array} candidates - Candidates to render
   * @param {Object} context - Command palette context
   * @param {string} searchQuery - Search query for highlighting
   */
  renderCandidates(candidates, context, searchQuery = '') {
    context.suggestions.innerHTML = ''

    if (candidates.length === 0) {
      const emptyEl = document.createElement('div')
      emptyEl.className = 'command-palette-empty'
      emptyEl.textContent = 'No matching tabs found'
      context.suggestions.appendChild(emptyEl)
      return
    }

    candidates.forEach((candidate, index) => {
      const suggestionEl = this.createSuggestionElement(candidate, index, context, searchQuery)
      context.suggestions.appendChild(suggestionEl)
    })
  }

  /**
   * Create a suggestion element with search highlighting
   * @param {Object} candidate - Candidate object
   * @param {number} index - Index of the candidate
   * @param {Object} context - Command palette context
   * @param {string} searchQuery - Search query for highlighting
   * @returns {HTMLElement} Suggestion element
   */
  createSuggestionElement(candidate, index, context, searchQuery) {
    const suggestionEl = document.createElement('button')
    suggestionEl.className = 'command-suggestion'
    
    // Highlight search terms in title and description
    const highlightedTitle = this.highlightSearchTerm(candidate.title, searchQuery)
    let highlightedDescription = this.highlightSearchTerm(candidate.description, searchQuery)
    
    if (highlightedDescription.length > 60) {
      highlightedDescription = highlightedDescription.substring(0, 60) + '...'
    }

    // Show keyboard shortcut number for candidates (0-9)
    const shortcutNumber = index < 10 ? `<div class="command-suggestion-number">${index}</div>` : ''

    suggestionEl.innerHTML = `
      ${shortcutNumber}
      <i class="i ${candidate.icon} command-suggestion-icon"></i>
      <div class="command-suggestion-content">
        <div class="command-suggestion-title">${highlightedTitle}</div>
        <div class="command-suggestion-description">${highlightedDescription}</div>
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

  /**
   * Highlight search terms in text
   * @param {string} text - Text to highlight
   * @param {string} searchQuery - Search query
   * @returns {string} Text with highlighted search terms
   */
  highlightSearchTerm(text, searchQuery) {
    if (!text || !searchQuery) {
      return text || ''
    }

    // Escape HTML to prevent XSS
    const escapeHtml = (str) => {
      const div = document.createElement('div')
      div.textContent = str
      return div.innerHTML
    }

    const escapedText = escapeHtml(text)
    const escapedQuery = escapeHtml(searchQuery)
    
    try {
      // Case-insensitive highlighting
      const regex = new RegExp(`(${escapedQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi')
      return escapedText.replace(regex, '<mark>$1</mark>')
    } catch (error) {
      // If regex fails, return original text
      return escapedText
    }
  }
}

module.exports = TabSearchStrategy 