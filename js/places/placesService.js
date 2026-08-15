/* global db Dexie fullTextPlacesSearch getSearchTextCache searchPlaces tagIndex tokenize */

const { ipcRenderer } = require('electron')
const createPlacesServiceConnection = require('./placesServiceConnection.js')
const { PlacesCache, projectPlace } = require('./placesCache.js')

function calculateHistoryScore (item, boost = 0) {
  let fs = item.lastVisit * (1 + 0.036 * Math.sqrt(item.visitCount))

  // bonus for short url's
  if (item.url.length < 20) {
    fs += (30 - item.url.length) * 2500
  }

  if (boost) {
    fs += fs * boost
  }

  return fs
}

const oneDayInMS = 24 * 60 * 60 * 1000 // one day in milliseconds

// the oldest an item can be to remain in the database
const maxItemAge = oneDayInMS * 42

function cleanupHistoryDatabase () { // removes old history entries
  const expired = db.places.where('lastVisit').below(Date.now() - maxItemAge).and(function (item) {
    return item.isBookmarked === false
  })
  return expired.primaryKeys().then(function (ids) {
    return expired.delete().then(function () {
      placesCache.removeByIds(ids)
      return ids.length
    })
  }).catch(function (error) {
    console.error('failed to clean up Places', error)
  })
}

setTimeout(cleanupHistoryDatabase, 20000) // don't run immediately on startup, since is might slow down searchbar search.
setInterval(cleanupHistoryDatabase, 60 * 60 * 1000)

const placesCache = new PlacesCache({ calculateScore: calculateHistoryScore, getSearchTextCache, tagIndex })
const historyInMemoryCache = placesCache.items
let doneLoadingHistoryCache = false
const activeFullTextRequests = new WeakMap()
const defaultRequestContext = {}

function addToHistoryCache (item, options) {
  return placesCache.add(item, options)
}

function addOrUpdateHistoryCache (item) {
  return placesCache.upsert(item)
}

function removeFromHistoryCache (url) {
  return placesCache.removeByURL(url)
}

function loadHistoryInMemory () {
  placesCache.reset()
  doneLoadingHistoryCache = false

  return db.places.orderBy('visitCount').reverse().each(function (item) {
    addToHistoryCache(item, { sort: false })
  }).then(function () {
    // if we have enough matches during the search, we exit. In order for this to work, frequently visited sites have to come first in the cache.
    placesCache.sort()

    doneLoadingHistoryCache = true
  })
}

const historyReady = loadHistoryInMemory()
historyReady.catch(function (error) {
  console.error('failed to initialize Places', error)
})

const supportedActions = new Set([
  'autocompleteTags',
  'changeTag',
  'deleteAllHistory',
  'deleteHistory',
  'getAllPlaces',
  'getAllTagsRanked',
  'getPlace',
  'getPlaceSuggestions',
  'getSuggestedItemsForTags',
  'getSuggestedTags',
  'importPlaces',
  'searchPlaces',
  'searchPlacesFullText',
  'updatePlace'
])

function requestError (callbackId, code, message) {
  return {
    callbackId,
    error: { code, message },
    ok: false
  }
}

function runInBatches (items, work, index = 0) {
  const batch = items.slice(index, index + 250)
  if (batch.length === 0) return Promise.resolve()
  return Promise.resolve(work(batch)).then(() => runInBatches(items, work, index + batch.length))
}

function changeTag (pageData) {
  return db.places.filter(item => item.tags.includes(pageData.tag)).primaryKeys().then(function (ids) {
    return runInBatches(ids, function (batchIds) {
      return db.transaction('rw', db.places, function () {
        if (pageData.operation === 'delete-bookmarks') return db.places.bulkDelete(batchIds)
        return db.places.where('id').anyOf(batchIds).toArray().then(function (items) {
          items.forEach(function (item) {
            item.tags = item.tags.filter(itemTag => itemTag !== pageData.tag)
            if (pageData.operation === 'rename') {
              const replacement = pageData.replacement.replace(/\s/g, '-')
              if (!item.tags.includes(replacement)) item.tags.push(replacement)
            }
          })
          return db.places.bulkPut(items)
        })
      })
    })
  })
}

function importPlaces (items) {
  return runInBatches(items, function (batch) {
    return db.transaction('rw', db.places, function () {
      return Dexie.Promise.all(batch.map(function (data) {
        return db.places.where('url').equals(data.url).first().then(function (item) {
          if (!item) {
            item = {
              url: data.url,
              title: data.url,
              color: null,
              visitCount: 0,
              lastVisit: Date.now(),
              pageHTML: '',
              extractedText: '',
              searchIndex: [],
              isBookmarked: false,
              tags: [],
              metadata: {}
            }
          }
          Object.assign(item, data)
          item.tags = item.tags.map(tag => tag.replace(/\s/g, '-'))
          return db.places.put(item)
        })
      }))
    })
  })
}

function handleRequest (data, respond, requestContext = defaultRequestContext) {
  const action = data.action
  const pageData = data.pageData
  const flags = data.flags || {}
  const searchText = data.text && data.text.toLowerCase()
  const callbackId = data.callbackId
  const options = data.options

  if (!supportedActions.has(action)) {
    respond(requestError(callbackId, 'UNSUPPORTED_PLACES_ACTION', `Unsupported Places action: ${action}`))
    return
  }

  if (action === 'getPlace') {
    respond({
      result: placesCache.getPublicByURL(pageData.url),
      callbackId: callbackId
    })
  }

  if (action === 'getAllPlaces') {
    respond({
      result: placesCache.getAllPublic(),
      callbackId: callbackId
    })
  }

  if (action === 'updatePlace') {
    let savedItem
    let savedItemIsNew = false
    return db.transaction('rw', db.places, function () {
      return db.places.where('url').equals(pageData.url).first().then(function (item) {
        var isNewItem = false
        if (!item) {
          isNewItem = true
          item = {
            url: pageData.url,
            title: pageData.url,
            color: null,
            visitCount: 0,
            lastVisit: Date.now(),
            pageHTML: '',
            extractedText: '',
            searchIndex: [],
            isBookmarked: false,
            tags: [],
            metadata: {}
          }
        }
        const contentChanged = Object.hasOwn(pageData, 'extractedText') && pageData.extractedText !== item.extractedText
        for (const key in pageData) {
          if (key === 'extractedText') {
            if (contentChanged) {
              item.searchIndex = tokenize(pageData.extractedText)
              item.extractedText = pageData.extractedText
            }
          } else if (key === 'tags') {
          // ensure tags are never saved with spaces in them
            item.tags = pageData.tags.map(t => t.replace(/\s/g, '-'))
          } else {
            item[key] = pageData[key]
          }
        }

        if (flags.isNewVisit) {
          item.visitCount++
          item.lastVisit = Date.now()
        }

        const metadataChanges = {}
        for (const key in pageData) {
          if (key !== 'extractedText') metadataChanges[key] = item[key]
        }
        if (flags.isNewVisit) {
          metadataChanges.visitCount = item.visitCount
          metadataChanges.lastVisit = item.lastVisit
        }
        const persist = isNewItem || contentChanged
          ? db.places.put(item)
          : db.places.update(item.id, metadataChanges)

        return persist.then(function () {
          savedItem = item
          savedItemIsNew = isNewItem
        })
      })
    }).then(function () {
      if (savedItemIsNew) {
        addToHistoryCache(savedItem)
      } else {
        addOrUpdateHistoryCache(savedItem)
      }
      respond({
        result: null,
        callbackId: callbackId
      })
    }).catch(function (error) {
      console.warn('failed to update history.')
      console.warn('page url was: ' + pageData.url)
      console.error(error)
      respond(requestError(callbackId, 'PLACES_PERSISTENCE_FAILED', error.message))
    })
  }

  if (action === 'deleteHistory') {
    return db.places.where('url').equals(pageData.url).delete().then(function () {
      removeFromHistoryCache(pageData.url)
      if (callbackId !== undefined) respond({ result: null, callbackId })
    }).catch(function (error) {
      console.error('failed to delete Places history', error)
      respond(requestError(callbackId, 'PLACES_PERSISTENCE_FAILED', error.message))
    })
  }

  if (action === 'deleteAllHistory') {
    return db.places.filter(function (item) {
      return item.isBookmarked === false
    }).delete().then(function () {
      return loadHistoryInMemory()
    }).then(function () {
      if (callbackId !== undefined) respond({ result: null, callbackId })
    }).catch(function (error) {
      console.error('failed to delete all Places history', error)
      respond(requestError(callbackId, 'PLACES_PERSISTENCE_FAILED', error.message))
    })
  }

  if (action === 'changeTag') {
    return changeTag(pageData).then(loadHistoryInMemory).then(function () {
      respond({ result: null, callbackId })
    }).catch(function (error) {
      respond(requestError(callbackId, 'PLACES_PERSISTENCE_FAILED', error.message))
    })
  }

  if (action === 'importPlaces') {
    return importPlaces(pageData.items).then(loadHistoryInMemory).then(function () {
      respond({ result: null, callbackId })
    }).catch(function (error) {
      respond(requestError(callbackId, 'PLACES_PERSISTENCE_FAILED', error.message))
    })
  }

  if (action === 'getSuggestedTags') {
    respond({
      result: tagIndex.getSuggestedTags(placesCache.getByURL(pageData.url)),
      callbackId: callbackId
    })
  }

  if (action === 'getAllTagsRanked') {
    respond({
      result: tagIndex.getAllTagsRanked(placesCache.getByURL(pageData.url)),
      callbackId: callbackId
    })
  }

  if (action === 'getSuggestedItemsForTags') {
    respond({
      result: tagIndex.getSuggestedItemsForTags(pageData.tags).map(item => projectPlace(item)),
      callbackId: callbackId
    })
  }

  if (action === 'autocompleteTags') {
    respond({
      result: tagIndex.autocompleteTags(pageData.tags),
      callbackId: callbackId
    })
  }

  if (action === 'searchPlaces') { // do a history search
    searchPlaces(searchText, function (matches) {
      respond({
        result: matches.map(item => projectPlace(item)),
        callbackId: callbackId
      })
    }, options)
  }

  if (action === 'searchPlacesFullText') {
    const activeFullTextRequest = activeFullTextRequests.get(requestContext)
    if (activeFullTextRequest) {
      activeFullTextRequest.cancelled = true
      activeFullTextRequest.respond(requestError(
        activeFullTextRequest.callbackId,
        'PLACES_QUERY_SUPERSEDED',
        'Places query was superseded by a newer query'
      ))
    }

    const request = { callbackId, cancelled: false, respond }
    activeFullTextRequests.set(requestContext, request)
    return fullTextPlacesSearch(searchText, function (matches, error) {
      if (request.cancelled) return
      if (activeFullTextRequests.get(requestContext) === request) activeFullTextRequests.delete(requestContext)
      if (error) {
        respond(requestError(callbackId, 'PLACES_FULL_TEXT_SEARCH_FAILED', error.message))
        return
      }
      respond({ result: matches, callbackId })
    }, Object.assign({}, options, { isCancelled: () => request.cancelled }))
  }

  if (action === 'getPlaceSuggestions') {
    const returnSuggestionResults = function () {
      const cTime = Date.now()

      let results = historyInMemoryCache.filter(i => cTime - i.lastVisit < 604800000)

      const excludedURLs = new Set(options?.excludeURLs || [])
      results = results.filter(item => !excludedURLs.has(item.url))

      for (let i = 0; i < results.length; i++) {
        results[i] = { item: results[i], score: calculateHistoryScore(results[i]) }
      }

      results = results.sort(function (a, b) {
        return b.score - a.score
      })

      const suggestionLimit = Number.isFinite(options?.limit) ? Math.max(0, options.limit) : 4

      respond({
        result: results.slice(0, suggestionLimit).map(result => projectPlace(result.item)),
        callbackId: callbackId
      })
    }
    if (historyInMemoryCache.length > 10 || doneLoadingHistoryCache) {
      returnSuggestionResults()
    } else {
      setTimeout(returnSuggestionResults, 100)
    }
  }
}

createPlacesServiceConnection({
  handleRequest,
  ipc: ipcRenderer,
  ready: historyReady
})
