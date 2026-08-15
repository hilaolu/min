const browserSession = require('tabState.js')
/* implements userscript support */

var webviews = require('webviews.js')
const rendererHost = require('rendererHost.js')
var settings = require('util/settings/settings.js')
var bangsPlugin = require('searchbar/bangsPlugin.js')
var tabEditor = require('navbar/tabEditor.js')
var searchbarPlugins = require('searchbar/searchbarPlugins.js')
var urlParser = require('util/urlParser.js')

var statistics = require('js/statistics.js')

function parseTampermonkeyFeatures (content) {
  var parsedFeatures = {}
  var foundFeatures = false

  var lines = content.split('\n')

  var isInFeatures = false
  for (var i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '// ==UserScript==') {
      isInFeatures = true
      continue
    }
    if (lines[i].trim() === '// ==/UserScript==') {
      isInFeatures = false
      break
    }
    if (isInFeatures && lines[i].startsWith('//')) {
      foundFeatures = true
      var feature = lines[i].replace('//', '').trim()
      var featureName = feature.split(' ')[0]
      var featureValue = feature.replace(featureName + ' ', '').trim()
      featureName = featureName.replace('@', '')

      if (parsedFeatures[featureName]) {
        parsedFeatures[featureName].push(featureValue)
      } else {
        parsedFeatures[featureName] = [featureValue]
      }
    }
  }
  if (foundFeatures) {
    return parsedFeatures
  } else {
    return null
  }
}

// checks if a URL matches a wildcard pattern
function urlMatchesPattern (url, pattern) {
  var idx = -1
  var parts = pattern.split('*')
  for (var i = 0; i < parts.length; i++) {
    idx = url.indexOf(parts[i], idx)
    if (idx === -1) {
      return false
    }
    idx += parts[i].length
  }
  return idx !== -1
}

const userscripts = {
  scripts: [], // {options: {}, content}
  loadSequence: 0,
  showDirectory: function () {
    rendererHost.openUserScriptsDirectory().catch(function (error) {
      console.warn('failed to open userscript directory', error)
    })
  },
  loadScripts: function () {
    const sequence = ++userscripts.loadSequence
    return rendererHost.loadUserScripts().then(function (files) {
      if (sequence !== userscripts.loadSequence || settings.get('userscriptsEnabled') !== true) return
      const loadedScripts = []

      files.forEach(function ({ content: file, filename }) {
        if (!file) return
        var domain = filename.slice(0, -3)
        if (domain.startsWith('www.')) {
          domain = domain.slice(4)
        }
        if (!domain) return

        var tampermonkeyFeatures = parseTampermonkeyFeatures(file)
        if (tampermonkeyFeatures) {
          var scriptName = tampermonkeyFeatures.name
          if (scriptName) {
            scriptName = scriptName[0]
          } else {
            scriptName = filename
          }
          loadedScripts.push({ options: tampermonkeyFeatures, content: file, name: scriptName })
        } else if (domain === 'global') {
          loadedScripts.push({
            options: { match: ['*'] },
            content: file,
            name: filename
          })
        } else {
          loadedScripts.push({
            options: { match: ['*://' + domain] },
            content: file,
            name: filename
          })
        }
      })
      userscripts.scripts = loadedScripts
    }).catch(function (error) {
      console.warn('failed to load userscripts', error)
    })
  },
  getMatchingScripts: function (src) {
    return userscripts.scripts.filter(function (script) {
      if (
        (!script.options.match && !script.options.include) ||
        (script.options.match && script.options.match.some(pattern => urlMatchesPattern(src, pattern))) ||
        (script.options.include && script.options.include.some(pattern => urlMatchesPattern(src, pattern)))) {
        if (!script.options.exclude || !script.options.exclude.some(pattern => urlMatchesPattern(src, pattern))) {
          return true
        }
      }
    })
  },
  runScript: function (tabId, script) {
    if (urlParser.isInternalURL(browserSession.tabs.get(tabId).url)) {
      return
    }
    webviews.runUserScript(tabId, script.content)
  },
  onPageLoad: function (tabId) {
    if (userscripts.scripts.length === 0) {
      return
    }

    var src = browserSession.tabs.get(tabId).url

    userscripts.getMatchingScripts(src).forEach(function (script) {
      // TODO run different types of scripts at the correct time
      if (!script.options['run-at'] || script.options['run-at'].some(i => ['document-start', 'document-body', 'document-end', 'document-idle'].includes(i))) {
        userscripts.runScript(tabId, script)
      }
    })
  },
  initialize: function () {
    statistics.registerGetter('userscriptCount', function () {
      return userscripts.scripts.length
    })

    settings.listen('userscriptsEnabled', function (value) {
      if (value === true) {
        userscripts.loadScripts()
      } else {
        userscripts.loadSequence++
        userscripts.scripts = []
      }
      rendererHost.setUserScriptsWatching(value === true).catch(function (error) {
        console.warn('failed to update userscript watching', error)
      })
    })
    rendererHost.onUserScriptsChanged(function () {
      if (settings.get('userscriptsEnabled') === true) userscripts.loadScripts()
    })
    webviews.bindEvent('document-ready', userscripts.onPageLoad)

    webviews.bindIPC('showUserscriptDirectory', function () {
      userscripts.showDirectory()
    })

    bangsPlugin.registerCustomBang({
      phrase: '!run',
      snippet: 'Run userscript',
      isAction: false,
      showSuggestions: function (text, input, event) {
        searchbarPlugins.reset('bangs')

        var isFirst = true
        userscripts.scripts.forEach(function (script) {
          if (script.name.toLowerCase().startsWith(text.toLowerCase())) {
            searchbarPlugins.addResult('bangs', {
              title: script.name,
              fakeFocus: isFirst && text,
              click: function () {
                tabEditor.hide()
                userscripts.runScript(browserSession.tabs.getSelected(), script)
              }
            })
            isFirst = false
          }
        })
      },
      fn: function (text) {
        if (!text) {
          return
        }
        var matchingScript = userscripts.scripts.find(script => script.name.toLowerCase().startsWith(text.toLowerCase()))
        if (matchingScript) {
          userscripts.runScript(browserSession.tabs.getSelected(), matchingScript)
        }
      }
    })
  }
}

module.exports = userscripts
