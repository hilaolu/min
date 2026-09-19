// Shared URL syntax only. Filesystem authorization lives in main/vault.js.
/* eslint-disable no-control-regex */
function invalid () {
  const error = new Error('Invalid vault URL')
  error.status = 400
  throw error
}

function parseVaultURL (input) {
  if (typeof input !== 'string' || !input.startsWith('vault://') || /[\\\s]/.test(input)) invalid()
  let url
  try { url = new URL(input) } catch (_) { invalid() }
  if (url.protocol !== 'vault:' || url.username || url.password || url.port) invalid()
  // The entire part after vault:// is a vault-relative path, not a host.
  // Read it verbatim so URL host parsing cannot change filename case.
  const pathname = input.slice('vault://'.length).split(/[?#]/)[0]
  let segments
  try { segments = pathname.split('/').filter(Boolean).map(decodeURIComponent) } catch (_) { invalid() }
  for (const segment of segments) {
    // Use the same portable filename policy on every platform (including ADS).
    if (segment === '.' || segment === '..' || /[\x00-\x1f\x7f/\\:<>"|?*]/.test(segment) || /[. ]$/.test(segment) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)) invalid()
  }
  const suffix = pathname.endsWith('/') && segments.length ? '/' : ''
  return { segments, vaultURL: 'vault://' + segments.map(encodeURIComponent).join('/') + suffix }
}

function resolveNoteReference (reference, documentURL) {
  if (typeof reference !== 'string' || /[\\\x00-\x1f]/.test(reference)) invalid()
  const base = parseVaultURL(documentURL).vaultURL
  if (reference.startsWith('#')) return reference
  if (/^https?:\/\//i.test(reference)) return new URL(reference).href
  if (reference.startsWith('vault://')) {
    const parsed = parseVaultURL(reference)
    return parsed.vaultURL + new URL(reference).search + new URL(reference).hash
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(reference) || reference.startsWith('//')) invalid()
  let depth = reference.startsWith('/') ? 0 : parseVaultURL(base).segments.length - 1
  for (const encoded of reference.split(/[?#]/)[0].split('/')) {
    let segment
    try { segment = decodeURIComponent(encoded) } catch (_) { invalid() }
    if (segment === '..') { if (--depth < 0) invalid() } else if (segment && segment !== '.') depth++
  }
  // A temporary authority keeps the first filename component in the path
  // while applying normal relative/root-relative URL resolution.
  const resolved = new URL(reference, 'https://vault.invalid/' + base.slice('vault://'.length))
  return parseVaultURL('vault://' + resolved.pathname.slice(1)).vaultURL + resolved.search + resolved.hash
}

if (typeof module !== 'undefined') module.exports = { parseVaultURL, resolveNoteReference }
