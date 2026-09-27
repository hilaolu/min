const CHANNEL = 'renderer-host:clipboard'

function installRendererHostClipboard ({ clipboard, ClipboardItem, ipc, isChrome }) {
  ipc.handle(CHANNEL, async function (event, operation, value) {
    const { sender, senderFrame } = event
    if (!sender || sender.isDestroyed() || !isChrome(sender) ||
        !senderFrame || senderFrame !== sender.mainFrame || senderFrame.url !== 'min://app/index.html') {
      throw new Error('Clipboard access is only available to Browser Chrome')
    }

    switch (operation) {
      case 'copy-page-link': {
        if (!value || typeof value.url !== 'string' || value.url.length === 0) {
          throw new TypeError('Copy Page URL requires a non-empty URL')
        }
        const link = value
        const url = link.url
        // Electron 44 clipboard access is main-process only. Commit all link
        // representations together so native bookmarks do not replace the URL.
        return clipboard.write([new ClipboardItem({
          'text/plain': url,
          'text/html': typeof link.html === 'string' ? link.html : '',
          'electron application/bookmark': {
            title: typeof link.title === 'string' ? link.title : '',
            url
          }
        })])
      }
      case 'copy-text':
        return clipboard.writeText(String(value))
      case 'read-text':
        return clipboard.readText()
      default:
        throw new Error('Unsupported clipboard operation')
    }
  })
}

module.exports = { CHANNEL, installRendererHostClipboard }
