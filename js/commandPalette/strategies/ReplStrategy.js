/**
 * REPL State Strategy
 *
 * Handles ">>>" prefix - JavaScript REPL mode
 */

const { CommandStateStrategy } = require('../CommandStateStrategy.js')

class ReplStrategy extends CommandStateStrategy {
  constructor () {
    super('REPL', 90) // Highest priority for exact matches
    this.replHistory = []
    this.replInputHistory = []
    this.replInputHistoryIndex = 0
  }

  /**
   * @param {string} input - Current input value
   * @returns {{matches: boolean, data?: Object, priority?: number}}
   */
  matches (input) {
    const trimmed = input.trim()
    // Matches ">>>" exactly or ">>> " with code
    const matches = trimmed === '>>>' || input.startsWith('>>> ')

    return {
      matches,
      data: { code: input.startsWith('>>> ') ? input.substring(4) : '' },
      priority: this.priority
    }
  }

  /**
   * Build a serialized history array for overlay rendering
   */
  getSerializedHistory () {
    return this.replHistory.map(entry => ({
      id: entry.id,
      input: String(entry.input ?? ''),
      output: entry.output,
      isError: !!entry.isError,
      timestamp: entry.timestamp?.toISOString?.() || null
    }))
  }

  /**
   * @param {string} input - Current input value
   * @param {Object} data - Extracted data from input matching
   * @param {Object} context - Command palette context
   * @returns {Promise<Array>} Array of candidates (special REPL payload)
   */
  async updateUI (input, data, context) {
    // Provide a single sentinel candidate that carries REPL history for the overlay
    const historyPayload = this.getSerializedHistory()

    return [
      {
        title: 'JavaScript REPL',
        description: historyPayload.length === 0 ? 'Type JavaScript after >>> and press Enter' : 'History',
        icon: 'carbon:terminal',
        displayData: {
          mode: 'repl',
          history: historyPayload
        }
      }
    ]
  }

  /**
   * @param {Object} context - Command palette context
   * @param {Object} data - State data
   */
  onEnter (context, data) {
    // Ensure input starts with ">>> "
    if (!context.input.value.startsWith('>>> ')) {
      context.input.value = '>>> '
      context.input.setSelectionRange(4, 4)
    }
  }

  /**
   * @param {Object} context - Command palette context
   */
  onExit (context) {
    // Reset REPL history when exiting
    this.replHistory = []
    this.replInputHistory = []
    this.replInputHistoryIndex = 0
    // No direct DOM manipulation here; overlay will reset via next update
  }

  /**
   * Handle REPL-specific keyboard events
   * @param {KeyboardEvent} event - Keyboard event
   * @param {Object} context - Command palette context
   * @returns {boolean} True if event was handled
   */
  handleKeydown (event, context) {
    switch (event.key) {
      case 'Enter': {
        event.preventDefault()
        const input = context.input.value
        if (input.startsWith('>>> ')) {
          const code = input.substring(4).trim()
          if (code) {
            this.executeReplCode(code, context)
          } else {
            // Even with empty code, keep caret after prompt
            context.input.value = '>>> '
            context.input.setSelectionRange(4, 4)
            // Trigger UI refresh to keep overlay in sync
            context.input.dispatchEvent(new Event('input', { bubbles: true }))
          }
        }
        return true
      }

      case 'ArrowUp':
        event.preventDefault()
        this.navigateHistory('up', context)
        return true

      case 'ArrowDown':
        event.preventDefault()
        this.navigateHistory('down', context)
        return true

      case 'Tab': {
        event.preventDefault()
        // Insert tab character for code indentation
        const start = context.input.selectionStart
        const end = context.input.selectionEnd
        const value = context.input.value

        context.input.value = value.substring(0, start) + '  ' + value.substring(end)
        context.input.setSelectionRange(start + 2, start + 2)
        return true
      }

      default:
        return false
    }
  }

  /**
   * Navigate through input history
   * @param {string} direction - 'up' or 'down'
   * @param {Object} context - Command palette context
   */
  navigateHistory (direction, context) {
    if (this.replInputHistory.length === 0) return

    if (direction === 'up') {
      if (this.replInputHistoryIndex > 0) {
        this.replInputHistoryIndex--
        const historyCode = this.replInputHistory[this.replInputHistoryIndex]
        context.input.value = `>>> ${historyCode}`
        context.input.setSelectionRange(4 + historyCode.length, 4 + historyCode.length)
        // Refresh overlay
        context.input.dispatchEvent(new Event('input', { bubbles: true }))
      }
    } else if (direction === 'down') {
      if (this.replInputHistoryIndex < this.replInputHistory.length - 1) {
        this.replInputHistoryIndex++
        const historyCode = this.replInputHistory[this.replInputHistoryIndex]
        context.input.value = `>>> ${historyCode}`
        context.input.setSelectionRange(4 + historyCode.length, 4 + historyCode.length)
        // Refresh overlay
        context.input.dispatchEvent(new Event('input', { bubbles: true }))
      } else if (this.replInputHistoryIndex === this.replInputHistory.length - 1) {
        this.replInputHistoryIndex++
        context.input.value = '>>> '
        context.input.setSelectionRange(4, 4)
        // Refresh overlay
        context.input.dispatchEvent(new Event('input', { bubbles: true }))
      }
    }
  }

  /**
   * Execute JavaScript code in the current tab context
   * @param {string} code - JavaScript code to execute
   * @param {Object} context - Command palette context
   */
  executeReplCode (code, context) {
    const webviews = require('../../webviews.js')

    // Validate input
    if (!code || !code.trim()) {
      return
    }

    // Safely access current tab from global tabs if available
    let currentTab = null
    try {
      if (typeof tabs !== 'undefined' && tabs && typeof tabs.getSelected === 'function') {
        currentTab = tabs.getSelected()
      }
    } catch (e) {
      // ignore
    }

    if (!currentTab) {
      const historyEntry = {
        id: this.replHistory.length + 1,
        input: code,
        output: 'Error: No active tab available',
        isError: true,
        timestamp: new Date()
      }
      this.replHistory.push(historyEntry)
      // Reset prompt and refresh overlay
      context.input.value = '>>> '
      context.input.setSelectionRange(4, 4)
      context.input.dispatchEvent(new Event('input', { bubbles: true }))
      return
    }

    // Add to input history
    this.replInputHistory.push(code)
    this.replInputHistoryIndex = this.replInputHistory.length

    // Execute code in the current tab
    try {
      webviews.callAsync(currentTab, 'executeJavaScript', code, (err, result) => {
        const historyEntry = {
          id: this.replHistory.length + 1,
          input: code,
          timestamp: new Date()
        }

        if (err) {
          historyEntry.output = `Error: ${err.message || err}`
          historyEntry.isError = true
        } else {
          historyEntry.output = result
          historyEntry.isError = false
        }

        this.replHistory.push(historyEntry)

        // Reset prompt and refresh overlay
        context.input.value = '>>> '
        context.input.setSelectionRange(4, 4)
        context.input.dispatchEvent(new Event('input', { bubbles: true }))
      })
    } catch (e) {
      const historyEntry = {
        id: this.replHistory.length + 1,
        input: code,
        output: `Error: ${e.message || e}`,
        isError: true,
        timestamp: new Date()
      }
      this.replHistory.push(historyEntry)
      context.input.value = '>>> '
      context.input.setSelectionRange(4, 4)
      context.input.dispatchEvent(new Event('input', { bubbles: true }))
    }
  }
}

module.exports = ReplStrategy
