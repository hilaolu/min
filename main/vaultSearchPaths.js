// Paths are vault-relative and use forward slashes, not the absolute root.
function isHiddenPath (relativePath) {
  return relativePath.split('/').some(component => component.startsWith('.'))
}

// Internal annotation records are metadata, never searchable vault files.
function isAnnotationMetadata (relativePath) {
  return relativePath === '.min-annotations' || /^\.min-annotations\/[a-f0-9]{64}\.(md|json)$/.test(relativePath)
}

module.exports = { isHiddenPath, isAnnotationMetadata }
