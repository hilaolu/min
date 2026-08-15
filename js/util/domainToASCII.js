function domainToASCII (domain) {
  if (!domain) return ''

  const isBracketedIPv6 = domain.startsWith('[') && domain.endsWith(']')
  const hasInvalidSeparator = domain.includes('@') || domain.includes('/') || domain.includes('?') || domain.includes('#')
  if (hasInvalidSeparator || (domain.includes(':') && !isBracketedIPv6)) {
    return ''
  }
  try {
    const parsed = new URL('http://' + domain)
    if (parsed.username || parsed.password || parsed.port || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      return ''
    }
    return parsed.hostname
  } catch (error) {
    return ''
  }
}

module.exports = domainToASCII
