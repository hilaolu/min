// Track manual position and size separately from the last rendered rectangle.
// Copy geometry: the PDF backend may mutate the objects it receives.
function pdfNoteLayout (automatic, previous, current) {
  current = current || previous?.rect
  const moved = Boolean(previous && (previous.moved || current.origin.x !== previous.rect.origin.x || current.origin.y !== previous.rect.origin.y))
  const resized = Boolean(previous && (previous.resized || current.size.width !== previous.rect.size.width || current.size.height !== previous.rect.size.height))
  return {
    moved,
    resized,
    rect: {
      origin: { ...(moved ? current.origin : automatic.origin) },
      size: { ...(resized ? current.size : automatic.size) }
    }
  }
}

if (typeof module !== 'undefined') module.exports = pdfNoteLayout
