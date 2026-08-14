const path = require('path')
const fs = require('fs')

const outFile = path.resolve(__dirname, '../main.build.js')

const modules = [
  'main/windowManagement.js',
  'js/util/keyMap.js',
  'main/menu.js',
  'main/touchbar.js',
  'main/registryConfig.js',
  'js/util/settings/settingsMain.js',
  'main/overlayManager.js',
  'main/commandPaletteOverlayTemplate.js',
  'main/commandPaletteOverlay.js',
  'main/main.js',
  'main/minInternalProtocol.js',
  'main/filtering.js',
  'main/viewManager.js',
  'main/download.js',
  'main/UASwitcher.js',
  'main/permissionManager.js',
  'main/prompt.js',
  'main/remoteMenu.js',
  'main/remoteActions.js',
  'main/keychainService.js',
  'js/util/proxy.js',
  'main/themeMain.js'
]

function buildMain () {
  /* concatenate modules */
  let output = ''

  // Load command palette overlay HTML template
  const overlayHtmlPath = path.resolve(__dirname, '../pages/commandPalette/overlay.html')
  let overlayHtml = ''

  try {
    overlayHtml = fs.readFileSync(overlayHtmlPath, 'utf-8')
    console.log('Successfully loaded command palette overlay HTML')
  } catch (error) {
    console.warn('Failed to load command palette overlay HTML:', error.message)
    overlayHtml = '<div>Command Palette Overlay</div>'
  }

  // Add the overlay HTML as a global variable
  output += 'global.commandPaletteOverlayHTML = ' + JSON.stringify(overlayHtml) + ';\n'

  modules.forEach(function (script) {
    output += fs.readFileSync(path.resolve(__dirname, '../', script)) + ';\n'
  })

  fs.writeFileSync(outFile, output, 'utf-8')
}

if (module.parent) {
  module.exports = buildMain
} else {
  buildMain()
}
