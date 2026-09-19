// Only Settings gets configuration authority. Raw vault documents get no API.
if (process.isMainFrame && window.location.href.split('?')[0] === 'min://app/pages/pdfViewer/index.html') {
  const { contextBridge, ipcRenderer } = require('electron')
  contextBridge.exposeInMainWorld('pdfAnnotations', {
    readFile: () => ipcRenderer.invoke('pdf-annotations', 'read-file'),
    load: () => ipcRenderer.invoke('pdf-annotations', 'load'),
    save: payload => ipcRenderer.invoke('pdf-annotations', 'save', payload),
    importLegacy: text => ipcRenderer.invoke('pdf-annotations', 'import', text)
  })
}

if (process.isMainFrame && window.location.href === 'min://app/pages/settings/index.html') {
  require('electron').contextBridge.exposeInMainWorld('vaultSettings', {
    getRoot: () => require('electron').ipcRenderer.invoke('vault:get-root'),
    selectRoot: directory => require('electron').ipcRenderer.invoke('vault:select-root', directory)
  })
}

if (process.isMainFrame && ['min://app/pages/markdown/index.html', 'min://app/pages/vault/index.html'].includes(window.location.href.split('?')[0])) {
  const { contextBridge, ipcRenderer } = require('electron')
  contextBridge.exposeInMainWorld('vaultPage', {
    readCurrent: () => ipcRenderer.invoke('vault:read'),
    saveCurrent: text => ipcRenderer.invoke('vault:save', text),
    listCurrent: query => ipcRenderer.invoke('vault:list', query),
    listDirectory: url => ipcRenderer.invoke('vault:list', '', url),
    open: url => ipcRenderer.invoke('vault:open', url)
  })
}
