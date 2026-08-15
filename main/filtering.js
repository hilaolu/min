const parser = require('../ext/abp-filter-parser-modified/abp-filter-parser.js')

function createFilteringPolicy ({
  app,
  cancelInterval = clearInterval,
  clock = () => performance.now(),
  fs,
  observePerformance = false,
  path,
  rootDir,
  scheduleInterval = setInterval,
  settings,
  webContents
}) {
  var enabledFilteringOptions = {
    blockingLevel: 0,
    contentTypes: [], // script, image
    exceptionDomains: []
  }

  const globalParamsToRemove = [
  // microsoft
    'msclkid',
    // google
    'gclid',
    'dclid',
    // facebook
    'fbclid',
    // yandex
    'yclid',
    '_openstat',
    // adobe
    'icid',
    // instagram
    'igshid',
    // mailchimp
    'mc_eid'
  ]
  const siteParamsToRemove = {
    'www.amazon.com': [
      '_ref',
      'ref_',
      'pd_rd_r',
      'pd_rd_w',
      'pf_rd_i',
      'pf_rd_m',
      'pf_rd_p',
      'pf_rd_r',
      'pf_rd_s',
      'pf_rd_t',
      'pd_rd_wg'
    ],
    'www.ebay.com': [
      '_trkparms'
    ]
  }

  // for tracking the number of blocked requests
  var unsavedBlockedRequests = 0

  const blockedRequestTimer = scheduleInterval(function () {
    if (unsavedBlockedRequests > 0) {
      var current = settings.get('filteringBlockedCount')
      settings.set('filteringBlockedCount', current + unsavedBlockedRequests)
      unsavedBlockedRequests = 0
    }
  }, 60000)
  if (blockedRequestTimer?.unref) blockedRequestTimer.unref()

  // electron uses different names for resource types than ABP
  // electron: https://github.com/electron/electron/blob/34c4c8d5088fa183f56baea28809de6f2a427e02/shell/browser/net/atom_network_delegate.cc#L30
  // abp: https://adblockplus.org/filter-cheatsheet#filter-options
  var electronABPElementTypeMap = {
    mainFrame: 'document',
    subFrame: 'subdocument',
    stylesheet: 'stylesheet',
    script: 'script',
    image: 'image',
    object: 'object',
    xhr: 'xmlhttprequest',
    other: 'other' // ?
  }

  var parsedFilterData = {}
  var filterListGeneration = 0
  var filterListReady = Promise.resolve()
  const performanceMetrics = {
    filterChecks: 0,
    filterListLoadCount: 0,
    filterListReadyMs: 0,
    filterMatches: 0,
    maximumRequestMs: 0,
    requestCount: 0,
    totalRequestMs: 0,
    trackingParamAttempts: 0,
    trackingParamFastPaths: 0,
    trackingParamParses: 0,
    trackingRedirects: 0
  }

  function readFilterFile (filePath) {
    return new Promise(function (resolve) {
      fs.readFile(filePath, 'utf8', function (error, data) {
        resolve(error ? '' : data || '')
      })
    })
  }

  function initFilterList () {
    const generation = ++filterListGeneration
    const loadStarted = observePerformance ? clock() : 0
    const nextFilterData = {}
    if (observePerformance) performanceMetrics.filterListLoadCount++

    filterListReady = Promise.all([
      readFilterFile(path.join(rootDir, 'ext/filterLists/easylist+easyprivacy-noelementhiding.txt')),
      readFilterFile(path.join(rootDir, 'ext/filterLists/minFilters.txt')),
      readFilterFile(path.join(app.getPath('userData'), 'customFilters.txt'))
    ]).then(function (filterLists) {
      return new Promise(function (resolve) {
        parser.parse(filterLists.join('\n'), nextFilterData, function () {
          if (generation === filterListGeneration) parsedFilterData = nextFilterData
          if (observePerformance && generation === filterListGeneration) {
            performanceMetrics.filterListReadyMs = clock() - loadStarted
          }
          resolve()
        })
      })
    })

    return filterListReady
  }

  function removeWWW (domain) {
    return domain.replace(/^www\./i, '')
  }

  function requestIsThirdParty (baseDomain, requestURL) {
    baseDomain = removeWWW(baseDomain)
    var requestDomain = removeWWW(parser.getUrlHost(requestURL))

    return !(parser.isSameOriginHost(baseDomain, requestDomain) || parser.isSameOriginHost(requestDomain, baseDomain))
  }

  function requestDomainIsException (domain) {
    return enabledFilteringOptions.exceptionDomains.includes(removeWWW(domain))
  }

  function filterPopups (url) {
    if (!/^https?:\/\//i.test(url)) {
      return true
    }

    const domain = parser.getUrlHost(url)
    if (enabledFilteringOptions.blockingLevel > 0 && !requestDomainIsException(domain)) {
      if (
        enabledFilteringOptions.blockingLevel === 2 ||
      (enabledFilteringOptions.blockingLevel === 1 && requestIsThirdParty(domain, url))
      ) {
        if (parser.matches(parsedFilterData, url, { domain: domain, elementType: 'popup' })) {
          unsavedBlockedRequests++
          return false
        }
      }
    }

    return true
  }

  function removeTrackingParams (url) {
    if (observePerformance) performanceMetrics.trackingParamAttempts++
    if (url.indexOf('?') === -1) {
      if (observePerformance) performanceMetrics.trackingParamFastPaths++
      return url
    }
    if (observePerformance) performanceMetrics.trackingParamParses++
    try {
      var urlObj = new URL(url)
      for (const param of urlObj.searchParams) {
        if (globalParamsToRemove.includes(param[0]) ||
        (siteParamsToRemove[urlObj.hostname] &&
          siteParamsToRemove[urlObj.hostname].includes(param[0]))) {
          urlObj.searchParams.delete(param[0])
        }
      }
      return urlObj.toString()
    } catch (e) {
      console.warn(e)
      return url
    }
  }

  function handleRequest (details, callback) {
  /* eslint-disable standard/no-callback-literal */
    const requestStarted = observePerformance ? clock() : 0
    if (observePerformance) performanceMetrics.requestCount++

    function respond (result) {
      if (observePerformance) {
        const elapsed = clock() - requestStarted
        performanceMetrics.totalRequestMs += elapsed
        performanceMetrics.maximumRequestMs = Math.max(performanceMetrics.maximumRequestMs, elapsed)
      }
      callback(result)
    }

    // webContentsId may not exist if this request is a mainFrame or subframe
    let domain
    if (details.webContentsId) {
      domain = parser.getUrlHost(webContents.fromId(details.webContentsId).getURL())
    }

    const isExceptionDomain = domain && requestDomainIsException(domain)

    const modifiedURL = (enabledFilteringOptions.blockingLevel > 0 && !isExceptionDomain) ? removeTrackingParams(details.url) : details.url

    if (!(details.url.startsWith('http://') || details.url.startsWith('https://')) || details.resourceType === 'mainFrame') {
      if (observePerformance && modifiedURL !== details.url) performanceMetrics.trackingRedirects++
      respond({
        cancel: false,
        requestHeaders: details.requestHeaders,
        redirectURL: (modifiedURL !== details.url) ? modifiedURL : undefined
      })
      return
    }

    // block javascript and images if needed

    if (enabledFilteringOptions.contentTypes.length > 0) {
      for (var i = 0; i < enabledFilteringOptions.contentTypes.length; i++) {
        if (details.resourceType === enabledFilteringOptions.contentTypes[i]) {
          respond({
            cancel: true,
            requestHeaders: details.requestHeaders
          })
          return
        }
      }
    }

    if (enabledFilteringOptions.blockingLevel > 0 && !isExceptionDomain) {
      if (
        (enabledFilteringOptions.blockingLevel === 1 && (!domain || requestIsThirdParty(domain, details.url))) ||
      (enabledFilteringOptions.blockingLevel === 2)
      ) {
      // by doing this check second, we can skip checking same-origin requests if only third-party blocking is enabled
        if (observePerformance) performanceMetrics.filterChecks++
        var matchesFilters = parser.matches(parsedFilterData, details.url, {
          domain: domain,
          elementType: electronABPElementTypeMap[details.resourceType]
        })
        if (matchesFilters) {
          unsavedBlockedRequests++
          if (observePerformance) performanceMetrics.filterMatches++

          respond({
            cancel: true,
            requestHeaders: details.requestHeaders
          })
          return
        }
      }
    }

    if (observePerformance && modifiedURL !== details.url) performanceMetrics.trackingRedirects++
    respond({
      cancel: false,
      requestHeaders: details.requestHeaders,
      redirectURL: (modifiedURL !== details.url) ? modifiedURL : undefined
    })
  /* eslint-enable standard/no-callback-literal */
  }

  function setFilteringSettings (settings) {
    if (settings.blockingLevel > 0 && !(enabledFilteringOptions.blockingLevel > 0)) { // we're enabling tracker filtering
      initFilterList()
    }

    enabledFilteringOptions.contentTypes = settings.contentTypes
    enabledFilteringOptions.blockingLevel = settings.blockingLevel
    enabledFilteringOptions.exceptionDomains = settings.exceptionDomains.map(d => removeWWW(d))
  }

  function registerFiltering (ses) {
    ses.webRequest.onBeforeRequest(handleRequest)
  }

  function getPerformanceSnapshot () {
    return {
      ...performanceMetrics,
      filterListReadyMs: Number(performanceMetrics.filterListReadyMs.toFixed(2)),
      maximumRequestMs: Number(performanceMetrics.maximumRequestMs.toFixed(3)),
      totalRequestMs: Number(performanceMetrics.totalRequestMs.toFixed(3))
    }
  }

  function destroy () {
    cancelInterval(blockedRequestTimer)
  }

  settings.listen('filtering', function (value) {
    setFilteringSettings(value)
  })

  return {
    destroy,
    filterPopups,
    getPerformanceSnapshot,
    install: registerFiltering,
    whenReady: () => filterListReady
  }
}

module.exports = createFilteringPolicy
