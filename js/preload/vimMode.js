/* Vim Mode - Vimium-like functionality for Min browser */

// Vim mode configuration
const VIM_CONFIG = {
  alphabet: 'abcdefghijklmnopqrstuvwxyz'.split(''),
  keyTimeout: 1000,
  scrollAmount: 60,
  quickScrollAmount: 400,
  hintStyle: `
    position: absolute;
    padding: 1px 3px 0px 3px;
    background: linear-gradient(to bottom, #FFF785 0%,#FFC542 100%);
    color: black;
    z-index: 9999;
    font-family: Helvetica, Arial, sans-serif;
    font-weight: bold;
    font-size: 12px;
    border: solid 1px #C38A22;
    border-radius: 3px;
    box-shadow: 0px 3px 7px 0px rgba(0, 0, 0, 0.3);
    pointer-events: none;
  `
}

// State variables
let command = ''
let isLinkKeyMode = false
let linkAction = null
let typedText = ''
let currentLinkItems = []
let blockKeybindings = null

// Initialize Vim mode
function initVimMode() {
  // Create hidden input for blocking keybindings
  blockKeybindings = document.createElement('input')
  blockKeybindings.style = 'position: fixed; top: 0; left: -9999px;'
  document.body.appendChild(blockKeybindings)

  // Set up event listeners
  setupEventListeners()
}

// Set up all event listeners
function setupEventListeners() {
  // Click handler to keep focus on blockKeybindings
  document.body.addEventListener('click', function () {
    if (isLinkKeyMode) {
      blockKeybindings.select()
    }
  })

  // Visibility change handler
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'hidden' && isLinkKeyMode) {
      blockKeybindings.select()
    } else if (document.visibilityState !== 'hidden' && !isLinkKeyMode) {
      blockKeybindings.blur()
    }
  }, false)

  // Keydown handler (capture phase so we can suppress site handlers)
  document.addEventListener('keydown', function (e) {
    // --- Scroll keys (j k d u) ---
    if ((e.key === 'j' || e.key === 'k' || e.key === 'd' || e.key === 'u') &&
        !isLinkKeyMode && !isCurrentlyInInput()) {
      // stop event so site scripts don't receive it
      e.preventDefault();
      e.stopPropagation();

      if (e.key === 'j') {
        window.scrollBy(0, VIM_CONFIG.scrollAmount)
      } else if (e.key === 'k') {
        window.scrollBy(0, -VIM_CONFIG.scrollAmount)
      } else if (e.key === 'd') {
        window.scrollBy(0, VIM_CONFIG.quickScrollAmount)
      } else if (e.key === 'u') {
        window.scrollBy(0, -VIM_CONFIG.quickScrollAmount)
      }
    }
    // Prevent site shortcuts for vim command letters and Ctrl+C
    if (!isLinkKeyMode && !isCurrentlyInInput()) {
      const keyLower = e.key.toLowerCase()
      if (VIM_CONFIG.alphabet.includes(keyLower) || e.key === 'F' || (e.ctrlKey && e.key === 'c')) {
        e.preventDefault()
        e.stopImmediatePropagation()
      }
    }
  }, true) // capture phase

  // Keyup handler for commands (capture phase as well)
  document.addEventListener('keyup', function (e) {
    handleKeyup(e)
  }, true)
}

  // Handle keyup events for Vim commands
  function handleKeyup(e) {
    if (e.ctrlKey && e.key === 'c') {
      e.preventDefault();
      e.stopPropagation();
      if (isLinkKeyMode) {
        hideLinkKeys()
        blockKeybindings.blur()
      } else {
        // Exit to normal mode - blur any focused element
        exitToNormalMode()
      }
    } else if (!isCurrentlyInInput() && !isLinkKeyMode &&
               (VIM_CONFIG.alphabet.includes(e.key) || e.key === 'F') &&
               !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    e.stopPropagation();
    
    command += e.key
    var match = true
    
    switch (command) {
      case 'f':
        showLinkKeys()
        blockKeybindings.select()
        linkAction = 'open'
        break
      case 'F':
        showLinkKeys()
        blockKeybindings.select()
        linkAction = 'openInNewTab'
        break
      case 'c':
        showLinkKeys()
        blockKeybindings.select()
        linkAction = 'copyToClipboard'
        break
      case 'yy':
        copyUrlToClipboard()
        break
      case 'gg':
        window.scrollTo(0, 0)
        break
      case 'G':
        window.scrollTo(0, document.body.scrollHeight)
        break
      default:
        match = false
        break
    }
    
    if (!match && command.length === 1) {
      setTimeout(function () {
        command = ''
      }, VIM_CONFIG.keyTimeout)
    } else if (match) {
      command = ''
    }
  } else if (isLinkKeyMode && VIM_CONFIG.alphabet.includes(e.key)) {
    onTextTyped(e.key)
  }
}

// Create link hint element
function createLinkItem(link, rect, key) {
  var item = document.createElement('span')
  item.setAttribute('style', VIM_CONFIG.hintStyle)
  item.textContent = key
  item.style.top = (window.scrollY + rect.top) + 'px'
  item.style.left = (window.scrollX + rect.left) + 'px'
  return item
}

// Check if element is visible in viewport
function isVisible(rect) {
  return (
    rect.top > 0 &&
    rect.top < window.innerHeight &&
    rect.left > 0 &&
    rect.left < window.innerWidth
  )
}

// Get next key combination for hints
function getNextKeyCombination(index) {
  let halfIndex = Math.floor(VIM_CONFIG.alphabet.length / 2)
  if (index < halfIndex) {
    return VIM_CONFIG.alphabet[index]
  } else {
    index -= halfIndex
    var firstIndex = Math.floor(index / VIM_CONFIG.alphabet.length) + halfIndex
    var secondIndex = index % VIM_CONFIG.alphabet.length
    return VIM_CONFIG.alphabet[firstIndex] + VIM_CONFIG.alphabet[secondIndex]
  }
}

// Show link hints
function showLinkKeys() {
  isLinkKeyMode = true
  typedText = ''

  var links = []
  var linkRects = []

  // Find all clickable elements
  var elements = document.querySelectorAll('a, button, input, textarea, select')
  for (var i = 0; i < elements.length; i++) {
    var link = elements[i]
    var rect = link.getBoundingClientRect()
    if (isVisible(rect)) {
      links.push(link)
      linkRects.push(rect)
    }
  }

  links.forEach(function (link, i) {
    var key = getNextKeyCombination(currentLinkItems.length)
    var item = createLinkItem(link, linkRects[i], key)
    currentLinkItems.push({
      link: link,
      element: item,
      key: key
    })
    document.body.appendChild(item)
  })
}

// Hide link hints
function hideLinkKeys() {
  isLinkKeyMode = false
  for (var i = 0; i < currentLinkItems.length; i++) {
    if (currentLinkItems[i].element.parentNode) {
      currentLinkItems[i].element.parentNode.removeChild(currentLinkItems[i].element)
    }
  }
  currentLinkItems = []
}

// Handle typed text for link hints
function onTextTyped(key) {
  typedText += key

  var viableElementRemaining = false
  currentLinkItems.forEach(function (link) {
    if (link.key === typedText) {
      viableElementRemaining = true
      if (link.link.tagName === 'A') {
        if (linkAction === "copyToClipboard") {
          copyToClipboard(link.link.href)
        } else if (linkAction === "openInNewTab") {
          window.open(link.link.href)
        } else {
          window.open(link.link.href, '_top')
        }
      } else if (link.link.tagName === 'BUTTON') {
        link.link.click()
      } else if (isFocusable(link.link)) {
        link.link.focus()
        if (['checkbox', 'radio'].indexOf((link.link.getAttribute('type') || '').toLowerCase()) >= 0) {
          link.link.click()
          document.activeElement.blur()
        } else if (link.link.tagName === 'SELECT') {
          link.link.click()
        }
      }
      hideLinkKeys()
    } else if (!link.key.startsWith(typedText)) {
      link.element.hidden = true
    } else {
      viableElementRemaining = true
    }
  })

  if (!viableElementRemaining) {
    hideLinkKeys()
    blockKeybindings.blur()
  }
}

// Utility functions
function isCurrentlyInInput() {
  return document.activeElement.tagName === 'INPUT' || 
         document.activeElement.tagName === 'TEXTAREA' || 
         document.activeElement.isContentEditable
}

function isFocusable(element) {
  return ['INPUT', 'TEXTAREA', 'SELECT'].indexOf(element.tagName) >= 0 || 
         element.isContentEditable
}

function copyToClipboard(text) {
  var dummy = document.createElement('input')
  document.body.appendChild(dummy)
  dummy.value = text
  dummy.select()
  document.execCommand('copy')
  document.body.removeChild(dummy)
}

function copyUrlToClipboard() {
  copyToClipboard(window.location.href)
}

// Exit to normal mode - blur any focused element
function exitToNormalMode() {
  // Blur any currently focused element
  if (document.activeElement && document.activeElement !== document.body) {
    document.activeElement.blur()
  }
  
  // Focus the body to ensure we're in normal mode
  document.body.focus()
  
  // Clear any ongoing commands
  command = ''
  typedText = ''
  
  // Ensure link key mode is off
  if (isLinkKeyMode) {
    hideLinkKeys()
  }
}

// Initialize Vim mode when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initVimMode)
} else {
  initVimMode()
} 