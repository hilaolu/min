/* Vim Mode - Vimium-like functionality for Min browser */

// Vim mode configuration
const VIM_CONFIG = {
  alphabet: 'abdefghijklmnopqrstuvwxyz'.split(''),
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
  `,
  hudStyle: `
    position: fixed;
    left: 50%;
    bottom: 18px;
    transform: translateX(-50%);
    background: rgba(20, 20, 20, 0.95);
    color: #fff;
    font-family: Helvetica, Arial, sans-serif;
    font-size: 16px;
    font-weight: 600;
    line-height: 1.7;
    padding: 6px 12px;
    border-radius: 6px;
    border: 1px solid rgba(255,255,255,0.35);
    z-index: 9999;
    pointer-events: none;
    text-shadow: 0 1px 1px rgba(0,0,0,0.5);
    box-shadow: 0 6px 18px rgba(0,0,0,0.4);
  `
}

// State variables
let command = ''
let isLinkKeyMode = false
let linkAction = null
let typedText = ''
let currentLinkItems = []
let blockKeybindings = null

// Search state
let isSearchMode = false
let searchBuffer = ''
let lastSearchQuery = ''
let searchIndicator = null
let lastSearchMatches = []
let lastSearchIndex = -1
let lastMatchesForQuery = ''
let computeMatchesTimeout = null

// Visual mode state
let isVisualMode = false

// Reusable HUD indicator utility
const HUD = (function () {
  let hudEl = null
  let hideTimeout = null
  function ensure() {
    if (!hudEl) {
      hudEl = document.createElement('div')
      hudEl.setAttribute('style', VIM_CONFIG.hudStyle)
      hudEl.style.display = 'none'
      document.body.appendChild(hudEl)
    }
    return hudEl
  }
  function show(text, persistMs = 1200) {
    const el = ensure()
    el.textContent = text
    el.style.display = 'block'
    if (hideTimeout) clearTimeout(hideTimeout)
    if (persistMs > 0) {
      hideTimeout = setTimeout(() => { el.style.display = 'none' }, persistMs)
    }
  }
  function hide() {
    if (!hudEl) return
    hudEl.style.display = 'none'
    if (hideTimeout) clearTimeout(hideTimeout)
  }
  function set(text) {
    const el = ensure()
    el.textContent = text
    el.style.display = 'block'
    if (hideTimeout) clearTimeout(hideTimeout)
  }
  return { show, hide, set }
})()

// Expose for reuse by other features running in the page context
try { if (!window.__minHUD) window.__minHUD = HUD } catch (e) {}

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
    // Global emergency exit to NORMAL mode
    if (e.ctrlKey && e.key === 'c') {
      e.preventDefault();
      e.stopPropagation();
      if (isSearchMode) exitSearchMode(true)
      if (isVisualMode) exitVisualMode()
      if (isLinkKeyMode) { hideLinkKeys(); blockKeybindings.blur() }
      exitToNormalMode()
      // Explicit NORMAL indicator on exit
      HUD.show('NORMAL', 1200)
      return
    }
    // Visual mode handling
    if (isVisualMode) {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') { exitVisualMode(); return }
      if (e.key === 'y' && !e.ctrlKey && !e.metaKey && !e.altKey) { copyCurrentSelection(); return }
      if (e.key === 'w' && !e.ctrlKey && !e.metaKey && !e.altKey) { extendSelectionByWord(true); return }
      if (e.key === 'b' && !e.ctrlKey && !e.metaKey && !e.altKey) { extendSelectionByWord(false); return }
      return
    }

    // Search mode has priority
    if (isSearchMode) {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'v' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        // Enter visual mode from search mode
        lastSearchQuery = searchBuffer
        ensureMatchesForQuery(lastSearchQuery)
        if (lastSearchMatches.length > 0) {
          if (lastSearchIndex < 0) lastSearchIndex = 0
          selectMatchAt(lastSearchIndex)
        }
        exitSearchMode()
        enterVisualMode()
        return
      }
      if (e.key === 'Escape') {
        exitSearchMode(true)
        return
      }
      if (e.key === 'Enter') {
        lastSearchQuery = searchBuffer
        ensureMatchesForQuery(lastSearchQuery)
        if (lastSearchMatches.length > 0) {
          lastSearchIndex = 0
          selectMatchAt(lastSearchIndex)
        } else {
          lastSearchIndex = -1
        }
        exitSearchMode()
        return
      }
      if (e.key === 'Backspace') {
        searchBuffer = searchBuffer.slice(0, -1)
        updateSearchIndicator()
        scheduleComputeMatches()
        return
      }
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        searchBuffer += e.key
        updateSearchIndicator()
        scheduleComputeMatches()
      }
      return
    }

    // --- Scroll keys (k l) and navigation keys (Ctrl+j Ctrl+;) ---
    if (!isLinkKeyMode && !isCurrentlyInInput()) {
      // stop event so site scripts don't receive it
      e.preventDefault();
      e.stopPropagation();

      // Enter Visual mode from NORMAL if a search was committed
      if (e.key === 'v' && !e.ctrlKey && !e.metaKey && !e.altKey && lastSearchQuery) {
        ensureMatchesForQuery(lastSearchQuery)
        if (lastSearchMatches.length > 0) {
          if (lastSearchIndex < 0) lastSearchIndex = 0
          selectMatchAt(lastSearchIndex)
        }
        enterVisualMode()
        return
      }

      if (e.key === 'k' && !e.ctrlKey) {
        // k for up
        window.scrollBy(0, -VIM_CONFIG.scrollAmount)
      } else if (e.key === 'l' && !e.ctrlKey) {
        // l for down
        window.scrollBy(0, VIM_CONFIG.scrollAmount)
      } else if (e.ctrlKey && e.key === 'k') {
        // Ctrl+k for up faster
        window.scrollBy(0, -VIM_CONFIG.quickScrollAmount)
      } else if (e.ctrlKey && e.key === 'l') {
        // Ctrl+l for down faster
        window.scrollBy(0, VIM_CONFIG.quickScrollAmount)
      } else if (e.ctrlKey && e.key === 'j') {
        // Ctrl+j for back
        window.history.back()
      } else if (e.ctrlKey && e.key === ';') {
        // Ctrl+; for forward
        window.history.forward()
      } else {
        // Don't prevent default for other keys
        e.stopPropagation = function() {} // Restore original behavior
        return
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
    // Also allow entering visual mode on keyup while in search mode
    if (isSearchMode && e.key === 'v' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      lastSearchQuery = searchBuffer
      ensureMatchesForQuery(lastSearchQuery)
      if (lastSearchMatches.length > 0) {
        if (lastSearchIndex < 0) lastSearchIndex = 0
        selectMatchAt(lastSearchIndex)
      }
      exitSearchMode()
      enterVisualMode()
      return
    }
    // Enter search mode on '/'
    if (!isSearchMode && !isLinkKeyMode && !isCurrentlyInInput() && e.key === '/') {
      e.preventDefault();
      e.stopPropagation();
      enterSearchMode()
      return
    }
    // Navigate search results with n / Shift+N
    if (!isSearchMode && !isLinkKeyMode && !isCurrentlyInInput() && lastSearchQuery) {
      if (e.key === 'n' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        navigateMatch(false)
        return
      }
      if ((e.key === 'N' && e.shiftKey) || (e.key === 'n' && e.shiftKey)) {
        e.preventDefault();
        e.stopPropagation();
        navigateMatch(true)
        return
      }
    }
    handleKeyup(e)
  }, true)
}

  // Handle keyup events for Vim commands
  function handleKeyup(e) {
    if (e.ctrlKey && e.key === 'c') {
      e.preventDefault();
      e.stopPropagation();
      // Always leave visual/search modes
      if (isSearchMode) {
        exitSearchMode(true)
      }
      if (isVisualMode) {
        exitVisualMode()
      }
      if (isLinkKeyMode) {
        hideLinkKeys()
        blockKeybindings.blur()
      } else {
        // Exit to normal mode - blur any focused element
        exitToNormalMode()
      }
      // Show NORMAL briefly when returning to normal
      HUD.show('NORMAL', 1200)
      
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

// Search helpers
function enterSearchMode() {
  isSearchMode = true
  searchBuffer = ''
  try { document.body.focus() } catch (e) {}
  HUD.set(`/${searchBuffer}`)
  // Kick off initial match computation (will be 0/0)
  scheduleComputeMatches()
}

function exitSearchMode(cancelOnly = false) {
  isSearchMode = false
  if (cancelOnly) {
    searchBuffer = ''
  }
  updateSearchIndicator()
}

function updateSearchIndicator() {
  // Don't override visual HUD while in visual mode
  if (isVisualMode) return
  if (isSearchMode) {
    const total = (searchBuffer && lastMatchesForQuery === searchBuffer) ? lastSearchMatches.length : 0
    const current = (lastSearchQuery === searchBuffer && lastSearchIndex >= 0) ? (lastSearchIndex + 1) : 0
    HUD.set(`/${searchBuffer} ${current}/${total}`)
  } else if (lastSearchQuery) {
    const total = (lastMatchesForQuery === lastSearchQuery) ? lastSearchMatches.length : 0
    const current = (lastSearchIndex >= 0) ? (lastSearchIndex + 1) : 0
    HUD.show(`/${lastSearchQuery} ${current}/${total}`)
  } else {
    HUD.hide()
  }
}

// Collect matches for a query (debounced when typing)
function scheduleComputeMatches() {
  if (computeMatchesTimeout) clearTimeout(computeMatchesTimeout)
  computeMatchesTimeout = setTimeout(() => {
    const q = searchBuffer.trim()
    if (!q) {
      lastMatchesForQuery = ''
      lastSearchMatches = []
      lastSearchIndex = -1
      updateSearchIndicator()
      return
    }
    ensureMatchesForQuery(q)
    // While typing, show counts as 0/total
    updateSearchIndicator()
  }, 120)
}

function ensureMatchesForQuery(q) {
  if (lastMatchesForQuery === q) return
  lastMatchesForQuery = q
  lastSearchMatches = collectMatches(q)
  lastSearchIndex = -1
}

function collectMatches(q) {
  const matches = []
  const MAX_MATCHES = 1000
  const query = q.toLowerCase()
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode: function (node) {
      if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT
      const parent = node.parentElement
      if (!parent) return NodeFilter.FILTER_REJECT
      const tag = parent.tagName
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return NodeFilter.FILTER_REJECT
      if (getComputedStyle(parent).visibility === 'hidden' || getComputedStyle(parent).display === 'none') return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_ACCEPT
    }
  })
  let node
  while ((node = walker.nextNode())) {
    const text = node.nodeValue
    const lower = text.toLowerCase()
    let start = 0
    while (true) {
      const idx = lower.indexOf(query, start)
      if (idx === -1) break
      const range = document.createRange()
      try {
        range.setStart(node, idx)
        range.setEnd(node, idx + query.length)
        const rects = range.getClientRects()
        if (rects && rects.length > 0) {
          matches.push(range)
        }
      } catch (e) {}
      if (matches.length >= MAX_MATCHES) return matches
      start = idx + query.length
    }
  }
  return matches
}

function selectMatchAt(index) {
  if (index < 0 || index >= lastSearchMatches.length) return
  const range = lastSearchMatches[index]
  const sel = window.getSelection()
  try {
    sel.removeAllRanges()
    sel.addRange(range.cloneRange())
  } catch (e) {}
  const el = range.startContainer.parentElement || document.body
  if (el && el.scrollIntoView) {
    try { el.scrollIntoView({ behavior: 'smooth', block: 'center' }) } catch (e) { el.scrollIntoView() }
  }
  HUD.show(`/${lastSearchQuery} ${index + 1}/${lastSearchMatches.length}`)
}

function navigateMatch(backwards = false) {
  if (!lastSearchQuery) return
  ensureMatchesForQuery(lastSearchQuery)
  const total = lastSearchMatches.length
  if (total === 0) { HUD.show(`/${lastSearchQuery} 0/0`); return }
  if (lastSearchIndex === -1) {
    lastSearchIndex = backwards ? total - 1 : 0
  } else {
    lastSearchIndex = (lastSearchIndex + (backwards ? -1 : 1) + total) % total
  }
  selectMatchAt(lastSearchIndex)
}

// Visual mode helpers
function enterVisualMode() {
  isVisualMode = true
  try { document.body.focus() } catch (e) {}
  // Ensure there is a selection; if none, try to select current match or start of body
  const sel = window.getSelection()
  if (!sel.rangeCount) {
    if (lastSearchMatches.length > 0 && lastSearchIndex >= 0) {
      selectMatchAt(lastSearchIndex)
    } else {
      const range = document.createRange()
      const root = document.body.firstChild
      if (root) {
        try { range.setStart(root, 0); range.setEnd(root, 0); sel.removeAllRanges(); sel.addRange(range) } catch (e) {}
      }
    }
  }
  updateVisualIndicator()
}

function exitVisualMode() {
  isVisualMode = false
  // After leaving visual, show last search briefly if available
  updateSearchIndicator()
}

function updateVisualIndicator() {
  const sel = window.getSelection()
  let len = 0
  try { len = (sel && sel.toString()) ? sel.toString().length : 0 } catch (e) { len = 0 }
  // Visual mode HUD without current/total (optional char count)
  HUD.set(len > 0 ? `VISUAL (${len} chars)` : 'VISUAL') 
}

function extendSelectionByWord(forward = true) {
  const sel = window.getSelection()
  if (!sel) return
  try {
    // If collapsed, start extending from current caret
    sel.modify('extend', forward ? 'forward' : 'backward', 'word')
  } catch (e) {
    // Fallback: move by character
    try { sel.modify('extend', forward ? 'forward' : 'backward', 'character') } catch (e2) {}
  }
  // Manual word-boundary fallback if still collapsed
  try {
    if (sel.isCollapsed && sel.focusNode && typeof sel.focusOffset === 'number') {
      const node = sel.focusNode
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.nodeValue || ''
        let start = sel.anchorOffset
        let end = sel.focusOffset
        if (forward) {
          // Move end to next word boundary
          const rest = text.slice(end)
          const m = rest.match(/\w+\b/)
          if (m) end += m.index + m[0].length
          else end = text.length
        } else {
          // Move start to previous word boundary
          const left = text.slice(0, start)
          const m = left.match(/\b\w+$/)
          if (m) start = left.lastIndexOf(m[0])
          else start = 0
        }
        const r = document.createRange()
        r.setStart(node, Math.max(0, Math.min(start, text.length)))
        r.setEnd(node, Math.max(0, Math.min(end, text.length)))
        sel.removeAllRanges(); sel.addRange(r)
      }
    }
  } catch (e) {}
  updateVisualIndicator()
}

function copyCurrentSelection() {
  const sel = window.getSelection()
  const text = sel ? sel.toString() : ''
  if (text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).catch(() => copyToClipboard(text))
      } else {
        copyToClipboard(text)
      }
    } catch (e) { copyToClipboard(text) }
    HUD.show('Copied selection')
  } else {
    HUD.show('Nothing selected', 800)
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