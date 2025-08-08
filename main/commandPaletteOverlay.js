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

// Constants
const OVERLAY_CONFIG = {
  SIZE: { width: 600, height: 450 },
  POSITION: 'center',
  DEFAULT_ICON: 'carbon:search'
}

// Use the global overlayManager that's available in the concatenated build
var commandPaletteOverlayManager = global.overlayManager || null

/**
 * Check if overlay manager is available and ready
 * @returns {boolean} True if ready
 */
function isOverlayManagerReady() {
  return commandPaletteOverlayManager !== null
}

/**
 * Safely execute RPC calls with minimal error handling
 * @param {string} code - JavaScript code to execute
 */
function safeRpcEval(code) {
  try {
    commandPaletteOverlayManager.eval(code)
  } catch (error) {
    // Silent fail for production - overlay will continue to work
  }
}

/**
 * Initialize the command palette overlay
 */
function initCommandPaletteOverlay() {
  if (!isOverlayManagerReady()) {
    return
  }

  // Use the template module to get the HTML content
  const overlayHTML = global.getCommandPaletteOverlayTemplate ? global.getCommandPaletteOverlayTemplate() : '<div>Command Palette Overlay</div>'

  // Initialize the overlay with the HTML content
  commandPaletteOverlayManager.init({
    size: OVERLAY_CONFIG.SIZE,
    position: OVERLAY_CONFIG.POSITION,
    html: overlayHTML
  })
}

/**
 * Show the command palette overlay
 */
function showCommandPaletteOverlay() {
  if (!isOverlayManagerReady()) {
    return
  }

  if (!commandPaletteOverlayManager.hasCurrent()) {
    initCommandPaletteOverlay()
  }
  
  commandPaletteOverlayManager.show()
  
  // Show the overlay via RPC
  try {
    safeRpcEval(`
      if (window.showOverlay) {
        window.showOverlay();
      }
    `);
  } catch (error) {
    // Silent fail for production - overlay will continue to work
  }
}

/**
 * Hide the command palette overlay
 */
function hideCommandPaletteOverlay() {
  if (!isOverlayManagerReady()) {
    return
  }

  if (commandPaletteOverlayManager.isVisible()) {
    // Hide the overlay via RPC
    try {
      safeRpcEval(`
        if (window.hideOverlay) {
          window.hideOverlay();
        }
      `);
    } catch (error) {
      // Silent fail for production - overlay will continue to work
    }
    
    commandPaletteOverlayManager.hide()
  }
}

/**
 * Update the overlay UI with complete state
 * @param {Object} overlayState - Complete state object with input, candidates, selection, and visibility
 */
function updateOverlayUI(overlayState) {
  if (!isOverlayManagerReady() || !commandPaletteOverlayManager.isVisible()) {
    return
  }

  try {
    // Update input content if provided
    if (overlayState.input !== undefined) {
      safeRpcEval(`
        if (window.updateOverlayInput) {
          window.updateOverlayInput(${JSON.stringify(overlayState.input)});
        }
      `);
    }

    // Update suggestions/candidates if provided
    if (overlayState.candidates !== undefined) {
      safeRpcEval(`
        if (window.updateSuggestions) {
          window.updateSuggestions(${JSON.stringify(overlayState.candidates)});
        }
      `);
    }

    // Update selection if provided
    if (overlayState.selectedIndex !== undefined) {
      const selectionData = {
        index: overlayState.selectedIndex,
        total: overlayState.candidates?.length ?? 0,
        candidate: overlayState.candidates && overlayState.selectedIndex < overlayState.candidates.length ? {
          title: overlayState.candidates[overlayState.selectedIndex].title ?? '',
          description: overlayState.candidates[overlayState.selectedIndex].description ?? '',
          icon: overlayState.candidates[overlayState.selectedIndex].icon ?? OVERLAY_CONFIG.DEFAULT_ICON,
          shortcut: overlayState.candidates[overlayState.selectedIndex].shortcut ?? '',
          displayData: overlayState.candidates[overlayState.selectedIndex].displayData ?? {}
        } : null
      }
      
      safeRpcEval(`
        if (window.updateSelection) {
          window.updateSelection(${JSON.stringify(selectionData)});
        }
      `);
    }
  } catch (error) {
    // Silent fail for production - overlay will continue to work
  }
}

/**
 * Destroy the command palette overlay
 */
function destroyCommandPaletteOverlay() {
  if (!isOverlayManagerReady()) {
    return
  }

  commandPaletteOverlayManager.destroy()
}

// Export functions for use in main process
module.exports = {
  initCommandPaletteOverlay,
  showCommandPaletteOverlay,
  hideCommandPaletteOverlay,
  updateOverlayUI,
  destroyCommandPaletteOverlay
}

// Make functions available globally for other modules in the concatenated build
global.initCommandPaletteOverlay = initCommandPaletteOverlay
global.showCommandPaletteOverlay = showCommandPaletteOverlay
global.hideCommandPaletteOverlay = hideCommandPaletteOverlay
global.updateOverlayUI = updateOverlayUI
global.destroyCommandPaletteOverlay = destroyCommandPaletteOverlay 