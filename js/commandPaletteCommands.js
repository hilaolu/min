/**
 * Command palette commands module
 * Defines available vim-like commands for the command palette
 */

const availableCommands = [
  {
    id: 'w',
    title: 'Close Tab',
    description: 'Close the current tab',
    shortcut: 'Ctrl+W',
    icon: 'carbon:close',
    action: () => {
      var browserUI = require('browserUI.js')
      browserUI.closeTab(tabs.getSelected())
    }
  },
  {
    id: 'r',
    title: 'Reload Tab',
    description: 'Reload the current tab',
    shortcut: 'F5',
    icon: 'carbon:renew',
    action: () => {
      var webviews = require('webviews.js')
      webviews.callAsync(tabs.getSelected(), 'reload')
    }
  },
  {
    id: 'new-tab',
    title: 'New Tab',
    description: 'Open a new tab',
    shortcut: 'Ctrl+T',
    icon: 'carbon:new-tab',
    action: () => {
      var browserUI = require('browserUI.js')
      browserUI.addTab()
    }
  },
  {
    id: 'new-window',
    title: 'New Window',
    description: 'Open a new window',
    shortcut: 'Ctrl+Shift+N',
    icon: 'carbon:new-window',
    action: () => {
      var browserUI = require('browserUI.js')
      browserUI.addWindow()
    }
  },
  {
    id: 'bookmarks',
    title: 'Show Bookmarks',
    description: 'Open the bookmarks manager',
    shortcut: 'Ctrl+Shift+B',
    icon: 'carbon:bookmark',
    action: () => {
      var searchbar = require('searchbar/searchbar.js')
      searchbar.showResults('!bookmarks')
    }
  },
  {
    id: 'history',
    title: 'Show History',
    description: 'Open the browsing history',
    shortcut: 'Ctrl+Shift+H',
    icon: 'carbon:time',
    action: () => {
      var searchbar = require('searchbar/searchbar.js')
      searchbar.showResults('!history')
    }
  },
  {
    id: 'settings',
    title: 'Settings',
    description: 'Open browser settings',
    shortcut: 'Ctrl+,',
    icon: 'carbon:settings',
    action: () => {
      var searchbar = require('searchbar/searchbar.js')
      searchbar.showResults('!settings')
    }
  },
  {
    id: 'find',
    title: 'Find in Page',
    description: 'Search for text on the current page',
    shortcut: 'Ctrl+F',
    icon: 'carbon:search',
    action: () => {
      var findinpage = require('findinpage.js')
      findinpage.start()
    }
  },
  {
    id: 'o',
    title: 'Open URL',
    description: 'Open a URL in a new tab',
    shortcut: '>o <url>',
    icon: 'carbon:launch',
    action: (url) => {
      if (url) {
        var urlParser = require('util/urlParser.js')
        var parsedUrl = urlParser.parse(url)
        var searchbar = require('searchbar/searchbar.js')
        searchbar.events.emit('url-selected', { url: parsedUrl, background: true, openInForeground: true })
        var webviews = require('webviews.js')
        webviews.focus()
      }
    }
  },
  {
    id: 'goo',
    title: 'Google Search',
    description: 'Search Google for the given string',
    shortcut: '>goo <query>',
    icon: 'carbon:search',
    action: (query) => {
      // Extract query from command palette input if not provided directly
      let searchQuery = query
      if (!searchQuery) {
        var commandPalette = require('commandPalette.js')
        const inputValue = commandPalette.input.value.trim()
        if (inputValue.startsWith('>goo ')) {
          searchQuery = inputValue.substring(5).trim()
        }
      }
      
      if (searchQuery) {
        var searchbar = require('searchbar/searchbar.js')
        var webviews = require('webviews.js')
        const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(searchQuery)}`
        searchbar.events.emit('url-selected', { url: searchUrl, background: true, openInForeground: true })
        webviews.focus()
      }
    }
  }
]

module.exports = availableCommands 