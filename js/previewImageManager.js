function createPreviewImageManager ({ canCapture, capture, captureOptions, getTab, now = Date.now, onAvailable, onError }) {
  const images = new Map()
  const inFlight = new Map()
  const versions = new Map()
  const maximumAge = 30000
  const maximumImages = 3

  function getVersion (tabId) {
    return versions.get(tabId) || 0
  }

  function get (tabId) {
    const tab = getTab(tabId)
    const image = images.get(tabId)
    if (!tab || tab.private || !image || now() - image.timestamp >= maximumAge) return null
    return image.dataURL
  }

  function capturePreview (tabId) {
    const tab = getTab(tabId)
    if (!tab || tab.private || !canCapture(tabId)) return Promise.resolve(null)
    if (inFlight.has(tabId)) return inFlight.get(tabId)

    const requestedVersion = getVersion(tabId)
    const promise = Promise.resolve(capture(tabId, captureOptions(tabId))).then(function (dataURL) {
      if (!dataURL || !getTab(tabId) || requestedVersion !== getVersion(tabId)) return null
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
    inFlight.set(tabId, promise)
    return promise
  }

  function invalidate (tabId) {
    versions.set(tabId, getVersion(tabId) + 1)
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
    invalidate,
    isCapturePending: tabId => inFlight.has(tabId)
  }
}

module.exports = createPreviewImageManager
