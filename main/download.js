function createDownloadPolicy ({ getTabIDFromWebContents, ipc, path, sendIPCToWindow, windows }) {
  const currrentDownloadItems = {}
  const mainFrameDownloadNavigations = new Map()

  ipc.on('cancelDownload', function (e, path) {
    if (currrentDownloadItems[path]) {
      currrentDownloadItems[path].cancel()
    }
  })

  function isAttachment (header) {
    return /^\s*attache*?ment/i.test(header)
  }

  function downloadHandler (event, item, webContents) {
    let sourceWindow = windows.windowFromContents(webContents)?.win
    if (!sourceWindow) {
      sourceWindow = windows.getCurrent()
    }

    const navigationDownload = mainFrameDownloadNavigations.get(webContents.id)
    const itemURL = typeof item.getURL === 'function' ? item.getURL() : null

    if (navigationDownload && (!itemURL || navigationDownload.url === itemURL)) {
      clearTimeout(navigationDownload.timeout)
      mainFrameDownloadNavigations.delete(webContents.id)
      sendIPCToWindow(sourceWindow, 'download-navigation', {
        tabId: getTabIDFromWebContents(webContents)
      })
    }

    var savePathFilename

    // send info to download manager
    sendIPCToWindow(sourceWindow, 'download-info', {
      path: item.getSavePath(),
      name: item.getFilename(),
      status: 'progressing',
      size: { received: 0, total: item.getTotalBytes() }
    })

    item.on('updated', function (e, state) {
      if (!savePathFilename) {
        savePathFilename = path.basename(item.getSavePath())
      }

      if (item.getSavePath()) {
        currrentDownloadItems[item.getSavePath()] = item
      }

      sendIPCToWindow(sourceWindow, 'download-info', {
        path: item.getSavePath(),
        name: savePathFilename,
        status: state,
        size: { received: item.getReceivedBytes(), total: item.getTotalBytes() }
      })
    })

    item.once('done', function (e, state) {
      delete currrentDownloadItems[item.getSavePath()]
      sendIPCToWindow(sourceWindow, 'download-info', {
        path: item.getSavePath(),
        name: savePathFilename,
        status: state,
        size: { received: item.getTotalBytes(), total: item.getTotalBytes() }
      })
    })
    return true
  }

  function listenForDownloadHeaders (ses) {
    ses.webRequest.onHeadersReceived(function (details, respond) {
      if (details.resourceType === 'mainFrame' && details.responseHeaders) {
        let sourceWindow
        if (details.webContents) {
          sourceWindow = windows.windowFromContents(details.webContents)?.win
        }
        if (!sourceWindow) {
          sourceWindow = windows.getCurrent()
        }

        // workaround for https://github.com/electron/electron/issues/24334
        var typeHeader = details.responseHeaders[Object.keys(details.responseHeaders).filter(k => k.toLowerCase() === 'content-type')]
        var attachment = isAttachment(details.responseHeaders[Object.keys(details.responseHeaders).filter(k => k.toLowerCase() === 'content-disposition')])

        if (typeHeader instanceof Array && typeHeader.filter(t => t.includes('application/pdf')).length > 0 && !attachment) {
          // open in PDF viewer instead
          respond({ cancel: false })
          sendIPCToWindow(sourceWindow, 'openPDF', {
            url: details.url,
            tabId: null
          })
          return
        }

        // whether this is a file being viewed in-browser or a page
        // Needed to save files correctly: https://github.com/minbrowser/min/issues/1717
        // It doesn't make much sense to have this here, but only one onHeadersReceived instance can be created per session
        const isFileView = typeHeader instanceof Array && !typeHeader.some(t => t.includes('text/html'))

        if (details.webContents && (attachment || isFileView)) {
          const previousNavigation = mainFrameDownloadNavigations.get(details.webContents.id)
          if (previousNavigation) {
            clearTimeout(previousNavigation.timeout)
          }

          const timeout = setTimeout(function () {
            mainFrameDownloadNavigations.delete(details.webContents.id)
          }, 30000)

          mainFrameDownloadNavigations.set(details.webContents.id, {
            url: details.url,
            timeout
          })
        }

        sendIPCToWindow(sourceWindow, 'set-file-view', {
          url: details.url,
          isFileView
        })
      }

      /*
    SECURITY POLICY EXCEPTION:
    reader and PDF internal pages get universal access to web resources
    Note: we can't limit to the URL in the query string, because there could be redirects
    */
      if (details.webContents && (details.webContents.getURL().startsWith('min://app/pages/pdfViewer') || details.webContents.getURL().startsWith('min://app/reader/') || details.webContents.getURL() === 'min://app/index.html')) {
        const filteredHeaders = Object.fromEntries(
          Object.entries(details.responseHeaders).filter(([key, val]) => key.toLowerCase() !== 'access-control-allow-origin' && key.toLowerCase() !== 'access-control-allow-credentials')
        )

        respond({
          responseHeaders: {
            ...filteredHeaders,
            'Access-Control-Allow-Origin': 'min://app',
            'Access-Control-Allow-Credentials': 'true'
          }
        })
        return
      }

      respond({ cancel: false })
    })
  }

  function install (session) {
    session.on('will-download', downloadHandler)
    listenForDownloadHeaders(session)
  }

  return { install }
}

module.exports = createDownloadPolicy
