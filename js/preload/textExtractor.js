/* global electron ipc */

const maximumExtractedCharacters = 300000
const ignoredElements = 'link, style, script, noscript, .hidden, .visually-hidden, .visuallyhidden, [role=presentation], [hidden], [style*="display:none"], [style*="display: none"], .ad, .dialog, .modal, select, svg, details:not([open]), header, nav, footer'

function isTextExtractionElementVisible (element, win) {
  if (win?.getComputedStyle) {
    const style = win.getComputedStyle(element)
    return style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse'
  }
  return element.offsetWidth || element.offsetHeight ||
    (element.getClientRects && element.getClientRects().length)
}

function createTextExtraction (doc, maximumCharacters = maximumExtractedCharacters, metrics = {}, win = doc.defaultView) {
  const childNodes = doc.body?.childNodes || []
  const stack = childNodes.length > 0 ? [{ index: 0, nodes: childNodes }] : []
  const chunks = []
  let characterCount = 0
  let complete = false
  let addedMetadata = false
  metrics.nodesVisited = 0
  metrics.stackPushes = stack.length
  function append (value) {
    if (!value || characterCount >= maximumCharacters) return
    const normalized = value.replace(/[\n\t]/g, ' ').replace(/\s{2,}/g, ' ').trim()
    if (!normalized) return
    const separator = chunks.length > 0 ? ' ' : ''
    const available = maximumCharacters - characterCount
    const chunk = (separator + normalized).slice(0, available)
    chunks.push(chunk)
    characterCount += chunk.length
  }

  function finish () {
    if (!addedMetadata && characterCount < maximumCharacters) {
      addedMetadata = true
      append(doc.head?.querySelector('meta[name=description]')?.content)
    }
    complete = true
  }

  function runSlice (deadline, isCancelled = () => false) {
    let sliceOperations = 0
    while (stack.length > 0 && characterCount < maximumCharacters && !isCancelled()) {
      if (sliceOperations >= 500 || (sliceOperations > 0 && deadline.timeRemaining() <= 1)) break
      sliceOperations++
      const frame = stack[stack.length - 1]
      if (frame.index >= frame.nodes.length) {
        stack.pop()
        continue
      }
      const node = frame.nodes[frame.index++]
      metrics.nodesVisited++

      if (node.matches && node.matches(ignoredElements)) continue
      if (node.nodeType === 3) {
        append(node.textContent)
        continue
      }
      if (node.nodeType === 1 && !isTextExtractionElementVisible(node, win)) continue

      const children = node.childNodes || []
      if (children.length > 0) {
        stack.push({ index: 0, nodes: children })
        metrics.stackPushes++
      }
    }

    if (isCancelled()) {
      complete = true
    } else if (stack.length === 0 || characterCount >= maximumCharacters) {
      finish()
    }
    return complete
  }

  return {
    getText: () => chunks.join(''),
    isComplete: () => complete,
    runSlice
  }
}

function extractPageText (doc, win, maximumCharacters = maximumExtractedCharacters, metrics) {
  const extraction = createTextExtraction(doc, maximumCharacters, metrics, win)
  const deadline = { timeRemaining: () => Infinity }
  while (!extraction.isComplete()) extraction.runSlice(deadline)
  return extraction.getText()
}

function scheduleIdleWork (work) {
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(work, { timeout: 1000 })
  } else {
    setTimeout(() => work({ timeRemaining: () => 8 }), 0)
  }
}

function extractPageTextAsync (doc, maximumCharacters, isCancelled) {
  const extraction = createTextExtraction(doc, maximumCharacters)
  return new Promise(function (resolve) {
    function run (deadline) {
      extraction.runSlice(deadline, isCancelled)
      if (extraction.isComplete()) {
        resolve(extraction.getText())
      } else {
        scheduleIdleWork(run)
      }
    }
    scheduleIdleWork(run)
  })
}

async function getPageData (options = {}) {
  const isCancelled = options.isCancelled || (() => false)
  let text = await extractPageTextAsync(document, maximumExtractedCharacters, isCancelled)
  if (isCancelled()) return null

  const frames = document.querySelectorAll('iframe')
  for (let index = 0; index < frames.length && text.length < maximumExtractedCharacters; index++) {
    try {
      const separator = text ? '. ' : ''
      const remaining = maximumExtractedCharacters - text.length - separator.length
      if (remaining <= 0) break
      const frameText = await extractPageTextAsync(frames[index].contentDocument, remaining, isCancelled)
      if (frameText) text += separator + frameText
    } catch (error) {}
    if (isCancelled()) return null
  }

  return { extractedText: text }
}

if (process.isMainFrame) {
  let extractionGeneration = 0
  let navigationGeneration = 0
  let extractionTimer = null
  let indexingEnabled = !process.argv.includes('--min-indexing-disabled')

  const scheduleExtraction = function () {
    extractionGeneration++
    const requestedExtraction = extractionGeneration
    clearTimeout(extractionTimer)
    if (!indexingEnabled) return

    extractionTimer = setTimeout(async function () {
      const sourceURL = window.location.href
      const requestedNavigation = navigationGeneration
      const isCancelled = () => requestedExtraction !== extractionGeneration ||
        requestedNavigation !== navigationGeneration || !indexingEnabled
      const data = await getPageData({ isCancelled })
      if (!data || isCancelled() || sourceURL !== window.location.href) return
      ipc.send('pageData', {
        ...data,
        navigationGeneration: requestedNavigation,
        sourceURL
      })
    }, 500)
  }

  ipc.on('page-navigation-generation', function (event, generation) {
    if (generation > navigationGeneration) navigationGeneration = generation
  })

  ipc.on('page-indexing-config', function (event, configuration) {
    if (configuration.navigationGeneration < navigationGeneration) return
    indexingEnabled = configuration.enabled === true
    navigationGeneration = configuration.navigationGeneration
    if (indexingEnabled) scheduleExtraction()
    else {
      extractionGeneration++
      clearTimeout(extractionTimer)
    }
  })

  window.addEventListener('load', scheduleExtraction)

  setTimeout(function () {
    electron.webFrame.executeJavaScript(`
      history.pushState = ( f => function pushState(){
        var ret = f.apply(this, arguments);
        window.postMessage('_minInternalLocationChange', '*')
        return ret;
    })(history.pushState);

    history.replaceState = ( f => function replaceState(){
        var ret = f.apply(this, arguments);
        window.postMessage('_minInternalLocationReplacement', '*')
        return ret;
    })(history.replaceState);
  `)
  }, 0)

  window.addEventListener('message', function (event) {
    if (event.source !== window) return
    if (event.data === '_minInternalLocationChange' || event.data === '_minInternalLocationReplacement') {
      scheduleExtraction()
    }
  })
}

if (typeof module !== 'undefined') {
  module.exports = {
    createTextExtraction,
    extractPageText,
    getPageData,
    maximumExtractedCharacters
  }
}
