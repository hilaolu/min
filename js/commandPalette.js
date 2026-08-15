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
  UPDATE_DEBOUNCE_MS: 50 // Debounce rapid updates
}

function createCommandPalette (options) {
  const {
    cancelSchedule = clearTimeout,
    createStrategies = function () {
      return [
        new EmptyStrategy(),
        new TabSearchStrategy(),
        new VimCommandStrategy(),
        new VimCommandWithArgsStrategy(),
        new ReplStrategy()
      ]
    },
    createStrategyManager = () => new StrategyManager(),
    document,
    keybindings,
    logger = console,
    rendererHost,
    schedule = setTimeout,
    webviews
  } = options

  let focusUnsubscribe = null
  let initialized = false
  let shortcutUnsubscribe = null
  const domUnsubscribes = []
  const strategyUnsubscribes = []

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

    // Overlay update debouncing
    overlayUpdateTimeout: null,

    /**
   * Initialize the command palette
   * Sets up DOM elements, strategies, and event listeners
   */
    initialize: function () {
      if (initialized) return
      // Get DOM elements - only input is required now, overlay handles the UI
      commandPalette.input = document.getElementById('command-palette-input')

      if (!commandPalette.input) {
        logger.error('Command palette input element not found')
        return
      }
      initialized = true

      // Initialize strategy manager
      commandPalette.strategyManager = createStrategyManager()

      // Register all strategies
      commandPalette.registerStrategies()

      // Set up event listeners
      commandPalette.setupEventListeners()

      shortcutUnsubscribe = keybindings.defineShortcut('showCommandPalette', function () {
        commandPalette.showWithPrefix('>')
      })

      logger.log('Command palette initialized with overlay-only mode')
    },

    /**
   * Register all command state strategies
   */
    registerStrategies: function () {
      const strategies = createStrategies()

      strategies.forEach(strategy => {
        try {
          commandPalette.strategyManager.registerStrategy(strategy)
        } catch (error) {
          logger.error(`Failed to register strategy ${strategy.stateName}:`, error)
        }
      })
    },

    /**
   * Set up event listeners for input and UI interactions
   */
    setupEventListeners: function () {
      function addInputListener (name, listener) {
        commandPalette.input.addEventListener(name, listener)
        if (typeof commandPalette.input.removeEventListener === 'function') {
          domUnsubscribes.push(() => commandPalette.input.removeEventListener(name, listener))
        }
      }

      addInputListener('input', commandPalette.handleInput)
      addInputListener('keydown', commandPalette.handleKeydown)
      addInputListener('blur', function () {
      // Couple overlay visibility with input focus
        if (commandPalette.isVisible) {
          commandPalette.hide()
        }
      })

      // Strategy manager event listeners
      strategyUnsubscribes.push(
        commandPalette.strategyManager.on('state-changed', commandPalette.handleStateChange),
        commandPalette.strategyManager.on('candidates-updated', commandPalette.handleCandidatesUpdate)
      )
      focusUnsubscribe = rendererHost.onCommandPaletteFocusRequested(commandPalette.focusInput)
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
        logger.error('Error processing input:', error)
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
        logger.error('Error executing action:', error)
      }
    },

    /**
   * Ensure the hidden input receives focus reliably
   */
    focusInput: function () {
      if (commandPalette.isVisible) commandPalette.input.focus()
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

      commandPalette.updateOverlayUI({ open: true, visible: true })
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

      commandPalette.updateOverlayUI({ open: true, visible: true })
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

      if (commandPalette.overlayUpdateTimeout) {
        cancelSchedule(commandPalette.overlayUpdateTimeout)
        commandPalette.overlayUpdateTimeout = null
      }

      commandPalette.updateOverlayUI({ visible: false })

      webviews.focus()
    },

    /**
   * Update the overlay UI with all current state
   * @param {Object} state - Complete state object to sync
   */
    updateOverlayUI: function (state = {}) {
      try {
      // Build complete state object with fallbacks to current values
        const overlayState = {
          input: state.input ?? commandPalette.input.value ?? '',
          candidates: state.candidates ?? commandPalette.currentCandidates ?? [],
          selectedIndex: state.selectedIndex ?? commandPalette.selectedIndex ?? 0,
          open: state.open === true,
          visible: state.visible ?? commandPalette.isVisible ?? false
        }

        // Serialize candidates to only include display data for security
        if (overlayState.candidates.length > 0) {
          overlayState.candidates = overlayState.candidates.map(candidate => ({
            id: candidate.id,
            title: candidate.title ?? '',
            description: candidate.description ?? '',
            icon: candidate.icon ?? OVERLAY_CONSTANTS.DEFAULT_ICON,
            shortcut: candidate.shortcut ?? '',
            displayData: candidate.displayData ?? {}
          }))
        }

        rendererHost.presentCommandPalette(overlayState).then(function (result) {
          if (!result.ok) logger.error('Command palette presentation failed:', result.error)
        }).catch(function (error) {
          logger.error('Command palette presentation failed:', error)
        })
      } catch (error) {
        logger.error('Command palette presentation failed:', error)
      }
    },

    /**
   * Debounced overlay UI update to prevent excessive updates
   * @param {Object} state - Complete state object to sync
   */
    updateOverlayUIDebounced: function (state = {}) {
    // Clear existing timeout
      if (commandPalette.overlayUpdateTimeout) {
        cancelSchedule(commandPalette.overlayUpdateTimeout)
      }

      // Set new timeout for debounced update
      commandPalette.overlayUpdateTimeout = schedule(() => {
        commandPalette.updateOverlayUI(state)
      }, OVERLAY_CONSTANTS.UPDATE_DEBOUNCE_MS)
    },

    /**
   * Get command palette context for strategies
   * @returns {Object} Context object
   */
    getContext: function () {
      return {
        input: commandPalette.input
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
   * Update selection highlighting in UI
   */
    updateSelection: function () {
    // Update overlay selection via unified interface
      commandPalette.updateOverlayUI({
        selectedIndex: commandPalette.selectedIndex
      })
    },

    destroy: function () {
      if (commandPalette.overlayUpdateTimeout) {
        cancelSchedule(commandPalette.overlayUpdateTimeout)
        commandPalette.overlayUpdateTimeout = null
      }
      if (focusUnsubscribe) {
        focusUnsubscribe()
        focusUnsubscribe = null
      }
      if (shortcutUnsubscribe) {
        shortcutUnsubscribe()
        shortcutUnsubscribe = null
      }
      strategyUnsubscribes.filter(Boolean).forEach(unsubscribe => unsubscribe())
      strategyUnsubscribes.length = 0
      domUnsubscribes.forEach(unsubscribe => unsubscribe())
      domUnsubscribes.length = 0
    }
  }

  const commandPaletteInterface = {
    destroy: commandPalette.destroy,
    hide: commandPalette.hide,
    initialize: commandPalette.initialize,
    show: commandPalette.show,
    showWithPrefix: commandPalette.showWithPrefix
  }
  Object.defineProperty(commandPaletteInterface, 'input', {
    get: () => commandPalette.input
  })
  return Object.freeze(commandPaletteInterface)
}

let productionCommandPalette = null

function getProductionCommandPalette () {
  if (!productionCommandPalette) {
    throw new Error('Command Palette has not been initialized')
  }
  return productionCommandPalette
}

const commandPalette = {
  createCommandPalette,
  initialize: function (options) {
    if (!productionCommandPalette) {
      productionCommandPalette = createCommandPalette(options)
    }
    return productionCommandPalette.initialize()
  },
  destroy: (...args) => getProductionCommandPalette().destroy(...args),
  hide: (...args) => getProductionCommandPalette().hide(...args),
  show: (...args) => getProductionCommandPalette().show(...args),
  showWithPrefix: (...args) => getProductionCommandPalette().showWithPrefix(...args)
}

Object.defineProperty(commandPalette, 'input', {
  get: () => getProductionCommandPalette().input
})

module.exports = commandPalette
