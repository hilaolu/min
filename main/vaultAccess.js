const { randomBytes } = require('crypto')
const { serveVaultResource } = require('./vaultProtocol.js')
const { parseVaultURL } = require('../js/util/vaultURL.js')

// Electron's Fetch Request has no trusted frame/WebContents identity. Transfer
// an approval from the existing onBeforeSendHeaders listener using a single-use
// main-generated header. Renderer-supplied versions are always stripped.
function createVaultAccess ({ getRoot }) {
  const associations = new Map()
  const tickets = new Map()
  const installed = new WeakSet()
  const watched = new WeakSet()
  const header = 'X-Min-Vault-Request'

  function revoke (contents) {
    associations.delete(contents.id)
    for (const [key, ticket] of tickets) {
      if (ticket.contents === contents) {
        clearTimeout(ticket.timer)
        tickets.delete(key)
      }
    }
  }

  function associate (contents, { url, pageURL = null, kind = 'resource', managed = false }) {
    const source = parseVaultURL(url).vaultURL
    revoke(contents)
    const association = { contents, source, pageURL, kind, root: getRoot(), managed }
    associations.set(contents.id, association)
    if (!watched.has(contents)) {
      watched.add(contents)
      contents.once('destroyed', () => revoke(contents))
      contents.on('did-start-navigation', (event, url, inPlace, mainFrame) => {
        const current = associations.get(contents.id)
        // Managed tabs revoke on approved departure/commit, not on a start
        // that will-navigate may cancel. Request checks still bind the frame,
        // current page and source; retaining it grants no destination access.
        if (!mainFrame || inPlace || !current || current.managed) return
        let source
        try { source = parseVaultURL(url).vaultURL } catch (_) {}
        if (url !== current.pageURL && source !== current.source) revoke(contents)
      })
    }
    return association
  }

  function approved (details) {
    const association = associations.get(details.webContentsId)
    if (!association || association.contents.isDestroyed() || association.root !== getRoot()) return null
    const contents = association.contents
    // Frame object identity is supplied by Electron, not by request headers.
    if (!details.frame || details.frame !== contents.mainFrame) return null
    let source
    try { source = parseVaultURL(details.url).vaultURL } catch (_) {
      // An associated caller may receive an explicit malformed-URL response.
      source = null
    }
    if (details.resourceType === 'mainFrame') {
      return association.kind === 'resource' && source === association.source ? association : null
    }
    if (!association.pageURL || contents.getURL().split('#')[0] !== association.pageURL || details.frame.url.split('#')[0] !== association.pageURL) return null
    if (association.kind === 'pdf' && source !== association.source) return null
    return ['markdown', 'browser', 'pdf'].includes(association.kind) ? association : null
  }

  function prepareHeaders (details) {
    if (!details.url.startsWith('vault:')) return
    Object.keys(details.requestHeaders).forEach(key => {
      if (key.toLowerCase() === header.toLowerCase()) delete details.requestHeaders[key]
    })
    const association = approved(details)
    if (!association) return
    const token = randomBytes(32).toString('hex')
    const timer = setTimeout(() => tickets.delete(token), 30000)
    timer.unref()
    tickets.set(token, { association, contents: association.contents, url: details.url, method: details.method, timer })
    details.requestHeaders[header] = token
  }

  function install (ses) {
    if (installed.has(ses)) return
    installed.add(ses)
    ses.protocol.handle('vault', request => {
      const token = request.headers.get(header)
      const ticket = tickets.get(token)
      if (ticket) {
        tickets.delete(token)
        clearTimeout(ticket.timer)
      }
      const association = ticket?.association
      const allowed = ticket && ticket.url === request.url && ticket.method === request.method &&
        !ticket.contents.isDestroyed() && ticket.contents.session === ses &&
        associations.get(ticket.contents.id) === association && association.root === getRoot()
      return serveVaultResource(request, allowed ? association.root : undefined)
    })
  }

  return { associate, revoke, prepareHeaders, install, getAssociation: contents => associations.get(contents.id), getAssociations: () => Array.from(associations.values()), hasAssociations: () => associations.size > 0 }
}

module.exports = createVaultAccess
