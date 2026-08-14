/**
 * Vim Command With Args Strategy
 *
 * Unified strategy for handling all vim commands with arguments:
 * - >o [url] - Open URL with candidates from history/bookmarks
 * - >r [url] - Reload current tab or load URL in current tab
 * - >w - Close current tab
 * - >goo [query] - Google search
 * - Other vim commands from commandPaletteCommands.js
 *
 * @author Command Palette Strategy System
 * @version 2.0.0
 */

const { CommandStateStrategy } = require('../CommandStateStrategy.js')

/**
 * Command handlers registry for different vim commands
 */
const COMMAND_HANDLERS = {
  o: 'handleOpenCommand',
  r: 'handleReloadCommand',
  w: 'handleCloseCommand',
  goo: 'handleGoogleSearchCommand'
}

class VimCommandWithArgsStrategy extends CommandStateStrategy {
  constructor () {
    super('VIM_COMMAND_WITH_ARGS', 80) // High priority for specific commands

    // Cache for places module to avoid repeated requires
    this._places = null
    this._urlParser = null
    this._searchbar = null
    this._webviews = null
    this._browserUI = null
  }

  /**
   * Lazy load commonly used modules
   */
  _getModules () {
    if (!this._places) {
      try {
        this._places = require('../../places/places.js')
        this._urlParser = require('../../util/urlParser.js')
        this._searchbar = require('../../searchbar/searchbar.js')
        this._webviews = require('../../webviews.js')
        this._browserUI = require('../../browserUI.js')
      } catch (error) {
        console.error('Error loading required modules:', error)
      }
    }
    return {
      places: this._places,
      urlParser: this._urlParser,
      searchbar: this._searchbar,
      webviews: this._webviews,
      browserUI: this._browserUI
    }
  }

  /**
   * Test if this strategy matches the given input
   * @param {string} input - Current input value
   * @returns {{matches: boolean, data?: Object, priority?: number}}
   */
  matches (input) {
    const trimmed = input.trim()

    // Quick exit for invalid inputs
    if (!trimmed.startsWith('>') || trimmed === '>') {
      return { matches: false }
    }

    // Matches ">command" with optional arguments
    const match = trimmed.match(/^>(\w+)(\s+(.*))?$/i)

    if (match) {
      const command = match[1].toLowerCase()
      const args = (match[3] || '').trim()

      return {
        matches: true,
        data: { command, args },
        priority: this.priority
      }
    }

    return { matches: false }
  }

  /**
   * Update UI for this command state
   * @param {string} input - Current input value
   * @param {Object} data - Extracted data from input matching
   * @param {Object} context - Command palette context
   * @returns {Promise<Array>} Array of candidates
   */
  async updateUI (input, data, context) {
    try {
      const { command, args } = data
      const candidates = await this.generateCandidates(command, args)

      // No direct DOM updates; overlay will render candidates
      return candidates
    } catch (error) {
      console.error(`Error updating UI for vim command '${data.command}':`, error)
      return []
    }
  }

  /**
   * Generate candidates based on the vim command
   * @param {string} command - Command name (o, r, w, goo, etc.)
   * @param {string} args - Command arguments
   * @returns {Promise<Array>} Array of candidates
   */
  async generateCandidates (command, args) {
    const handlerName = COMMAND_HANDLERS[command]

    if (handlerName && typeof this[handlerName] === 'function') {
      try {
        return await this[handlerName](args)
      } catch (error) {
        console.error(`Error in ${handlerName}:`, error)
        return []
      }
    }

    // Fallback to generic command handling
    return this.handleGenericCommand(command, args)
  }

  /**
   * Handle >o command - Open URL with candidates
   * @param {string} args - URL or search query
   * @returns {Promise<Array>} Array of candidates
   */
  async handleOpenCommand (args) {
    const modules = this._getModules()
    if (!modules.places || !modules.urlParser) {
      return []
    }

    const candidates = []

    // Add typed URL as first candidate if provided
    if (args) {
      const urlCandidate = this.createURLCandidate(args, 'new-tab')
      if (urlCandidate) {
        candidates.push(urlCandidate)
      }
    }

    // Add history and bookmark results
    try {
      const results = await modules.places.searchPlaces(args, { limit: 20 })
      const historyCandidates = results.map(result =>
        this.createHistoryCandidate(result, 'new-tab')
      )
      candidates.push(...historyCandidates)
    } catch (error) {
      console.error('Error searching places for open command:', error)
    }

    return candidates.slice(0, 10)
  }

  /**
   * Handle >r command - Reload current tab or load URL
   * @param {string} args - URL or search query
   * @returns {Promise<Array>} Array of candidates
   */
  async handleReloadCommand (args) {
    const candidates = []

    if (!args) {
      // No arguments - show current page reload option
      const currentTab = tabs.get(tabs.getSelected())
      if (currentTab?.url) {
        const reloadCandidate = this.createReloadCandidate(currentTab.url, 'Current page')
        if (reloadCandidate) {
          candidates.push(reloadCandidate)
        }
      }
    } else {
      // Has arguments - show URL and search results
      const urlCandidate = this.createReloadCandidate(args, 'Load URL')
      if (urlCandidate) {
        candidates.push(urlCandidate)
      }

      const modules = this._getModules()
      if (modules.places) {
        try {
          const results = await modules.places.searchPlaces(args, { limit: 20 })
          const historyCandidates = results.map(result =>
            this.createReloadHistoryCandidate(result)
          )
          candidates.push(...historyCandidates)
        } catch (error) {
          console.error('Error searching places for reload command:', error)
        }
      }
    }

    return candidates.slice(0, 10)
  }

  /**
   * Handle >w command - Close current tab
   * @returns {Array} Array with close tab candidate
   */
  handleCloseCommand () {
    return [{
      id: 'close-tab',
      title: 'Close Tab',
      description: 'Close the current tab',
      icon: 'carbon:close',
      action: () => {
        const modules = this._getModules()
        if (modules.browserUI) {
          modules.browserUI.closeTab(tabs.getSelected())
        }
      }
    }]
  }

  /**
   * Handle >goo command - Google search
   * @param {string} args - Search query
   * @returns {Array} Array with Google search candidate
   */
  handleGoogleSearchCommand (args) {
    return [{
      id: 'google-search',
      title: `Google Search${args ? `: ${args}` : ''}`,
      description: args ? `Search Google for "${args}"` : 'Enter search query',
      icon: 'carbon:search',
      action: () => {
        if (args?.trim()) {
          const modules = this._getModules()
          if (modules.searchbar && modules.webviews) {
            const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(args)}`
            modules.searchbar.events.emit('url-selected', {
              url: searchUrl,
              background: true,
              openInForeground: true
            })
            modules.webviews.focus()
          }
        }
      }
    }]
  }

  /**
   * Handle generic commands from commandPaletteCommands.js
   * @param {string} command - Command name
   * @param {string} args - Command arguments
   * @returns {Array} Array of candidates
   */
  handleGenericCommand (command, args) {
    try {
      const availableCommands = require('../../commandPaletteCommands.js')
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
    } catch (error) {
      console.error('Error loading available commands:', error)
      return []
    }
  }

  /**
   * Create a URL candidate for opening/loading
   * @param {string} url - The URL to create a candidate for
   * @param {string} mode - 'new-tab' or 'current-tab'
   * @returns {Object|null} Candidate object
   */
  createURLCandidate (url, mode = 'new-tab') {
    if (!url?.trim()) return null

    const modules = this._getModules()
    if (!modules.urlParser) return null

    const description = mode === 'new-tab'
      ? `Open ${url} in a new tab`
      : `Load ${url} in current tab`

    return {
      id: `open-url-${mode}`,
      title: `Open URL: ${url}`,
      description: description,
      icon: 'carbon:launch',
      action: () => this.executeURLAction(url, mode)
    }
  }

  /**
   * Execute URL action (open in new tab or current tab)
   * @param {string} url - URL to open
   * @param {string} mode - 'new-tab' or 'current-tab'
   */
  executeURLAction (url, mode) {
    const modules = this._getModules()
    if (!modules.urlParser || !modules.webviews) return

    try {
      const parsedUrl = modules.urlParser.parse(url)

      if (mode === 'new-tab' && modules.searchbar) {
        modules.searchbar.events.emit('url-selected', {
          url: parsedUrl,
          background: true,
          openInForeground: true
        })
      } else {
        modules.webviews.update(tabs.getSelected(), parsedUrl)
      }
      modules.webviews.focus()
    } catch (error) {
      console.error('Error executing URL action:', error)
    }
  }

  /**
   * Create a history candidate
   * @param {Object} result - Places result object
   * @param {string} mode - 'new-tab' or 'current-tab'
   * @returns {Object} Candidate object
   */
  createHistoryCandidate (result, mode = 'new-tab') {
    const modules = this._getModules()
    if (!modules.urlParser) return null

    return {
      id: `candidate-${mode}-${result.url}`,
      title: result.title || modules.urlParser.prettyURL(modules.urlParser.getSourceURL(result.url)),
      description: modules.urlParser.basicURL(modules.urlParser.getSourceURL(result.url)),
      icon: result.isBookmarked ? 'carbon:star-filled' : 'carbon:wikis',
      action: () => this.executeHistoryAction(result.url, mode)
    }
  }

  /**
   * Execute history action
   * @param {string} url - URL to open
   * @param {string} mode - 'new-tab' or 'current-tab'
   */
  executeHistoryAction (url, mode) {
    const modules = this._getModules()
    if (!modules.webviews) return

    try {
      if (mode === 'new-tab' && modules.searchbar) {
        modules.searchbar.events.emit('url-selected', {
          url: url,
          background: true,
          openInForeground: true
        })
      } else {
        modules.webviews.update(tabs.getSelected(), url)
      }
      modules.webviews.focus()
    } catch (error) {
      console.error('Error executing history action:', error)
    }
  }

  /**
   * Create a reload candidate for current tab
   * @param {string} url - The URL to create a candidate for
   * @param {string} description - Description for the candidate
   * @returns {Object|null} Candidate object
   */
  createReloadCandidate (url, description) {
    if (!url?.trim()) return null

    const modules = this._getModules()
    if (!modules.urlParser) return null

    return {
      id: 'reload-url',
      title: `${description}: ${modules.urlParser.prettyURL(modules.urlParser.getSourceURL(url))}`,
      description: modules.urlParser.basicURL(modules.urlParser.getSourceURL(url)),
      icon: 'carbon:renew',
      action: () => this.executeReloadAction(url)
    }
  }

  /**
   * Create a reload history candidate
   * @param {Object} result - Places result object
   * @returns {Object} Candidate object
   */
  createReloadHistoryCandidate (result) {
    const modules = this._getModules()
    if (!modules.urlParser) return null

    return {
      id: `reload-candidate-${result.url}`,
      title: result.title || modules.urlParser.prettyURL(modules.urlParser.getSourceURL(result.url)),
      description: modules.urlParser.basicURL(modules.urlParser.getSourceURL(result.url)),
      icon: result.isBookmarked ? 'carbon:star-filled' : 'carbon:renew',
      action: () => this.executeReloadAction(result.url)
    }
  }

  /**
   * Execute reload action
   * @param {string} url - URL to reload with
   */
  executeReloadAction (url) {
    const modules = this._getModules()
    if (!modules.urlParser || !modules.webviews) return

    try {
      const parsedUrl = modules.urlParser.parse(url)
      modules.webviews.update(tabs.getSelected(), parsedUrl)
      modules.webviews.focus()
    } catch (error) {
      console.error('Error executing reload action:', error)
    }
  }
}

module.exports = VimCommandWithArgsStrategy
