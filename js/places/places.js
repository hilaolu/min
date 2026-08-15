const browserSession = require('tabState.js')
const rendererHost = require('rendererHost.js')

var webviews = require('webviews.js')
const searchEngine = require('util/searchEngine.js')
const urlParser = require('util/urlParser.js')
const historyPolicy = require('./historyPolicy.js')

const places = {
  connection: null,
  sendMessage: function (data) {
    return rendererHost.sendPlacesMessage(data).catch(function (error) {
      console.warn('Places update failed:', error)
      return { ok: false, error }
    })
  },
  invokeWithPromise: function (data) {
    return rendererHost.requestPlaces(data)
  },
  savePage: function (tabId, pageData) {
    /* this prevents pages that are immediately left from being saved to history, and also gives the page-favicon-updated event time to fire (so the colors saved to history are correct). */
    setTimeout(function () {
      const tab = browserSession.tabs.get(tabId)
      const currentURL = tab && historyPolicy.getCanonicalURL(tab.url, urlParser)
      if (historyPolicy.matchesCurrentNavigation(tab, pageData, webviews.navigationGenerations[tabId], urlParser)) {
        const data = {
          url: currentURL, // for PDF viewer and reader mode, save the original page URL and not the viewer URL
          title: tab.title,
          color: tab.backgroundColor,
          extractedText: pageData.extractedText
        }

        places.sendMessage({
          action: 'updatePlace',
          pageData: data,
          flags: {
            isNewVisit: true
          }
        })
      }
    }, 500)
  },
  receiveHistoryData: function (tabId, args) {
    // called when js/preload/textExtractor.js returns the page's text content

    var tab = browserSession.tabs.get(tabId)
    var data = args[0]

    if (!historyPolicy.matchesCurrentNavigation(tab, data, webviews.navigationGenerations[tabId], urlParser)) {
      return
    }

    if (tab.url.startsWith('data:') || tab.url.length > 5000) {
      /*
      very large URLs cause performance issues. In particular:
      * they can cause the database to grow abnormally large, which increases memory usage and startup time
      * they can cause the browser to hang when they are displayed in search results
      To avoid this, don't save them to history
      */
      return
    }

    /* if the page is an internal page, it normally shouldn't be saved,
     unless the page represents another page (such as the PDF viewer or reader view) */
    var isNonIndexableInternalPage = urlParser.isInternalURL(tab.url) && urlParser.getSourceURL(tab.url) === tab.url
    var isSearchPage = !!(searchEngine.getSearch(tab.url))

    // full-text data from search results isn't useful
    if (isSearchPage) {
      data.extractedText = ''
    }

    // don't save to history if in private mode, or the page is a browser page (unless it contains the content of a normal page)
    if (tab.private === false && !isNonIndexableInternalPage) {
      places.savePage(tabId, data)
    }
  },
  deleteHistory: function (url) {
    places.sendMessage({
      action: 'deleteHistory',
      pageData: {
        url: url
      }
    })
  },
  deleteAllHistory: function () {
    places.sendMessage({
      action: 'deleteAllHistory'
    })
  },
  searchPlaces: function (text, options) {
    return places.invokeWithPromise({
      action: 'searchPlaces',
      text: text,
      options: options
    })
  },
  searchPlacesFullText: function (text, options) {
    return places.invokeWithPromise({
      action: 'searchPlacesFullText',
      text: text,
      options: options
    }).catch(function (error) {
      if (error.code === 'PLACES_QUERY_SUPERSEDED') return []
      throw error
    })
  },
  getPlaceSuggestions: function (url, options) {
    return places.invokeWithPromise({
      action: 'getPlaceSuggestions',
      text: url,
      options: options
    })
  },
  getItem: function (url) {
    return places.invokeWithPromise({
      action: 'getPlace',
      pageData: {
        url: url
      }
    })
  },
  getAllItems: function () {
    return places.invokeWithPromise({
      action: 'getAllPlaces'
    })
  },
  changeTag: function (tag, operation, replacement) {
    return places.invokeWithPromise({
      action: 'changeTag',
      pageData: { tag, operation, replacement }
    })
  },
  importItems: function (items) {
    return places.invokeWithPromise({
      action: 'importPlaces',
      pageData: { items }
    })
  },
  updateItem: function (url, fields) {
    return places.invokeWithPromise({
      action: 'updatePlace',
      pageData: {
        url: url,
        ...fields
      }
    })
  },
  toggleTag: function (url, tag) {
    return places.getItem(url)
      .then(function (item) {
        if (!item) {
          return
        }
        if (item.tags.includes(tag)) {
          item.tags = item.tags.filter(t => t !== tag)
        } else {
          item.tags.push(tag)
        }
        places.sendMessage({
          action: 'updatePlace',
          pageData: {
            url: url,
            tags: item.tags
          }
        })
      })
  },
  getSuggestedTags: function (url) {
    return places.invokeWithPromise({
      action: 'getSuggestedTags',
      pageData: {
        url: url
      }
    })
  },
  getAllTagsRanked: function (url) {
    return places.invokeWithPromise({
      action: 'getAllTagsRanked',
      pageData: {
        url: url
      }
    })
  },
  getSuggestedItemsForTags: function (tags) {
    return places.invokeWithPromise({
      action: 'getSuggestedItemsForTags',
      pageData: {
        tags: tags
      }
    })
  },
  autocompleteTags: function (tags) {
    return places.invokeWithPromise({
      action: 'autocompleteTags',
      pageData: {
        tags: tags
      }
    })
  },
  initialize: function () {
    places.connection = rendererHost.connectPlaces().catch(function (error) {
      console.warn('Places connection failed:', error)
      return { ok: false, error }
    })

    webviews.bindIPC('pageData', places.receiveHistoryData)
  }
}

places.initialize()
module.exports = places
