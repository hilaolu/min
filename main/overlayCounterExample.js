/**
 * Overlay Counter Example
 * 
 * This module demonstrates how to use the overlay manager to create a counter overlay
 * that can be toggled with Ctrl+Y. It includes RPC functionality to increment the
 * counter from the main thread when the overlay is shown.
 * 
 * Features:
 * - Beautiful gradient UI with modern design
 * - Counter with increment/decrement/reset functionality
 * - RPC integration for main thread communication
 * - Visual feedback for RPC operations
 * - Automatic counter increment on overlay show
 */

// Use the global overlayManager that's available in the concatenated build
var counterOverlayManager = global.overlayManager || null

/**
 * Initialize the counter overlay example
 */
function initCounterOverlay() {
  if (!counterOverlayManager) {
    console.warn('Overlay manager not available')
    return
  }

  // Create the counter overlay HTML
  const counterHTML = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body {
          margin: 0;
          padding: 20px;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          color: white;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          height: 100vh;
          box-sizing: border-box;
        }
        
        .counter-container {
          text-align: center;
          background: rgba(255, 255, 255, 0.1);
          padding: 30px;
          border-radius: 15px;
          backdrop-filter: blur(10px);
          box-shadow: 0 8px 32px rgba(0, 0, 0, 0.1);
          border: 1px solid rgba(255, 255, 255, 0.2);
        }
        
        h1 {
          margin: 0 0 20px 0;
          font-size: 24px;
          font-weight: 300;
        }
        
        .counter-display {
          font-size: 48px;
          font-weight: bold;
          margin: 20px 0;
          text-shadow: 2px 2px 4px rgba(0, 0, 0, 0.3);
        }
        
        .button-group {
          display: flex;
          gap: 10px;
          margin-top: 20px;
        }
        
        button {
          background: rgba(255, 255, 255, 0.2);
          border: 1px solid rgba(255, 255, 255, 0.3);
          color: white;
          padding: 10px 20px;
          border-radius: 8px;
          cursor: pointer;
          font-size: 14px;
          transition: all 0.3s ease;
          backdrop-filter: blur(5px);
        }
        
        button:hover {
          background: rgba(255, 255, 255, 0.3);
          transform: translateY(-2px);
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
        }
        
        button:active {
          transform: translateY(0);
        }
        
        .instructions {
          margin-top: 20px;
          font-size: 12px;
          opacity: 0.8;
          text-align: center;
        }
        
        .rpc-notification {
          position: fixed;
          top: 20px;
          right: 20px;
          background: rgba(76, 175, 80, 0.9);
          color: white;
          padding: 10px 15px;
          border-radius: 8px;
          font-size: 12px;
          opacity: 0;
          transform: translateX(100%);
          transition: all 0.3s ease;
          backdrop-filter: blur(5px);
          z-index: 1000;
        }
        
        .rpc-notification.show {
          opacity: 1;
          transform: translateX(0);
        }
      </style>
    </head>
    <body>
      <div class="counter-container">
        <h1>Counter Overlay</h1>
        <div class="counter-display">
          <span id="counter">0</span>
        </div>
        <div class="button-group">
          <button onclick="decrementCounter()">-</button>
          <button onclick="resetCounter()">Reset</button>
          <button onclick="incrementCounter()">+</button>
        </div>
        <div class="instructions">
          Press Ctrl+Y to toggle this overlay<br>
          Counter auto-increments when shown
        </div>
      </div>
      
      <div class="rpc-notification" id="rpc-notification">
        RPC: Counter incremented! 🎉
      </div>
      
      <script>
        let counter = 0;
        
        function updateDisplay() {
          document.getElementById('counter').textContent = counter;
        }
        
        function showRPCNotification() {
          const notification = document.getElementById('rpc-notification');
          notification.classList.add('show');
          setTimeout(() => {
            notification.classList.remove('show');
          }, 2000);
        }
        
        function incrementCounter() {
          counter++;
          updateDisplay();
          showRPCNotification();
        }
        
        function decrementCounter() {
          counter--;
          updateDisplay();
        }
        
        function resetCounter() {
          counter = 0;
          updateDisplay();
        }
        
        // Initialize display
        updateDisplay();
      </script>
    </body>
    </html>
  `

  // Initialize the overlay with the counter HTML
  counterOverlayManager.init({
    size: { width: 400, height: 400 },
    position: 'center',
    html: counterHTML
  })
}

/**
 * Toggle the counter overlay
 */
function toggleCounterOverlay() {
  if (!counterOverlayManager) {
    console.warn('Overlay manager not available')
    return
  }

  if (!counterOverlayManager.hasCurrent()) {
    // If no overlay exists, initialize it
    initCounterOverlay()
  }
  
  // Get the current visibility state before toggling
  const wasVisible = counterOverlayManager.isVisible()
  
  // Toggle the overlay
  counterOverlayManager.toggle()
  
  // If the overlay was just shown (was hidden before), increment the counter via RPC
  if (!wasVisible && counterOverlayManager.isVisible()) {
    // Use RPC to call the increment function in the overlay
    counterOverlayManager.eval(`
      incrementCounter();
    `)
  }
}

/**
 * Show the counter overlay
 */
function showCounterOverlay() {
  if (!counterOverlayManager) {
    console.warn('Overlay manager not available')
    return
  }

  if (!counterOverlayManager.hasCurrent()) {
    initCounterOverlay()
  }
  
  // Get the current visibility state before showing
  const wasVisible = counterOverlayManager.isVisible()
  
  // Show the overlay
  counterOverlayManager.show()
  
  // If the overlay was just shown (was hidden before), increment the counter via RPC
  if (!wasVisible && counterOverlayManager.isVisible()) {
    // Use RPC to call the increment function in the overlay
    counterOverlayManager.eval(`
      incrementCounter();
    `)
  }
}

/**
 * Hide the counter overlay
 */
function hideCounterOverlay() {
  if (!counterOverlayManager) {
    console.warn('Overlay manager not available')
    return
  }

  if (counterOverlayManager.hasCurrent()) {
    counterOverlayManager.hide()
  }
}

/**
 * Destroy the counter overlay
 */
function destroyCounterOverlay() {
  if (!counterOverlayManager) {
    console.warn('Overlay manager not available')
    return
  }

  counterOverlayManager.destroy()
}

// Export functions for use in other modules
module.exports = {
  initCounterOverlay,
  toggleCounterOverlay,
  showCounterOverlay,
  hideCounterOverlay,
  destroyCounterOverlay
}

// Make functions available globally for other modules in the concatenated build
global.initCounterOverlay = initCounterOverlay
global.toggleCounterOverlay = toggleCounterOverlay
global.showCounterOverlay = showCounterOverlay
global.hideCounterOverlay = hideCounterOverlay
global.destroyCounterOverlay = destroyCounterOverlay 