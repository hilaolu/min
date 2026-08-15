var isFocusMode = false
const rendererHost = require('rendererHost.js')

rendererHost.onBrowserCommand(function (command) {
  if (command.type === 'enter-focus-mode') {
    isFocusMode = true
    document.body.classList.add('is-focus-mode')
  } else if (command.type === 'exit-focus-mode') {
    isFocusMode = false
    document.body.classList.remove('is-focus-mode')
  }
})

module.exports = {
  enabled: function () {
    return isFocusMode
  },
  warn: function () {
    rendererHost.showFocusModeWarning()
  }
}
