/**
 * AnnotationMarker - Text highlighting system for annotations
 * Handles visual highlighting of text ranges and note display
 * @constructor
 */
function AnnotationMarker () {
  this.highlightTagName = 'min-annotation-highlight'
  this.highlightIdAttribute = 'annotation-id'
  this.normalizeTextCache = {}
  this.setupStyles()
}

/**
 * Setup CSS styles for annotation highlights and notes
 */
AnnotationMarker.prototype.setupStyles = function () {
  if (document.getElementById('min-annotation-styles')) return

  // Wait for DOM to be ready
  if (!document.head) {
    var self = this
    setTimeout(function () {
      self.setupStyles()
    }, 100)
    return
  }

  var style = document.createElement('style')
  style.id = 'min-annotation-styles'
  style.textContent =
    this.highlightTagName + ' {' +
      'position: relative;' +
      'cursor: pointer;' +
      'text-decoration: underline 2px;' +
      'background-color: rgba(129, 45, 255, 0.133);' +
      'text-indent: 0px !important;' +
    '}' +

    this.highlightTagName + ' * {' +
      'text-indent: 0px !important;' +
    '}' +

    this.highlightTagName + ':hover {' +
      'opacity: 0.8;' +
    '}' +

    '.notelix-notes-inline {' +
      'display: inline-block;' +
      'position: relative;' +
      'margin-top: calc(1em + 10px);' +
      'cursor: pointer;' +
      'filter: brightness(1);' +
      'transition: all 0.15s ease-in-out;' +
    '}' +

    '.notelix-notes-inline .comments-svg svg {' +
      'position: relative;' +
      'top: 2px;' +
      'box-sizing: content-box !important;' +
      'width: 1em;' +
      'padding: 0 2px 0 4px;' +
      'fill: #000000;' +
      'transition: all 0.2s ease-in-out;' +
    '}' +

    '.notelix-notes-inline .comments-svg:hover svg {' +
      'transform: scale(1.15);' +
    '}' +

    '.notelix-notes-inline .text {' +
      'font-family: sans-serif;' +
      'text-decoration: none;' +
      'font-style: normal;' +
      'font-weight: normal;' +
      'white-space: nowrap;' +
      'display: inline;' +
      'padding: 4px 8px;' +
      'position: absolute;' +
      'z-index: 1;' +
      'top: calc(-1em - 11px);' +
      'left: 0;' +
      'border-radius: 2px;' +
      'font-size: 11px;' +
      'overflow: hidden;' +
      'text-overflow: ellipsis;' +
      'line-height: 12px;' +
    '}' +

    '.notelix-notes-inline .caret {' +
      'display: inline-block;' +
      'width: 10px;' +
      'height: 10px;' +
      'transform: rotate(45deg);' +
      'position: absolute;' +
      'top: -9px;' +
      'z-index: 0;' +
      'left: 6px;' +
    '}' +

    '.notelix-notes-inline:hover {' +
      'filter: brightness(1.05);' +
      'z-index: 100;' +
    '}'

  document.head.appendChild(style)
}

AnnotationMarker.prototype.normalizeText = function (text) {
  if (!this.normalizeTextCache[text]) {
    this.normalizeTextCache[text] = text.replace(/\s/g, '').toLowerCase()
  }
  return this.normalizeTextCache[text]
}

AnnotationMarker.prototype.getNormalizedInnerText = function (element) {
  var text = ''
  var walker = document.createTreeWalker(
    element,
    NodeFilter.SHOW_TEXT,
    function (node) {
      // Skip script, style, and other non-visible elements
      var parent = node.parentElement
      while (parent) {
        var tagName = parent.tagName
        if (tagName === 'SCRIPT' || tagName === 'STYLE' || tagName === 'NOSCRIPT') {
          return NodeFilter.FILTER_REJECT
        }
        var computedStyle = getComputedStyle(parent)
        if (computedStyle.display === 'none' || computedStyle.visibility === 'hidden') {
          return NodeFilter.FILTER_REJECT
        }
        parent = parent.parentElement
      }
      return NodeFilter.FILTER_ACCEPT
    },
    false
  )

  var node
  while (node = walker.nextNode()) {
    text += this.normalizeText(node.textContent || '')
  }
  return text
}

AnnotationMarker.prototype.findTextOffset = function (rootText, serializedRange) {
  var beforeText = this.normalizeText(serializedRange.textBefore)
  var targetText = this.normalizeText(serializedRange.text)
  var afterText = this.normalizeText(serializedRange.textAfter)

  // Find the position where textBefore + text + textAfter appears
  var searchText = beforeText + targetText + afterText
  var index = rootText.indexOf(searchText)

  if (index === -1) {
    // Try with just textBefore + text
    searchText = beforeText + targetText
    index = rootText.indexOf(searchText)
    if (index !== -1) {
      return index + beforeText.length
    }

    // Try with just text + textAfter
    searchText = targetText + afterText
    index = rootText.indexOf(searchText)
    if (index !== -1) {
      return index
    }

    // Last resort: just find the text
    index = rootText.indexOf(targetText)
    if (index !== -1) {
      return index
    }

    throw new Error('Could not find text in document: ' + serializedRange.text)
  }

  return index + beforeText.length
}

AnnotationMarker.prototype.findElementAtOffset = function (rootElement, offset) {
  // Handle edge cases
  if (offset < 0) {
    console.warn('Negative offset provided:', offset)
    offset = 0
  }

  if (offset > 1000000) {
    console.error('Offset too large:', offset)
    throw new Error('Invalid offset: ' + offset)
  }

  var currentOffset = 0
  var lastValidNode = null
  var walker = document.createTreeWalker(
    rootElement,
    NodeFilter.SHOW_TEXT,
    function (node) {
      var parent = node.parentElement
      while (parent) {
        var tagName = parent.tagName
        if (tagName === 'SCRIPT' || tagName === 'STYLE' || tagName === 'NOSCRIPT') {
          return NodeFilter.FILTER_REJECT
        }
        var computedStyle = getComputedStyle(parent)
        if (computedStyle.display === 'none' || computedStyle.visibility === 'hidden') {
          return NodeFilter.FILTER_REJECT
        }
        parent = parent.parentElement
      }
      return NodeFilter.FILTER_ACCEPT
    },
    false
  )

  var node
  while (node = walker.nextNode()) {
    lastValidNode = node
    var nodeText = this.normalizeText(node.textContent || '')

    if (currentOffset + nodeText.length >= offset) {
      var localOffset = offset - currentOffset
      return {
        element: node,
        offset: Math.max(0, localOffset)
      }
    }
    currentOffset += nodeText.length
  }

  // If we couldn't find the exact offset, return the last valid node
  if (lastValidNode) {
    console.warn('Could not find exact offset', offset, 'total text length', currentOffset, 'using last node')
    return {
      element: lastValidNode,
      offset: this.normalizeText(lastValidNode.textContent || '').length
    }
  }

  throw new Error('Could not find any text nodes in element')
}

AnnotationMarker.prototype.getRealOffset = function (textNode, normalizedOffset) {
  var text = textNode.textContent || ''

  // Handle edge cases
  if (normalizedOffset <= 0) {
    return 0
  }

  if (normalizedOffset < 0 || normalizedOffset > 1000000) {
    console.error('Invalid normalized offset:', normalizedOffset)
    return 0
  }

  var cumulative = 0

  for (var i = 0; i < text.length; i++) {
    var char = text.substr(i, 1)
    var normalizedChar = this.normalizeText(char)

    if (normalizedChar) {
      if (cumulative === normalizedOffset) {
        return i
      }
      cumulative++
    }
  }

  // If we've reached the end and still haven't found the offset
  if (cumulative === normalizedOffset) {
    return text.length
  }

  console.warn('Could not find real offset', normalizedOffset, 'in text of length', text.length, 'normalized length', cumulative)
  return Math.min(normalizedOffset, text.length)
}

AnnotationMarker.prototype.convertTextNodeToHighlightElement = function (textNode) {
  var highlightElement = document.createElement(this.highlightTagName)
  var parent = textNode.parentNode

  parent.insertBefore(highlightElement, textNode.nextSibling)
  parent.removeChild(textNode)
  highlightElement.appendChild(textNode)

  return highlightElement
}

AnnotationMarker.prototype.highlightRange = function (range, uid, annotation, eventHandlers) {
  var self = this

  if (range.collapsed) {
    console.warn('Cannot highlight collapsed range')
    return
  }

  var elementsToHighlight = []

  if (range.startContainer === range.endContainer) {
    // Simple case: start and end in same text node
    if (range.startOffset === range.endOffset) {
      return
    }

    var textNode = range.startContainer
    var textLength = (textNode.textContent || '').length

    // Validate offsets
    var startOffset = Math.max(0, Math.min(range.startOffset, textLength))
    var endOffset = Math.max(startOffset, Math.min(range.endOffset, textLength))

    if (startOffset >= endOffset) {
      console.warn('Invalid offsets for single text node')
      return
    }

    var word = textNode.splitText(startOffset)
    word.splitText(endOffset - startOffset)

    var highlightElement = this.convertTextNodeToHighlightElement(word)
    highlightElement.setAttribute(this.highlightIdAttribute, uid)
    elementsToHighlight.push(highlightElement)
  } else {
    // Complex case: spans multiple text nodes
    var toPaint = []

    // Validate start offset
    var startTextLength = (range.startContainer.textContent || '').length
    var startOffset = Math.max(0, Math.min(range.startOffset, startTextLength))

    // Split start container and add first part
    if (startOffset < startTextLength) {
      var startNode = range.startContainer.splitText(startOffset)
      toPaint.push(startNode)
    } else {
      toPaint.push(range.startContainer)
    }

    // Find all text nodes between start and end
    var walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      null,
      false
    )

    // Position walker at start node
    var node
    var startNodeFound = false
    while (node = walker.nextNode()) {
      if (node === toPaint[0]) {
        startNodeFound = true
        break
      }
    }

    if (!startNodeFound) {
      console.warn('Could not find start node in walker')
      return
    }

    // Collect nodes until we reach end container
    while (node = walker.nextNode()) {
      if (node === range.endContainer) {
        break
      }
      toPaint.push(node)
    }

    // Validate end offset
    var endTextLength = (range.endContainer.textContent || '').length
    var endOffset = Math.max(0, Math.min(range.endOffset, endTextLength))

    // Split end container and add the part we want
    if (endOffset > 0 && endOffset < endTextLength) {
      range.endContainer.splitText(endOffset)
    }
    toPaint.push(range.endContainer)

    // Convert all text nodes to highlight elements
    for (var i = 0; i < toPaint.length; i++) {
      var textNode = toPaint[i]
      if (textNode && textNode.textContent && textNode.textContent.trim()) {
        var highlightElement = this.convertTextNodeToHighlightElement(textNode)
        highlightElement.setAttribute(this.highlightIdAttribute, uid)
        elementsToHighlight.push(highlightElement)
      }
    }
  }

  // Apply styling and event handlers to all highlight elements
  for (var i = 0; i < elementsToHighlight.length; i++) {
    var element = elementsToHighlight[i]
    var color = annotation.data.color || '#8129ff'

    // Apply new underline style
    element.style.textDecoration = 'underline 2px ' + color
    element.style.backgroundColor = this.hexToRgba(color, 0.133)

    // Add click handler
    if (eventHandlers && eventHandlers.onClick) {
      (function (ann, handler) {
        element.addEventListener('click', function (e) {
          e.stopPropagation()
          handler(ann, e.target)
        })
      })(annotation, eventHandlers.onClick)
    }

    // Add always-visible notes if they exist
    if (annotation.data.notes && annotation.data.notes.trim()) {
      // Only add notes container to the first highlight element
      if (i === 0) {
        this.addNotesContainer(element, annotation.data.notes, color)
      }
    }
  }

  if (elementsToHighlight.length === 0) {
    console.warn('No highlight elements were created!')
  } else {
  }
}

AnnotationMarker.prototype.paint = function (annotation, eventHandlers) {
  try {
    var uid = annotation.uid
    var serializedRange = {
      uid: uid,
      text: annotation.data.text,
      textBefore: annotation.data.textBefore,
      textAfter: annotation.data.textAfter
    }

    // Validate input
    if (!serializedRange.text) {
      console.warn('No text to highlight')
      return
    }

    // Get the normalized text of the entire document
    var rootText = this.getNormalizedInnerText(document.body)

    if (rootText.length === 0) {
      console.warn('No text found in document')
      return
    }

    // Find the offset of our text
    var textOffset = this.findTextOffset(rootText, serializedRange)

    // Validate offset
    if (textOffset < 0 || textOffset >= rootText.length) {
      console.error('Invalid text offset:', textOffset, 'root text length:', rootText.length)
      return
    }

    // Find the start and end elements
    var normalizedTextLength = this.normalizeText(serializedRange.text).length

    if (normalizedTextLength === 0) {
      console.warn('Normalized text has zero length')
      return
    }

    var endOffset = textOffset + normalizedTextLength
    if (endOffset > rootText.length) {
      console.warn('End offset exceeds root text length, adjusting')
      endOffset = rootText.length
    }

    var startPos = this.findElementAtOffset(document.body, textOffset)
    var endPos = this.findElementAtOffset(document.body, endOffset)

    // Validate positions
    if (!startPos.element || !endPos.element) {
      console.error('Could not find start or end elements')
      return
    }

    // Create a range with bounds checking
    var range = document.createRange()

    var startRealOffset = this.getRealOffset(startPos.element, startPos.offset)
    var endRealOffset = this.getRealOffset(endPos.element, endPos.offset)

    // Validate real offsets
    var startTextLength = (startPos.element.textContent || '').length
    var endTextLength = (endPos.element.textContent || '').length

    startRealOffset = Math.max(0, Math.min(startRealOffset, startTextLength))
    endRealOffset = Math.max(0, Math.min(endRealOffset, endTextLength))

    range.setStart(startPos.element, startRealOffset)
    range.setEnd(endPos.element, endRealOffset)

    // Validate range
    if (range.collapsed) {
      console.warn('Range is collapsed, cannot highlight')
      return
    }

    // Highlight the range
    this.highlightRange(range, uid, annotation, eventHandlers)
  } catch (error) {
    console.error('Failed to paint annotation:', error)
    console.error('Annotation data:', annotation)
    // Don't re-throw, just log the error to prevent breaking other annotations
  }
}

AnnotationMarker.prototype.unpaint = function (uid) {
  var highlights = document.querySelectorAll(this.highlightTagName + '[' + this.highlightIdAttribute + '="' + uid + '"]')

  for (var i = 0; i < highlights.length; i++) {
    var highlightElement = highlights[i]
    var parent = highlightElement.parentNode

    // Remove icon and bubble elements first, keep only text nodes
    var children = Array.prototype.slice.call(highlightElement.childNodes)
    for (var j = 0; j < children.length; j++) {
      var child = children[j]
      if (child.nodeType === Node.TEXT_NODE) {
        // Move text nodes back to parent
        parent.insertBefore(child, highlightElement)
      } else if (child.classList && (child.classList.contains('min-annotation-icon') || child.classList.contains('min-annotation-notes-bubble'))) {
        // Remove icon and bubble elements
        highlightElement.removeChild(child)
      }
    }

    // Remove the highlight element
    parent.removeChild(highlightElement)
  }

  // Normalize the parent to merge adjacent text nodes
  if (highlights.length > 0) {
    document.body.normalize()
  }
}

AnnotationMarker.prototype.showNoteTooltip = function (element, notes) {
  var tooltip = document.createElement('div')
  tooltip.className = 'min-annotation-note'
  tooltip.textContent = notes
  element.appendChild(tooltip)
}

AnnotationMarker.prototype.hideNoteTooltip = function (element) {
  var tooltip = element.querySelector('.min-annotation-note')
  if (tooltip) {
    tooltip.remove()
  }
}

// Helper method to convert hex color to rgba
AnnotationMarker.prototype.hexToRgba = function (hex, alpha) {
  var result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
  if (!result) return 'rgba(129, 45, 255, ' + alpha + ')'

  return 'rgba(' +
    parseInt(result[1], 16) + ', ' +
    parseInt(result[2], 16) + ', ' +
    parseInt(result[3], 16) + ', ' +
    alpha + ')'
}

// Create comment icon SVG
AnnotationMarker.prototype.createCommentIcon = function (color) {
  var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('fill', color)
  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  svg.setAttribute('viewBox', '0 0 32 32')
  svg.setAttribute('xml:space', 'preserve')
  svg.style.fill = color
  svg.innerHTML =
    '<g>' +
      '<path d="M2.5,32c-0.667,0-1.294-0.261-1.767-0.733C0.26,30.793,0,30.165,0,29.498L0.003,4.501C0.003,3.122,1.125,2,2.504,2h13.898 c0.552,0,1,0.448,1,1s-0.448,1-1,1H2.504C2.232,4,2.003,4.229,2.003,4.501L2,29.499c0,0.179,0.092,0.298,0.147,0.354 C2.203,29.907,2.322,30,2.5,30l24.999-0.003c0.271,0,0.501-0.229,0.501-0.501V15.598c0-0.552,0.447-1,1-1s1,0.448,1,1v13.898 c0,1.379-1.122,2.501-2.501,2.501L2.5,32z"></path>' +
      '<path d="M7,26c-0.263,0-0.518-0.104-0.707-0.293c-0.236-0.236-0.339-0.575-0.273-0.903l1.274-6.372 c0.097-0.484,0.333-0.927,0.683-1.277L24.839,0.293c0.216-0.215,0.521-0.323,0.821-0.287c3.344,0.386,5.948,2.991,6.333,6.334 c0.035,0.303-0.07,0.605-0.286,0.821l-16.86,16.86c-0.349,0.35-0.79,0.586-1.276,0.685L7.196,25.98C7.131,25.993,7.065,26,7,26z M25.893,2.067l-16.5,16.5c-0.07,0.07-0.118,0.159-0.137,0.256l-0.98,4.902l4.901-0.98c0.097-0.02,0.186-0.067,0.255-0.137 L29.933,6.107C29.514,4.068,27.932,2.486,25.893,2.067z"></path>' +
    '</g>'
  return svg
}

// Add always-visible notes container
AnnotationMarker.prototype.addNotesContainer = function (element, notes, color) {
  // Create the main notes container div - matching reference structure
  var notesInline = document.createElement('div')
  notesInline.className = 'web-marker-black-listed-element notelix-notes-inline'
  notesInline.style.backgroundColor = 'transparent'

  // Create the comments icon span with hidden accessibility text
  var iconSpan = document.createElement('span')
  iconSpan.className = 'comments-svg'
  iconSpan.style.backgroundColor = 'transparent'
  iconSpan.style.borderColor = 'transparent'

  // Add hidden accessibility text
  var hiddenText = document.createElement('span')
  hiddenText.style.cssText = 'visibility: hidden; display: inline-block; white-space: nowrap; width: 0;'
  hiddenText.textContent = 'notes'
  iconSpan.appendChild(hiddenText)

  // Add the SVG icon using our helper function
  var svgElement = this.createCommentIcon(color)
  svgElement.style.fill = color
  iconSpan.appendChild(svgElement)

  // Create the notes text bubble - matching reference class name
  var notesText = document.createElement('div')
  notesText.className = 'text'
  notesText.style.cssText = 'background: ' + color + ' !important; max-width: 300px !important; color: rgb(0, 0, 0);'
  notesText.textContent = notes

  // Create the caret (arrow pointing down) - matching reference class name
  var caret = document.createElement('div')
  caret.className = 'caret'
  caret.style.cssText = 'background: ' + color + ' !important;'

  // Assemble the structure: notes-inline contains icon, notes-text, and caret
  notesInline.appendChild(iconSpan)
  notesInline.appendChild(notesText)
  notesInline.appendChild(caret)

  // Insert the notes container at the beginning of the highlight element
  element.insertBefore(notesInline, element.firstChild)
}

// Export for use in other scripts
if (typeof module !== 'undefined' && module.exports) {
  module.exports = AnnotationMarker
} else if (typeof window !== 'undefined') {
  window.AnnotationMarker = AnnotationMarker
}
