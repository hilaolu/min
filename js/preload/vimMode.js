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

// State variables (managed by VimStateManager)
let command = ''
let linkAction = null
let currentLinkItems = []
let blockKeybindings = null

// Search state
let searchBuffer = ''
let lastSearchQuery = ''
let lastSearchMatches = []
let lastSearchIndex = -1
let lastMatchesForQuery = ''

// Generic command buffer (for multi-key commands & link hints)
let cmdBuffer = ''
let cmdBufferTimer = null
function clearCmdBuffer () {
  cmdBuffer = ''
  if (cmdBufferTimer) { clearTimeout(cmdBufferTimer); cmdBufferTimer = null }
}
function bufferAppend (ch) {
  cmdBuffer += ch
  if (cmdBufferTimer) clearTimeout(cmdBufferTimer)
  cmdBufferTimer = setTimeout(clearCmdBuffer, VIM_CONFIG.keyTimeout)
}
function bufferBackspace () {
  cmdBuffer = cmdBuffer.slice(0, -1)
  if (cmdBufferTimer) { clearTimeout(cmdBufferTimer); cmdBufferTimer = setTimeout(clearCmdBuffer, VIM_CONFIG.keyTimeout) }
}

// Reusable HUD indicator utility
const HUD = (function () {
  let hudEl = null
  let hideTimeout = null
  function ensure () {
    if (!hudEl) {
      hudEl = document.createElement('div')
      hudEl.setAttribute('style', VIM_CONFIG.hudStyle)
      hudEl.setAttribute('data-min-vim-hud', 'true')
      hudEl.style.display = 'none'
      document.body.appendChild(hudEl)
    }
    return hudEl
  }
  function show (text, persistMs = 1200) {
    const el = ensure()
    el.textContent = text
    el.style.display = 'block'
    if (hideTimeout) clearTimeout(hideTimeout)
    if (persistMs > 0) {
      hideTimeout = setTimeout(() => { el.style.display = 'none' }, persistMs)
    }
  }
  function hide () {
    if (!hudEl) return
    hudEl.style.display = 'none'
    if (hideTimeout) clearTimeout(hideTimeout)
  }
  function set (text) {
    const el = ensure()
    el.textContent = text
    el.style.display = 'block'
    if (hideTimeout) clearTimeout(hideTimeout)
    hideTimeout = setTimeout(() => { el.style.display = 'none' }, 3000)
  }
  return { show, hide, set }
})()

// Expose for reuse by other features running in the page context
try { if (!window.__minHUD) window.__minHUD = HUD } catch (e) {}

// ===============
// Strategy Pattern
// ===============
class VimStateStrategy {
  getName () { return 'BASE' }
  onEnter (ctx) {}
  onExit (ctx) {}
  handleKeydown (e, ctx) { return false }
  handleKeyup (e, ctx) { return false }
}

class NormalStrategy extends VimStateStrategy {
  getName () { return 'NORMAL' }
  handleKeydown (e, ctx) {
    // Emergency exit handled globally by manager
    if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      ctx.transition('SEARCH')
      return true
    }
    if (e.key === 'v' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const sel = window.getSelection()
      if (sel && !sel.isCollapsed) {
        // Existing selection, enter visual mode
        ctx.transition('VISUAL')
        return true
      }
    }
    if ((e.key === 'n' || e.key === 'N') && !e.ctrlKey && !e.metaKey && !e.altKey && ctx.lastSearchQuery) {
      navigateMatch(e.key === 'N')
      return true
    }
    // Link hints
    if ((e.key === 'f' || e.key === 'F' || e.key === 'c') && !e.ctrlKey && !e.metaKey && !e.altKey && !isCurrentlyInInput()) {
      // Set global action used by onTextTyped
      linkAction = (e.key === 'F') ? 'openInNewTab' : (e.key === 'c' ? 'copyToClipboard' : 'open')
      showLinkKeys()
      try { blockKeybindings.select() } catch (e) {}
      ctx.transition('LINK_HINT')
      return true
    }
    // Scrolling and nav
    if (!isCurrentlyInInput()) {
      if (e.key === 'k' && !e.ctrlKey) { window.scrollBy(0, -VIM_CONFIG.scrollAmount); return true }
      if (e.key === 'l' && !e.ctrlKey) { window.scrollBy(0, VIM_CONFIG.scrollAmount); return true }
      if (e.ctrlKey && e.key === 'k') { window.scrollBy(0, -VIM_CONFIG.quickScrollAmount); return true }
      if (e.ctrlKey && e.key === 'l') { window.scrollBy(0, VIM_CONFIG.quickScrollAmount); return true }
      if (e.ctrlKey && e.key === 'j') { window.history.back(); return true }
      if (e.ctrlKey && e.key === ';') { window.history.forward(); return true }
      if (e.key === 'G' && !e.ctrlKey) { window.scrollTo(0, document.body.scrollHeight); return true }
      // Buffered multi-key yy / gg handled in legacy handler below; keep fallback
    }
    return false
  }
}

class SearchStrategy extends VimStateStrategy {
  getName () { return 'SEARCH' }
  onEnter (ctx) {
    ctx.searchBuffer = ''
    try { document.body.focus() } catch (e) {}
    HUD.set(`/${ctx.searchBuffer}`)
  }

  onExit (ctx) {
    // Clean exit from search mode
  }

  handleKeydown (e, ctx) {
    // Esc no longer exits; use Ctrl+C globally
    if (e.key === 'Enter') {
      ctx.lastSearchQuery = ctx.searchBuffer
      ensureMatchesForQuery(ctx.lastSearchQuery)
      if (ctx.lastSearchMatches.length > 0) { ctx.lastSearchIndex = 0; selectMatchAt(ctx.lastSearchIndex) }
      ctx.transition('NORMAL')
      return true
    }
    if (e.key === 'Backspace') {
      ctx.searchBuffer = ctx.searchBuffer.slice(0, -1)
      updateSearchIndicator()
      return true
    }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      ctx.searchBuffer += e.key
      updateSearchIndicator()
      return true
    }
    return false
  }
}

class VisualStrategy extends VimStateStrategy {
  getName () { return 'VISUAL' }
  onEnter (ctx) { try { document.body.focus() } catch (e) {} updateVisualIndicator() }
  handleKeydown (e, ctx) {
    // Esc no longer exits; use Ctrl+C globally
    if (e.key === 'y' && !e.ctrlKey && !e.metaKey && !e.altKey) { copyCurrentSelection(); return true }
    if (e.key === 'w' && !e.ctrlKey && !e.metaKey && !e.altKey) { extendSelectionByWord(true); return true }
    if (e.key === 'b' && !e.ctrlKey && !e.metaKey && !e.altKey) { extendSelectionByWord(false); return true }
    return false
  }
}

class LinkHintStrategy extends VimStateStrategy {
  getName () { return 'LINK_HINT' }
  onEnter (ctx) {
    // Reset buffers for fresh hint session
    ctx.bufferClear()
    try { blockKeybindings.select() } catch (e) {}
    // Show initial count
    try { HUD.show(`HINTS: ${currentLinkItems.length}`, 800) } catch (e) {}
  }

  onExit (ctx) {
    hideLinkKeys()
    ctx.bufferClear()
    try { blockKeybindings.blur() } catch (e) {}
  }

  handleKeydown (e, ctx) {
    // Prevent page handlers and process immediately
    // Esc no longer exits; use Ctrl+C globally
    if (e.key === 'Backspace') { ctx.bufferBackspace(); processLinkHintBuffer(); return true }
    const keyLower = e.key.toLowerCase()
    if (VIM_CONFIG.alphabet.includes(keyLower)) { ctx.bufferAppend(keyLower); processLinkHintBuffer(); return true }
    return false
  }

  handleKeyup (e, ctx) {
    const keyLower = e.key.toLowerCase()
    // Esc no longer exits; use Ctrl+C globally
    if (VIM_CONFIG.alphabet.includes(keyLower)) { /* handled in keydown */ return true }
    return false
  }
}

class InputFocusStrategy extends VimStateStrategy {
  getName () { return 'INPUT_FOCUS' }
  onEnter (ctx) {
    // Focus on the input element if available, otherwise body
    try {
      if (document.activeElement && isCurrentlyInInput()) {
        // Already in an input, keep focus
      } else {
        document.body.focus()
      }
    } catch (e) {}
    HUD.set('INPUT FOCUS - Press Ctrl+C to exit')
  }

  onExit (ctx) {
    // Clear any input buffer state if needed
    ctx.bufferClear()
  }

  handleKeydown (e, ctx) {
    // Capture ALL input and prevent any state transitions
    // Only Ctrl+C (handled globally by VimStateManager) can exit this mode

    // Consume all keys to prevent normal page behavior
    // No state transitions allowed in this mode
    return true
  }

  handleKeyup (e, ctx) {
    // Consume all keyup events as well
    return true
  }
}

class VimStateManager {
  constructor () {
    this.ctx = {
      get searchBuffer () { return searchBuffer },
      set searchBuffer (v) { searchBuffer = v },
      get lastSearchQuery () { return lastSearchQuery },
      set lastSearchQuery (v) { lastSearchQuery = v },
      get lastSearchMatches () { return lastSearchMatches },
      set lastSearchMatches (v) { lastSearchMatches = v },
      get lastSearchIndex () { return lastSearchIndex },
      set lastSearchIndex (v) { lastSearchIndex = v },
      get buffer () { return cmdBuffer },
      set buffer (v) { cmdBuffer = v },
      bufferAppend: (ch) => bufferAppend(ch),
      bufferBackspace: () => bufferBackspace(),
      bufferClear: () => clearCmdBuffer(),
      linkAction: null,
      transition: (name) => this.transition(name),
      ensureMatchesForQuery: (q) => ensureMatchesForQuery(q)
    }
    this.strategies = {
      NORMAL: new NormalStrategy(),
      SEARCH: new SearchStrategy(),
      VISUAL: new VisualStrategy(),
      LINK_HINT: new LinkHintStrategy(),
      INPUT_FOCUS: new InputFocusStrategy()
    }
    this.current = this.strategies.NORMAL
  }

  transition (name) {
    if (this.current && this.current.onExit) this.current.onExit(this.ctx)
    this.current = this.strategies[name] || this.strategies.NORMAL
    // Clear command buffer on state change
    clearCmdBuffer()
    if (this.current && this.current.onEnter) this.current.onEnter(this.ctx)
  }

  processKeydown (e) {
    // Global Ctrl+C
    if (e.ctrlKey && e.key === 'c') {
      e.preventDefault(); e.stopPropagation()
      this.transition('NORMAL')
      exitToNormalMode()
      HUD.show('NORMAL', 1200)
      return true
    }
    return this.current.handleKeydown(e, this.ctx) === true
  }

  processKeyup (e) {
    // Allow LINK_HINT to consume keyup letters
    if (this.current.handleKeyup) return this.current.handleKeyup(e, this.ctx) === true
    return false
  }
}

let vimManager = null

// Initialize Vim mode
function initVimMode () {
  // Create hidden input for blocking keybindings
  blockKeybindings = document.createElement('input')
  blockKeybindings.style = 'position: fixed; top: 0; left: -9999px;'
  document.body.appendChild(blockKeybindings)

  // Create manager
  vimManager = new VimStateManager()

  // Set up event listeners
  setupEventListeners()
}

// Set up all event listeners
function setupEventListeners () {
  // Click handler to keep focus on blockKeybindings
  document.body.addEventListener('click', function () {
    if (vimManager && vimManager.current.getName() === 'LINK_HINT') {
      blockKeybindings.select()
    }
  })

  // Focus event handler - automatically switch to INPUT_FOCUS mode when input is focused
  document.addEventListener('focusin', function (e) {
    if (vimManager && isCurrentlyInInput() && vimManager.current.getName() !== 'INPUT_FOCUS') {
      vimManager.transition('INPUT_FOCUS')
    }
  }, true)

  // Blur event handler - check if we should stay in INPUT_FOCUS or return to NORMAL
  document.addEventListener('focusout', function (e) {
    if (vimManager && vimManager.current.getName() === 'INPUT_FOCUS') {
      // Small delay to check if focus moved to another input
      setTimeout(() => {
        if (!isCurrentlyInInput()) {
          vimManager.transition('NORMAL')
        }
      }, 0)
    }
  }, true)

  // Visibility change handler
  document.addEventListener('visibilitychange', function () {
    if (vimManager && document.visibilityState !== 'hidden' && vimManager.current.getName() === 'LINK_HINT') {
      blockKeybindings.select()
    } else if (vimManager && document.visibilityState !== 'hidden' && vimManager.current.getName() !== 'LINK_HINT') {
      blockKeybindings.blur()
    }
  }, false)

  // Keydown handler (capture phase)
  document.addEventListener('keydown', function (e) {
    if (vimManager && vimManager.processKeydown(e)) return
    // Legacy fallback (kept for non-critical behaviors); prevent site handlers for vim letters and Ctrl+C
    if (vimManager && vimManager.current.getName() !== 'LINK_HINT' && !isCurrentlyInInput()) {
      const keyLower = e.key.toLowerCase()
      if (VIM_CONFIG.alphabet.includes(keyLower) || e.key === 'F' || (e.ctrlKey && e.key === 'c')) {
        e.preventDefault(); e.stopImmediatePropagation()
      }
    }
  }, true)

  // Keyup handler (capture)
  document.addEventListener('keyup', function (e) {
    if (vimManager && vimManager.processKeyup(e)) return
    handleKeyup(e) // legacy buffered commands (yy, gg)
  }, true)
}

// Handle keyup events for legacy buffered commands only
function handleKeyup (e) {
  // Only handle legacy buffered commands (yy, gg) - no state transitions
  if (!isCurrentlyInInput() && vimManager && vimManager.current.getName() === 'NORMAL' &&
        (VIM_CONFIG.alphabet.includes(e.key) || e.key === 'G') &&
        !e.ctrlKey && !e.metaKey) {
    e.preventDefault()
    e.stopPropagation()

    command += e.key
    var match = true

    switch (command) {
      case 'yy':
        copyUrlToClipboard()
        HUD.show('Copied URL', 800)
        break
      case 'gg':
        window.scrollTo(0, 0)
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
  }
}

function updateSearchIndicator () {
  // Don't override visual HUD while in visual mode
  if (vimManager && vimManager.current.getName() === 'VISUAL') return
  if (vimManager && vimManager.current.getName() === 'SEARCH') {
    // While typing, do not compute or display candidate counts
    HUD.set(`/${searchBuffer}`)
  } else if (lastSearchQuery) {
    const total = (lastMatchesForQuery === lastSearchQuery) ? lastSearchMatches.length : 0
    const current = (lastSearchIndex >= 0) ? (lastSearchIndex + 1) : 0
    HUD.show(`/${lastSearchQuery} ${current}/${total}`)
  } else {
    HUD.hide()
  }
}

function ensureMatchesForQuery (q) {
  if (lastMatchesForQuery === q) return
  if (!q) {
    lastMatchesForQuery = ''
    lastSearchMatches = []
    lastSearchIndex = -1
    return
  }
  lastMatchesForQuery = q
  lastSearchMatches = collectMatches(q)
  lastSearchIndex = -1
}

function collectMatches (q) {
  const matches = []
  const MAX_MATCHES = 1000
  const query = q.toLowerCase()
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode: function (node) {
      if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT
      const parent = node.parentElement
      if (!parent) return NodeFilter.FILTER_REJECT
      if (parent.closest('[data-min-vim-hud]')) return NodeFilter.FILTER_REJECT
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

const smoothScrolling = process.argv.some(arg => arg.startsWith('--smooth-scrolling'))
  ? process.argv.find(arg => arg.startsWith('--smooth-scrolling')).split('=')[1]
  : 'true'

function selectMatchAt (index) {
  if (index < 0 || index >= lastSearchMatches.length) return
  const range = lastSearchMatches[index]
  const sel = window.getSelection()
  try {
    sel.removeAllRanges()
    sel.addRange(range.cloneRange())
  } catch (e) {}
  const el = range.startContainer.parentElement || document.body
  if (el && el.scrollIntoView) {
    try { el.scrollIntoView({ behavior: smoothScrolling === 'true' ? 'smooth' : 'auto', block: 'center' }) } catch (e) { el.scrollIntoView() }
  }
  HUD.show(`/${lastSearchQuery} ${index + 1}/${lastSearchMatches.length}`)
}

function navigateMatch (backwards = false) {
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
function enterVisualMode () {
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

function exitVisualMode () {
  // After leaving visual, show last search briefly if available
  updateSearchIndicator()
}

function updateVisualIndicator () {
  const sel = window.getSelection()
  let len = 0
  try { len = (sel && sel.toString()) ? sel.toString().length : 0 } catch (e) { len = 0 }
  // Visual mode HUD without current/total (optional char count)
  HUD.set(len > 0 ? `VISUAL (${len} chars)` : 'VISUAL')
}

function extendSelectionByWord (forward = true) {
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

function copyCurrentSelection () {
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
function createLinkItem (link, rect, key) {
  var item = document.createElement('span')
  item.setAttribute('style', VIM_CONFIG.hintStyle)
  item.textContent = key
  item.style.top = (window.scrollY + rect.top) + 'px'
  item.style.left = (window.scrollX + rect.left) + 'px'
  return item
}

// Check if element is visible in viewport
function isVisible (rect) {
  return (
    rect.top > 0 &&
    rect.top < window.innerHeight &&
    rect.left > 0 &&
    rect.left < window.innerWidth
  )
}

// Get next key combination for hints
function getNextKeyCombination (index) {
  const halfIndex = Math.floor(VIM_CONFIG.alphabet.length / 2)
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
function showLinkKeys () {
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
function hideLinkKeys () {
  for (var i = 0; i < currentLinkItems.length; i++) {
    if (currentLinkItems[i].element.parentNode) {
      currentLinkItems[i].element.parentNode.removeChild(currentLinkItems[i].element)
    }
  }
  currentLinkItems = []
}

// Handle typed text for link hints
function onTextTyped (key) {
  bufferAppend(key)
  processLinkHintBuffer()
}

// Apply current buffer to filter hints and act when matched
function processLinkHintBuffer () {
  var viableElementRemaining = false
  let remaining = 0
  const typed = cmdBuffer
  currentLinkItems.forEach(function (link) {
    if (link.key === typed) {
      viableElementRemaining = true
      if (link.link.tagName === 'A') {
        if (linkAction === 'copyToClipboard') {
          copyToClipboard(link.link.href)
        } else if (linkAction === 'openInNewTab') {
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
      // Use proper state transition instead of direct HUD call
      if (vimManager) vimManager.transition('NORMAL')
    } else if (!link.key.startsWith(typed)) {
      link.element.hidden = true
    } else {
      viableElementRemaining = true
      remaining++
    }
  })

  if (!viableElementRemaining) {
    // Use proper state transition instead of direct HUD call
    if (vimManager) vimManager.transition('NORMAL')
    return
  }
  // Update HUD with buffer and remaining count
  try { HUD.set(`HINT ${typed.toUpperCase()} (${remaining})`) } catch (e) {}
}

// Utility functions
function isCurrentlyInInput () {
  const ae = document.activeElement || document.body
  return (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)
}

function isFocusable (element) {
  return ['INPUT', 'TEXTAREA', 'SELECT'].indexOf(element.tagName) >= 0 ||
         element.isContentEditable
}

function copyToClipboard (text) {
  var dummy = document.createElement('input')
  document.body.appendChild(dummy)
  dummy.value = text
  dummy.select()
  document.execCommand('copy')
  document.body.removeChild(dummy)
}

function copyUrlToClipboard () {
  copyToClipboard(window.location.href)
}

// Exit to normal mode - blur any focused element
function exitToNormalMode () {
  // Blur any currently focused element
  if (document.activeElement && document.activeElement !== document.body) {
    document.activeElement.blur()
  }

  // Focus the body to ensure we're in normal mode
  document.body.focus()

  // Clear any ongoing commands
  command = ''
}

// Initialize Vim mode when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initVimMode)
} else {
  initVimMode()
}
