const EventEmitter = require('events')
var keybindings = require('keybindings.js')
var modalMode = require('modalMode.js')

// Import strategy components
const StrategyManager = require('./commandPalette/StrategyManager.js')
const EmptyStrategy = require('./commandPalette/strategies/EmptyStrategy.js')
const TabSearchStrategy = require('./commandPalette/strategies/TabSearchStrategy.js')
const VimCommandStrategy = require('./commandPalette/strategies/VimCommandStrategy.js')
const OpenUrlStrategy = require('./commandPalette/strategies/OpenUrlStrategy.js')
const ReloadUrlStrategy = require('./commandPalette/strategies/ReloadUrlStrategy.js')
const ReplStrategy = require('./commandPalette/strategies/ReplStrategy.js')
const VimCommandArgsStrategy = require('./commandPalette/strategies/VimCommandArgsStrategy.js')

/**
 * Modern Command Palette with Strategy Pattern Architecture
 * 
 * Features:
 * - Strategy-based state management for better maintainability
 * - Decoupled command logic (UI, regex, actions) in separate files
 * - Automatic input pattern matching with priority resolution
 * - Extensible architecture for adding new command types
 * - Consistent keyboard navigation and shortcuts
 */
var commandPalette = {
  // Core DOM elements
  el: null,
  input: null,
  suggestions: null,
  
  // State management
  isVisible: false,
  selectedIndex: 0,
  currentCandidates: [],
  
  // Strategy manager
  strategyManager: null,
  
  // Event system
  events: new EventEmitter(),

  /**
   * Initialize the command palette
   * Sets up DOM elements, strategies, and event listeners
   */
  initialize: function () {
    // Get DOM elements
    commandPalette.el = document.getElementById('command-palette')
    commandPalette.input = document.getElementById('command-palette-input')
    commandPalette.suggestions = document.getElementById('command-palette-suggestions')

    if (!commandPalette.el || !commandPalette.input || !commandPalette.suggestions) {
      console.error('Command palette DOM elements not found')
      return
    }

    // Initialize strategy manager
    commandPalette.strategyManager = new StrategyManager()
    
    // Register all strategies
    commandPalette.registerStrategies()
    
    // Set up event listeners
    commandPalette.setupEventListeners()
    
    console.log('Command palette initialized with strategy pattern')
  },

  /**
   * Register all command state strategies
   */
  registerStrategies: function () {
    const strategies = [
      new EmptyStrategy(),
      new TabSearchStrategy(),
      new VimCommandStrategy(),
      new OpenUrlStrategy(),
      new ReloadUrlStrategy(),
      new ReplStrategy(),
      new VimCommandArgsStrategy()
    ]

    strategies.forEach(strategy => {
      try {
        commandPalette.strategyManager.registerStrategy(strategy)
      } catch (error) {
        console.error(`Failed to register strategy ${strategy.stateName}:`, error)
      }
    })
  },

  /**
   * Set up event listeners for input and UI interactions
   */
  setupEventListeners: function () {
    // Input event listener
    commandPalette.input.addEventListener('input', commandPalette.handleInput)
    commandPalette.input.addEventListener('keydown', commandPalette.handleKeydown)

    // Close when clicking outside
    commandPalette.el.addEventListener('click', function (e) {
      if (e.target === commandPalette.el) {
        commandPalette.hide()
      }
    })

    // Strategy manager event listeners
    commandPalette.strategyManager.on('state-changed', commandPalette.handleStateChange)
    commandPalette.strategyManager.on('candidates-updated', commandPalette.handleCandidatesUpdate)
    commandPalette.strategyManager.on('action-executed', commandPalette.handleActionExecuted)
    commandPalette.strategyManager.on('action-error', commandPalette.handleActionError)
  },

  /**
   * Handle input changes
   */
  handleInput: async function () {
    const inputValue = commandPalette.input.value
    const context = commandPalette.getContext()
    
    try {
      const stateChanged = await commandPalette.strategyManager.processInput(inputValue, context)
      if (!stateChanged) {
        // State didn't change, just update selection
        commandPalette.selectedIndex = 0
        commandPalette.updateSelection()
      }
    } catch (error) {
      console.error('Error processing input:', error)
    }
  },

  /**
   * Handle keyboard events
   * @param {KeyboardEvent} e - Keyboard event
   */
  handleKeydown: function (e) {
    const context = commandPalette.getContext()
    
    // Let strategy handle state-specific keyboard events first
    if (commandPalette.strategyManager.handleKeydown(e, context)) {
      return
    }

    // Handle Ctrl+0 to Ctrl+9 for quick candidate selection
    if (e.ctrlKey && e.key >= '0' && e.key <= '9') {
      e.preventDefault()
      const index = parseInt(e.key)
      if (index < commandPalette.currentCandidates.length) {
        const selectedCandidate = commandPalette.currentCandidates[index]
        commandPalette.executeAction(selectedCandidate)
      }
      return
    }

    // Handle Ctrl+K (up) and Ctrl+L (down) for navigation
    if (e.ctrlKey && (e.key === 'k' || e.key === 'l')) {
      e.preventDefault()
      if (e.key === 'k') {
        commandPalette.selectedIndex = Math.max(commandPalette.selectedIndex - 1, 0)
      } else {
        commandPalette.selectedIndex = Math.min(
          commandPalette.selectedIndex + 1,
          commandPalette.currentCandidates.length - 1
        )
      }
      commandPalette.updateSelection()
      return
    }

    // Handle arrow keys for navigation
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        commandPalette.selectedIndex = Math.min(
          commandPalette.selectedIndex + 1,
          commandPalette.currentCandidates.length - 1
        )
        commandPalette.updateSelection()
        break

      case 'ArrowUp':
        e.preventDefault()
        commandPalette.selectedIndex = Math.max(commandPalette.selectedIndex - 1, 0)
        commandPalette.updateSelection()
        break

      case 'Enter':
        e.preventDefault()
        if (commandPalette.currentCandidates.length > 0) {
          const selectedCandidate = commandPalette.currentCandidates[commandPalette.selectedIndex]
          commandPalette.executeAction(selectedCandidate)
        }
        break

      case 'Escape':
        e.preventDefault()
        commandPalette.hide()
        break
    }
  },

  /**
   * Execute action for selected candidate
   * @param {Object} candidate - Selected candidate
   */
  executeAction: async function (candidate) {
    if (!candidate) return
    
    const context = commandPalette.getContext()
    
    try {
      await commandPalette.strategyManager.executeAction(candidate, context)
      commandPalette.hide()
    } catch (error) {
      console.error('Error executing action:', error)
    }
  },

  /**
   * Show the command palette
   */
  show: function () {
    if (commandPalette.isVisible) return

    commandPalette.isVisible = true
    commandPalette.el.hidden = false
    
    document.body.classList.add('is-command-palette-mode')
    
    var webviews = require('webviews.js')
    webviews.requestPlaceholder('commandPalette')

    // Reset state
    commandPalette.selectedIndex = 0
    commandPalette.input.value = ''
    
    // Initialize with empty strategy
    const context = commandPalette.getContext()
    commandPalette.strategyManager.resetToFallback(context)

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

    // Set input value and process it
    commandPalette.selectedIndex = 0
    commandPalette.input.value = prefix
    
    // Process the input to determine initial state
    commandPalette.handleInput()
    
    setTimeout(() => {
      commandPalette.input.focus()
      commandPalette.input.setSelectionRange(prefix.length, prefix.length)
    }, 100)
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
    
    // Reset state
    commandPalette.selectedIndex = 0
    commandPalette.currentCandidates = []
    
    var webviews = require('webviews.js')
    webviews.hidePlaceholder('commandPalette')
  },

  /**
   * Get command palette context for strategies
   * @returns {Object} Context object
   */
  getContext: function () {
    return {
      input: commandPalette.input,
      suggestions: commandPalette.suggestions,
      selectedIndex: commandPalette.selectedIndex,
      isVisible: commandPalette.isVisible,
      events: commandPalette.events
    }
  },

  /**
   * Handle state change events from strategy manager
   * @param {Object} event - State change event data
   */
  handleStateChange: function (event) {
    commandPalette.selectedIndex = 0
    commandPalette.currentCandidates = event.candidates || []
    commandPalette.updateSelection()
    
    // Emit event for external listeners
    commandPalette.events.emit('state-changed', {
      previousStrategy: event.previousStrategy,
      currentStrategy: event.currentStrategy,
      data: event.data
    })
  },

  /**
   * Handle candidates update events
   * @param {Object} event - Candidates update event data
   */
  handleCandidatesUpdate: function (event) {
    commandPalette.currentCandidates = event.candidates || []
    commandPalette.updateSelection()
  },

  /**
   * Handle action execution events
   * @param {Object} event - Action execution event data
   */
  handleActionExecuted: function (event) {
    commandPalette.events.emit('command-executed', event.candidate)
  },

  /**
   * Handle action error events
   * @param {Object} event - Action error event data
   */
  handleActionError: function (event) {
    console.error('Action execution error:', event.error)
    commandPalette.events.emit('command-error', event)
  },

  /**
   * Update selection highlighting in UI
   */
  updateSelection: function () {
    const suggestions = commandPalette.suggestions.querySelectorAll('.command-suggestion')
    suggestions.forEach((suggestion, index) => {
      if (index === commandPalette.selectedIndex) {
        suggestion.classList.add('selected')
      } else {
        suggestion.classList.remove('selected')
      }
    })
  },

  /**
   * Get current state information
   * @returns {Object} Current state information
   */
  getState: function () {
    return {
      isVisible: commandPalette.isVisible,
      selectedIndex: commandPalette.selectedIndex,
      candidatesCount: commandPalette.currentCandidates.length,
      currentStrategy: commandPalette.strategyManager?.getCurrentState()?.strategy || null
    }
  },

  /**
   * Register a new strategy (for external use)
   * @param {CommandStateStrategy} strategy - Strategy to register
   */
  registerStrategy: function (strategy) {
    if (commandPalette.strategyManager) {
      commandPalette.strategyManager.registerStrategy(strategy)
    }
  }
}

// Register keyboard shortcuts
keybindings.defineShortcut('showCommandPalette', function () {
  commandPalette.showWithPrefix('>')
})

module.exports = commandPalette 