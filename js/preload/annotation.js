/**
 * Min Browser Annotation System
 * Provides text highlighting and note-taking functionality integrated with Notelix Server
 */

// IPC communication for annotation features
var annotationSettings = {
  enabled: false,
  serverUrl: '',
  username: '',
  password: '',
  jwt: null
}

// Global state for annotations
var annotationState = {
  annotations: {},
  selectedAnnotationId: null,
  popoverPos: { x: 0, y: 0 },
  annotatePopoverDom: null,
  editAnnotationPopoverDom: null
}

// Highlighter colors
var highlighterColors = [
  '#ffeb3b', '#ff9800', '#f44336', '#e91e63', 
  '#9c27b0', '#673ab7', '#3f51b5', '#2196f3',
  '#03a9f4', '#00bcd4', '#009688', '#4caf50',
  '#8bc34a', '#cddc39', '#ffc107', '#ff5722'
]

// Utility functions
function makeid(length) {
  if (typeof length === 'undefined') length = 10
  var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  var result = ''
  for (var i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return result
}

function getNormalizedUrl() {
  return window.location.href.split('#')[0]
}

function sleep(ms) {
  return new Promise(function(resolve) {
    setTimeout(resolve, ms)
  })
}

// Function to get annotation settings via IPC
function getAnnotationSettings(callback) {
  ipc.send('getAnnotationSettings')

  // Listen for the response
  ipc.once('annotationSettingsReceived', function (e, settings) {
    annotationSettings = settings || {}

    if (callback) {
      callback(annotationSettings)
    }
  })
}

/**
 * Annotation API Client for communicating with Notelix Server
 * @constructor
 */
function AnnotationApiClient() {
  this.baseUrl = ''
  this.headers = {}
}

/**
 * Update API configuration with server settings
 * @param {Object} settings - Configuration object containing serverUrl, jwt, etc.
 */
AnnotationApiClient.prototype.updateConfig = function(settings) {
  this.baseUrl = (settings.serverUrl && settings.serverUrl.replace(/\/$/, '')) || ''
  // Look for JWT token in settings (could be 'jwt' or 'annotationJwt')
  var jwtToken = settings.jwt || settings.annotationJwt
  this.headers = jwtToken ? { 'Authorization': 'jwt ' + jwtToken } : {}

}

AnnotationApiClient.prototype.request = function(method, endpoint, data) {
  var self = this
  data = data || null
  
  if (!this.baseUrl) {
    return Promise.reject(new Error('Server URL not configured'))
  }

  var url = this.baseUrl + '/' + endpoint
  var options = {
    method: method,
    headers: Object.assign({
      'Content-Type': 'application/json'
    }, this.headers)
  }

  if (data) {
    options.body = JSON.stringify(data)
  }

  return fetch(url, options).then(function(response) {
    if (!response.ok) {
      throw new Error('HTTP ' + response.status + ': ' + response.statusText)
    }
    return response.json()
  }).catch(function(error) {
    console.error('API request failed:', error)
    throw error
  })
}

AnnotationApiClient.prototype.saveAnnotation = function(annotation) {
  return this.request('POST', 'annotations/save', Object.assign({}, annotation, {
    url: getNormalizedUrl(),
    title: document.title,
    host: window.location.host
  }))
}

AnnotationApiClient.prototype.deleteAnnotation = function(uid) {
  return this.request('POST', 'annotations/delete', { uid: uid })
}

AnnotationApiClient.prototype.queryAnnotationsByUrl = function(url) {
  return this.request('POST', 'annotations/queryByUrl', { url: url }).then(function(response) {
    return response.list || []
  })
}

AnnotationApiClient.prototype.searchAnnotations = function(query) {
  return this.request('POST', 'annotations/search', { q: query }).then(function(response) {
    return (response.results && response.results.hits) || []
  })
}

var apiClient = new AnnotationApiClient()

// Text selection and range utilities
function TextSelectionHandler() {
  this.isSelecting = false
  this.setupSelectionListener()
}

TextSelectionHandler.prototype.setupSelectionListener = function() {
  var self = this
  
  document.addEventListener('selectionchange', function() {
    self.handleSelectionChange()
  })

  document.addEventListener('mouseup', function(e) {
    // Don't handle selection changes if clicking on popover elements
    if (e.target.closest('#min-annotate-popover') || e.target.closest('#min-edit-annotation-popover')) {
      return
    }
    setTimeout(function() {
      self.handleSelectionChange()
    }, 10)
  })
}

TextSelectionHandler.prototype.handleSelectionChange = function() {
  var selection = document.getSelection()
  
  // If popover is currently shown and we have a preserved selection, don't hide it
  if (this.currentSelection && annotationState.annotatePopoverDom && 
      annotationState.annotatePopoverDom.style.display === 'flex') {
    return
  }
  
  if (!selection.toString() || 
      !selection.rangeCount || 
      selection.isCollapsed ||
      this.isRangeInContentEditable(selection.getRangeAt(0))) {
    this.hideAnnotatePopover()
        } else {
    this.showAnnotatePopover()
  }
}

TextSelectionHandler.prototype.isRangeInContentEditable = function(range) {
  var ptr = range.commonAncestorContainer
  while (ptr) {
    if (ptr.isContentEditable) {
      return true
    }
    ptr = ptr.parentElement
  }
  return false
}

TextSelectionHandler.prototype.serializeRange = function(range, options) {
  options = options || {}
  var uid = options.uid
  var charsToKeepForTextBeforeAndTextAfter = options.charsToKeepForTextBeforeAndTextAfter || 128
  
  try {
    var selectedText = range.toString().trim()
    if (!selectedText) return null

    // Get text before and after selection
    var beforeRange = document.createRange()
    beforeRange.setStart(document.body, 0)
    beforeRange.setEnd(range.startContainer, range.startOffset)
    var textBefore = beforeRange.toString().slice(-charsToKeepForTextBeforeAndTextAfter)

    var afterRange = document.createRange()
    afterRange.setStart(range.endContainer, range.endOffset)
    afterRange.setEnd(document.body, document.body.childNodes.length)
    var textAfter = afterRange.toString().slice(0, charsToKeepForTextBeforeAndTextAfter)

    return {
      uid: uid,
      text: selectedText,
      textBefore: textBefore,
      textAfter: textAfter
    }
  } catch (error) {
    console.error('Failed to serialize range:', error)
    return null
  }
}

TextSelectionHandler.prototype.showAnnotatePopover = function() {
  var selection = document.getSelection()
  if (!selection.rangeCount) return

  var range = selection.getRangeAt(0)
  var rect = range.getBoundingClientRect()
  
  // Store the current selection to preserve it
  this.currentSelection = {
    range: range.cloneRange(),
    text: selection.toString()
  }
  
  annotationState.popoverPos = {
    x: rect.left + rect.width / 2 - 100,
    y: rect.top + window.scrollY - 50
  }


  if (annotationState.annotatePopoverDom) {
    annotationState.annotatePopoverDom.style.left = annotationState.popoverPos.x + 'px'
    annotationState.annotatePopoverDom.style.top = annotationState.popoverPos.y + 'px'
    annotationState.annotatePopoverDom.style.display = 'flex'
  } else {
    console.error('Annotate popover DOM element not found!')
  }
}

TextSelectionHandler.prototype.hideAnnotatePopover = function() {
  if (annotationState.annotatePopoverDom) {
    annotationState.annotatePopoverDom.style.display = 'none'
  }
  // Clear preserved selection when hiding popover
  this.currentSelection = null
}

// AnnotationMarker is loaded by buildPreload.js before this file

// Event handler functions for marker
function showEditPopover(annotation, element) {
  annotationState.selectedAnnotationId = annotation.uid
  var rect = element.getBoundingClientRect()
  
  annotationState.popoverPos = {
    x: rect.left,
    y: rect.top + window.scrollY - 40
  }

  if (annotationState.editAnnotationPopoverDom) {
    annotationState.editAnnotationPopoverDom.style.left = annotationState.popoverPos.x + 'px'
    annotationState.editAnnotationPopoverDom.style.top = annotationState.popoverPos.y + 'px'
    annotationState.editAnnotationPopoverDom.style.display = 'flex'
  }
}

function showNoteTooltip(element, notes) {
  var tooltip = document.createElement('div')
  tooltip.className = 'min-annotation-note'
  tooltip.textContent = notes
  element.appendChild(tooltip)
}

function hideNoteTooltip(element) {
  var tooltip = element.querySelector('.min-annotation-note')
  if (tooltip) {
    tooltip.remove()
  }
}





var marker = null
var selectionHandler = null

// Initialize these after DOM is ready
function initializeMarkerAndHandler() {
  
  if (!marker) {
    try {
      marker = new AnnotationMarker()
    } catch (error) {
      console.error('Failed to create AnnotationMarker:', error)
    }
  }
  
  if (!selectionHandler) {
    try {
      selectionHandler = new TextSelectionHandler()
    } catch (error) {
      console.error('Failed to create TextSelectionHandler:', error)
    }
  }
  
}

// DOM UI Components
function createAnnotatePopover() {
  if (annotationState.annotatePopoverDom) return
  
  if (!document.body) {
    setTimeout(createAnnotatePopover, 100)
    return
  }

  var popover = document.createElement('div')
  popover.id = 'min-annotate-popover'
  popover.style.cssText = 
    'position: absolute;' +
    'display: none;' +
    'flex-direction: row;' +
    'gap: 4px;' +
    'padding: 8px;' +
    'background: white;' +
    'border: 1px solid #ccc;' +
    'border-radius: 4px;' +
    'box-shadow: 0 2px 10px rgba(0,0,0,0.1);' +
    'z-index: 10000;'

  for (var i = 0; i < highlighterColors.length; i++) {
    var color = highlighterColors[i]
    var colorSpan = document.createElement('span')
    colorSpan.style.cssText = 
      'width: 20px;' +
      'height: 20px;' +
      'background-color: ' + color + ';' +
      'cursor: pointer;' +
      'border-radius: 2px;' +
      'border: 1px solid #ddd;'
    
    colorSpan.addEventListener('click', (function(c) {
      return function() { onHighlightClick(c) }
    })(color))
    
    popover.appendChild(colorSpan)
  }

  document.body.appendChild(popover)
  annotationState.annotatePopoverDom = popover
}

function createEditPopover() {
  if (annotationState.editAnnotationPopoverDom) return
  
  // Wait for DOM body to be ready
  if (!document.body) {
    setTimeout(createEditPopover, 100)
    return
  }

  var popover = document.createElement('div')
  popover.id = 'min-edit-popover'
  popover.style.cssText = 
    'position: absolute;' +
    'display: none;' +
    'flex-direction: row;' +
    'gap: 4px;' +
    'padding: 8px;' +
    'background: white;' +
    'border: 1px solid #ccc;' +
    'border-radius: 4px;' +
    'box-shadow: 0 2px 10px rgba(0,0,0,0.1);' +
    'z-index: 10000;'

  var editButton = document.createElement('button')
  editButton.textContent = '📝'
  editButton.title = 'Edit Notes'
  editButton.addEventListener('click', onEditNotesClick)

  var deleteButton = document.createElement('button')
  deleteButton.textContent = '🗑️'
  deleteButton.title = 'Delete'
  deleteButton.addEventListener('click', onDeleteClick)

  popover.appendChild(editButton)
  popover.appendChild(deleteButton)
  document.body.appendChild(popover)
  annotationState.editAnnotationPopoverDom = popover
}

// Event handlers
function onHighlightClick(color) {
  
  if (!selectionHandler || !marker) {
    console.warn('Annotation system not ready - selectionHandler:', !!selectionHandler, 'marker:', !!marker)
    return
  }
  
  // Use the preserved selection instead of current selection
  if (!selectionHandler.currentSelection || !selectionHandler.currentSelection.range) {
    console.warn('No preserved selection available')
    return
  }
  
  var range = selectionHandler.currentSelection.range
  var uid = makeid()
  
  var serializedRange = selectionHandler.serializeRange(range, { uid: uid })
  
  if (!serializedRange) {
    console.warn('Failed to serialize range')
    return
  }

  // Clear the actual selection and hide popover
  document.getSelection().removeAllRanges()
  selectionHandler.hideAnnotatePopover()
  
  // Clear the preserved selection
  selectionHandler.currentSelection = null

  var annotation = {
    uid: uid,
    data: { 
      color: color, 
      notes: '', 
      text: serializedRange.text,
      textBefore: serializedRange.textBefore,
      textAfter: serializedRange.textAfter
    }
  }

  annotationState.annotations[uid] = annotation
  
  try {
    marker.paint(annotation, {
      onClick: showEditPopover,
      onMouseEnter: showNoteTooltip,
      onMouseLeave: hideNoteTooltip
    })
    
    // Verify the highlight was actually created
    var highlightElements = document.querySelectorAll('[annotation-id="' + annotation.uid + '"]')
    if (highlightElements.length === 0) {
      console.error('No highlight elements were created in DOM!')
    }
  } catch (error) {
    console.error('Paint failed:', error)
    console.error('Error stack:', error.stack)
  }

  // Save to server
  saveAnnotation(annotation).then(function() {
  }).catch(function(error) {
    console.error('Failed to save annotation:', error)
    if (marker) {
      marker.unpaint(uid)
    }
    delete annotationState.annotations[uid]
  })
}

function onEditNotesClick() {
  var uid = annotationState.selectedAnnotationId
  if (!uid) return

  var annotation = annotationState.annotations[uid]
  if (!annotation) return

  showNotesEditDialog(annotation)

  if (annotationState.editAnnotationPopoverDom) {
    annotationState.editAnnotationPopoverDom.style.display = 'none'
  }
}

function showNotesEditDialog(annotation) {
  // Remove existing dialog if any
  var existingDialog = document.getElementById('min-notes-edit-dialog')
  if (existingDialog) {
    existingDialog.remove()
  }

  // Create dialog overlay
  var overlay = document.createElement('div')
  overlay.id = 'min-notes-edit-dialog'
  overlay.style.cssText = 
    'position: fixed;' +
    'top: 0;' +
    'left: 0;' +
    'width: 100%;' +
    'height: 100%;' +
    'background: rgba(0, 0, 0, 0.5);' +
    'z-index: 10001;' +
    'display: flex;' +
    'align-items: center;' +
    'justify-content: center;'

  // Create dialog box
  var dialog = document.createElement('div')
  dialog.style.cssText = 
    'background: white;' +
    'border-radius: 8px;' +
    'padding: 20px;' +
    'min-width: 400px;' +
    'max-width: 600px;' +
    'box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);' +
    'font-family: system-ui, -apple-system, sans-serif;'

  // Create title
  var title = document.createElement('h3')
  title.textContent = 'Edit Note'
  title.style.cssText = 
    'margin: 0 0 15px 0;' +
    'font-size: 16px;' +
    'color: #333;'

  // Create textarea
  var textarea = document.createElement('textarea')
  textarea.value = annotation.data.notes || ''
  textarea.placeholder = 'Enter your notes here...'
  textarea.style.cssText = 
    'width: 100%;' +
    'height: 100px;' +
    'border: 1px solid #ddd;' +
    'border-radius: 4px;' +
    'padding: 10px;' +
    'font-size: 14px;' +
    'font-family: inherit;' +
    'resize: vertical;' +
    'box-sizing: border-box;' +
    'margin-bottom: 15px;'

  // Create button container
  var buttonContainer = document.createElement('div')
  buttonContainer.style.cssText = 
    'display: flex;' +
    'gap: 10px;' +
    'justify-content: flex-end;'

  // Create cancel button
  var cancelButton = document.createElement('button')
  cancelButton.textContent = 'Cancel'
  cancelButton.style.cssText = 
    'padding: 8px 16px;' +
    'border: 1px solid #ddd;' +
    'border-radius: 4px;' +
    'background: white;' +
    'color: #666;' +
    'cursor: pointer;' +
    'font-size: 14px;'

  // Create save button
  var saveButton = document.createElement('button')
  saveButton.textContent = 'Save'
  saveButton.style.cssText = 
    'padding: 8px 16px;' +
    'border: none;' +
    'border-radius: 4px;' +
    'background: #007bff;' +
    'color: white;' +
    'cursor: pointer;' +
    'font-size: 14px;'

  // Add hover effects
  cancelButton.addEventListener('mouseenter', function() {
    this.style.backgroundColor = '#f5f5f5'
  })
  cancelButton.addEventListener('mouseleave', function() {
    this.style.backgroundColor = 'white'
  })

  saveButton.addEventListener('mouseenter', function() {
    this.style.backgroundColor = '#0056b3'
  })
  saveButton.addEventListener('mouseleave', function() {
    this.style.backgroundColor = '#007bff'
  })

  // Add event listeners
  cancelButton.addEventListener('click', function() {
    overlay.remove()
  })

  saveButton.addEventListener('click', function() {
    var newNotes = textarea.value.trim()
    annotation.data.notes = newNotes
    
    // Update the annotation
    saveAnnotation(annotation).then(function() {
      
      // Repaint the marker to show updated notes
      if (marker) {
        try {
          // First remove the old marker
          marker.unpaint(annotation.uid)
          // Then paint it again with updated content
          marker.paint(annotation, {
            onClick: showEditPopover,
            onMouseEnter: showNoteTooltip,
            onMouseLeave: hideNoteTooltip
          })
        } catch (error) {
          console.error('Failed to repaint marker after notes update:', error)
        }
      }
    }).catch(function(error) {
      console.error('Failed to update notes:', error)
      alert('Failed to save notes. Please try again.')
    })
    
    overlay.remove()
  })

  // Close on overlay click
  overlay.addEventListener('click', function(e) {
    if (e.target === overlay) {
      overlay.remove()
    }
  })

  // Close on Escape key
  document.addEventListener('keydown', function onEscape(e) {
    if (e.key === 'Escape') {
      overlay.remove()
      document.removeEventListener('keydown', onEscape)
    }
  })

  // Assemble dialog
  buttonContainer.appendChild(cancelButton)
  buttonContainer.appendChild(saveButton)
  
  dialog.appendChild(title)
  dialog.appendChild(textarea)
  dialog.appendChild(buttonContainer)
  
  overlay.appendChild(dialog)
  document.body.appendChild(overlay)

  // Focus the textarea
  setTimeout(function() {
    textarea.focus()
    textarea.select()
  }, 100)
}

function onDeleteClick() {
  var uid = annotationState.selectedAnnotationId
  if (!uid) return

  if (confirm('Delete this annotation?')) {
    if (marker) {
      marker.unpaint(uid)
    }
    delete annotationState.annotations[uid]
    deleteAnnotation(uid)
  }

  if (annotationState.editAnnotationPopoverDom) {
    annotationState.editAnnotationPopoverDom.style.display = 'none'
  }
}

// API functions
function saveAnnotation(annotation) {
  if (!annotationSettings.enabled) return Promise.resolve()
  return apiClient.saveAnnotation(annotation)
}

function deleteAnnotation(uid) {
  if (!annotationSettings.enabled) return Promise.resolve()
  return apiClient.deleteAnnotation(uid)
}

function loadAnnotations() {
  if (!annotationSettings.enabled) return Promise.resolve()

  return apiClient.queryAnnotationsByUrl(getNormalizedUrl()).then(function(annotations) {
    for (var i = 0; i < annotations.length; i++) {
      var annotation = annotations[i]
      annotationState.annotations[annotation.uid] = annotation
      if (marker) {
        try {
          marker.paint(annotation, {
            onClick: showEditPopover,
            onMouseEnter: showNoteTooltip,
            onMouseLeave: hideNoteTooltip
          })
        } catch (error) {
          console.error('Failed to paint server annotation:', annotation.uid, error)
        }
      }
    }
  }).catch(function(error) {
    console.error('Failed to load annotations:', error)
  })
}

function searchAnnotations(query) {
  if (!annotationSettings.enabled) return Promise.resolve([])
  return apiClient.searchAnnotations(query)
}

// Initialize annotation functionality
function initializeAnnotations() {
  // Ensure DOM is ready before initializing
  if (!document.body || !document.head) {
    setTimeout(initializeAnnotations, 100)
    return
  }
  
  // Initialize marker and selection handler
  initializeMarkerAndHandler()
  
  createAnnotatePopover()
  createEditPopover()

  // Hide popovers when clicking outside
  document.addEventListener('click', function(e) {
    if (!e.target.closest('#min-annotate-popover') && 
        !e.target.closest('#min-edit-popover')) {
      if (selectionHandler) {
        selectionHandler.hideAnnotatePopover()
      }
      if (annotationState.editAnnotationPopoverDom) {
        annotationState.editAnnotationPopoverDom.style.display = 'none'
      }
    }
  })

  // Load existing annotations
  getAnnotationSettings(function(settings) {
    apiClient.updateConfig(settings)
    if (settings.enabled) {
      loadAnnotations()
    }
  })
}

// Wait for DOM to be ready before creating instances
function waitForDOMReady(callback) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', callback)
  } else {
    callback()
  }
}

// Initialize when page loads
if (process.isMainFrame) {
  // Use multiple strategies to ensure DOM is ready
  waitForDOMReady(function() {
    // Additional delay to ensure everything is settled
    setTimeout(function() {
      // Only initialize if DOM elements are available
      if (document.body && document.head) {
        initializeAnnotations()
      } else {
        // Fallback: keep trying until DOM is ready
        var retryCount = 0
        var retryInit = function() {
          if (document.body && document.head) {
            initializeAnnotations()
          } else if (retryCount < 50) { // Max 5 seconds of retries
            retryCount++
            setTimeout(retryInit, 100)
          }
        }
        retryInit()
      }
    }, 500)
  })
}

// Export API for external use
window.annotationAPI = {
  getSettings: getAnnotationSettings,
  loadAnnotations: loadAnnotations,
  searchAnnotations: searchAnnotations,
  saveAnnotation: saveAnnotation,
  deleteAnnotation: deleteAnnotation,
  state: annotationState
}