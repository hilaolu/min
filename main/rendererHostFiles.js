const ASYNC_CHANNEL = 'renderer-host:files'
const SYNC_CHANNEL = 'renderer-host:files-sync'
const USER_SCRIPTS_CHANGED_CHANNEL = 'renderer-host:user-scripts-changed'

function createError (code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function createRendererHostFiles ({ atomicWriter, dialog, fs, getBrowserChromeContents, hostsFile, ipc, now = Date.now, path, saveTabContentPage, schedule = setTimeout, shell, userDataPath, watch, windows }) {
  const bookmarksBackupPath = path.join(userDataPath, 'bookmarksBackup.html')
  const browserSessionPath = path.join(userDataPath, 'sessionRestore.json')
  const newTabBackgroundPath = path.join(userDataPath, 'newTabBackground')
  const userScriptsPath = path.join(userDataPath, 'userscripts')
  const systemHostsPath = hostsFile || (process.platform === 'win32'
    ? 'C:/Windows/System32/drivers/etc/hosts'
    : '/etc/hosts')
  let userScriptChangeTimer = null
  let userScriptWatcher = null

  function requireBrowserChrome (sender) {
    const owner = windows.windowFromContents(sender)
    if (!owner || windows.getChromeContents(owner.win) !== sender) {
      throw createError('BROWSER_CHROME_NOT_OWNER', 'Renderer Host request did not come from Browser Chrome')
    }
    return owner.win
  }

  function requireString (value, name) {
    if (typeof value !== 'string') {
      throw createError('INVALID_RENDERER_HOST_FILE_REQUEST', `${name} must be a string`)
    }
    return value
  }

  function success (value) {
    return { ok: true, value }
  }

  function failure (error) {
    return {
      ok: false,
      error: {
        code: error.code === 'BROWSER_CHROME_NOT_OWNER' || error.code === 'INVALID_RENDERER_HOST_FILE_REQUEST'
          ? error.code
          : 'RENDERER_HOST_FILE_WORKFLOW_FAILED',
        message: error.message || 'Renderer Host file workflow failed'
      }
    }
  }

  async function readOptionalFile (filePath, encoding) {
    try {
      return await fs.promises.readFile(filePath, encoding)
    } catch (error) {
      if (error.code === 'ENOENT') return null
      throw error
    }
  }

  function readOptionalFileSync (filePath, encoding) {
    try {
      return fs.readFileSync(filePath, encoding)
    } catch (error) {
      if (error.code === 'ENOENT') return null
      throw error
    }
  }

  function parseHosts (data) {
    const limit = 128 * 1024
    const lines = data.length > limit
      ? data.substring(0, limit).split('\n').slice(0, -1)
      : data.split('\n')
    const hosts = []
    const seen = new Set()

    lines.forEach(function (line) {
      if (line.startsWith('#')) return
      line.split(/\s/g).forEach(function (host) {
        if (host && host !== '255.255.255.255' && host !== 'broadcasthost' && !seen.has(host)) {
          seen.add(host)
          hosts.push(host)
        }
      })
    })
    return hosts
  }

  function notifyUserScriptChanges () {
    if (userScriptChangeTimer) clearTimeout(userScriptChangeTimer)
    userScriptChangeTimer = schedule(function () {
      userScriptChangeTimer = null
      getBrowserChromeContents().forEach(function (contents) {
        if (!contents.isDestroyed || !contents.isDestroyed()) {
          contents.send(USER_SCRIPTS_CHANGED_CHANNEL)
        }
      })
    }, 100)
  }

  function startUserScriptWatcher () {
    if (userScriptWatcher) return
    userScriptWatcher = watch(userScriptsPath, {
      ignoreInitial: true,
      disableGlobbing: true,
      awaitWriteFinish: {
        stabilityThreshold: 500,
        pollInterval: 100
      }
    })
    userScriptWatcher.on('all', notifyUserScriptChanges)
  }

  function stopUserScriptWatcher () {
    if (userScriptWatcher) {
      userScriptWatcher.close()
      userScriptWatcher = null
    }
  }

  async function loadUserScripts () {
    await fs.promises.mkdir(userScriptsPath, { recursive: true })
    const filenames = await fs.promises.readdir(userScriptsPath)
    const scripts = await Promise.all(filenames
      .filter(filename => filename.endsWith('.js'))
      .sort()
      .map(async function (filename) {
        try {
          return {
            content: await fs.promises.readFile(path.join(userScriptsPath, filename), 'utf8'),
            filename
          }
        } catch {
          return null
        }
      }))
    return scripts.filter(Boolean)
  }

  const asyncOperations = {
    'bookmarks.backup': async function (window, payload) {
      await atomicWriter(bookmarksBackupPath, requireString(payload.data, 'bookmark data'), {})
      return true
    },
    'bookmarks.export': async function (window, payload) {
      const result = await dialog.showSaveDialog(window, {
        defaultPath: 'bookmarks.html',
        filters: [{ name: 'HTML files', extensions: ['htm', 'html'] }]
      })
      if (result.canceled || !result.filePath) return false
      await fs.promises.writeFile(result.filePath, requireString(payload.data, 'bookmark data'), 'utf8')
      return true
    },
    'bookmarks.import': async function (window) {
      const result = await dialog.showOpenDialog(window, {
        filters: [{ name: 'HTML files', extensions: ['htm', 'html'] }]
      })
      if (result.canceled || !result.filePaths[0]) return null
      return fs.promises.readFile(result.filePaths[0], 'utf8')
    },
    'new-tab-background.choose': async function (window) {
      const result = await dialog.showOpenDialog(window, {
        filters: [{ name: 'Image files', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp'] }]
      })
      if (result.canceled || !result.filePaths[0]) return false
      await fs.promises.copyFile(result.filePaths[0], newTabBackgroundPath)
      return true
    },
    'new-tab-background.load': async function () {
      return readOptionalFile(newTabBackgroundPath)
    },
    'new-tab-background.remove': async function () {
      try {
        await fs.promises.unlink(newTabBackgroundPath)
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
      return true
    },
    'page.save': async function (window, payload, sender) {
      const tabId = requireString(payload.tabId, 'Tab ID')
      const suggestedName = requireString(payload.suggestedName, 'suggested page name').replace(/[/\\]/g, '_')
      const result = await dialog.showSaveDialog(window, { defaultPath: suggestedName })
      if (result.canceled || !result.filePath) return false
      const filePath = result.filePath.endsWith('.html') ? result.filePath : result.filePath + '.html'
      await saveTabContentPage(sender, tabId, filePath)
      return true
    },
    'session.save': async function (window, payload) {
      await atomicWriter(browserSessionPath, requireString(payload.data, 'Browser Session data'), {})
      return true
    },
    'system-hosts.load': async function () {
      const data = await readOptionalFile(systemHostsPath, 'utf8')
      return data === null ? [] : parseHosts(data)
    },
    'user-scripts.load': loadUserScripts,
    'user-scripts.open-directory': async function () {
      await fs.promises.mkdir(userScriptsPath, { recursive: true })
      await shell.openPath(userScriptsPath)
      return true
    },
    'user-scripts.set-watching': async function (window, payload) {
      if (payload.enabled === true) {
        await fs.promises.mkdir(userScriptsPath, { recursive: true })
        startUserScriptWatcher()
      } else {
        stopUserScriptWatcher()
      }
      return true
    }
  }

  function executeSyncOperation (operation, payload) {
    if (operation === 'session.load') {
      return readOptionalFileSync(browserSessionPath, 'utf8')
    }
    if (operation === 'session.save') {
      atomicWriter.sync(browserSessionPath, requireString(payload.data, 'Browser Session data'), {})
      return true
    }
    if (operation === 'session.backup-corrupt') {
      const filename = `sessionRestoreBackup-${now()}.json`
      atomicWriter.sync(path.join(userDataPath, filename), requireString(payload.data, 'Browser Session data'), {})
      return filename
    }
    throw createError('INVALID_RENDERER_HOST_FILE_REQUEST', `Unsupported synchronous Renderer Host file operation: ${operation}`)
  }

  async function execute (sender, request = {}) {
    try {
      const window = requireBrowserChrome(sender)
      const operation = asyncOperations[request.operation]
      if (!operation) {
        throw createError('INVALID_RENDERER_HOST_FILE_REQUEST', `Unsupported Renderer Host file operation: ${request.operation}`)
      }
      return success(await operation(window, request.payload || {}, sender))
    } catch (error) {
      return failure(error)
    }
  }

  function executeSync (sender, request = {}) {
    try {
      requireBrowserChrome(sender)
      return success(executeSyncOperation(request.operation, request.payload || {}))
    } catch (error) {
      return failure(error)
    }
  }

  ipc.handle(ASYNC_CHANNEL, function (event, request) {
    return execute(event.sender, request)
  })
  ipc.on(SYNC_CHANNEL, function (event, request) {
    event.returnValue = executeSync(event.sender, request)
  })

  function destroy () {
    if (userScriptChangeTimer) {
      clearTimeout(userScriptChangeTimer)
      userScriptChangeTimer = null
    }
    stopUserScriptWatcher()
  }

  return { destroy, execute, executeSync }
}

module.exports = {
  ASYNC_CHANNEL,
  createRendererHostFiles,
  SYNC_CHANNEL,
  USER_SCRIPTS_CHANGED_CHANNEL
}
