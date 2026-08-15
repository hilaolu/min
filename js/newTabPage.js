/* global Blob */

const rendererHost = require('rendererHost.js')
const statistics = require('js/statistics.js')

const newTabPage = {
  background: document.getElementById('ntp-background'),
  hasBackground: false,
  picker: document.getElementById('ntp-image-picker'),
  deleteBackground: document.getElementById('ntp-image-remove'),
  blobInstance: null,
  reloadBackground: function () {
    return rendererHost.loadNewTabBackground().then(function (data) {
      if (newTabPage.blobInstance) {
        URL.revokeObjectURL(newTabPage.blobInstance)
        newTabPage.blobInstance = null
      }
      if (data === null) {
        newTabPage.background.hidden = true
        newTabPage.hasBackground = false
        document.body.classList.remove('ntp-has-background')
        newTabPage.deleteBackground.hidden = true
      } else {
        const blob = new Blob([data], { type: 'application/octet-binary' })
        const url = URL.createObjectURL(blob)
        newTabPage.blobInstance = url
        newTabPage.background.src = url

        newTabPage.background.hidden = false
        newTabPage.hasBackground = true
        document.body.classList.add('ntp-has-background')
        newTabPage.deleteBackground.hidden = false
      }
    }).catch(function (error) {
      console.warn('failed to load new-tab background', error)
    })
  },
  initialize: function () {
    newTabPage.reloadBackground()

    newTabPage.picker.addEventListener('click', async function () {
      try {
        if (await rendererHost.chooseNewTabBackground()) {
          await newTabPage.reloadBackground()
        }
      } catch (error) {
        console.warn('failed to select new-tab background', error)
      }
    })

    newTabPage.deleteBackground.addEventListener('click', async function () {
      try {
        await rendererHost.removeNewTabBackground()
        await newTabPage.reloadBackground()
      } catch (error) {
        console.warn('failed to remove new-tab background', error)
      }
    })

    statistics.registerGetter('ntpHasBackground', function () {
      return newTabPage.hasBackground
    })
  }
}

module.exports = newTabPage
