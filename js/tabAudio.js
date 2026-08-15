const browserSession = require('tabState.js')
var webviews = require('webviews.js')
var keybindings = require('keybindings.js')

var tabAudio = {
  muteIcon: 'carbon:volume-mute',
  volumeIcon: 'carbon:volume-up',
  getButton: function (tabId) {
    var button = document.createElement('button')
    button.className = 'tab-icon tab-audio-button i'

    button.setAttribute('data-tab', tabId)
    button.setAttribute('role', 'button')

    button.addEventListener('click', function (e) {
      e.stopPropagation()
      tabAudio.toggleAudio(tabId)
    })

    tabAudio.updateButton(tabId, button)

    return button
  },
  updateButton: function (tabId, button) {
    var audioButton = button || document.querySelector('.tab-audio-button[data-tab="{id}"]'.replace('{id}', tabId))
    var tab = browserSession.tabs.get(tabId)

    var muteIcon = tabAudio.muteIcon
    var volumeIcon = tabAudio.volumeIcon

    if (tab.muted) {
      audioButton.hidden = false
      audioButton.classList.remove(volumeIcon)
      audioButton.classList.add(muteIcon)
    } else if (tab.hasAudio) {
      audioButton.hidden = false
      audioButton.classList.add(volumeIcon)
      audioButton.classList.remove(muteIcon)
    } else {
      audioButton.hidden = true
    }
  },
  toggleAudio: function (tabId) {
    var tab = browserSession.tabs.get(tabId)
    // can be muted if has audio, can be unmuted if muted
    if (tab.hasAudio || tab.muted) {
      webviews.setAudioMuted(tabId, !tab.muted)
      browserSession.updateTab(tabId, { muted: !tab.muted })
    }
  },
  initialize: function () {
    keybindings.defineShortcut('toggleTabAudio', function () {
      tabAudio.toggleAudio(browserSession.tabs.getSelected())
    })

    webviews.bindEvent('media-started', function (tabId) {
      browserSession.updateTab(tabId, { hasAudio: true })
    })
    webviews.bindEvent('media-paused', function (tabId) {
      browserSession.updateTab(tabId, { hasAudio: false })
    })
  }
}

tabAudio.initialize()

module.exports = tabAudio
