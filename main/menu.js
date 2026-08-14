function buildAppMenu (options = {}) {
  const keyMap = userKeyMap(settings.get('keyMap'))

  function getFormattedKeyMapEntry (keybinding) {
    const value = keyMap[keybinding]

    if (value) {
      if (Array.isArray(value)) {
        // value is array if multiple entries are set
        return value[0].replace('mod', 'CmdOrCtrl')
      } else {
        return value.replace('mod', 'CmdOrCtrl')
      }
    }

    return null
  }

  var tabTaskActions = [
    {
      label: 'New Tab',
      accelerator: getFormattedKeyMapEntry('addTab'),
      click: function (item, window, event) {
        // keyboard shortcuts for these items are handled in the renderer
        if (!event.triggeredByAccelerator) {
          sendIPCToWindow(window, 'addTab')
        }
      }
    },
    {
      label: 'New Private Tab',
      accelerator: getFormattedKeyMapEntry('addPrivateTab'),
      click: function (item, window, event) {
        if (!event.triggeredByAccelerator) {
          sendIPCToWindow(window, 'addPrivateTab')
        }
      }
    },
    {
      label: 'New Task',
      accelerator: getFormattedKeyMapEntry('addTask'),
      click: function (item, window, event) {
        if (!event.triggeredByAccelerator) {
          sendIPCToWindow(window, 'addTask')
        }
      }
    },
    {
      label: 'New Window',
      accelerator: getFormattedKeyMapEntry('addWindow'),
      click: function () {
        if (isFocusMode) {
          showFocusModeDialog2()
        } else {
          createWindow()
        }
      }
    }
  ]

  var personalDataItems = [
    {
      label: 'Bookmarks',
      accelerator: getFormattedKeyMapEntry('showBookmarks'),
      click: function (item, window, event) {
        if (!event.triggeredByAccelerator) {
          sendIPCToWindow(window, 'showBookmarks')
        }
      }
    },
    {
      label: 'History',
      accelerator: getFormattedKeyMapEntry('showHistory'),
      click: function (item, window, event) {
        if (!event.triggeredByAccelerator) {
          sendIPCToWindow(window, 'showHistory')
        }
      }
    }
  ]

  var quitAction = {
    label: `Quit ${app.name}`,
    accelerator: getFormattedKeyMapEntry('quitMin'),
    click: function (item, window, event) {
      if (!event.triggeredByAccelerator) {
        app.quit()
      }
    }
  }

  var preferencesAction = {
    label: 'Preferences',
    accelerator: 'CmdOrCtrl+,',
    click: function (item, window) {
      sendIPCToWindow(window, 'addTab', {
        url: 'min://app/pages/settings/index.html'
      })
    }
  }

  var template = [
    ...(options.secondary ? tabTaskActions : []),
    ...(options.secondary ? [{ type: 'separator' }] : []),
    ...(options.secondary ? personalDataItems : []),
    ...(options.secondary ? [{ type: 'separator' }] : []),
    ...(options.secondary ? [preferencesAction] : []),
    ...(options.secondary ? [{ type: 'separator' }] : []),
    ...(process.platform === 'darwin'
      ? [
        {
          label: app.name,
          submenu: [
            {
              label: `About ${app.name}`,
              role: 'about'
            },
            {
              type: 'separator'
            },
            preferencesAction,
            {
              label: 'Services',
              role: 'services',
              submenu: []
            },
            {
              type: 'separator'
            },
            {
              label: `Hide ${app.name}`,
              accelerator: 'CmdOrCtrl+H',
              role: 'hide'
            },
            {
              label: 'Hide Others',
              accelerator: 'CmdOrCtrl+Alt+H',
              role: 'hideothers'
            },
            {
              label: 'Show All',
              role: 'unhide'
            },
            {
              type: 'separator'
            },
            quitAction
          ]
        }
      ] : []),
    {
      label: 'File',
      submenu: [
        ...(!options.secondary ? tabTaskActions : []),
        ...(!options.secondary ? [{ type: 'separator' }] : []),
        {
          label: 'Save Page As',
          accelerator: 'CmdOrCtrl+s',
          click: function (item, window) {
            sendIPCToWindow(window, 'saveCurrentPage')
          }
        },
        {
          type: 'separator'
        },
        {
          label: 'Print',
          accelerator: 'CmdOrCtrl+p',
          click: function (item, window) {
            sendIPCToWindow(window, 'print')
          }
        },
        ...(!options.secondary && process.platform === 'linux' ? [{ type: 'separator' }] : []),
        ...(!options.secondary && process.platform === 'linux' ? [quitAction] : [])
      ]
    },
    {
      label: 'Edit',
      submenu: [
        {
          label: 'Undo',
          accelerator: 'CmdOrCtrl+Z',
          role: 'undo'
        },
        {
          label: 'Redo',
          accelerator: 'Shift+CmdOrCtrl+Z',
          role: 'redo'
        },
        {
          type: 'separator'
        },
        {
          label: 'Cut',
          accelerator: 'CmdOrCtrl+X',
          role: 'cut'
        },
        {
          label: 'Copy',
          accelerator: 'CmdOrCtrl+C',
          role: 'copy'
        },
        {
          label: 'Paste',
          accelerator: 'CmdOrCtrl+V',
          role: 'paste'
        },
        {
          label: 'Paste and Match Style',
          accelerator: 'Shift+CmdOrCtrl+V',
          role: 'pasteAndMatchStyle'
        },
        {
          label: 'Select All',
          accelerator: 'CmdOrCtrl+A',
          role: 'selectall'
        },
        {
          type: 'separator'
        },
        {
          label: 'Find',
          accelerator: 'CmdOrCtrl+F',
          click: function (item, window) {
            sendIPCToWindow(window, 'findInPage')
          }
        },
        ...(!options.secondary && process.platform !== 'darwin' ? [{ type: 'separator' }] : []),
        ...(!options.secondary && process.platform !== 'darwin' ? [preferencesAction] : [])
      ]
    },
    {
      label: 'View',
      submenu: [
        ...(!options.secondary ? personalDataItems : []),
        ...(!options.secondary ? [{ type: 'separator' }] : []),
        {
          label: 'Zoom In',
          accelerator: 'CmdOrCtrl+Plus',
          click: function (item, window) {
            sendIPCToWindow(window, 'zoomIn')
          }
        },
        // Hidden item to enable shortcut on keyboards where = is on a different physical key than +
        {
          label: 'Zoom In',
          accelerator: 'CmdOrCtrl+=',
          click: function (item, window) {
            sendIPCToWindow(window, 'zoomIn')
          },
          visible: false
        },
        {
          label: 'Zoom Out',
          accelerator: 'CmdOrCtrl+-',
          click: function (item, window) {
            sendIPCToWindow(window, 'zoomOut')
          }
        },
        {
          label: 'Actual Size',
          accelerator: undefined,
          click: function (item, window) {
            sendIPCToWindow(window, 'zoomReset')
          }
        },
        {
          type: 'separator'
        },
        {
          label: 'Focus Mode',
          accelerator: undefined,
          type: 'checkbox',
          checked: false,
          click: function (item, window) {
            if (isFocusMode) {
              isFocusMode = false
              windows.getAll().forEach(win => sendIPCToWindow(win, 'exitFocusMode'))
            } else {
              isFocusMode = true
              windows.getAll().forEach(win => sendIPCToWindow(win, 'enterFocusMode'))

              // wait to show the message until the tabs have been hidden, to make the message less confusing
              setTimeout(function () {
                showFocusModeDialog1()
              }, 16)
            }
          }
        },
        {
          label: 'Full Screen',
          accelerator: (function () {
            if (process.platform === 'darwin') { return 'Ctrl+Command+F' } else { return 'F11' }
          })(),
          role: 'togglefullscreen'
        }
      ]
    },
    {
      label: 'Developer',
      submenu: [
        {
          label: 'Inspect Page',
          accelerator: (function () {
            if (process.platform === 'darwin') { return 'Cmd+Alt+I' } else { return 'Ctrl+Shift+I' }
          })(),
          click: function (item, window) {
            sendIPCToWindow(window, 'inspectPage')
          }
        },
        // this is defined a second time (but hidden) in order to provide two keyboard shortcuts
        {
          label: 'Inspect Page',
          visible: false,
          accelerator: 'f12',
          click: function (item, window) {
            sendIPCToWindow(window, 'inspectPage')
          }
        },
        ...(isDevelopmentMode || isDebuggingEnabled
          ? [
            {
              type: 'separator'
            },
            {
              label: 'Reload Browser',
              accelerator: (isDevelopmentMode ? 'alt+CmdOrCtrl+R' : undefined),
              click: function (item, focusedWindow) {
                destroyAllViews()
                windows.getAll().forEach(win => win.close())
                createWindow()
              }
            },
            {
              label: 'Inspect Browser',
              accelerator: (function () {
                if (process.platform === 'darwin') { return 'Shift+Cmd+Alt+I' } else { return 'Ctrl+Shift+Alt+I' }
              })(),
              click: function (item, focusedWindow) {
                if (focusedWindow) getWindowWebContents(focusedWindow).toggleDevTools()
              }
            },
            {
              label: 'Inspect Places Service',
              click: function (item, focusedWindow) {
                placesWindow.webContents.openDevTools({ mode: 'detach' })
              }
            }
          ] : [])
      ]
    },
    ...(process.platform === 'darwin' ? [
      {
        label: 'Window',
        role: 'window',
        submenu: [
          {
            label: 'Minimize',
            accelerator: 'CmdOrCtrl+M',
            role: 'minimize'
          },
          {
            label: 'Close',
            accelerator: 'CmdOrCtrl+W',
            click: function (item, window) {
              if (windows.getAll().length > 0 && !windows.getAll().some(win => win.isFocused())) {
                // a devtools window is focused, close it
                var contents = webContents.getAllWebContents()
                for (var i = 0; i < contents.length; i++) {
                  if (contents[i].isDevToolsFocused()) {
                    contents[i].closeDevTools()
                    return
                  }
                }
              }
            // otherwise, this event will be handled in the main window
            }
          },
          {
            label: 'Always on Top',
            type: 'checkbox',
            checked: settings.get('windowAlwaysOnTop') || false,
            click: function (item, window) {
              windows.getAll().forEach(function (win) {
                win.setAlwaysOnTop(item.checked)
              })
              settings.set('windowAlwaysOnTop', item.checked)
            }
          },
          {
            type: 'separator'
          },
          {
            label: 'Bring All to Front',
            role: 'front'
          }
        ]
      }
    ] : []),
    {
      label: 'Help',
      role: 'help',
      submenu: [
        {
          label: 'Keyboard Shortcuts',
          click: function () {
            openTabInWindow('https://github.com/minbrowser/min/wiki#keyboard-shortcuts')
          }
        },
        {
          label: 'Report a Bug',
          click: function () {
            openTabInWindow('https://github.com/minbrowser/min/issues/new')
          }
        },
        {
          label: 'Take a Tour',
          click: function () {
            openTabInWindow('https://minbrowser.github.io/min/tour/')
          }
        },
        {
          label: 'View on GitHub',
          click: function () {
            openTabInWindow('https://github.com/minbrowser/min')
          }
        },
        ...(process.platform !== 'darwin' ? [{ type: 'separator' }] : []),
        ...(process.platform !== 'darwin' ? [{
          label: `About ${app.name}`,
          click: function (item, window) {
            var info = [
              'Min v' + app.getVersion(),
              'Chromium v' + process.versions.chrome
            ]
            electron.dialog.showMessageBox({
              type: 'info',
              title: `About ${app.name}`,
              message: info.join('\n'),
              buttons: ['OK']
            })
          }
        }] : [])
      ]
    },
    ...(options.secondary && process.platform !== 'darwin' ? [{ type: 'separator' }] : []),
    ...(options.secondary && process.platform !== 'darwin' ? [quitAction] : [])
  ]
  return Menu.buildFromTemplate(template)
}

function createDockMenu () {
  // create the menu. based on example from https://github.com/electron/electron/blob/master/docs/tutorial/desktop-environment-integration.md#custom-dock-menu-macos
  if (process.platform === 'darwin') {
    var Menu = electron.Menu

    var template = [
      {
        label: 'New Tab',
        click: function (item, window) {
          sendIPCToWindow(window, 'addTab')
        }
      },
      {
        label: 'New Private Tab',
        click: function (item, window) {
          sendIPCToWindow(window, 'addPrivateTab')
        }
      },
      {
        label: 'New Task',
        click: function (item, window) {
          sendIPCToWindow(window, 'addTask')
        }
      },
      {
        label: 'New Window',
        click: function () {
          if (isFocusMode) {
            showFocusModeDialog2()
          } else {
            createWindow()
          }
        }
      }
    ]

    var dockMenu = Menu.buildFromTemplate(template)
    app.dock.setMenu(dockMenu)
  }
}
