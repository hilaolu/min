const defaultFolder = 'Annotations'

function normalizeFolder (value) {
  if (typeof value !== 'string') throw new Error('Enter a vault-relative annotation folder')
  const folder = value.trim().replace(/\/$/, '')
  const hasControl = Array.from(folder).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  // Use portable directory names and keep the store inside visible vault paths.
  const invalidComponent = folder.split('/').some(part =>
    !part || part.startsWith('.') || /[\\:*?"<>|]/.test(part) || /[. ]$/.test(part) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) || part === 'node_modules')
  if (!folder || folder.length > 240 || hasControl || invalidComponent) {
    throw new Error('Use a vault-relative folder without hidden, reserved, or parent path components')
  }
  return folder
}

function isInFolder (relativePath, folder) {
  return relativePath === folder || relativePath.startsWith(folder + '/')
}

function nativeMatch (relativePath, folder = defaultFolder) {
  if (!relativePath.startsWith(folder + '/')) return null
  return relativePath.slice(folder.length + 1).match(/^([a-f0-9]{64})\.(md|json)$/)
}

module.exports = { defaultFolder, normalizeFolder, isInFolder, nativeMatch }
