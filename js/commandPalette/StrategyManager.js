/**
 * Strategy Manager for Command Palette
 * 
 * Manages registration and execution of command state strategies.
 * Handles input matching, state transitions, and fallback logic.
 */

const { CommandStateStrategy } = require('./CommandStateStrategy.js')

/**
 * @typedef {Object} StateTransition
 * @property {CommandStateStrategy} strategy - The target strategy
 * @property {Object} data - Extracted data from input matching
 * @property {string} input - Original input that triggered the transition
 */

class StrategyManager {
  constructor() {
    /** @type {Map<string, CommandStateStrategy>} */
    this.strategies = new Map()
    
    /** @type {CommandStateStrategy|null} */
    this.currentStrategy = null
    
    /** @type {CommandStateStrategy|null} */
    this.fallbackStrategy = null
    
    this.eventListeners = new Map()
  }

  /**
   * Register a command state strategy
   * @param {CommandStateStrategy} strategy - Strategy to register
   */
  registerStrategy(strategy) {
    if (!(strategy instanceof CommandStateStrategy)) {
      throw new Error('Strategy must extend CommandStateStrategy')
    }
    
    this.strategies.set(strategy.stateName, strategy)
    
    // Set fallback strategy (usually the one with lowest priority or empty state)
    if (!this.fallbackStrategy || strategy.stateName === 'EMPTY') {
      this.fallbackStrategy = strategy
    }
  }

  /**
   * Unregister a strategy
   * @param {string} stateName - Name of the strategy to unregister
   */
  unregisterStrategy(stateName) {
    const strategy = this.strategies.get(stateName)
    if (strategy) {
      strategy.deactivate()
      this.strategies.delete(stateName)
      
      if (this.currentStrategy === strategy) {
        this.currentStrategy = null
      }
      
      if (this.fallbackStrategy === strategy) {
        this.fallbackStrategy = this.findBestFallback()
      }
    }
  }

  /**
   * Find the best matching strategy for the given input
   * @param {string} input - Current input value
   * @returns {StateTransition|null} State transition information
   */
  findMatchingStrategy(input) {
    const matches = []
    
    // Test all strategies
    for (const strategy of this.strategies.values()) {
      try {
        const result = strategy.matches(input)
        if (result.matches) {
          matches.push({
            strategy,
            data: result.data || {},
            priority: result.priority || strategy.priority,
            input
          })
        }
      } catch (error) {
        console.error(`Error testing strategy ${strategy.stateName}:`, error)
      }
    }
    
    if (matches.length === 0) {
      // No matches, use fallback
      if (this.fallbackStrategy) {
        return {
          strategy: this.fallbackStrategy,
          data: { query: input },
          input
        }
      }
      return null
    }
    
    // Sort by priority (highest first)
    matches.sort((a, b) => b.priority - a.priority)
    
    return matches[0]
  }

  /**
   * Process input and determine if state transition is needed
   * @param {string} input - Current input value
   * @param {Object} context - Command palette context
   * @returns {Promise<boolean>} True if state changed, false otherwise
   */
  async processInput(input, context) {
    const transition = this.findMatchingStrategy(input)
    
    if (!transition) {
      console.warn('No matching strategy found for input:', input)
      return false
    }
    
    // Check if we need to transition to a different strategy
    if (this.currentStrategy !== transition.strategy) {
      await this.transitionTo(transition.strategy, transition.data, context)
      return true
    }
    
    // Same strategy, just update UI with new data
    try {
      const candidates = await this.currentStrategy.updateUI(input, transition.data, context)
      this.emit('candidates-updated', { candidates, strategy: this.currentStrategy })
      return false
    } catch (error) {
      console.error(`Error updating UI for ${this.currentStrategy.stateName}:`, error)
      return false
    }
  }

  /**
   * Transition to a new strategy
   * @param {CommandStateStrategy} newStrategy - Target strategy
   * @param {Object} data - State data
   * @param {Object} context - Command palette context
   */
  async transitionTo(newStrategy, data, context) {
    const previousStrategy = this.currentStrategy
    
    // Exit current strategy
    if (this.currentStrategy) {
      try {
        this.currentStrategy.onExit(context)
        this.currentStrategy.deactivate()
      } catch (error) {
        console.error(`Error exiting strategy ${this.currentStrategy.stateName}:`, error)
      }
    }
    
    // Enter new strategy
    this.currentStrategy = newStrategy
    
    try {
      newStrategy.activate()
      newStrategy.onEnter(context, data)
      
      // Update UI
      const candidates = await newStrategy.updateUI(context.input.value, data, context)
      
      // Update placeholder and CSS classes
      context.input.placeholder = newStrategy.getPlaceholder(data)
      
      // Reset CSS classes
      context.input.className = context.input.className.replace(/strategy-\w+/g, '')
      const inputClasses = newStrategy.getInputClasses()
      if (inputClasses.length > 0) {
        context.input.classList.add(...inputClasses)
      }
      
      this.emit('state-changed', {
        previousStrategy: previousStrategy?.stateName || null,
        currentStrategy: newStrategy.stateName,
        data,
        candidates
      })
      
    } catch (error) {
      console.error(`Error entering strategy ${newStrategy.stateName}:`, error)
      
      // Fallback to previous strategy or default
      if (previousStrategy && previousStrategy !== newStrategy) {
        this.currentStrategy = previousStrategy
        previousStrategy.activate()
      } else if (this.fallbackStrategy && this.fallbackStrategy !== newStrategy) {
        this.currentStrategy = this.fallbackStrategy
        this.fallbackStrategy.activate()
      }
    }
  }

  /**
   * Execute action for selected candidate
   * @param {Object} candidate - Selected candidate
   * @param {Object} context - Command palette context
   */
  async executeAction(candidate, context) {
    if (!this.currentStrategy) {
      console.warn('No current strategy to execute action')
      return
    }
    
    try {
      await this.currentStrategy.executeAction(candidate, context)
      this.emit('action-executed', { candidate, strategy: this.currentStrategy })
    } catch (error) {
      console.error(`Error executing action for ${candidate.id}:`, error)
      this.emit('action-error', { error, candidate, strategy: this.currentStrategy })
    }
  }

  /**
   * Handle keyboard events
   * @param {KeyboardEvent} event - Keyboard event
   * @param {Object} context - Command palette context
   * @returns {boolean} True if event was handled
   */
  handleKeydown(event, context) {
    if (!this.currentStrategy) {
      return false
    }
    
    try {
      return this.currentStrategy.handleKeydown(event, context)
    } catch (error) {
      console.error(`Error handling keydown in ${this.currentStrategy.stateName}:`, error)
      return false
    }
  }

  /**
   * Get current strategy information
   * @returns {Object} Current strategy information
   */
  getCurrentState() {
    return {
      strategy: this.currentStrategy?.stateName || null,
      isActive: this.currentStrategy?.isActive || false,
      availableStrategies: Array.from(this.strategies.keys())
    }
  }

  /**
   * Find the best fallback strategy
   * @returns {CommandStateStrategy|null}
   */
  findBestFallback() {
    let best = null
    let bestPriority = -Infinity
    
    for (const strategy of this.strategies.values()) {
      if (strategy.stateName === 'EMPTY' || strategy.priority > bestPriority) {
        best = strategy
        bestPriority = strategy.priority
      }
    }
    
    return best
  }

  /**
   * Reset to fallback strategy
   * @param {Object} context - Command palette context
   */
  async resetToFallback(context) {
    if (this.fallbackStrategy) {
      await this.transitionTo(this.fallbackStrategy, {}, context)
    }
  }

  /**
   * Add event listener
   * @param {string} event - Event name
   * @param {Function} listener - Event listener function
   */
  on(event, listener) {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, [])
    }
    this.eventListeners.get(event).push(listener)
  }

  /**
   * Remove event listener
   * @param {string} event - Event name
   * @param {Function} listener - Event listener function
   */
  off(event, listener) {
    const listeners = this.eventListeners.get(event)
    if (listeners) {
      const index = listeners.indexOf(listener)
      if (index !== -1) {
        listeners.splice(index, 1)
      }
    }
  }

  /**
   * Emit event
   * @param {string} event - Event name
   * @param {Object} data - Event data
   */
  emit(event, data) {
    const listeners = this.eventListeners.get(event)
    if (listeners) {
      listeners.forEach(listener => {
        try {
          listener(data)
        } catch (error) {
          console.error(`Error in event listener for ${event}:`, error)
        }
      })
    }
  }
}

module.exports = StrategyManager 