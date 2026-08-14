var { ipcRenderer } = require('electron')
var fs = require('fs')
var path = require('path')

var webviews = require('webviews.js')
var settings = require('util/settings/settings.js')
var browserUI = require('browserUI.js')
var modalMode = require('modalMode.js')
var ProcessSpawner = require('util/process.js')

var dialog = document.getElementById('manager-setup-dialog')

var primaryInstructions = document.getElementById('manager-setup-instructions-primary')
var secondaryInstructions = document.getElementById('manager-setup-instructions-secondary')
var dragBox = document.getElementById('manager-setup-drop-box')

const setupDialog = {
  manager: null,
  setupMode: null,
  installerCompletionTimeout: null,
  show: function (manager) {
    setupDialog.manager = manager
    setupDialog.setupMode = manager.getSetupMode()

    document.getElementById('manager-setup-heading').textContent = `Finish setting up ${manager.name} to use Autofill`
    document.getElementById('password-manager-setup-link').textContent = `download the ${manager.name} CLI tool`
    document.getElementById('password-manager-setup-link-installer').textContent = `the ${manager.name} CLI installer`

    dragBox.textContent = 'Drag the tool here'

    if (setupDialog.setupMode === 'installer') {
      primaryInstructions.hidden = true
      secondaryInstructions.hidden = false

      setupDialog.installerCompletionTimeout = setTimeout(waitForInstallerComplete, 2000)
    } else {
      primaryInstructions.hidden = false
      secondaryInstructions.hidden = true
    }

    modalMode.toggle(true, {
      onDismiss: function () {
        settings.set('passwordManager', null)
        setupDialog.hide()
      }
    })

    dialog.hidden = false
    webviews.requestPlaceholder('managerSetup')
  },
  hide: function () {
    setupDialog.manager = null
    setupDialog.setupMode = null
    clearTimeout(setupDialog.installerCompletionTimeout)
    setupDialog.installerCompletionTimeout = null

    modalMode.toggle(false)
    dialog.hidden = true
    webviews.hidePlaceholder('managerSetup')
  },
  initialize: function () {
    document.getElementById('manager-setup-disable').addEventListener('click', function () {
      settings.set('passwordManager', null)
      setupDialog.hide()
    })

    document.getElementById('manager-setup-close').addEventListener('click', function () {
      settings.set('passwordManager', null)
      setupDialog.hide()
    })

    document.getElementById('password-manager-setup-link').addEventListener('click', function () {
      browserUI.addTab(tabs.add({
        url: setupDialog.manager.getDownloadLink()
      }), { openInBackground: true })
    })

    document.getElementById('password-manager-setup-link-installer').addEventListener('click', function () {
      browserUI.addTab(tabs.add({
        url: setupDialog.manager.getDownloadLink()
      }), { openInBackground: true })
    })

    dragBox.ondragover = () => {
      return false
    }

    dragBox.ondragleave = () => {
      return false
    }

    dragBox.ondragend = () => {
      return false
    }

    dragBox.ondrop = (e) => {
      e.preventDefault()

      if (e.dataTransfer.files.length === 0) {
        return
      }

      dragBox.textContent = 'Installing...'

      const filePath = electron.webUtils.getPathForFile(e.dataTransfer.files[0])

      // try to filter out anything that isn't an executable (note: not 100% accurate)
      if (e.dataTransfer.files[0].type !== '' && !e.dataTransfer.files[0].name.endsWith('.exe')) {
        dragBox.textContent = 'Make sure you\'re using the right file and entering a correct password. You can retry by dragging the tool here again.'
        return
      }

      if (setupDialog.setupMode === 'installer') {
        launchInstaller(filePath, window.platformType)
      } else {
        install(filePath).then(afterInstall)
      }

      return false
    }
  }
}

function waitForInstallerComplete () {
  setupDialog.manager.checkIfConfigured().then(function (configured) {
    if (configured) {
      afterInstall()
      setupDialog.installerCompletionTimeout = null
    } else {
      setupDialog.installerCompletionTimeout = setTimeout(waitForInstallerComplete, 2000)
    }
  })
}

// Install the tool into the Min user folder.
function install (filePath, callback) {
  return new Promise((resolve, reject) => {
    try {
      const toolsDir = path.join(window.globalArgs['user-data-path'], 'tools')
      if (!fs.existsSync(toolsDir)) {
        fs.mkdirSync(toolsDir)
      }

      const targetFilePath = setupDialog.manager.getLocalPath()
      fs.createReadStream(filePath).pipe(fs.createWriteStream(targetFilePath)).on('finish', function () {
        fs.chmodSync(targetFilePath, '755')
        resolve(targetFilePath)
      }).on('error', function (error) {
        reject(error)
      })
    } catch (e) {
      reject(e)
    }
  })
}

// Launch installer file.
function launchInstaller (filePath, platform) {
  if (platform === 'mac') {
    return new ProcessSpawner('open', [filePath]).execute()
  } else {
    return new ProcessSpawner(filePath).execute()
  }
}

function afterInstall (toolPath) {
  setupDialog.manager.signInAndSave(toolPath)
    .then(() => {
      setupDialog.hide()
    })
    .catch(function (e) {
      console.warn(e)
      if (setupDialog.setupMode === 'installer') {
        // show the dialog again
        afterInstall()
      } else {
        // Cleanup after we failed.
        const targetFilePath = setupDialog.manager.getLocalPath()
        if (fs.existsSync(targetFilePath)) {
          fs.unlinkSync(targetFilePath)
        }

        const message = (e.error || '').replace(/\n$/gm, '')
        dragBox.textContent = `Failed to unlock the password store: ${message} Make sure you're using the right file and entering a correct password. You can retry by dragging the tool here again.`
      }
    })
}

setupDialog.initialize()

module.exports = setupDialog
