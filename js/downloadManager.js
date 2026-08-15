var webviews = require('webviews.js')
const remoteMenu = require('remoteMenuRenderer.js')
const rendererHost = require('rendererHost.js')

function getFileSizeString (bytes) {
  const prefixes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']

  let size = bytes
  let prefixIndex = 0

  while (size > 900) { // prefer "0.9 KB" to "949 bytes"
    size /= 1024
    prefixIndex++
  }

  return (Math.round(size * 10) / 10) + ' ' + prefixes[prefixIndex]
}

const downloadManager = {
  isShown: false,
  bar: document.getElementById('download-bar'),
  container: document.getElementById('download-container'),
  closeButton: document.getElementById('download-close-button'),
  height: 40,
  lastDownloadCompleted: null,
  downloadItems: {},
  downloadBarElements: {},
  show: function () {
    if (!downloadManager.isShown) {
      downloadManager.isShown = true
      downloadManager.bar.hidden = false
      webviews.adjustMargin([0, 0, downloadManager.height, 0])
    }
  },
  hide: function () {
    if (downloadManager.isShown) {
      downloadManager.isShown = false
      downloadManager.bar.hidden = true
      webviews.adjustMargin([0, 0, downloadManager.height * -1, 0])

      // remove all completed or failed items
      for (const item in downloadManager.downloadItems) {
        if (downloadManager.downloadItems[item].status !== 'progressing') {
          downloadManager.removeItem(item)
        }
      }
    }
  },
  removeItem: function (id) {
    if (downloadManager.downloadBarElements[id]) {
      downloadManager.downloadBarElements[id].container.remove()
    }

    delete downloadManager.downloadBarElements[id]
    delete downloadManager.downloadItems[id]
    rendererHost.releaseDownload(id)

    if (Object.keys(downloadManager.downloadItems).length === 0) {
      downloadManager.hide()
    }
  },
  openFolder: function (id) {
    rendererHost.revealDownload(id)
  },
  onItemClicked: function (id) {
    if (downloadManager.downloadItems[id].status === 'completed') {
      rendererHost.openDownload(id)
      // provide a bit of time for the file to open before the download bar disappears
      setTimeout(function () {
        downloadManager.removeItem(id)
      }, 100)
    }
  },
  onItemDragged: function (id) {
    rendererHost.startDownloadDrag(id)
  },
  onDownloadCompleted: function () {
    downloadManager.lastDownloadCompleted = Date.now()
    setTimeout(function () {
      if (Date.now() - downloadManager.lastDownloadCompleted >= 120000 && Object.values(downloadManager.downloadItems).filter(i => i.status === 'progressing').length === 0) {
        downloadManager.hide()
      }
    }, 120 * 1000)
  },
  createItem: function (downloadItem) {
    const container = document.createElement('div')
    container.className = 'download-item'
    container.setAttribute('role', 'listitem')
    container.setAttribute('draggable', 'true')

    const title = document.createElement('div')
    title.className = 'download-title'
    title.textContent = downloadItem.name
    container.appendChild(title)

    const infoBox = document.createElement('div')
    infoBox.className = 'download-info'
    container.appendChild(infoBox)

    const detailedInfoBox = document.createElement('div')
    detailedInfoBox.className = 'download-info detailed'
    container.appendChild(detailedInfoBox)

    const progress = document.createElement('div')
    progress.className = 'download-progress'
    container.appendChild(progress)

    const dropdown = document.createElement('button')
    dropdown.className = 'download-action-button i carbon:chevron-down'
    container.appendChild(dropdown)

    const openFolder = document.createElement('button')
    openFolder.className = 'download-action-button i carbon:folder'
    openFolder.hidden = true
    container.appendChild(openFolder)

    container.addEventListener('click', function () {
      downloadManager.onItemClicked(downloadItem.id)
    })
    container.addEventListener('dragstart', function (e) {
      e.preventDefault()
      downloadManager.onItemDragged(downloadItem.id)
    })

    dropdown.addEventListener('click', function (e) {
      e.stopPropagation()
      var template = [
        [
          {
            label: 'Cancel',
            click: function () {
              rendererHost.cancelDownload(downloadItem.id)
              downloadManager.removeItem(downloadItem.id)
            }
          }
        ]
      ]

      remoteMenu.open(template, Math.round(dropdown.getBoundingClientRect().left), Math.round(dropdown.getBoundingClientRect().top - 15))
    })

    openFolder.addEventListener('click', function (e) {
      e.stopPropagation()
      downloadManager.openFolder(downloadItem.id)
      downloadManager.removeItem(downloadItem.id)
    })

    downloadManager.container.appendChild(container)
    downloadManager.downloadBarElements[downloadItem.id] = { container, title, infoBox, detailedInfoBox, progress, dropdown, openFolder }
  },
  updateItem: function (downloadItem) {
    const elements = downloadManager.downloadBarElements[downloadItem.id]

    if (downloadItem.status === 'completed') {
      elements.container.classList.remove('loading')
      elements.container.classList.add('completed')
      elements.progress.hidden = true
      elements.dropdown.hidden = true
      elements.openFolder.hidden = false
      elements.infoBox.textContent = 'Completed'
      elements.detailedInfoBox.textContent = 'Completed'
    } else if (downloadItem.status === 'interrupted') {
      elements.container.classList.remove('loading')
      elements.container.classList.remove('completed')
      elements.progress.hidden = true
      elements.dropdown.hidden = true
      elements.openFolder.hidden = true
      elements.infoBox.textContent = 'Failed'
      elements.detailedInfoBox.textContent = 'Failed'
    } else {
      elements.container.classList.add('loading')
      elements.container.classList.remove('completed')
      elements.progress.hidden = false
      elements.dropdown.hidden = false
      elements.openFolder.hidden = true
      elements.infoBox.textContent = getFileSizeString(downloadItem.size.total)
      elements.detailedInfoBox.textContent = getFileSizeString(downloadItem.size.received) + ' / ' + getFileSizeString(downloadItem.size.total)

      // the progress bar has a minimum width so that it's visible even if there's 0 download progress
      const adjustedProgress = 0.025 + ((downloadItem.size.received / downloadItem.size.total) * 0.975)
      elements.progress.style.transform = 'scaleX(' + adjustedProgress + ')'
    }
  },
  initialize: function () {
    this.closeButton.addEventListener('click', function () {
      downloadManager.hide()
    })

    rendererHost.onDownloadChanged(function (info) {
      if (info.status === 'cancelled') {
        downloadManager.removeItem(info.id)
        return
      }

      if (info.status === 'completed') {
        downloadManager.onDownloadCompleted()
      }

      if (!downloadManager.downloadItems[info.id]) {
        downloadManager.show()
        downloadManager.createItem(info)
      }
      downloadManager.updateItem(info)

      downloadManager.downloadItems[info.id] = info
    })
  }
}

module.exports = downloadManager
