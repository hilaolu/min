const CHANNEL = 'renderer-host:clipboard'

function installRendererHostClipboard ({ clipboard, ipc, isChrome }) {
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
        // Commit all link representations together so native bookmarks do not
        // replace the URL. Electron 43 takes the bookmark URL from the text field.
        return clipboard.write({
          text: url,
          html: typeof link.html === 'string' ? link.html : '',
          bookmark: typeof link.title === 'string' ? link.title : ''
        })
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
