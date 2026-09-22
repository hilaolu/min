// Shared numeric policy for imported and stored PDF rectangles. Zero-sized
// rectangles remain valid for compatibility with existing annotation records.
function validRect (value) {
  if (!value || !value.origin || !value.size) return false
  const { x, y } = value.origin
  const { width, height } = value.size
  return [x, y, width, height].every(n => Number.isFinite(n) && Math.abs(n) <= 1000000) &&
    width >= 0 && height >= 0
}

module.exports = { validRect }
