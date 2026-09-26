function createPermissionManager ({ getTabIDFromWebContents, ipc, sendIPCToWindow, windows }) {
  var pendingPermissions = []
  var grantedPermissions = []
  var nextPermissionId = 1
  const observedContents = new WeakSet()

  /*
All permission requests are given to the renderer on each change,
it will figure out what updates to make
*/
  function sendPermissionsToRenderers () {
  // send all requests to all windows - the tab bar in each will figure out what to display
    windows.getAll().forEach(function (win) {
      sendIPCToWindow(win, 'updatePermissions', pendingPermissions.concat(grantedPermissions).map(p => {
      // remove properties that can't be serialized over IPC
        return {
          permissionId: p.permissionId,
          tabId: p.tabId,
          origin: p.origin,
          permission: p.permission,
          details: p.details,
          granted: p.granted
        }
      }))
    })
  }

  function removePermissionsForContents (contents) {
    pendingPermissions = pendingPermissions.filter(perm => perm.contents !== contents)
    grantedPermissions = grantedPermissions.filter(perm => perm.contents !== contents)

    sendPermissionsToRenderers()
  }

  function observeContents (contents) {
    if (observedContents.has(contents)) return
    observedContents.add(contents)
    function onNavigation (event, url, isInPlace, isMainFrame) {
      if (isMainFrame && !isInPlace) removePermissionsForContents(contents)
    }
    contents.on('did-start-navigation', onNavigation)
    contents.once('destroyed', function () {
      contents.removeListener('did-start-navigation', onNavigation)
      observedContents.delete(contents)
      // Always release records/callbacks, including after the last window has
      // closed. sendPermissionsToRenderers already skips IPC with no windows.
      removePermissionsForContents(contents)
    })
  }

  /*
Was permission already granted for this origin?
*/
  function isPermissionGrantedForOrigin (requestOrigin, requestPermission, requestDetails) {
    for (var i = 0; i < grantedPermissions.length; i++) {
      if (requestOrigin === grantedPermissions[i].origin) {
        if (requestPermission === 'notifications' && grantedPermissions[i].permission === 'notifications') {
          return true
        }

        if (requestPermission === 'pointerLock' && grantedPermissions[i].permission === 'pointerLock') {
          return true
        }

        if (requestPermission === 'media' && grantedPermissions[i].permission === 'media') {
        // type 1: from permissionCheckHandler
        // request has a single media type
          if (requestDetails.mediaType && grantedPermissions[i].details.mediaTypes.includes(requestDetails.mediaType)) {
            return true
          }
          // type 2: from a permissionRequestHandler
          // request has multiple media types
          // TODO existing granted permissions should be merged together (i.e. if there is an existing permission for audio, and another for video, a new request for audio+video should be approved, but it currently won't be)
          if (requestDetails.mediaTypes && requestDetails.mediaTypes.every(type => grantedPermissions[i].details.mediaTypes.includes(type))) {
            return true
          }

          // type 3: a general media permission with no specific type
          // occurs immediately after granting a more specific permission type
          if (!requestDetails.mediaType && !requestDetails.mediaTypes && grantedPermissions[i].permission === 'media') {
            return true
          }
        }
      }
    }
    return false
  }

  /*
Is there already a pending request of the given type for this origin?
 */
  function hasPendingRequestForOrigin (requestOrigin, permission, details) {
    for (var i = 0; i < pendingPermissions.length; i++) {
      if (requestOrigin === pendingPermissions[i].origin && permission === pendingPermissions[i].permission) {
        return true
      }
    }
    return false
  }

  function pagePermissionRequestHandler (webContents, permission, respond, details) {
    if (permission === 'fullscreen') {
      respond(true)
      return
    }

    if (!details.isMainFrame) {
    // not supported for now to simplify the UI
      respond(false)
      return
    }

    if (!details.requestingUrl) {
      respond(false)
      return
    }

    if (permission === 'clipboard-sanitized-write') {
      respond(true)
      return
    }

    let requestOrigin
    try {
      requestOrigin = new URL(details.requestingUrl).hostname
    } catch (e) {
    // invalid URL
      console.warn(e, details.requestingUrl)
      respond(false)
      return
    }

    /*
  Geolocation requires a Google API key (https://www.electronjs.org/docs/api/environment-variables#google_api_key), so it is disabled.
  Other permissions aren't supported for now to simplify the UI
  */
    if (['media', 'notifications', 'pointerLock'].includes(permission)) {
      observeContents(webContents)
      // Permissions granted for this origin in another tab can be reused.
      if (isPermissionGrantedForOrigin(requestOrigin, permission, details)) {
        if (!grantedPermissions.some(grant => grant.contents === webContents && grant.permission === permission)) {
          grantedPermissions.push({
            permissionId: nextPermissionId,
            tabId: getTabIDFromWebContents(webContents),
            contents: webContents,
            origin: requestOrigin,
            permission: permission,
            details: details,
            granted: true
          })

          sendPermissionsToRenderers()
          nextPermissionId++
        }
        respond(true)
      } else if (permission === 'notifications' && hasPendingRequestForOrigin(requestOrigin, permission, details)) {
      /*
      Sites sometimes make a new request for each notification, which can generate multiple requests if the first one wasn't approved.
      TODO this isn't entirely correct (some requests will be rejected when they should be pending) - correct solution is to show a single button to approve all requests in the UI.
      */
        respond(false)
      } else {
        pendingPermissions.push({
          permissionId: nextPermissionId,
          tabId: getTabIDFromWebContents(webContents),
          contents: webContents,
          origin: requestOrigin,
          permission: permission,
          details: details,
          callback: respond
        })

        sendPermissionsToRenderers()
        nextPermissionId++
      }
    } else {
      respond(false)
    }
  }

  function pagePermissionCheckHandler (webContents, permission, requestingOrigin, details) {
    if (!details.isMainFrame && requestingOrigin !== details.embeddingOrigin) {
      return false
    }

    // TODO sometimes the origin field is blank, figure out why
    if (!requestingOrigin) {
      return false
    }

    if (permission === 'clipboard-sanitized-write') {
      return true
    }

    let requestHostname
    try {
      requestHostname = new URL(requestingOrigin).hostname
    } catch (e) {
    // invalid URL
      console.warn(e, requestingOrigin)
      return false
    }

    return isPermissionGrantedForOrigin(requestHostname, permission, details)
  }

  function install (session) {
    session.setPermissionRequestHandler(pagePermissionRequestHandler)
    session.setPermissionCheckHandler(pagePermissionCheckHandler)
  }

  ipc.on('permissionGranted', function (e, permissionId) {
    if (!windows.windowFromContents(e.sender)) return
    for (var i = 0; i < pendingPermissions.length; i++) {
      if (permissionId && pendingPermissions[i].permissionId === permissionId) {
      // Focus the webContents before granting pointerLock, since clicking
      // the tab-bar permission button shifts focus away from the webview
      // and Chromium's pointerLock activation can silently fail if the
      // document isn't focused when the callback is processed.
        if (pendingPermissions[i].permission === 'pointerLock') {
          pendingPermissions[i].contents.focus()
        }

        const permission = pendingPermissions.splice(i, 1)[0]
        const respond = permission.callback
        delete permission.callback
        permission.granted = true
        grantedPermissions.push(permission)
        // The response may trigger navigation/destruction; publish the grant
        // first so lifecycle cleanup cannot be undone after the callback.
        respond(true)

        sendPermissionsToRenderers()
        break
      }
    }
  })

  ipc.on('revokePermission', function (e, permissionId) {
    if (!windows.windowFromContents(e.sender)) return
    for (var i = 0; i < grantedPermissions.length; i++) {
      if (grantedPermissions[i].permissionId === permissionId) {
        grantedPermissions.splice(i, 1)
        sendPermissionsToRenderers()
        break
      }
    }
  })

  return { install, pagePermissionCheckHandler, pagePermissionRequestHandler }
}

module.exports = createPermissionManager
