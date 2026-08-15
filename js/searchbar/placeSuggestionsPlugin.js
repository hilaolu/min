const browserSession = require('tabState.js')
var searchbarPlugins = require('searchbar/searchbarPlugins.js')
var searchbarUtils = require('searchbar/searchbarUtils.js')
var urlParser = require('util/urlParser.js')

var places = require('places/places.js')

async function showPlaceSuggestions (text, input, inputFlags) {
  // use the current tab's url for history suggestions, or the previous tab if the current tab is empty
  var url = browserSession.tabs.get(browserSession.tabs.getSelected()).url

  if (!url) {
    var previousTab = browserSession.tabs.getAtIndex(browserSession.tabs.getIndex(browserSession.tabs.getSelected()) - 1)
    if (previousTab) {
      url = previousTab.url
    }
  }

  var tabList = browserSession.tabs.get().map(function (tab) {
    return tab.url
  })

  const results = await places.getPlaceSuggestions(url, {
    limit: 4,
    excludeURLs: tabList
  })

  searchbarPlugins.reset('placeSuggestions')

  results.forEach(function (result) {
    searchbarPlugins.addResult('placeSuggestions', {
      title: urlParser.prettyURL(result.url),
      secondaryText: searchbarUtils.getRealTitle(result.title),
      url: result.url,
      delete: function () {
        places.deleteHistory(result.url)
      }
    })
  })
}

function initialize () {
  searchbarPlugins.register('placeSuggestions', {
    index: 1,
    trigger: function (text) {
      return !text
    },
    showResults: showPlaceSuggestions
  })
}

module.exports = { initialize }
