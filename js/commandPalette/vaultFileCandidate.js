// Paths are literal vault-relative filenames, not URLs or search queries.
function vaultFileCandidate (command, input, open) {
  const extension = command === 'm' ? '.md' : '.pdf'
  const label = command === 'm' ? 'Markdown' : 'PDF'
  const path = input.trim()
  const segments = path.split('/')
  const valid = path.toLowerCase().endsWith(extension) &&
    !/[\\:\x00-\x1f\x7f]/.test(path) && // eslint-disable-line no-control-regex
    segments.every(segment => segment && segment !== '.' && segment !== '..')
  if (!valid) {
    return {
      id: 'vault-path-help',
      title: `Open vault ${label}`,
      description: `Enter a vault-relative ${extension} path, e.g. >${command} folder/file${extension}`,
      icon: 'carbon:document'
    }
  }
  const url = 'vault://local/' + segments.map(encodeURIComponent).join('/')
  return {
    id: `vault-${command}-${url}`,
    title: `Open ${label}: ${path}`,
    description: 'Open from the folder configured in vault Settings',
    icon: 'carbon:document',
    action: () => open(url)
  }
}

module.exports = vaultFileCandidate
