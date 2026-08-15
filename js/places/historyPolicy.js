function getCanonicalURL (url, urlParser) {
  if (typeof url !== 'string') return null
  return urlParser.removeTextFragment(urlParser.getSourceURL(url))
}

function canExtractHistory (tab, url, urlParser) {
  if (!tab || tab.private || typeof url !== 'string') return false
  if (url.startsWith('data:') || url.length > 5000) return false
  return !(urlParser.isInternalURL(url) && urlParser.getSourceURL(url) === url)
}

function matchesCurrentNavigation (tab, pageData, navigationGeneration, urlParser) {
  if (!tab || !pageData || pageData.navigationGeneration !== navigationGeneration) return false
  return getCanonicalURL(tab.url, urlParser) === getCanonicalURL(pageData.sourceURL, urlParser)
}

module.exports = { canExtractHistory, getCanonicalURL, matchesCurrentNavigation }
