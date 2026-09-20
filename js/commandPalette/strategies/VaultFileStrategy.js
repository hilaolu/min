const { CommandStateStrategy } = require('../CommandStateStrategy.js')
const vaultFileCandidate = require('../vaultFileCandidate.js')

class VaultFileStrategy extends CommandStateStrategy {
  constructor (search, open) {
    super('VAULT_FILES', 90)
    this.search = search
    this.open = open
  }

  matches (input) {
    const match = input.trim().match(/^>(m|p)(?:\s+(.*))?$/i)
    return { matches: Boolean(match), data: match ? { command: match[1].toLowerCase(), query: match[2] || '' } : {} }
  }

  loadingCandidates () {
    return [{ id: 'vault-loading', title: 'Searching vault…', icon: 'carbon:search' }]
  }

  async updateUI (input, { command, query }) {
    let result
    try { result = await this.search(command, query) } catch (_) {
      result = { ok: false, error: 'Vault search failed. Check vault Settings and retry.' }
    }
    if (!result.ok) return [{ id: 'vault-error', title: result.error, icon: 'carbon:warning' }]
    const candidates = result.entries.map(entry => ({
      id: entry.url,
      title: entry.title || entry.relativePath,
      description: command === 'p' ? `${entry.annotationCount} PDF annotations · ${entry.source}` : 'Open from vault',
      icon: 'carbon:document',
      action: () => this.open(entry.url)
    }))
    const direct = command === 'm' ? vaultFileCandidate(command, query, this.open) : {}
    if (direct.action && !result.entries.some(entry => entry.url === direct.id.substring(`vault-${command}-`.length))) candidates.unshift(direct)
    if (!candidates.length) candidates.push({ id: 'vault-empty', title: command === 'p' ? (result.total ? 'No matching annotated PDFs' : 'No annotated PDFs found') : 'No matching vault files', icon: 'carbon:search' })
    if (result.errors) candidates.push({ id: 'vault-errors', title: 'Some annotation records could not be read or validated', description: result.diagnostics?.slice(0, 3).join(' · '), icon: 'carbon:warning' })
    if (result.truncated) candidates.push({ id: 'vault-limit', title: command === 'p' ? 'Results limited; refine your query (vault scan may be incomplete)' : 'Search limit reached; use an exact vault-relative path', icon: 'carbon:search' })
    return candidates
  }
}

module.exports = VaultFileStrategy
