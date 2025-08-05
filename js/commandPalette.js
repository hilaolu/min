const EventEmitter = require('events')
var keybindings = require('keybindings.js')
var modalMode = require('modalMode.js')
var availableCommands = require('commandPaletteCommands.js')

/**
 * Command palette module for vim-like command interface
 * Provides quick access to browser functions via keyboard shortcuts
 * 
 * Features:
 * - Vim-like command syntax (>w, >r, >o url, etc.)
 * - Tab switching and searching
 * - URL opening with history/bookmark candidates
 * - Keyboard shortcuts (Ctrl+0-9) for quick selection
 * - Intuitive shortcuts (Ctrl+T, Ctrl+., Ctrl+O)
 * - REPL mode (>>>) for JavaScript execution in current tab
 */
var commandPalette = {
  el: null,
  input: null,
  suggestions: null,
  isVisible: false,
  selectedIndex: 0,
  filteredCommands: [],
  events: new EventEmitter(),
  
  // REPL mode properties
  isReplMode: false,
  replHistory: [],
  replHistoryIndex: 0,
  replInputHistory: [],
  replInputHistoryIndex: 0,

  /**
   * Initialize the command palette
   * Sets up DOM elements and event listeners
   */
  initialize: function () {
    commandPalette.el = document.getElementById('command-palette')
    commandPalette.input = document.getElementById('command-palette-input')
    commandPalette.suggestions = document.getElementById('command-palette-suggestions')

    // Set up event listeners
    commandPalette.input.addEventListener('input', commandPalette.handleInput)
    commandPalette.input.addEventListener('keydown', commandPalette.handleKeydown)

    // Close when clicking outside
    commandPalette.el.addEventListener('click', function (e) {
      if (e.target === commandPalette.el) {
        commandPalette.hide()
      }
    })

    // Initialize with empty list
    commandPalette.filteredCommands = []
    commandPalette.renderSuggestions()
  },

  /**
   * Show the command palette with empty input
   */
  show: function () {
    if (commandPalette.isVisible) return

    commandPalette.isVisible = true
    commandPalette.el.hidden = false
    
    document.body.classList.add('is-command-palette-mode')
    
    var webviews = require('webviews.js')
    webviews.requestPlaceholder('commandPalette')

    commandPalette.selectedIndex = 0
    commandPalette.input.value = ''
    commandPalette.isReplMode = false
    
    try {
      commandPalette.showTabs()
    } catch (e) {
      console.error('Error showing tabs on command palette open:', e)
      commandPalette.filteredCommands = []
      commandPalette.renderSuggestions()
    }

    setTimeout(() => {
      commandPalette.input.focus()
    }, 100)
  },

  /**
   * Show the command palette with a pre-filled prefix
   * @param {string} prefix - The prefix to pre-fill in the input
   */
  showWithPrefix: function (prefix) {
    if (commandPalette.isVisible) return

    commandPalette.isVisible = true
    commandPalette.el.hidden = false
    
    document.body.classList.add('is-command-palette-mode')
    
    var webviews = require('webviews.js')
    webviews.requestPlaceholder('commandPalette')

    commandPalette.selectedIndex = 0
    commandPalette.input.value = prefix
    
    // Check if entering REPL mode
    if (prefix === '>>>') {
      commandPalette.enterReplMode()
    } else {
      commandPalette.handleInput()
    }
    
    setTimeout(() => {
      commandPalette.input.focus()
      commandPalette.input.setSelectionRange(prefix.length, prefix.length)
    }, 100)
  },

  /**
   * Enter REPL mode
   */
  enterReplMode: function () {
    commandPalette.isReplMode = true
    commandPalette.input.value = '>>> '
    commandPalette.input.placeholder = 'Enter JavaScript code...'
    commandPalette.input.classList.add('repl-mode')
    commandPalette.renderReplHistory()
    commandPalette.input.setSelectionRange(4, 4) // Position cursor after >>>
  },

  /**
   * Exit REPL mode
   */
  exitReplMode: function () {
    commandPalette.isReplMode = false
    commandPalette.input.placeholder = 'Search tabs or type >w, >r...'
    commandPalette.input.classList.remove('repl-mode')
    commandPalette.showTabs()
  },

  /**
   * Hide the command palette
   */
  hide: function () {
    if (!commandPalette.isVisible) return

    commandPalette.isVisible = false
    commandPalette.el.hidden = true
    document.body.classList.remove('is-command-palette-mode')
    commandPalette.input.blur()
    commandPalette.isReplMode = false
    commandPalette.input.classList.remove('repl-mode')
    
    var webviews = require('webviews.js')
    webviews.hidePlaceholder('commandPalette')
  },

  /**
   * Handle input changes in the command palette
   * Routes to appropriate handlers based on input content
   */
  handleInput: function () {
    const query = commandPalette.input.value.trim()
    
    // Check for REPL mode entry
    if (query === '>>>') {
      commandPalette.enterReplMode()
      return
    }
    
    // Handle REPL mode input
    if (commandPalette.isReplMode) {
      commandPalette.handleReplInput()
      return
    }
    
    if (query === '') {
      commandPalette.showTabs()
    } else if (query.startsWith('>')) {
      commandPalette.handleVimCommand(query)
    } else {
      commandPalette.searchTabs(query)
    }

    commandPalette.selectedIndex = 0
  },

  /**
   * Handle REPL mode input
   */
  handleReplInput: function () {
    const input = commandPalette.input.value
    if (input.startsWith('>>> ')) {
      const code = input.substring(4).trim()
      // Don't execute empty code, just update the display
      if (code) {
        // Code will be executed on Enter key press
        // This function is just for display updates
      }
    }
  },

  /**
   * Execute JavaScript code in the current tab context
   * @param {string} code - JavaScript code to execute
   */
  executeReplCode: function (code) {
    var webviews = require('webviews.js')
    
    // Validate input
    if (!code || !code.trim()) {
      return
    }
    
    // Check if there's a current tab
    const currentTab = tabs.getSelected()
    if (!currentTab) {
      const historyEntry = {
        id: commandPalette.replHistory.length + 1,
        input: code,
        output: 'Error: No active tab available',
        isError: true,
        timestamp: new Date()
      }
      commandPalette.replHistory.push(historyEntry)
      commandPalette.renderReplHistory()
      commandPalette.input.value = '>>> '
      commandPalette.input.setSelectionRange(4, 4)
      return
    }
    
    // Add to input history
    commandPalette.replInputHistory.push(code)
    commandPalette.replInputHistoryIndex = commandPalette.replInputHistory.length
    
    // Execute code in the current tab
    webviews.callAsync(currentTab, 'executeJavaScript', code, function (err, result) {
      const historyEntry = {
        id: commandPalette.replHistory.length + 1,
        input: code,
        timestamp: new Date()
      }
      
      if (err) {
        // Handle errors
        historyEntry.output = `Error: ${err.message || err}`
        historyEntry.isError = true
      } else {
        // Add to history
        historyEntry.output = result
        historyEntry.isError = false
      }
      
      commandPalette.replHistory.push(historyEntry)
      commandPalette.renderReplHistory()
      
      // Clear input and prepare for next command
      commandPalette.input.value = '>>> '
      commandPalette.input.setSelectionRange(4, 4)
    })
  },

  /**
   * Show all available tabs as candidates
   */
  showTabs: function () {
    try {
      if (typeof tabs === 'undefined' || !tabs.get) {
        console.warn('Tabs module not available')
        commandPalette.filteredCommands = []
        commandPalette.renderSuggestions()
        return
      }
      
      const allTabs = tabs.get()
      commandPalette.filteredCommands = allTabs.map(tab => ({
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
      commandPalette.renderSuggestions()
    } catch (e) {
      console.error('Error showing tabs:', e)
      commandPalette.filteredCommands = []
      commandPalette.renderSuggestions()
    }
  },

  /**
   * Search tabs by title or URL
   * @param {string} query - Search query
   */
  searchTabs: function (query) {
    try {
      if (typeof tabs === 'undefined' || !tabs.get) {
        console.warn('Tabs module not available')
        commandPalette.filteredCommands = []
        commandPalette.renderSuggestions()
        return
      }
      
      const allTabs = tabs.get()
      const searchQuery = query.toLowerCase()
      
      const matchedTabs = allTabs.filter(tab => {
        const title = (tab.title || '').toLowerCase()
        const url = (tab.url || '').toLowerCase()
        return title.includes(searchQuery) || url.includes(searchQuery)
      })

      commandPalette.filteredCommands = matchedTabs.map(tab => ({
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
      commandPalette.renderSuggestions()
    } catch (e) {
      console.error('Error searching tabs:', e)
      commandPalette.filteredCommands = []
      commandPalette.renderSuggestions()
    }
  },

  /**
   * Show URL candidates from history and bookmarks
   * @param {string} searchQuery - Optional search query to filter results
   */
  showOpenCandidates: async function (searchQuery = '') {
    try {
      var places = require('places/places.js')
      var urlParser = require('util/urlParser.js')
      var searchbar = require('searchbar/searchbar.js')
      var webviews = require('webviews.js')
      
      const results = await places.searchPlaces(searchQuery, { limit: 20 })
      let candidates = []
      
      // Always add typed URL as first candidate (default selection)
      if (searchQuery && searchQuery.trim()) {
        const candidate = commandPalette.createURLCandidate(searchQuery)
        if (candidate) {
          candidates.push(candidate)
        }
      }

      // Add history and bookmark results
      candidates = candidates.concat(results.map(result => commandPalette.createHistoryCandidate(result)))

      // Limit to 10 candidates for keyboard shortcuts (0-9)
      commandPalette.filteredCommands = candidates.slice(0, 10)
      commandPalette.renderSuggestions()
    } catch (e) {
      console.error('Error showing open candidates:', e)
      commandPalette.filteredCommands = []
      commandPalette.renderSuggestions()
    }
  },

  /**
   * Show URL candidates for reloading in current tab
   * @param {string} searchQuery - Optional search query to filter results
   */
  showReloadCandidates: async function (searchQuery = '') {
    try {
      var places = require('places/places.js')
      var urlParser = require('util/urlParser.js')
      
      let candidates = []
      
      if (!searchQuery || !searchQuery.trim()) {
        // No search query - show only current page
        const currentTab = tabs.get(tabs.getSelected())
        if (currentTab && currentTab.url) {
          candidates.push(commandPalette.createReloadCandidate(currentTab.url, 'Current page'))
        }
      } else {
        // Has search query - follow >o logic but open in current tab
        const results = await places.searchPlaces(searchQuery, { limit: 20 })
        
        // Always add typed URL as first candidate (default selection)
        const candidate = commandPalette.createReloadCandidate(searchQuery, 'Load URL')
        if (candidate) {
          candidates.push(candidate)
        }

        // Add history and bookmark results
        candidates = candidates.concat(results.map(result => commandPalette.createReloadHistoryCandidate(result)))
      }

      commandPalette.filteredCommands = candidates.slice(0, 10)
      commandPalette.renderSuggestions()
    } catch (e) {
      console.error('Error showing reload candidates:', e)
      commandPalette.filteredCommands = []
      commandPalette.renderSuggestions()
    }
  },

  /**
   * Create a URL candidate for the typed URL
   * @param {string} url - The URL to create a candidate for
   * @returns {Object} Candidate object
   */
  createURLCandidate: function (url) {
    var urlParser = require('util/urlParser.js')
    var searchbar = require('searchbar/searchbar.js')
    var webviews = require('webviews.js')
    
    // Validate URL before creating candidate
    if (!url || !url.trim()) {
      return null
    }
    
    return {
      id: 'open-url',
      title: `Open URL: ${url}`,
      description: `Open ${url} in a new tab`,
      icon: 'carbon:launch',
      action: () => {
        try {
          var parsedUrl = urlParser.parse(url)
          searchbar.events.emit('url-selected', { url: parsedUrl, background: true, openInForeground: true })
          webviews.focus()
        } catch (e) {
          console.error('Error opening URL:', e)
        }
      }
    }
  },

  /**
   * Create a history candidate from a places result
   * @param {Object} result - Places result object
   * @returns {Object} Candidate object
   */
  createHistoryCandidate: function (result) {
    var urlParser = require('util/urlParser.js')
    var searchbar = require('searchbar/searchbar.js')
    var webviews = require('webviews.js')
    
    return {
      id: `candidate-${result.url}`,
      title: result.title || urlParser.prettyURL(urlParser.getSourceURL(result.url)),
      description: urlParser.basicURL(urlParser.getSourceURL(result.url)),
      icon: result.isBookmarked ? 'carbon:star-filled' : 'carbon:wikis',
      action: () => {
        searchbar.events.emit('url-selected', { url: result.url, background: true, openInForeground: true })
        webviews.focus()
      }
    }
  },

  /**
   * Create a reload candidate for the current URL or typed URL
   * @param {string} url - The URL to create a candidate for
   * @param {string} description - Description for the candidate
   * @returns {Object} Candidate object
   */
  createReloadCandidate: function (url, description) {
    var urlParser = require('util/urlParser.js')
    var webviews = require('webviews.js')
    
    // Validate URL before creating candidate
    if (!url || !url.trim()) {
      return null
    }
    
    return {
      id: 'reload-url',
      title: `${description}: ${urlParser.prettyURL(urlParser.getSourceURL(url))}`,
      description: urlParser.basicURL(urlParser.getSourceURL(url)),
      icon: 'carbon:renew',
      action: () => {
        try {
          const parsedUrl = urlParser.parse(url)
          webviews.update(tabs.getSelected(), parsedUrl)
          webviews.focus()
        } catch (e) {
          console.error('Error loading URL:', e)
        }
      }
    }
  },

  /**
   * Create a reload history candidate from a places result
   * @param {Object} result - Places result object
   * @returns {Object} Candidate object
   */
  createReloadHistoryCandidate: function (result) {
    var urlParser = require('util/urlParser.js')
    var webviews = require('webviews.js')
    
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
  },

  /**
   * Handle vim-like commands starting with '>'
   * @param {string} query - The full query string
   */
  handleVimCommand: function (query) {
    const vimCommand = query.substring(1).trim()
    const parts = vimCommand.split(' ')
    const commandName = parts[0].toLowerCase()
    const commandArgs = parts.slice(1).join(' ')
    
    if (commandName === 'o') {
      if (commandArgs) {
        commandPalette.showOpenCandidates(commandArgs)
      } else {
        commandPalette.showOpenCandidates()
      }
    } else if (commandName === 'goo') {
      // Show the command as a suggestion for Google search
      commandPalette.filteredCommands = availableCommands.filter(cmd => 
        cmd.id === 'goo'
      )
      commandPalette.renderSuggestions()
    } else if (commandName === 'r') {
      if (commandArgs) {
        commandPalette.showReloadCandidates(commandArgs)
      } else {
        commandPalette.showReloadCandidates()
      }
    } else {
      commandPalette.filteredCommands = availableCommands.filter(cmd => 
        cmd.id.toLowerCase() === commandName
      )
      commandPalette.renderSuggestions()
    }
  },

  /**
   * Render REPL history in Jupyter-like format
   */
  renderReplHistory: function () {
    commandPalette.suggestions.innerHTML = ''
    
    if (commandPalette.replHistory.length === 0) {
      const emptyEl = document.createElement('div')
      emptyEl.className = 'repl-empty'
      emptyEl.textContent = 'No commands executed yet. Type JavaScript code and press Enter.'
      commandPalette.suggestions.appendChild(emptyEl)
      return
    }
    
    // Display history in reverse order (newest first)
    const reversedHistory = [...commandPalette.replHistory].reverse()
    
    reversedHistory.forEach((entry) => {
      const historyEl = commandPalette.createReplHistoryElement(entry)
      commandPalette.suggestions.appendChild(historyEl)
    })
    
    // Scroll to bottom to show latest entries
    commandPalette.suggestions.scrollTop = commandPalette.suggestions.scrollHeight
  },

  /**
   * Create a REPL history element
   * @param {Object} entry - History entry object
   * @returns {HTMLElement} History element
   */
  createReplHistoryElement: function (entry) {
    const historyEl = document.createElement('div')
    historyEl.className = 'repl-history-entry'
    
    const isError = entry.isError || false
    const outputClass = isError ? 'repl-output-error' : 'repl-output'
    
    // Format output for better display
    let outputText = String(entry.output)
    if (entry.output === null) {
      outputText = 'null'
    } else if (entry.output === undefined) {
      outputText = 'undefined'
    } else if (typeof entry.output === 'object') {
      try {
        outputText = JSON.stringify(entry.output, null, 2)
      } catch (e) {
        outputText = entry.output.toString()
      }
    }
    
    historyEl.innerHTML = `
      <div class="repl-input-line">
        <span class="repl-prompt-label">In</span>
        <span class="repl-prompt-number">[${entry.id}]:</span>
        <span class="repl-input-code">${this.escapeHtml(entry.input)}</span>
      </div>
      <div class="repl-output-line">
        <span class="repl-prompt-label">Out</span>
        <span class="repl-prompt-number">[${entry.id}]:</span>
        <span class="${outputClass}">${this.escapeHtml(outputText)}</span>
      </div>
    `
    
    return historyEl
  },

  /**
   * Escape HTML to prevent XSS
   * @param {string} text - Text to escape
   * @returns {string} Escaped text
   */
  escapeHtml: function (text) {
    const div = document.createElement('div')
    div.textContent = text
    return div.innerHTML
  },

  /**
   * Handle keyboard events in the command palette
   * @param {KeyboardEvent} e - Keyboard event
   */
  handleKeydown: function (e) {
    // Handle REPL mode keyboard shortcuts
    if (commandPalette.isReplMode) {
      commandPalette.handleReplKeydown(e)
      return
    }

    // Handle Ctrl+0 to Ctrl+9 for quick candidate selection (0-9)
    if (e.ctrlKey && e.key >= '0' && e.key <= '9') {
      e.preventDefault()
      const index = parseInt(e.key)
      if (index < commandPalette.filteredCommands.length) {
        const selectedCommand = commandPalette.filteredCommands[index]
        commandPalette.executeCommand(selectedCommand)
      }
      return
    }

    // Handle Ctrl+K (up) and Ctrl+L (down) for navigation
    if (e.ctrlKey && (e.key === 'k' || e.key === 'l')) {
      e.preventDefault()
      if (e.key === 'k') {
        // Ctrl+K: Move up
        commandPalette.selectedIndex = Math.max(commandPalette.selectedIndex - 1, 0)
      } else {
        // Ctrl+L: Move down
        commandPalette.selectedIndex = Math.min(
          commandPalette.selectedIndex + 1,
          commandPalette.filteredCommands.length - 1
        )
      }
      commandPalette.renderSuggestions()
      return
    }

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        commandPalette.selectedIndex = Math.min(
          commandPalette.selectedIndex + 1,
          commandPalette.filteredCommands.length - 1
        )
        commandPalette.renderSuggestions()
        break

      case 'ArrowUp':
        e.preventDefault()
        commandPalette.selectedIndex = Math.max(commandPalette.selectedIndex - 1, 0)
        commandPalette.renderSuggestions()
        break

      case 'Enter':
        e.preventDefault()
        if (commandPalette.filteredCommands.length > 0) {
          // Always execute the selected candidate (first one is user's input by default)
          const selectedCommand = commandPalette.filteredCommands[commandPalette.selectedIndex]
          commandPalette.executeCommand(selectedCommand)
        } else {
          commandPalette.handleEnterWithNoCandidates()
        }
        break

      case 'Escape':
        e.preventDefault()
        commandPalette.hide()
        break
    }
  },

  /**
   * Handle keyboard events in REPL mode
   * @param {KeyboardEvent} e - Keyboard event
   */
  handleReplKeydown: function (e) {
    switch (e.key) {
      case 'Enter':
        e.preventDefault()
        const input = commandPalette.input.value
        if (input.startsWith('>>> ')) {
          const code = input.substring(4).trim()
          if (code) {
            commandPalette.executeReplCode(code)
          }
        }
        break

      case 'Escape':
        e.preventDefault()
        commandPalette.exitReplMode()
        break

      case 'ArrowUp':
        e.preventDefault()
        // Navigate through input history
        if (commandPalette.replInputHistory.length > 0) {
          if (commandPalette.replInputHistoryIndex > 0) {
            commandPalette.replInputHistoryIndex--
            const historyCode = commandPalette.replInputHistory[commandPalette.replInputHistoryIndex]
            commandPalette.input.value = `>>> ${historyCode}`
            commandPalette.input.setSelectionRange(4 + historyCode.length, 4 + historyCode.length)
          }
        }
        break

      case 'ArrowDown':
        e.preventDefault()
        // Navigate through input history
        if (commandPalette.replInputHistory.length > 0) {
          if (commandPalette.replInputHistoryIndex < commandPalette.replInputHistory.length - 1) {
            commandPalette.replInputHistoryIndex++
            const historyCode = commandPalette.replInputHistory[commandPalette.replInputHistoryIndex]
            commandPalette.input.value = `>>> ${historyCode}`
            commandPalette.input.setSelectionRange(4 + historyCode.length, 4 + historyCode.length)
          } else if (commandPalette.replInputHistoryIndex === commandPalette.replInputHistory.length - 1) {
            commandPalette.replInputHistoryIndex++
            commandPalette.input.value = '>>> '
            commandPalette.input.setSelectionRange(4, 4)
          }
        }
        break

      case 'Tab':
        e.preventDefault()
        // Insert tab character for code indentation
        const start = commandPalette.input.selectionStart
        const end = commandPalette.input.selectionEnd
        const value = commandPalette.input.value
        
        commandPalette.input.value = value.substring(0, start) + '  ' + value.substring(end)
        commandPalette.input.setSelectionRange(start + 2, start + 2)
        break
    }
  },

  /**
   * Handle Enter key when no candidates are selected
   * Fallback for edge cases where candidates might not be available
   */
  handleEnterWithNoCandidates: function () {
    const query = commandPalette.input.value.trim()
    
    // Handle basic commands that don't need candidates
    if (query === '>r') {
      // Reload current tab
      var webviews = require('webviews.js')
      webviews.callAsync(tabs.getSelected(), 'reload')
      commandPalette.hide()
    }
    // For other commands, we should always have candidates now
  },

  /**
   * Render the command suggestions in the UI
   */
  renderSuggestions: function () {
    commandPalette.suggestions.innerHTML = ''

    if (commandPalette.filteredCommands.length === 0) {
      const emptyEl = document.createElement('div')
      emptyEl.className = 'command-palette-empty'
      emptyEl.textContent = 'No tabs or commands found'
      commandPalette.suggestions.appendChild(emptyEl)
      return
    }

    commandPalette.filteredCommands.forEach((command, index) => {
      const suggestionEl = commandPalette.createSuggestionElement(command, index)
      commandPalette.suggestions.appendChild(suggestionEl)
    })
  },

  /**
   * Create a suggestion element for the UI
   * @param {Object} command - Command object
   * @param {number} index - Index of the command
   * @returns {HTMLElement} Suggestion element
   */
  createSuggestionElement: function (command, index) {
    const suggestionEl = document.createElement('button')
    suggestionEl.className = 'command-suggestion'
    
    const isTab = command.id.startsWith('tab-')
    let description = command.description
    if (isTab && description.length > 60) {
      description = description.substring(0, 60) + '...'
    }

    // Show keyboard shortcut number for candidates (0-9)
    const shortcutNumber = index < 10 ? `<div class="command-suggestion-number">${index}</div>` : ''

    suggestionEl.innerHTML = `
      ${shortcutNumber}
      <i class="i ${command.icon} command-suggestion-icon"></i>
      <div class="command-suggestion-content">
        <div class="command-suggestion-title">${command.title}</div>
        <div class="command-suggestion-description">${description}</div>
      </div>
      ${command.shortcut ? `<div class="command-suggestion-shortcut">${command.shortcut}</div>` : ''}
    `

    // Add selected class after setting innerHTML
    if (index === commandPalette.selectedIndex) {
      suggestionEl.classList.add('selected')
    }

    // Disable all mouse interactions to prevent interference with keyboard navigation
    const preventMouseInteraction = (e) => {
      e.preventDefault()
      e.stopPropagation()
    }
    
    suggestionEl.addEventListener('click', preventMouseInteraction)
    suggestionEl.addEventListener('mousedown', preventMouseInteraction)
    suggestionEl.addEventListener('mouseenter', preventMouseInteraction)

    return suggestionEl
  },

  /**
   * Execute a command and hide the palette
   * @param {Object} command - Command object to execute
   */
  executeCommand: function (command) {
    commandPalette.hide()
    commandPalette.events.emit('command-executed', command)
    if (command.action) {
      command.action()
    }
  }
}

// Register keyboard shortcuts
keybindings.defineShortcut('showCommandPalette', function () {
  commandPalette.showWithPrefix('>')
})

module.exports = commandPalette 