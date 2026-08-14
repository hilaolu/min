const browserSession = require('tabState.js')
var searchbarPlugins = require('searchbar/searchbarPlugins.js')
var searchbarUtils = require('searchbar/searchbarUtils.js')

var browserUI = require('browserUI.js')

function getFormattedTitle (tab) {
  if (tab.title) {
    var title = searchbarUtils.getRealTitle(tab.title)
    return '"' + (title.length > 45 ? title.substring(0, 45).trim() + '...' : title) + '"'
  } else {
    return 'New Tab'
  }
}

function showRestoreTask () {
  searchbarPlugins.reset('restoreTask')

  var lastTask = browserSession.tasks.slice().sort((a, b) => {
    return browserSession.tasks.getLastActivity(b.id) - browserSession.tasks.getLastActivity(a.id)
  })[1]
  var recentTabs = lastTask.tabs.get().sort((a, b) => b.lastActivity - a.lastActivity).slice(0, 3)

  var taskDescription
  if (recentTabs.length === 1) {
    taskDescription = getFormattedTitle(recentTabs[0])
  } else if (recentTabs.length === 2) {
    taskDescription = `${getFormattedTitle(recentTabs[0])} and ${getFormattedTitle(recentTabs[1])}`
  } else {
    taskDescription = `${getFormattedTitle(recentTabs[0])}, ${getFormattedTitle(recentTabs[1])}, and ${lastTask.tabs.count() - 2} more`
  }

  searchbarPlugins.addResult('restoreTask', {
    title: 'Return to your previous task',
    descriptionBlock: taskDescription,
    icon: 'carbon:redo',
    click: function (e) {
      var thisTask = browserSession.tasks.getSelected().id
      browserUI.switchToTask(lastTask.id)
      browserUI.closeTask(thisTask)
    }
  })
}

function initialize () {
  searchbarPlugins.register('restoreTask', {
    index: 0,
    trigger: function (text) {
      return !text && performance.now() < 15000 && browserSession.tasks.getSelected().tabs.isEmpty() && window.createdNewTaskOnStartup
    },
    showResults: showRestoreTask
  })
}

module.exports = { initialize }
