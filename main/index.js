const fs = require('fs')
const path = require('path')

const createAppRuntime = require('./main.js')
const createCommandPaletteOverlay = require('./commandPaletteOverlay.js')
const createDownloadPolicy = require('./download.js')
const createFilteringPolicy = require('./filtering.js')
const createMenu = require('./menu.js')
const createOverlayManager = require('./overlayManager.js')
const createPermissionManager = require('./permissionManager.js')
const createProtocolPolicy = require('./minInternalProtocol.js')
const createProxyPolicy = require('../js/util/proxy.js')
const createSessionPolicies = require('./sessionPolicies.js')
const createSettings = require('../js/util/settings/settingsMain.js')
const createTouchBar = require('./touchbar.js')
const createUserAgentPolicy = require('./UASwitcher.js')
const createViewManager = require('./viewManager.js')
const createWindowRegistry = require('./windowManagement.js')
const installPromptManager = require('./prompt.js')
const installRemoteActions = require('./remoteActions.js')
const installRemoteMenu = require('./remoteMenu.js')
const installThemePolicy = require('./themeMain.js')
const registryInstaller = require('./registryConfig.js')
const { userKeyMap } = require('../js/util/keyMap.js')

function createMainProcess (options = {}) {
  const electron = options.electron || require('electron')
  const rootDir = options.rootDir || path.resolve(__dirname, '..')
  const app = electron.app
  const ipc = electron.ipcMain
  const isDevelopmentMode = process.argv.some(arg => arg === '--development-mode')
  const isDebuggingEnabled = process.argv.some(arg => arg === '--debug-browser')

  if (isDevelopmentMode) {
    app.setPath('userData', app.getPath('userData') + '-development')
  }

  const runtimeRef = { current: null }
  const overlayRef = { current: null }
  const settingsRef = { current: null }
  const touchBarRef = { current: null }
  const viewManagerRef = { current: null }

  const windows = createWindowRegistry({
    app,
    BaseWindow: electron.BaseWindow,
    browserPage: 'min://app/index.html',
    buildTouchBar: () => touchBarRef.current?.buildTouchBar(),
    fs,
    getSetting: key => settingsRef.current?.get(key),
    isDevelopmentMode,
    onAllWindowsClosed: () => {
      if (viewManagerRef.current) {
        viewManagerRef.current.destroyAllViews()
      }
      if (overlayRef.current) {
        overlayRef.current.destroy()
      }
    },
    onRecenterOverlay: window => {
      if (overlayRef.current?.isVisible()) {
        overlayRef.current.recenter(window)
      }
    },
    path,
    rootDir,
    screen: electron.screen,
    userDataPath: app.getPath('userData'),
    WebContentsView: electron.WebContentsView
  })
  const getWindowWebContents = windows.getChromeContents

  const settings = createSettings({ fs, ipc, windows, getWindowWebContents })
  settingsRef.current = settings
  settings.initialize(app.getPath('userData'))

  const filtering = createFilteringPolicy({
    app,
    fs,
    path,
    rootDir,
    settings,
    webContents: electron.webContents
  })

  const prompt = installPromptManager({
    BrowserWindow: electron.BrowserWindow,
    ipc,
    path,
    rootDir,
    settings,
    windows
  })

  const viewManager = createViewManager({
    app,
    BrowserWindow: electron.BrowserWindow,
    createPrompt: prompt.createPrompt,
    electron,
    filterPopups: filtering.filterPopups,
    getWindowWebContents,
    ipc,
    path,
    rootDir,
    settings,
    WebContentsView: electron.WebContentsView,
    windows
  })
  viewManagerRef.current = viewManager

  const overlayManager = createOverlayManager({
    WebContentsView: electron.WebContentsView,
    getDefaultViewWebPreferences: viewManager.getDefaultViewWebPreferences,
    getWindowWebContents,
    windows
  })
  overlayRef.current = overlayManager

  const sendIPCToWindow = (...args) => runtimeRef.current.sendIPCToWindow(...args)
  const createWindow = (...args) => runtimeRef.current.createWindow(...args)

  const protocol = createProtocolPolicy({
    net: electron.net,
    path,
    protocol: electron.protocol,
    rootDir,
    Response: options.Response || global.Response
  })
  const userAgent = createUserAgentPolicy({ app, settings })
  const permissions = createPermissionManager({
    getTabIDFromWebContents: viewManager.getTabIDFromWebContents,
    ipc,
    sendIPCToWindow,
    windows
  })
  const downloads = createDownloadPolicy({
    getTabIDFromWebContents: viewManager.getTabIDFromWebContents,
    ipc,
    path,
    sendIPCToWindow,
    windows
  })
  const proxy = createProxyPolicy({ settings, webContents: electron.webContents })
  const sessionPolicies = createSessionPolicies([
    protocol,
    filtering,
    userAgent,
    permissions,
    downloads,
    proxy
  ])

  const remoteActions = installRemoteActions({
    app,
    createWindow,
    dialog: electron.dialog,
    ipc,
    session: electron.session,
    shell: electron.shell,
    windows
  })
  installRemoteMenu({ ipc, Menu: electron.Menu, MenuItem: electron.MenuItem })
  const menu = createMenu({
    app,
    createWindow,
    destroyAllViews: viewManager.destroyAllViews,
    electron,
    getPlacesWindow: () => runtimeRef.current.getPlacesWindow(),
    getWindowWebContents,
    isDebuggingEnabled,
    isDevelopmentMode,
    Menu: electron.Menu,
    openTabInWindow: url => runtimeRef.current.openTabInWindow(url),
    sendIPCToWindow,
    settings,
    showFocusModeDialog1: remoteActions.showFocusModeDialog1,
    showFocusModeDialog2: remoteActions.showFocusModeDialog2,
    userKeyMap,
    webContents: electron.webContents,
    windows
  })
  const touchBar = createTouchBar({
    TouchBar: electron.TouchBar,
    nativeImage: electron.nativeImage,
    sendIPCToWindow,
    windows
  })
  touchBarRef.current = touchBar

  let overlayHTML = ''
  try {
    overlayHTML = fs.readFileSync(path.join(rootDir, 'pages/commandPalette/overlay.html'), 'utf-8')
  } catch (error) {
    console.warn('Failed to load command palette overlay HTML:', error.message)
  }
  const commandPalette = createCommandPaletteOverlay({ overlayHTML, overlayManager })

  const runtime = createAppRuntime({
    buildAppMenu: menu.buildAppMenu,
    commandPalette,
    createDockMenu: menu.createDockMenu,
    electron,
    fs,
    installSessionPolicies: sessionPolicies.install,
    installThemePolicy: () => installThemePolicy({ nativeTheme: electron.nativeTheme, settings }),
    path,
    registryInstaller,
    rootDir,
    settings,
    windows
  })
  runtimeRef.current = runtime

  return {
    filtering,
    runtime,
    sessionPolicies,
    settings,
    viewManager,
    windows
  }
}

module.exports = createMainProcess
