/**
 * REPL State Strategy
 * 
 * Handles ">>>" prefix - JavaScript REPL mode
 */

const { CommandStateStrategy } = require('../CommandStateStrategy.js')

class ReplStrategy extends CommandStateStrategy {
  constructor() {
    super('REPL', 90) // Highest priority for exact matches
    this.replHistory = []
    this.replInputHistory = []
    this.replInputHistoryIndex = 0
  }

  /**
   * @param {string} input - Current input value
   * @returns {{matches: boolean, data?: Object, priority?: number}}
   */
  matches(input) {
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
   * @returns {RegExp}
   */
  getPattern() {
    return /^>>>(\s.*)?$/
  }

  /**
   * @param {string} input - Current input value
   * @param {Object} data - Extracted data from input matching
   * @param {Object} context - Command palette context
   * @returns {Promise<Array>} Array of candidates (empty for REPL)
   */
  async updateUI(input, data, context) {
    // REPL mode doesn't show candidates, it shows history
    if (context.suggestions) {
      this.renderReplHistory(context)
    }
    
    return [] // No candidates in REPL mode
  }

  /**
   * @param {Object} data - Current state data
   * @returns {string}
   */
  getPlaceholder(data = {}) {
    return 'Enter JavaScript code...'
  }

  /**
   * @returns {string[]}
   */
  getInputClasses() {
    return ['repl-mode']
  }

  /**
   * @param {Object} context - Command palette context
   * @param {Object} data - State data
   */
  onEnter(context, data) {
    // Ensure input starts with ">>> "
    if (!context.input.value.startsWith('>>> ')) {
      context.input.value = '>>> '
      context.input.setSelectionRange(4, 4)
    }
  }

  /**
   * @param {Object} context - Command palette context
   */
  onExit(context) {
    // Reset REPL history when exiting
    this.replHistory = []
    this.replInputHistory = []
    this.replInputHistoryIndex = 0
    
    // Clear the suggestions area
    if (context.suggestions) {
      context.suggestions.innerHTML = ''
    }
  }

  /**
   * Handle REPL-specific keyboard events
   * @param {KeyboardEvent} event - Keyboard event
   * @param {Object} context - Command palette context
   * @returns {boolean} True if event was handled
   */
  handleKeydown(event, context) {
    switch (event.key) {
      case 'Enter':
        event.preventDefault()
        const input = context.input.value
        if (input.startsWith('>>> ')) {
          const code = input.substring(4).trim()
          if (code) {
            this.executeReplCode(code, context)
          }
        }
        return true

      case 'ArrowUp':
        event.preventDefault()
        this.navigateHistory('up', context)
        return true

      case 'ArrowDown':
        event.preventDefault()
        this.navigateHistory('down', context)
        return true

      case 'Tab':
        event.preventDefault()
        // Insert tab character for code indentation
        const start = context.input.selectionStart
        const end = context.input.selectionEnd
        const value = context.input.value
        
        context.input.value = value.substring(0, start) + '  ' + value.substring(end)
        context.input.setSelectionRange(start + 2, start + 2)
        return true

      default:
        return false
    }
  }

  /**
   * Navigate through input history
   * @param {string} direction - 'up' or 'down'
   * @param {Object} context - Command palette context
   */
  navigateHistory(direction, context) {
    if (this.replInputHistory.length === 0) return

    if (direction === 'up') {
      if (this.replInputHistoryIndex > 0) {
        this.replInputHistoryIndex--
        const historyCode = this.replInputHistory[this.replInputHistoryIndex]
        context.input.value = `>>> ${historyCode}`
        context.input.setSelectionRange(4 + historyCode.length, 4 + historyCode.length)
      }
    } else if (direction === 'down') {
      if (this.replInputHistoryIndex < this.replInputHistory.length - 1) {
        this.replInputHistoryIndex++
        const historyCode = this.replInputHistory[this.replInputHistoryIndex]
        context.input.value = `>>> ${historyCode}`
        context.input.setSelectionRange(4 + historyCode.length, 4 + historyCode.length)
      } else if (this.replInputHistoryIndex === this.replInputHistory.length - 1) {
        this.replInputHistoryIndex++
        context.input.value = '>>> '
        context.input.setSelectionRange(4, 4)
      }
    }
  }

  /**
   * Execute JavaScript code in the current tab context
   * @param {string} code - JavaScript code to execute
   * @param {Object} context - Command palette context
   */
  executeReplCode(code, context) {
    const webviews = require('../../webviews.js')
    
    // Validate input
    if (!code || !code.trim()) {
      return
    }
    
    // Check if there's a current tab
    const currentTab = tabs.getSelected()
    if (!currentTab) {
      const historyEntry = {
        id: this.replHistory.length + 1,
        input: code,
        output: 'Error: No active tab available',
        isError: true,
        timestamp: new Date()
      }
      this.replHistory.push(historyEntry)
      this.renderReplHistory(context)
      context.input.value = '>>> '
      context.input.setSelectionRange(4, 4)
      return
    }
    
    // Add to input history
    this.replInputHistory.push(code)
    this.replInputHistoryIndex = this.replInputHistory.length
    
    // Execute code in the current tab
    webviews.callAsync(currentTab, 'executeJavaScript', code, (err, result) => {
      const historyEntry = {
        id: this.replHistory.length + 1,
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
      
      this.replHistory.push(historyEntry)
      this.renderReplHistory(context)
      
      // Scroll to show the newest result
      context.suggestions.scrollTop = context.suggestions.scrollHeight
      
      // Clear input and prepare for next command
      context.input.value = '>>> '
      context.input.setSelectionRange(4, 4)
    })
  }

  /**
   * Render REPL history in Jupyter-like format
   * @param {Object} context - Command palette context
   */
  renderReplHistory(context) {
    context.suggestions.innerHTML = ''
    
    if (this.replHistory.length === 0) {
      const emptyEl = document.createElement('div')
      emptyEl.className = 'repl-empty'
      emptyEl.textContent = 'No commands executed yet. Type JavaScript code and press Enter.'
      context.suggestions.appendChild(emptyEl)
      return
    }
    
    // Display history in chronological order (oldest first)
    this.replHistory.forEach((entry) => {
      const historyEl = this.createReplHistoryElement(entry)
      context.suggestions.appendChild(historyEl)
    })
  }

  /**
   * Create a REPL history element
   * @param {Object} entry - History entry object
   * @returns {HTMLElement} History element
   */
  createReplHistoryElement(entry) {
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
  }

  /**
   * Escape HTML to prevent XSS
   * @param {string} text - Text to escape
   * @returns {string} Escaped text
   */
  escapeHtml(text) {
    const div = document.createElement('div')
    div.textContent = text
    return div.innerHTML
  }
}

module.exports = ReplStrategy 