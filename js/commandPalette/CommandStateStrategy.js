/**
 * Command State Strategy Interface
 * 
 * Defines the interface that all command state strategies must implement.
 * Each strategy handles input pattern matching, UI updates, and action execution
 * for a specific command palette state.
 */

/**
 * @typedef {Object} Candidate
 * @property {string} id - Unique identifier for the candidate
 * @property {string} title - Display title
 * @property {string} description - Description text
 * @property {string} icon - Icon identifier
 * @property {Function} action - Function to execute when selected
 * @property {string} [shortcut] - Optional keyboard shortcut display
 */

/**
 * @typedef {Object} MatchResult
 * @property {boolean} matches - Whether input matches this strategy
 * @property {Object} [data] - Extracted data from the input (command, args, etc.)
 * @property {number} [priority] - Priority for conflict resolution (higher = higher priority)
 */

/**
 * Abstract base class for command state strategies
 * Each concrete strategy implements specific behavior for a command palette state
 */
class CommandStateStrategy {
  /**
   * @param {string} stateName - The name of the state this strategy handles
   * @param {number} priority - Priority for conflict resolution (higher = higher priority)
   */
  constructor(stateName, priority = 0) {
    this.stateName = stateName
    this.priority = priority
    this.isActive = false
  }

  /**
   * Test if this strategy matches the given input
   * @param {string} input - Current input value
   * @returns {MatchResult} Match result with extracted data
   */
  matches(input) {
    throw new Error('matches() must be implemented by subclass')
  }

  /**
   * Get the regex pattern for this strategy
   * @returns {RegExp} Regular expression pattern
   */
  getPattern() {
    throw new Error('getPattern() must be implemented by subclass')
  }

  /**
   * Update UI for this state
   * @param {string} input - Current input value
   * @param {Object} data - Extracted data from input matching
   * @param {Object} context - Command palette context (DOM elements, etc.)
   * @returns {Promise<Candidate[]>} Array of candidates to display
   */
  async updateUI(input, data, context) {
    throw new Error('updateUI() must be implemented by subclass')
  }

  /**
   * Execute action when a candidate is selected
   * @param {Candidate} candidate - Selected candidate
   * @param {Object} context - Command palette context
   * @returns {Promise<void>}
   */
  async executeAction(candidate, context) {
    if (candidate.action && typeof candidate.action === 'function') {
      try {
        await candidate.action()
      } catch (error) {
        console.error(`Error executing action for ${candidate.id}:`, error)
      }
    }
  }

  /**
   * Handle state-specific keyboard events
   * @param {KeyboardEvent} event - Keyboard event
   * @param {Object} context - Command palette context
   * @returns {boolean} True if event was handled, false otherwise
   */
  handleKeydown(event, context) {
    // Default implementation does nothing
    return false
  }

  /**
   * Get placeholder text for this state
   * @param {Object} data - Current state data
   * @returns {string} Placeholder text
   */
  getPlaceholder(data = {}) {
    return 'Enter command...'
  }

  /**
   * Activate this strategy
   */
  activate() {
    this.isActive = true
  }

  /**
   * Deactivate this strategy
   */
  deactivate() {
    this.isActive = false
  }

  /**
   * Get CSS classes to apply to input element
   * @returns {string[]} Array of CSS class names
   */
  getInputClasses() {
    return []
  }

  /**
   * Called when transitioning into this state
   * @param {Object} context - Command palette context
   * @param {Object} data - State data
   */
  onEnter(context, data) {
    // Override in subclasses if needed
  }

  /**
   * Called when transitioning out of this state
   * @param {Object} context - Command palette context
   */
  onExit(context) {
    // Override in subclasses if needed
  }
}

module.exports = {
  CommandStateStrategy,
  // Export types for JSDoc
  /**
   * @typedef {Candidate} Candidate
   * @typedef {MatchResult} MatchResult
   */
} 