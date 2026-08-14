/**
 * Command Palette Overlay
 *
 * This module provides overlay functionality for the command palette.
 * The overlay shows when the command palette is visible and provides
 * visual feedback and context for the current command state.
 *
 * Features:
 * - Visual overlay that appears when command palette is shown
 * - Context-aware display showing current command type
 * - Smooth animations and modern design
 * - Non-intrusive overlay that doesn't interfere with keyboard events
 * - Unified RPC communication for updating UI state
 */

function createCommandPaletteOverlay ({ overlayHTML, overlayManager }) {
// Constants
  const OVERLAY_CONFIG = {
    SIZE: { width: 600, height: 450 },
    POSITION: 'center',
    FALLBACK_HTML: '<div>Command Palette Overlay</div>'
  }

  // Use the global overlayManager that's available in the concatenated build
  var commandPaletteOverlayManager = overlayManager

  /**
 * Check if overlay manager is available and ready
 * @returns {boolean} True if ready
 */
  function isOverlayManagerReady () {
    return commandPaletteOverlayManager !== null
  }

  /**
 * Safely execute RPC calls with minimal error handling
 * @param {string} code - JavaScript code to execute
 */
  function safeRpcEval (code) {
    try {
      commandPaletteOverlayManager.eval(code)
    } catch (error) {
    // Silent fail for production - overlay will continue to work
    }
  }

  /**
 * Initialize the command palette overlay
 */
  function initCommandPaletteOverlay () {
    if (!isOverlayManagerReady()) {
      return
    }

    // Initialize the overlay with the HTML content
    commandPaletteOverlayManager.init({
      size: OVERLAY_CONFIG.SIZE,
      position: OVERLAY_CONFIG.POSITION,
      html: overlayHTML || OVERLAY_CONFIG.FALLBACK_HTML
    })
  }

  /**
 * Show the command palette overlay
 */
  function showCommandPaletteOverlay () {
    if (!isOverlayManagerReady()) {
      return
    }

    if (!commandPaletteOverlayManager.hasCurrent()) {
      initCommandPaletteOverlay()
    }

    commandPaletteOverlayManager.show()

    // Show the overlay via RPC
    safeRpcEval(`
    if (window.showOverlay) {
      window.showOverlay();
    }
  `)

    // After showing, ensure bounds are recalculated to center within current window size
    try {
      if (typeof commandPaletteOverlayManager.recenter === 'function') {
        commandPaletteOverlayManager.recenter()
      }
    } catch (e) {}
  }

  /**
 * Hide the command palette overlay
 */
  function hideCommandPaletteOverlay () {
    if (!isOverlayManagerReady()) {
      return
    }

    if (commandPaletteOverlayManager.isVisible()) {
    // Hide the overlay via RPC
      safeRpcEval(`
      if (window.hideOverlay) {
        window.hideOverlay();
      }
    `)

      commandPaletteOverlayManager.hide()
    }
  }

  /**
 * Update the overlay UI with complete state
 * @param {Object} overlayState - Complete state object with input, candidates, selection, and visibility
 */
  function updateOverlayUI (overlayState) {
    if (!isOverlayManagerReady() || !commandPaletteOverlayManager.isVisible()) {
      return
    }

    try {
    // Ensure overlay stays centered if window size changed recently
      try {
        if (typeof commandPaletteOverlayManager.recenter === 'function') {
          commandPaletteOverlayManager.recenter()
        }
      } catch (e) {}

      // Update input content if provided
      if (overlayState.input !== undefined) {
        safeRpcEval(`
        if (window.updateOverlayInput) {
          window.updateOverlayInput(${JSON.stringify(overlayState.input)});
        }
      `)
      }

      // Update suggestions/candidates if provided
      if (overlayState.candidates !== undefined) {
        safeRpcEval(`
        if (window.updateSuggestions) {
          window.updateSuggestions(${JSON.stringify(overlayState.candidates)});
        }
      `)
      }

      // Update selection if provided
      if (overlayState.selectedIndex !== undefined) {
        safeRpcEval(`
        if (window.updateSelection) {
          window.updateSelection(${JSON.stringify({ index: overlayState.selectedIndex })});
        }
      `)
      }
    } catch (error) {
    // Silent fail for production - overlay will continue to work
    }
  }

  /**
 * Destroy the command palette overlay
 */
  function destroyCommandPaletteOverlay () {
    if (!isOverlayManagerReady()) {
      return
    }

    commandPaletteOverlayManager.destroy()
  }

  return {
    destroy: destroyCommandPaletteOverlay,
    hide: hideCommandPaletteOverlay,
    init: initCommandPaletteOverlay,
    show: showCommandPaletteOverlay,
    update: updateOverlayUI
  }
}

module.exports = createCommandPaletteOverlay
