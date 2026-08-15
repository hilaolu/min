var settings = require('util/settings/settings.js')
const rendererHost = require('rendererHost.js')
const runtimeConfiguration = rendererHost.getRuntimeConfiguration()

function initialize () {
  if (settings.get('useSeparateTitlebar') === true) {
    document.body.classList.add('separate-titlebar')
  }

  var windowIsMaximized = false
  var windowIsFullscreen = false

  var captionMinimize =
  document.querySelector('.windows-caption-buttons .caption-minimise, body.linux .titlebar-linux .caption-minimise')

  var captionMaximize =
  document.querySelector('.windows-caption-buttons .caption-maximize, body.linux .titlebar-linux .caption-maximize')

  var captionRestore =
  document.querySelector('.windows-caption-buttons .caption-restore, body.linux .titlebar-linux .caption-restore')

  var captionClose =
  document.querySelector('.windows-caption-buttons .caption-close, body.linux .titlebar-linux .caption-close')

  var linuxClose = document.querySelector('#linux-control-buttons #close-button')
  var linuxMinimize = document.querySelector('#linux-control-buttons #minimize-button')
  var linuxMaximize = document.querySelector('#linux-control-buttons #maximize-button')

  function updateCaptionButtons () {
    if (runtimeConfiguration.platform === 'win32') {
      if (windowIsMaximized || windowIsFullscreen) {
        captionMaximize.hidden = true
        captionRestore.hidden = false
      } else {
        captionMaximize.hidden = false
        captionRestore.hidden = true
      }
    }
  }

  if (runtimeConfiguration.platform === 'win32') {
    updateCaptionButtons()

    captionMinimize.addEventListener('click', function (e) {
      rendererHost.minimizeWindow()
    })

    captionMaximize.addEventListener('click', function (e) {
      rendererHost.maximizeWindow()
    })

    captionRestore.addEventListener('click', function (e) {
      if (windowIsFullscreen) {
        rendererHost.setWindowFullScreen(false)
      } else {
        rendererHost.unmaximizeWindow()
      }
    })

    captionClose.addEventListener('click', function (e) {
      rendererHost.closeWindow()
    })
  }

  rendererHost.onWindowStateChanged(function (state) {
    windowIsMaximized = state.maximized
    windowIsFullscreen = state.fullScreen
    updateCaptionButtons()
  })

  if (runtimeConfiguration.platform === 'linux') {
    linuxClose.addEventListener('click', function (e) {
      rendererHost.closeWindow()
    })
    linuxMaximize.addEventListener('click', function (e) {
      if (windowIsFullscreen) {
        rendererHost.setWindowFullScreen(false)
      } else if (windowIsMaximized) {
        rendererHost.unmaximizeWindow()
      } else {
        rendererHost.maximizeWindow()
      }
    })
    linuxMinimize.addEventListener('click', function (e) {
      rendererHost.minimizeWindow()
    })
  }
}

module.exports = { initialize }
