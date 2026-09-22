// Paths are vault-relative and use forward slashes, not the absolute root.
function isHiddenPath (relativePath) {
  return relativePath.split('/').some(component => component.startsWith('.'))
}

module.exports = { isHiddenPath }
