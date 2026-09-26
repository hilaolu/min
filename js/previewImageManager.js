function createPreviewImageManager ({ canCapture, capture, captureOptions, getTab, now = Date.now, onAvailable, onError }) {
  const images = new Map()
  const inFlight = new Map()
  // Invalidation belongs to a request, not a permanent entry for every tab ID
  // ever seen. Weak keys also allow cleared, settled requests to be collected.
  const invalidated = new WeakSet()
  const maximumAge = 30000
  const maximumImages = 3

  function get (tabId) {
    const tab = getTab(tabId)
    const image = images.get(tabId)
    if (!tab || tab.private || !image || now() - image.timestamp >= maximumAge) {
      images.delete(tabId)
      return null
    }
    return image.dataURL
  }

  function capturePreview (tabId) {
    const tab = getTab(tabId)
    if (!tab || tab.private || !canCapture(tabId)) return Promise.resolve(null)
    if (inFlight.has(tabId)) return inFlight.get(tabId)

    let resolveCapture
    let rejectCapture
    const result = new Promise(function (resolve, reject) {
      resolveCapture = resolve
      rejectCapture = reject
    })
    const promise = result.then(function (dataURL) {
      const currentTab = getTab(tabId)
      if (!dataURL || !currentTab || currentTab.private || invalidated.has(promise)) return null
      if (images.has(tabId)) images.delete(tabId)
      images.set(tabId, { dataURL, timestamp: now() })
      while (images.size > maximumImages) images.delete(images.keys().next().value)
      onAvailable(tabId, dataURL)
      return dataURL
    }).catch(function (error) {
      onError(error)
      return null
    }).finally(function () {
      if (inFlight.get(tabId) === promise) inFlight.delete(tabId)
    })
    // Register before dispatch, which can throw or synchronously invalidate the
    // tab. Reentrant callers must see the same request, not start another one.
    inFlight.set(tabId, promise)
    try {
      resolveCapture(capture(tabId, captureOptions(tabId)))
    } catch (error) {
      rejectCapture(error)
    }
    return promise
  }

  function invalidate (tabId) {
    const pending = inFlight.get(tabId)
    if (pending) invalidated.add(pending)
    images.delete(tabId)
  }

  function clear (tabId) {
    invalidate(tabId)
    inFlight.delete(tabId)
  }

  return {
    capture: capturePreview,
    clear,
    get,
    invalidate
  }
}

module.exports = createPreviewImageManager
