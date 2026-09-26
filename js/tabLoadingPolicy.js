// Only defer content that has never started loading; selection owns its creation.
function shouldDeferBackgroundTab (tab, options = {}, enabled = false) {
  if (enabled !== true || options.openInBackground !== true ||
      options.existingViewId != null || tab.private ||
      typeof tab.url !== 'string' || !/^https?:\/\//i.test(tab.url)) {
    return false
  }

  try {
    const url = new URL(tab.url)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch (error) {
    return false
  }
}

module.exports = shouldDeferBackgroundTab
