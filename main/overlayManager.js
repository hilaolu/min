/**
 * Overlay Manager - A comprehensive system for creating and managing overlay views
 *
 * This system provides a clean API for creating overlay views that can be displayed
 * on top of the main browser window. Only one overlay can exist at any given time.
 *
 * Key Features:
 * - Single overlay instance (auto-destroys previous overlay)
 * - Non-focusable overlays (maintains main window keyboard shortcuts)
 * - RPC interface for JavaScript execution
 * - Automatic focus management
 *
 * @example
 * // Initialize an overlay
 * overlayManager.init({
 *   size: { width: 400, height: 300 },
 *   position: 'center',
 *   html: '<div>Hello World</div>'
 * });
 *
 * // Toggle visibility
 * overlayManager.toggle();
 *
 * // Execute JavaScript in overlay
 * overlayManager.eval('console.log("Hello from overlay")');
 */

// Dependencies - these are expected to be available globally in the main process
// var { WebContentsView } = require('electron')
// var windows = require('./windows.js')
// var { getDefaultViewWebPreferences } = require('./viewManager.js')
// var { getWindowWebContents } = require('./main.js')

var overlayManager = {
  /** @type {Object|null} Current overlay instance (only one allowed) */
  currentOverlay: null,

  /**
   * Initialize a new overlay (destroys any existing overlay)
   * @param {Object} options - Overlay configuration options
   * @param {Object} options.size - Size of the overlay {width: number, height: number}
   * @param {Object|string} options.position - Position of the overlay {x: number, y: number} or 'center'
   * @param {string} options.html - HTML content for the overlay (user provided) or file path
   * @param {Object} options.webPreferences - Custom web preferences (optional)
   */
  init: function (options) {
    // Destroy any existing overlay first
    this.destroy()

    const defaultSize = { width: 400, height: 400 }
    const size = options.size || defaultSize

    const defaultPosition = 'center'
    const position = options.position || defaultPosition

    // Get default web preferences from the global function
    const defaultWebPreferences = {
      ...(typeof getDefaultViewWebPreferences === 'function' ? getDefaultViewWebPreferences() : {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        javascript: true,
        focusable: false
      }),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      javascript: true,
      focusable: false,
      // Additional settings to ensure overlay doesn't interfere with keyboard events
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false
    }
    const webPreferences = options.webPreferences || defaultWebPreferences

    // Create the overlay object
    const overlay = {
      size: size,
      position: position,
      html: options.html || '<div>Empty Overlay</div>',
      webPreferences: webPreferences,
      view: null,
      visible: false,
      window: null
    }

    // Create the WebContentsView
    overlay.view = new WebContentsView({ webPreferences: webPreferences })

    // Load the HTML content - check if it's a file path or inline HTML
    if (overlay.html.startsWith('file://') || overlay.html.startsWith('http')) {
      // Load from file path or URL
      overlay.view.webContents.loadURL(overlay.html)
    } else {
      // Load inline HTML content
      const htmlContent = this.createHTMLContent(overlay)
      overlay.view.webContents.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(htmlContent))
    }

    // Ensure the overlay doesn't interfere with keyboard events
    overlay.view.webContents.setIgnoreMenuShortcuts(true)

    // Store the overlay as current
    this.currentOverlay = overlay

    // Add to viewMap for compatibility (use a fixed ID since only one overlay exists)
    const overlayId = 'overlay-current'
    if (typeof viewMap !== 'undefined') {
      viewMap[overlayId] = overlay.view
    }
    if (typeof viewStateMap !== 'undefined') {
      viewStateMap[overlayId] = {
        loadedInitialURL: true,
        hasJS: true
      }
    }
  },

  /**
   * Create HTML content with user-provided HTML
   * @param {Object} overlay - Overlay object
   * @returns {string} HTML content
   */
  createHTMLContent: function (overlay) {
    // Use user-provided HTML as-is
    return overlay.html
  },

  /**
   * Toggle overlay visibility
   * @param {Object} win - Window object (optional, uses current window if not provided)
   * @returns {boolean} - True if overlay is now visible, false if hidden
   */
  toggle: function (win) {
    const overlay = this.currentOverlay
    if (!overlay) {
      console.warn('No overlay to toggle')
      return false
    }

    if (!win) {
      win = typeof windows !== 'undefined' ? windows.getCurrent() : null
    }

    if (!win) {
      console.warn('No window available to toggle overlay')
      return false
    }

    if (overlay.visible) {
      this.hide(win)
      return false
    } else {
      this.show(win)
      return true
    }
  },

  /**
   * Show overlay
   * @param {Object} win - Window object (optional, uses current window if not provided)
   */
  show: function (win) {
    const overlay = this.currentOverlay
    if (!overlay) {
      console.warn('No overlay to show')
      return
    }

    if (!win) {
      win = typeof windows !== 'undefined' ? windows.getCurrent() : null
    }

    if (!win) {
      console.warn('No window available to show overlay')
      return
    }

    if (overlay.visible) {
      return // Already visible
    }

    // Calculate position
    const winBounds = win.getContentBounds()
    let overlayX, overlayY

    if (overlay.position === 'center') {
      overlayX = Math.max(0, (winBounds.width - overlay.size.width) / 2)
      overlayY = Math.max(0, (winBounds.height - overlay.size.height) / 2)
    } else {
      overlayX = overlay.position.x || 0
      overlayY = overlay.position.y || 0
    }

    // Set the bounds for the overlay
    overlay.view.setBounds({
      x: overlayX,
      y: overlayY,
      width: overlay.size.width,
      height: overlay.size.height
    })

    // Add the overlay to the window
    win.getContentView().addChildView(overlay.view)
    overlay.visible = true
    overlay.window = win

    // Ensure the main window maintains focus so keyboard shortcuts continue to work
    // This is crucial for the overlay to not interfere with keyboard events
    setTimeout(() => {
      if (win && !win.isDestroyed() && typeof getWindowWebContents === 'function') {
        // Force focus back to the main window
        getWindowWebContents(win).focus()
        // Also ensure the window itself is focused
        if (win.isVisible() && !win.isDestroyed()) {
          win.focus()
        }
      }
    }, 150)
  },

  /**
   * Hide overlay
   * @param {Object} win - Window object (optional, uses current window if not provided)
   */
  hide: function (win) {
    const overlay = this.currentOverlay
    if (!overlay) {
      console.warn('No overlay to hide')
      return
    }

    if (!win) {
      win = overlay.window || (typeof windows !== 'undefined' ? windows.getCurrent() : null)
    }

    if (!win || !overlay.visible) {
      return
    }

    // Remove the overlay from the window
    win.getContentView().removeChildView(overlay.view)
    overlay.visible = false
    overlay.window = null

    // Focus back to the main window
    if (win.isFocused() && typeof getWindowWebContents === 'function') {
      getWindowWebContents(win).focus()
    }
  },

  /**
   * Execute JavaScript in the overlay
   * @param {string} code - JavaScript code to execute
   * @returns {Promise} - Promise that resolves with the result
   */
  eval: function (code) {
    const overlay = this.currentOverlay
    if (!overlay) {
      return Promise.reject(new Error('No overlay to evaluate'))
    }

    if (!overlay.view || !overlay.view.webContents) {
      return Promise.reject(new Error('Overlay view not available'))
    }

    return overlay.view.webContents.executeJavaScript(code)
  },

  /**
   * Destroy overlay
   */
  destroy: function () {
    const overlay = this.currentOverlay
    if (!overlay) {
      return
    }

    // Hide the overlay first
    if (overlay.visible) {
      this.hide(overlay.window)
    }

    // Remove from all windows
    if (typeof windows !== 'undefined' && typeof windows.getAll === 'function') {
      windows.getAll().forEach(function (window) {
        try {
          window.getContentView().removeChildView(overlay.view)
        } catch (e) {
          // View might not be attached to this window
        }
      })
    }

    // Destroy the web contents
    if (overlay.view && overlay.view.webContents) {
      overlay.view.webContents.destroy()
    }

    // Clean up references
    this.currentOverlay = null
    if (typeof viewMap !== 'undefined') {
      delete viewMap['overlay-current']
    }
    if (typeof viewStateMap !== 'undefined') {
      delete viewStateMap['overlay-current']
    }
  },

  /**
   * Check if there is a current overlay
   * @returns {boolean} - True if there is a current overlay
   */
  hasCurrent: function () {
    return this.currentOverlay !== null
  },

  /**
   * Check if overlay is visible
   * @returns {boolean} - True if overlay is visible
   */
  isVisible: function () {
    const overlay = this.currentOverlay
    return overlay ? overlay.visible : false
  },

  /**
   * Recenter overlay in the current window using current size
   */
  recenter: function (win) {
    const overlay = this.currentOverlay
    if (!overlay || !overlay.view) return
    if (!win) {
      win = typeof windows !== 'undefined' ? windows.getCurrent() : null
    }
    if (!win) return

    const winBounds = win.getContentBounds()

    // Dynamically increase overlay height when there is screen space
    try {
      const minHeight = Math.max(overlay.size.height || 450, 450)
      const targetHeight = Math.floor(winBounds.height * 0.8) // up to 80% of window height
      const maxAllowed = Math.max(0, winBounds.height - 40) // keep 20px margin top/bottom
      const newHeight = Math.min(Math.max(minHeight, targetHeight), maxAllowed)
      overlay.size.height = newHeight
    } catch (e) {}

    let overlayX, overlayY
    if (overlay.position === 'center') {
      overlayX = Math.max(0, Math.floor((winBounds.width - overlay.size.width) / 2))
      overlayY = Math.max(0, Math.floor((winBounds.height - overlay.size.height) / 2))
    } else {
      overlayX = overlay.position.x || 0
      overlayY = overlay.position.y || 0
    }
    try {
      overlay.view.setBounds({
        x: overlayX,
        y: overlayY,
        width: overlay.size.width,
        height: overlay.size.height
      })
    } catch (e) {}
  }
}

// Make overlayManager available globally for other modules in the concatenated build
global.overlayManager = overlayManager
