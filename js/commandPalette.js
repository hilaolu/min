const EventEmitter = require('events')
var keybindings = require('keybindings.js')
var modalMode = require('modalMode.js')

// Import strategy components
const StrategyManager = require('./commandPalette/StrategyManager.js')
const EmptyStrategy = require('./commandPalette/strategies/EmptyStrategy.js')
const TabSearchStrategy = require('./commandPalette/strategies/TabSearchStrategy.js')
const VimCommandStrategy = require('./commandPalette/strategies/VimCommandStrategy.js')
const VimCommandWithArgsStrategy = require('./commandPalette/strategies/VimCommandWithArgsStrategy.js')
const ReplStrategy = require('./commandPalette/strategies/ReplStrategy.js')

// Constants for overlay communication
const OVERLAY_CONSTANTS = {
  DEFAULT_ICON: 'carbon:search',
  MAX_DESCRIPTION_LENGTH: 60,
  UPDATE_DEBOUNCE_MS: 50, // Debounce rapid updates
  IPC_CHANNELS: {
    SHOW: 'showCommandPaletteOverlay',
    HIDE: 'hideCommandPaletteOverlay',
    UPDATE_UI: 'updateCommandPaletteOverlayUI'
  }
}

// Command palette object
const commandPalette = {
  // Core DOM elements
  input: null,
  
  // State management
  isVisible: false,
  selectedIndex: 0,
  currentCandidates: [],
  
  // Strategy management
  strategyManager: null,
  
  // Event system
  events: null,
  
  // Overlay update debouncing
  overlayUpdateTimeout: null,

  /**
   * Initialize the command palette
   * Sets up DOM elements, strategies, and event listeners
   */
  initialize: function () {
    // Get DOM elements - only input is required now, overlay handles the UI
    commandPalette.input = document.getElementById('command-palette-input')

    if (!commandPalette.input) {
      console.error('Command palette input element not found')
      return
    }

    // Initialize event emitter
    commandPalette.events = new EventEmitter()

    // Initialize strategy manager
    commandPalette.strategyManager = new StrategyManager()
    
    // Register all strategies
    commandPalette.registerStrategies()
    
    // Set up event listeners
    commandPalette.setupEventListeners()
    
    // Initialize overlay for command palette
    commandPalette.initializeOverlay()
    
    console.log('Command palette initialized with overlay-only mode')
  },

  /**
   * Initialize the command palette overlay
   */
  initializeOverlay: function () {
    // Send IPC message to initialize the command palette overlay
    if (typeof window.ipc !== 'undefined') {
      window.ipc.send('initCommandPaletteOverlay')
    }
  },

  /**
   * Register all command state strategies
   */
  registerStrategies: function () {
    const strategies = [
      new EmptyStrategy(),
      new TabSearchStrategy(),
      new VimCommandStrategy(),
      new VimCommandWithArgsStrategy(),
      new ReplStrategy()
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
    commandPalette.input.addEventListener('blur', function () {
      // Couple overlay visibility with input focus
      if (commandPalette.isVisible) {
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
    
    // Update the overlay input content with debouncing for better performance
    commandPalette.updateOverlayUIDebounced({ input: inputValue })
    
    try {
      const stateChanged = await commandPalette.strategyManager.processInput(inputValue, context)
      if (!stateChanged) {
        // State didn't change, just update selection
        commandPalette.selectedIndex = 0
        commandPalette.updateSelection()
      }
    } catch (error) {
      console.error('Error processing input:', error)
      // Fallback to empty state on error
      if (commandPalette.strategyManager) {
        commandPalette.strategyManager.resetToFallback(context)
      }
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
   * Ensure the hidden input receives focus reliably
   */
  focusInputWithRetry: function () {
    // Try immediately
    try { commandPalette.input.focus() } catch (e) {}
    // Retry after overlay manager refocuses the main window
    setTimeout(() => {
      if (document.activeElement !== commandPalette.input) {
        try { commandPalette.input.focus() } catch (e) {}
      }
    }, 220)
  },

  /**
   * Show the command palette
   */
  show: function () {
    if (commandPalette.isVisible) return

    commandPalette.isVisible = true

    // Reset state
    commandPalette.selectedIndex = 0
    commandPalette.input.value = ''
    
    // Initialize with empty strategy
    const context = commandPalette.getContext()
    commandPalette.strategyManager.resetToFallback(context)

    // Show the overlay and clear its input and suggestions
    commandPalette.showOverlay()
    commandPalette.updateOverlayInput('')
    commandPalette.clearOverlaySuggestions()

    commandPalette.focusInputWithRetry()
  },

  /**
   * Show the command palette with a pre-filled prefix
   * @param {string} prefix - The prefix to pre-fill in the input
   */
  showWithPrefix: function (prefix) {
    if (commandPalette.isVisible) return

    commandPalette.isVisible = true

    // Set input value and process it
    commandPalette.selectedIndex = 0
    commandPalette.input.value = prefix
    
    // Process the input to determine initial state
    commandPalette.handleInput()
    
    // Show the overlay and update its input with the prefix
    commandPalette.showOverlay()
    commandPalette.updateOverlayInput(prefix)
    
    setTimeout(() => {
      try {
        commandPalette.input.focus()
        commandPalette.input.setSelectionRange(prefix.length, prefix.length)
      } catch (e) {}
    }, 50)

    setTimeout(() => {
      try {
        commandPalette.input.focus()
        commandPalette.input.setSelectionRange(prefix.length, prefix.length)
      } catch (e) {}
    }, 220)
  },

  /**
   * Hide the command palette
   */
  hide: function () {
    if (!commandPalette.isVisible) return

    commandPalette.isVisible = false
    commandPalette.input.blur()
    
    // Reset state
    commandPalette.selectedIndex = 0
    commandPalette.currentCandidates = []
    
    // Hide the overlay and clear its input and suggestions
    commandPalette.hideOverlay()
    commandPalette.updateOverlayInput('')
    commandPalette.clearOverlaySuggestions()

    // Ensure the active tab regains focus
    try {
      var webviews = require('webviews.js')
      webviews.focus()
    } catch (e) {}
  },

  /**
   * Update the overlay input content
   * @param {string} inputValue - The new input value
   */
  updateOverlayInput: function (inputValue) {
    commandPalette.updateOverlayUI({ input: inputValue })
  },

  /**
   * Update suggestions in the overlay
   * @param {Array} candidates - Array of candidate objects
   */
  updateOverlaySuggestions: function (candidates) {
    commandPalette.updateOverlayUI({ candidates: candidates })
  },

  /**
   * Update selection in the overlay
   * @param {number} index - Index of the selected item
   */
  updateOverlaySelection: function (index) {
    commandPalette.updateOverlayUI({ selectedIndex: index })
  },

  /**
   * Clear suggestions in the overlay
   */
  clearOverlaySuggestions: function () {
    commandPalette.updateOverlayUI({ candidates: [] })
  },

  /**
   * Update the overlay UI with all current state
   * @param {Object} state - Complete state object to sync
   */
  updateOverlayUI: function (state = {}) {
    if (typeof window.ipc !== 'undefined') {
      try {
        // Build complete state object with fallbacks to current values
        const overlayState = {
          input: state.input ?? commandPalette.input.value ?? '',
          candidates: state.candidates ?? commandPalette.currentCandidates ?? [],
          selectedIndex: state.selectedIndex ?? commandPalette.selectedIndex ?? 0,
          isVisible: state.isVisible ?? commandPalette.isVisible ?? false
        }
        
        // Serialize candidates to only include display data for security
        if (overlayState.candidates.length > 0) {
          overlayState.candidates = overlayState.candidates.map(candidate => ({
            title: candidate.title ?? '',
            description: candidate.description ?? '',
            icon: candidate.icon ?? OVERLAY_CONSTANTS.DEFAULT_ICON,
            shortcut: candidate.shortcut ?? '',
            displayData: candidate.displayData ?? {}
          }))
        }
        
        window.ipc.send(OVERLAY_CONSTANTS.IPC_CHANNELS.UPDATE_UI, overlayState)
      } catch (error) {
        // Silent fail for production - overlay will continue to work
      }
    }
  },

  /**
   * Debounced overlay UI update to prevent excessive updates
   * @param {Object} state - Complete state object to sync
   */
  updateOverlayUIDebounced: function (state = {}) {
    // Clear existing timeout
    if (commandPalette.overlayUpdateTimeout) {
      clearTimeout(commandPalette.overlayUpdateTimeout)
    }
    
    // Set new timeout for debounced update
    commandPalette.overlayUpdateTimeout = setTimeout(() => {
      commandPalette.updateOverlayUI(state)
    }, OVERLAY_CONSTANTS.UPDATE_DEBOUNCE_MS)
  },

  /**
   * Show the overlay when command palette becomes visible
   */
  showOverlay: function () {
    if (typeof window.ipc !== 'undefined') {
      try {
        window.ipc.send(OVERLAY_CONSTANTS.IPC_CHANNELS.SHOW)
        // Update overlay UI with current state after showing
        commandPalette.updateOverlayUI({ isVisible: true })
      } catch (error) {
        // Silent fail for production - overlay will continue to work
      }
    }
  },

  /**
   * Hide the overlay when command palette becomes hidden
   */
  hideOverlay: function () {
    if (typeof window.ipc !== 'undefined') {
      try {
        // Clear any pending overlay updates
        if (commandPalette.overlayUpdateTimeout) {
          clearTimeout(commandPalette.overlayUpdateTimeout)
          commandPalette.overlayUpdateTimeout = null
        }
        
        window.ipc.send(OVERLAY_CONSTANTS.IPC_CHANNELS.HIDE)
      } catch (error) {
        // Silent fail for production - overlay will continue to work
      }
    }
  },

  /**
   * Get command palette context for strategies
   * @returns {Object} Context object
   */
  getContext: function () {
    return {
      input: commandPalette.input,
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
    
    // Update overlay UI with new state
    commandPalette.updateOverlayUI({
      candidates: commandPalette.currentCandidates,
      selectedIndex: commandPalette.selectedIndex
    })
    
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
    
    // Update overlay UI with new candidates
    commandPalette.updateOverlayUI({
      candidates: commandPalette.currentCandidates,
      selectedIndex: commandPalette.selectedIndex
    })
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
    // Update overlay selection via unified interface
    commandPalette.updateOverlayUI({
      selectedIndex: commandPalette.selectedIndex
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