/**
 * Command Palette Overlay Template
 * 
 * This module handles the loading and management of the command palette overlay HTML template.
 * The HTML is loaded during build time and made available as a global variable.
 */

// The HTML template is loaded during build time and made available globally
var commandPaletteOverlayTemplate = global.commandPaletteOverlayHTML || '<div>Command Palette Overlay</div>'

/**
 * Get the command palette overlay HTML template
 * @returns {string} The HTML template for the command palette overlay
 */
function getCommandPaletteOverlayTemplate() {
  if (!isTemplateAvailable()) {
    console.warn('Command palette overlay template not available, using fallback')
  }
  return commandPaletteOverlayTemplate
}

/**
 * Check if the template is available
 * @returns {boolean} True if the template is available
 */
function isTemplateAvailable() {
  return !!commandPaletteOverlayTemplate && commandPaletteOverlayTemplate !== '<div>Command Palette Overlay</div>'
}

// Export functions for use in other modules
module.exports = {
  getCommandPaletteOverlayTemplate,
  isTemplateAvailable
}

// Make functions available globally for other modules in the concatenated build
global.getCommandPaletteOverlayTemplate = getCommandPaletteOverlayTemplate
global.isTemplateAvailable = isTemplateAvailable 