const EventEmitter = require('events')
var keybindings = require('keybindings.js')
var modalMode = require('modalMode.js')

// Available commands
const availableCommands = [
  {
    id: 'w',
    title: 'Close Tab',
    description: 'Close the current tab',
    shortcut: 'Ctrl+W',
    icon: 'carbon:close',
    action: () => {
      var browserUI = require('browserUI.js')
      browserUI.closeTab(tabs.getSelected())
    }
  },
  {
    id: 'r',
    title: 'Reload Tab',
    description: 'Reload the current tab',
    shortcut: 'F5',
    icon: 'carbon:renew',
    action: () => {
      var webviews = require('webviews.js')
      webviews.callAsync(tabs.getSelected(), 'reload')
    }
  },
  {
    id: 'new-tab',
    title: 'New Tab',
    description: 'Open a new tab',
    shortcut: 'Ctrl+T',
    icon: 'carbon:new-tab',
    action: () => {
      var browserUI = require('browserUI.js')
      browserUI.addTab()
    }
  },
  {
    id: 'new-window',
    title: 'New Window',
    description: 'Open a new window',
    shortcut: 'Ctrl+Shift+N',
    icon: 'carbon:new-window',
    action: () => {
      var browserUI = require('browserUI.js')
      browserUI.addWindow()
    }
  },
  {
    id: 'bookmarks',
    title: 'Show Bookmarks',
    description: 'Open the bookmarks manager',
    shortcut: 'Ctrl+Shift+B',
    icon: 'carbon:bookmark',
    action: () => {
      var searchbar = require('searchbar/searchbar.js')
      searchbar.showResults('!bookmarks')
    }
  },
  {
    id: 'history',
    title: 'Show History',
    description: 'Open the browsing history',
    shortcut: 'Ctrl+Shift+H',
    icon: 'carbon:time',
    action: () => {
      var searchbar = require('searchbar/searchbar.js')
      searchbar.showResults('!history')
    }
  },
  {
    id: 'settings',
    title: 'Settings',
    description: 'Open browser settings',
    shortcut: 'Ctrl+,',
    icon: 'carbon:settings',
    action: () => {
      var searchbar = require('searchbar/searchbar.js')
      searchbar.showResults('!settings')
    }
  },
  {
    id: 'find',
    title: 'Find in Page',
    description: 'Search for text on the current page',
    shortcut: 'Ctrl+F',
    icon: 'carbon:search',
    action: () => {
      var findinpage = require('findinpage.js')
      findinpage.start()
    }
  },
  {
    id: 'o',
    title: 'Open URL',
    description: 'Open a URL in a new tab',
    shortcut: '>o <url>',
    icon: 'carbon:launch',
    action: (url) => {
      if (url) {
        var urlParser = require('util/urlParser.js')
        var parsedUrl = urlParser.parse(url)
        var searchbar = require('searchbar/searchbar.js')
        searchbar.events.emit('url-selected', { url: parsedUrl, background: true, openInForeground: true })
        var webviews = require('webviews.js')
        webviews.focus()
      }
    }
  }
]

var commandPalette = {
  el: null,
  input: null,
  suggestions: null,
  isVisible: false,
  selectedIndex: 0,
  filteredCommands: [],
  events: new EventEmitter(),

  initialize: function () {
    commandPalette.el = document.getElementById('command-palette')
    commandPalette.input = document.getElementById('command-palette-input')
    commandPalette.suggestions = document.getElementById('command-palette-suggestions')

    // Set up event listeners
    commandPalette.input.addEventListener('input', commandPalette.handleInput)
    commandPalette.input.addEventListener('keydown', commandPalette.handleKeydown)
    
    // Close on escape
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && commandPalette.isVisible) {
        commandPalette.hide()
      }
    })

    // Close when clicking outside
    commandPalette.el.addEventListener('click', function (e) {
      if (e.target === commandPalette.el) {
        commandPalette.hide()
      }
    })

    // Initialize with empty list - tabs will be loaded when needed
    commandPalette.filteredCommands = []
    commandPalette.renderSuggestions()
  },

  show: function () {
    if (commandPalette.isVisible) return

    commandPalette.isVisible = true
    commandPalette.el.hidden = false
    
    // Add class to body to show overlay (like searchbar does)
    document.body.classList.add('is-command-palette-mode')
    
    // Request webview placeholder to create blur effect (like tabEditor does)
    var webviews = require('webviews.js')
    webviews.requestPlaceholder('commandPalette')

    // Reset state
    commandPalette.selectedIndex = 0
    commandPalette.input.value = ''
    
    // Show tabs with safety check
    try {
      commandPalette.showTabs()
    } catch (e) {
      console.error('Error showing tabs on command palette open:', e)
      commandPalette.filteredCommands = []
      commandPalette.renderSuggestions()
    }

    // Focus the input
    setTimeout(() => {
      commandPalette.input.focus()
    }, 100)
  },

  hide: function () {
    if (!commandPalette.isVisible) return

    commandPalette.isVisible = false
    commandPalette.el.hidden = true
    document.body.classList.remove('is-command-palette-mode')
    commandPalette.input.blur()
    
    // Hide webview placeholder (like tabEditor does)
    var webviews = require('webviews.js')
    webviews.hidePlaceholder('commandPalette')
  },

  handleInput: function () {
    const query = commandPalette.input.value.trim()
    
    if (query === '') {
      // Show all tabs when no query
      commandPalette.showTabs()
    } else {
      // Check for vim-like commands (starting with >)
      if (query.startsWith('>')) {
        const vimCommand = query.substring(1).trim()
        const parts = vimCommand.split(' ')
        const commandName = parts[0].toLowerCase()
        const commandArgs = parts.slice(1).join(' ')
        
        // Special handling for 'o' command
        if (commandName === 'o') {
          if (commandArgs) {
            // Filter candidates based on the provided text
            commandPalette.showOpenCandidates(commandArgs)
          } else {
            // Show candidates from history and bookmarks
            commandPalette.showOpenCandidates()
          }
        } else {
          // Handle other single-word commands
          commandPalette.filteredCommands = availableCommands.filter(cmd => 
            cmd.id.toLowerCase() === commandName
          )
          commandPalette.renderSuggestions()
        }
      } else {
        // Fuzzy search through tabs
        commandPalette.searchTabs(query)
      }
    }

    commandPalette.selectedIndex = 0
  },

  showTabs: function () {
    try {
      // Check if tabs module is available
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
      // Fallback to empty list
      commandPalette.filteredCommands = []
      commandPalette.renderSuggestions()
    }
  },

  searchTabs: function (query) {
    try {
      // Check if tabs module is available
      if (typeof tabs === 'undefined' || !tabs.get) {
        console.warn('Tabs module not available')
        commandPalette.filteredCommands = []
        commandPalette.renderSuggestions()
        return
      }
      
      const allTabs = tabs.get()
      const searchQuery = query.toLowerCase()
      
      // Fuzzy search through tabs
      const matchedTabs = allTabs.filter(tab => {
        const title = (tab.title || '').toLowerCase()
        const url = (tab.url || '').toLowerCase()
        
        // Check if query matches title or URL
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
      // Fallback to empty list
      commandPalette.filteredCommands = []
      commandPalette.renderSuggestions()
    }
  },

  showOpenCandidates: async function (searchQuery = '') {
    try {
      var places = require('places/places.js')
      var urlParser = require('util/urlParser.js')
      var searchbar = require('searchbar/searchbar.js')
      var webviews = require('webviews.js')
      
      // Get history and bookmarks filtered by search query (same as address bar)
      const results = await places.searchPlaces(searchQuery, {
        limit: 20
      })

      // Add the typed URL as the first candidate if it's not empty and doesn't match any existing results
      let candidates = []
      
      if (searchQuery && searchQuery.trim()) {
        const searchQueryLower = searchQuery.toLowerCase()
        const hasExactMatch = results.some(result => 
          result.url.toLowerCase().includes(searchQueryLower) ||
          (result.title && result.title.toLowerCase().includes(searchQueryLower))
        )
        
        if (!hasExactMatch) {
          candidates.push({
            id: 'open-url',
            title: `Open URL: ${searchQuery}`,
            description: `Open ${searchQuery} in a new tab`,
            icon: 'carbon:launch',
            action: () => {
              var parsedUrl = urlParser.parse(searchQuery)
              searchbar.events.emit('url-selected', { url: parsedUrl, background: true, openInForeground: true })
              webviews.focus()
            }
          })
        }
      }

      // Add history and bookmark results (limit to 10 total candidates)
      candidates = candidates.concat(results.map(result => ({
        id: `candidate-${result.url}`,
        title: result.title || urlParser.prettyURL(urlParser.getSourceURL(result.url)),
        description: urlParser.basicURL(urlParser.getSourceURL(result.url)),
        icon: result.isBookmarked ? 'carbon:star-filled' : 'carbon:wikis',
        action: () => {
          searchbar.events.emit('url-selected', { url: result.url, background: true, openInForeground: true })
          webviews.focus()
        }
      })))

      // Limit to 10 candidates for keyboard shortcuts (0-9)
      commandPalette.filteredCommands = candidates.slice(0, 10)
      commandPalette.renderSuggestions()
    } catch (e) {
      console.error('Error showing open candidates:', e)
      // Fallback to empty list
      commandPalette.filteredCommands = []
      commandPalette.renderSuggestions()
    }
  },

  handleKeydown: function (e) {
    // Handle Ctrl+0 to Ctrl+9 for quick candidate selection
    if (e.ctrlKey && e.key >= '0' && e.key <= '9') {
      e.preventDefault()
      const index = e.key === '0' ? 9 : parseInt(e.key) - 1
      if (index < commandPalette.filteredCommands.length) {
        const selectedCommand = commandPalette.filteredCommands[index]
        commandPalette.executeCommand(selectedCommand)
      }
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
          const selectedCommand = commandPalette.filteredCommands[commandPalette.selectedIndex]
          commandPalette.executeCommand(selectedCommand)
        } else {
          // If no candidates are selected, try to open the typed URL
          const query = commandPalette.input.value.trim()
          if (query.startsWith('>o ')) {
            const url = query.substring(3).trim()
            if (url) {
              var urlParser = require('util/urlParser.js')
              var parsedUrl = urlParser.parse(url)
              var searchbar = require('searchbar/searchbar.js')
              searchbar.events.emit('url-selected', { url: parsedUrl, background: true, openInForeground: true })
              var webviews = require('webviews.js')
              webviews.focus()
              commandPalette.hide()
            }
          }
        }
        break

      case 'Escape':
        e.preventDefault()
        commandPalette.hide()
        break
    }
  },

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
      const suggestionEl = document.createElement('button')
      suggestionEl.className = 'command-suggestion'
      if (index === commandPalette.selectedIndex) {
        suggestionEl.classList.add('selected')
      }

      // Check if this is a tab (has tab- prefix in id)
      const isTab = command.id.startsWith('tab-')
      
      // Format the description for tabs (truncate long URLs)
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

      suggestionEl.addEventListener('click', () => {
        commandPalette.executeCommand(command)
      })

      suggestionEl.addEventListener('mouseenter', () => {
        commandPalette.selectedIndex = index
        commandPalette.renderSuggestions()
      })

      commandPalette.suggestions.appendChild(suggestionEl)
    })
  },

  executeCommand: function (command) {
    commandPalette.hide()
    
    // Emit event for external handling
    commandPalette.events.emit('command-executed', command)
    
    // Execute the command action
    if (command.action) {
      command.action()
    }
  }
}

// Register the keyboard shortcut (Ctrl+.)
keybindings.defineShortcut('showCommandPalette', function () {
  commandPalette.show()
})

module.exports = commandPalette 