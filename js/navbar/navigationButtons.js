const browserSession = require('tabState.js')
const webviews = require('webviews.js')

var navigationButtons = {
  tabsList: document.getElementById('tabs-inner'),
  container: document.getElementById('toolbar-navigation-buttons'),
  backButton: document.getElementById('back-button'),
  forwardButton: document.getElementById('forward-button'),
  update: function () {
    if (!browserSession.tabs.get(browserSession.tabs.getSelected()).url) {
      navigationButtons.backButton.disabled = true
      navigationButtons.forwardButton.disabled = true
      return
    }
    webviews.callAsync(browserSession.tabs.getSelected(), 'canGoBack', function (err, canGoBack) {
      if (err) {
        return
      }
      navigationButtons.backButton.disabled = !canGoBack
    })
    webviews.callAsync(browserSession.tabs.getSelected(), 'canGoForward', function (err, canGoForward) {
      if (err) {
        return
      }
      navigationButtons.forwardButton.disabled = !canGoForward
      if (canGoForward) {
        navigationButtons.container.classList.add('can-go-forward')
      } else {
        navigationButtons.container.classList.remove('can-go-forward')
      }
    })
  },
  initialize: function () {
    navigationButtons.container.hidden = false

    navigationButtons.backButton.addEventListener('click', function (e) {
      webviews.goBackIgnoringRedirects(browserSession.tabs.getSelected())
    })

    navigationButtons.forwardButton.addEventListener('click', function () {
      webviews.callAsync(browserSession.tabs.getSelected(), 'goForward')
    })

    navigationButtons.container.addEventListener('mouseenter', function () {
      /*
      Prevent scrollbars from showing up when hovering the navigation buttons, if one isn't already shown
      This also works around a chromium bug where a flickering scrollbar is shown during the expanding animation:
      https://github.com/minbrowser/min/pull/1665#issuecomment-868551126
      */
      if (navigationButtons.tabsList.scrollWidth <= navigationButtons.tabsList.clientWidth) {
        navigationButtons.tabsList.classList.add('disable-scroll')
      }
    })

    navigationButtons.container.addEventListener('mouseleave', function () {
      navigationButtons.tabsList.classList.remove('disable-scroll')
    })

    browserSession.tasks.on('tab-selected', this.update)
    webviews.bindEvent('did-navigate', this.update)
    webviews.bindEvent('did-navigate-in-page', this.update)
  }
}

module.exports = navigationButtons
