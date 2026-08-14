/**
 * Vim Command State Strategy
 *
 * Handles ">" prefix - shows available vim commands
 */

const { CommandStateStrategy } = require('../CommandStateStrategy.js')

class VimCommandStrategy extends CommandStateStrategy {
  constructor () {
    super('VIM_COMMAND', 70) // High priority for exact matches
  }

  /**
   * @param {string} input - Current input value
   * @returns {{matches: boolean, data?: Object, priority?: number}}
   */
  matches (input) {
    const trimmed = input.trim()
    // Matches exactly ">"
    const matches = trimmed === '>'

    return {
      matches,
      data: {},
      priority: this.priority
    }
  }

  /**
   * @param {string} input - Current input value
   * @param {Object} data - Extracted data from input matching
   * @param {Object} context - Command palette context
   * @returns {Promise<Array>} Array of candidates
   */
  async updateUI (input, data, context) {
    try {
      // Get available commands
      const availableCommands = require('../../commandPaletteCommands.js')

      // Limit to 10 commands for keyboard shortcuts (0-9)
      const candidates = availableCommands.slice(0, 10).map(cmd => ({
        id: cmd.id,
        title: cmd.title,
        description: cmd.description,
        icon: cmd.icon,
        shortcut: cmd.shortcut,
        action: cmd.action
      }))

      // No direct DOM updates; overlay will render candidates
      return candidates
    } catch (e) {
      console.error('Error showing vim commands:', e)
      return []
    }
  }
}

module.exports = VimCommandStrategy
