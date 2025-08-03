const EventEmitter = require('events')
var keybindings = require('keybindings.js')
var modalMode = require('modalMode.js')

// Sample commands - these will be expanded later
const availableCommands = [
  {
    id: 'new-tab',
    title: 'New Tab',
    description: 'Open a new tab',
    shortcut: 'Ctrl+T',
    icon: 'carbon:new-tab',
    action: () => {
      // Will be implemented later
      console.log('New Tab command executed')
    }
  },
  {
    id: 'close-tab',
    title: 'Close Tab',
    description: 'Close the current tab',
    shortcut: 'Ctrl+W',
    icon: 'carbon:close',
    action: () => {
      console.log('Close Tab command executed')
    }
  },
  {
    id: 'new-window',
    title: 'New Window',
    description: 'Open a new window',
    shortcut: 'Ctrl+Shift+N',
    icon: 'carbon:new-window',
    action: () => {
      console.log('New Window command executed')
    }
  },
  {
    id: 'bookmarks',
    title: 'Show Bookmarks',
    description: 'Open the bookmarks manager',
    shortcut: 'Ctrl+Shift+B',
    icon: 'carbon:bookmark',
    action: () => {
      console.log('Show Bookmarks command executed')
    }
  },
  {
    id: 'history',
    title: 'Show History',
    description: 'Open the browsing history',
    shortcut: 'Ctrl+Shift+H',
    icon: 'carbon:time',
    action: () => {
      console.log('Show History command executed')
    }
  },
  {
    id: 'settings',
    title: 'Settings',
    description: 'Open browser settings',
    shortcut: 'Ctrl+,',
    icon: 'carbon:settings',
    action: () => {
      console.log('Settings command executed')
    }
  },
  {
    id: 'find',
    title: 'Find in Page',
    description: 'Search for text on the current page',
    shortcut: 'Ctrl+F',
    icon: 'carbon:search',
    action: () => {
      console.log('Find in Page command executed')
    }
  },
  {
    id: 'reload',
    title: 'Reload Page',
    description: 'Refresh the current page',
    shortcut: 'F5',
    icon: 'carbon:renew',
    action: () => {
      console.log('Reload Page command executed')
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

    // Initialize with all commands
    commandPalette.filteredCommands = [...availableCommands]
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
    commandPalette.filteredCommands = [...availableCommands]
    commandPalette.renderSuggestions()

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
    const query = commandPalette.input.value.toLowerCase().trim()
    
    if (query === '') {
      commandPalette.filteredCommands = [...availableCommands]
    } else {
      commandPalette.filteredCommands = availableCommands.filter(cmd => 
        cmd.title.toLowerCase().includes(query) ||
        cmd.description.toLowerCase().includes(query) ||
        cmd.id.toLowerCase().includes(query)
      )
    }

    commandPalette.selectedIndex = 0
    commandPalette.renderSuggestions()
  },

  handleKeydown: function (e) {
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
      emptyEl.textContent = 'No commands found'
      commandPalette.suggestions.appendChild(emptyEl)
      return
    }

    commandPalette.filteredCommands.forEach((command, index) => {
      const suggestionEl = document.createElement('button')
      suggestionEl.className = 'command-suggestion'
      if (index === commandPalette.selectedIndex) {
        suggestionEl.classList.add('selected')
      }

      suggestionEl.innerHTML = `
        <i class="i ${command.icon} command-suggestion-icon"></i>
        <div class="command-suggestion-content">
          <div class="command-suggestion-title">${command.title}</div>
          <div class="command-suggestion-description">${command.description}</div>
        </div>
        <div class="command-suggestion-shortcut">${command.shortcut}</div>
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