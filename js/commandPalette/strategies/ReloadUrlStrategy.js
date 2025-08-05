/**
 * Reload URL State Strategy
 * 
 * Handles ">r [url]" command - reloads current tab or loads URL in current tab
 */

const { CommandStateStrategy } = require('../CommandStateStrategy.js')

class ReloadUrlStrategy extends CommandStateStrategy {
  constructor() {
    super('RELOAD_URL', 80) // High priority for specific commands
  }

  /**
   * @param {string} input - Current input value
   * @returns {{matches: boolean, data?: Object, priority?: number}}
   */
  matches(input) {
    const trimmed = input.trim()
    // Matches ">r" optionally followed by space and arguments
    const match = trimmed.match(/^>r(\s+(.*))?$/i)
    
    if (match) {
      const args = match[2] || ''
      return {
        matches: true,
        data: { command: 'r', args: args.trim() },
        priority: this.priority
      }
    }
    
    return { matches: false }
  }

  /**
   * @returns {RegExp}
   */
  getPattern() {
    return /^>r(\s+.*)?$/i
  }

  /**
   * @param {string} input - Current input value
   * @param {Object} data - Extracted data from input matching
   * @param {Object} context - Command palette context
   * @returns {Promise<Array>} Array of candidates
   */
  async updateUI(input, data, context) {
    try {
      const searchQuery = data.args || ''
      const candidates = await this.generateCandidates(searchQuery)

      // Update UI
      if (context.suggestions) {
        this.renderCandidates(candidates, context, searchQuery)
      }

      return candidates
    } catch (e) {
      console.error('Error showing reload candidates:', e)
      return []
    }
  }

  /**
   * Generate reload candidates
   * @param {string} searchQuery - Search query to filter results
   * @returns {Promise<Array>} Array of candidates
   */
  async generateCandidates(searchQuery = '') {
    try {
      let candidates = []
      
      if (!searchQuery || !searchQuery.trim()) {
        // No search query - show only current page
        const currentTab = tabs.get(tabs.getSelected())
        if (currentTab && currentTab.url) {
          candidates.push(this.createReloadCandidate(currentTab.url, 'Current page'))
        }
      } else {
        // Has search query - follow >o logic but reload in current tab
        const places = require('../../places/places.js')
        
        // Always add typed URL as first candidate (default selection)
        const candidate = this.createReloadCandidate(searchQuery, 'Load URL')
        if (candidate) {
          candidates.push(candidate)
        }

        // Add history and bookmark results
        const results = await places.searchPlaces(searchQuery, { limit: 20 })
        candidates = candidates.concat(results.map(result => this.createReloadHistoryCandidate(result)))
      }

      return candidates.slice(0, 10)
    } catch (error) {
      console.error('Error generating reload candidates:', error)
      return []
    }
  }

  /**
   * Create a reload candidate for the current URL or typed URL
   * @param {string} url - The URL to create a candidate for
   * @param {string} description - Description for the candidate
   * @returns {Object|null} Candidate object
   */
  createReloadCandidate(url, description) {
    if (!url || !url.trim()) {
      return null
    }
    
    const urlParser = require('../../util/urlParser.js')
    
    return {
      id: 'reload-url',
      title: `${description}: ${urlParser.prettyURL(urlParser.getSourceURL(url))}`,
      description: urlParser.basicURL(urlParser.getSourceURL(url)),
      icon: 'carbon:renew',
      action: () => {
        try {
          const webviews = require('../../webviews.js')
          const parsedUrl = urlParser.parse(url)
          webviews.update(tabs.getSelected(), parsedUrl)
          webviews.focus()
        } catch (e) {
          console.error('Error loading URL:', e)
        }
      }
    }
  }

  /**
   * Create a reload history candidate from a places result
   * @param {Object} result - Places result object
   * @returns {Object} Candidate object
   */
  createReloadHistoryCandidate(result) {
    const urlParser = require('../../util/urlParser.js')
    const webviews = require('../../webviews.js')
    
    return {
      id: `reload-candidate-${result.url}`,
      title: result.title || urlParser.prettyURL(urlParser.getSourceURL(result.url)),
      description: urlParser.basicURL(urlParser.getSourceURL(result.url)),
      icon: result.isBookmarked ? 'carbon:star-filled' : 'carbon:renew',
      action: () => {
        webviews.update(tabs.getSelected(), result.url)
        webviews.focus()
      }
    }
  }

  /**
   * @param {Object} data - Current state data
   * @returns {string}
   */
  getPlaceholder(data = {}) {
    return data.args ? `Reload with: ${data.args}...` : 'Reload current tab or enter URL...'
  }

  /**
   * @returns {string[]}
   */
  getInputClasses() {
    return ['reload-url-mode']
  }

  /**
   * Render candidates in the UI
   * @param {Array} candidates - Candidates to render
   * @param {Object} context - Command palette context
   * @param {string} searchQuery - Search query for highlighting
   */
  renderCandidates(candidates, context, searchQuery = '') {
    context.suggestions.innerHTML = ''

    if (candidates.length === 0) {
      const emptyEl = document.createElement('div')
      emptyEl.className = 'command-palette-empty'
      emptyEl.textContent = searchQuery ? 'No matching URLs found' : 'No page to reload'
      context.suggestions.appendChild(emptyEl)
      return
    }

    candidates.forEach((candidate, index) => {
      const suggestionEl = this.createSuggestionElement(candidate, index, context, searchQuery)
      context.suggestions.appendChild(suggestionEl)
    })
  }

  /**
   * Create a suggestion element for reload candidates
   * @param {Object} candidate - Candidate object
   * @param {number} index - Index of the candidate
   * @param {Object} context - Command palette context
   * @param {string} searchQuery - Search query for highlighting
   * @returns {HTMLElement} Suggestion element
   */
  createSuggestionElement(candidate, index, context, searchQuery) {
    const suggestionEl = document.createElement('button')
    suggestionEl.className = 'command-suggestion reload-candidate'
    
    // Highlight search terms in title and description
    const highlightedTitle = this.highlightSearchTerm(candidate.title, searchQuery)
    let highlightedDescription = this.highlightSearchTerm(candidate.description, searchQuery)
    
    if (highlightedDescription.length > 80) {
      highlightedDescription = highlightedDescription.substring(0, 80) + '...'
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

module.exports = ReloadUrlStrategy 