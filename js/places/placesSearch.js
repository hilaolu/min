/* global calculateHistoryScore historyInMemoryCache oneDayInMS quickScore */

const searchSeparatorRegex = /[+\s._/-]+/g

function searchFormatTitle (text) {
  return text.toLowerCase().replace(searchSeparatorRegex, ' ').normalize('NFD').replace(/[\u0300-\u036f]/g, '') // remove diacritics
}

function searchFormatURL (text) {
  // the order of these transformations is important - for example, searchSeparatorRegex removes / characters, so protocols must be removed before it runs
  return text.toLowerCase().split('?')[0].replace('http://', '').replace('https://', '').replace('www.', '').replace(searchSeparatorRegex, ' ')
    // Remove diacritics
    // URLs don't normally contrain diacritics, but this processing is also applied to the user-typed text, so it needs to match the transformations
    // Applied by searchFormatTitle
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .trim()
}

function getSearchTextCache (item) {
  return {
    title: searchFormatTitle(item.title),
    url: searchFormatURL(item.url)
  }
}

function searchPlaces (searchText, callback, options) {
  function processSearchItem (item) {
    if (limitToBookmarks && !item.isBookmarked) {
      return
    }
    let itext = item.searchTextCache.url

    if (item.url !== item.title) {
      itext += ' ' + item.searchTextCache.title
    }

    if (item.tags) {
      itext += ' ' + item.tags.join(' ')
    }

    const tindex = itext.indexOf(st)

    // if the url contains the search string, count as a match
    // prioritize matches near the beginning of the url
    if (tindex === 0) {
      matches.push({ item, boost: itemStartBoost })
    } else if (tindex !== -1) {
      matches.push({ item, boost: exactMatchBoost })
    } else {
      // if all of the search words (split by spaces, etc) exist in the url, count it as a match, even if they are out of order

      if (substringSearchEnabled) {
        let substringMatch = true

        // check if the search text matches but is out of order
        for (let i = 0; i < swl; i++) {
          if (itext.indexOf(searchWords[i]) === -1) {
            substringMatch = false
            break
          }
        }

        if (substringMatch) {
          matches.push({ item, boost: 0.125 * swl + (0.02 * stl) })
          return
        }
      }

      if ((item.visitCount > 2 && item.lastVisit > oneWeekAgo) || item.lastVisit > oneDayAgo) {
        const score = Math.max(quickScore.quickScore(item.searchTextCache.url.substring(0, 100), st), quickScore.quickScore(item.searchTextCache.title.substring(0, 50), st))
        if (score > 0.3) {
          matches.push({ item, boost: score * 0.33 })
        }
      }
    }
  }

  const oneDayAgo = Date.now() - (oneDayInMS)
  const oneWeekAgo = Date.now() - (oneDayInMS * 7)

  const matches = []
  const st = searchFormatURL(searchText)
  const stl = searchText.length
  const searchWords = st.split(' ')
  const swl = searchWords.length
  let substringSearchEnabled = false
  const itemStartBoost = Math.min(2.5 * stl, 10)
  const exactMatchBoost = 0.4 + (0.075 * stl)
  const limitToBookmarks = options && options.searchBookmarks
  const requestedLimit = options && options.limit
  const resultsLimit = Number.isFinite(requestedLimit) && requestedLimit >= 0
    ? requestedLimit
    : 100

  if (searchText.indexOf(' ') !== -1) {
    substringSearchEnabled = true
  }

  for (let i = 0; i < historyInMemoryCache.length; i++) {
    processSearchItem(historyInMemoryCache[i])
  }

  matches.sort(function (a, b) {
    return calculateHistoryScore(b.item, b.boost) - calculateHistoryScore(a.item, a.boost)
  })

  callback(matches.slice(0, resultsLimit).map(match => match.item))
}

if (typeof window !== 'undefined') {
  window.getSearchTextCache = getSearchTextCache
  window.searchPlaces = searchPlaces
}

if (typeof module !== 'undefined') {
  module.exports = { getSearchTextCache, searchPlaces }
}
