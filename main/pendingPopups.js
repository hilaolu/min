// Pending popups have no tab owner yet. Keep them only until adoption or the
// originating Browser Chrome/window goes away, with one listener set per owner.
function createPendingPopups () {
  const entries = new Map()
  const owners = new Map()

  function remove (id) {
    const entry = entries.get(id)
    if (!entry) return null
    entries.delete(id)
    entry.view.webContents.removeListener('destroyed', entry.onDestroyed)
    const owner = entry.owner
    owner.ids.delete(id)
    if (owner.ids.size === 0) {
      owners.delete(owner.contents)
      owner.contents.removeListener('destroyed', owner.dispose)
      owner.contents.removeListener('render-process-gone', owner.dispose)
      owner.window.removeListener('closed', owner.dispose)
    }
    return entry
  }

  function destroy (id) {
    const entry = remove(id)
    if (entry && !entry.view.webContents.isDestroyed()) entry.view.webContents.destroy()
  }

  return {
    add (id, view, contents, window) {
      if (!contents || contents.isDestroyed() || !window || window.isDestroyed()) {
        if (!view.webContents.isDestroyed()) view.webContents.destroy()
        return false
      }
      let owner = owners.get(contents)
      if (!owner) {
        owner = { contents, window, ids: new Set() }
        owner.dispose = () => Array.from(owner.ids).forEach(destroy)
        owners.set(contents, owner)
        contents.once('destroyed', owner.dispose)
        contents.once('render-process-gone', owner.dispose)
        window.once('closed', owner.dispose)
      }
      const entry = { view, owner, onDestroyed: () => remove(id) }
      entries.set(id, entry)
      owner.ids.add(id)
      view.webContents.once('destroyed', entry.onDestroyed)
      return true
    },
    take (id, contents) {
      const entry = entries.get(id)
      if (!entry) return null
      if (entry.owner.contents !== contents) {
        const error = new Error('Popup belongs to another Browser Chrome')
        error.code = 'TAB_CONTENT_NOT_OWNER'
        throw error
      }
      remove(id)
      return entry.view
    },
    destroyAll () {
      Array.from(entries.keys()).forEach(destroy)
    }
  }
}

module.exports = createPendingPopups
