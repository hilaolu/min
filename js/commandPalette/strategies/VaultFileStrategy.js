const { CommandStateStrategy } = require('../CommandStateStrategy.js')
const vaultFileCandidate = require('../vaultFileCandidate.js')

class VaultFileStrategy extends CommandStateStrategy {
  constructor (search, open) {
    super('VAULT_FILES', 90)
    this.search = search
    this.open = open
  }

  matches (input) {
    const match = input.trim().match(/^>(m|p|a)(?:\s+(.*))?$/i)
    return { matches: Boolean(match), data: match ? { command: match[1].toLowerCase(), query: match[2] || '' } : {} }
  }

  loadingCandidates () {
    // Clear stale actions while searching, without displaying a loading row.
    return []
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
      description: command !== 'm' ? `${entry.annotationCount} ${command === 'p' ? 'PDF' : 'webpage'} annotations · ${entry.source}` : 'Open from vault',
      icon: 'carbon:document',
      action: () => this.open(entry.url)
    }))
    const direct = command === 'm' ? vaultFileCandidate(command, query, this.open) : {}
    if (direct.action && !result.entries.some(entry => entry.url === direct.id.substring(`vault-${command}-`.length))) candidates.unshift(direct)
    const resources = command === 'p' ? 'PDFs' : 'web pages'
    if (!candidates.length) candidates.push({ id: 'vault-empty', title: command !== 'm' ? (result.total ? `No matching annotated ${resources}` : `No annotated ${resources} found`) : 'No matching vault files', icon: 'carbon:search' })
    if (result.errors) candidates.push({ id: 'vault-errors', title: 'Some annotation records could not be read or validated', description: result.diagnostics?.slice(0, 3).join(' · '), icon: 'carbon:warning' })
    if (result.truncated) candidates.push({ id: 'vault-limit', title: command !== 'm' ? 'Results limited; refine your query (vault scan may be incomplete)' : 'Search limit reached; use an exact vault-relative path', icon: 'carbon:search' })
    return candidates
  }
}

module.exports = VaultFileStrategy
