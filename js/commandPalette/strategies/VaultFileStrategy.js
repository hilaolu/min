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
      title: entry.relativePath,
      description: 'Open from vault',
      icon: 'carbon:document',
      action: () => this.open(entry.url)
    }))
    const direct = vaultFileCandidate(command, query, this.open)
    if (direct.action && !result.entries.some(entry => entry.url === direct.id.substring(`vault-${command}-`.length))) candidates.unshift(direct)
    if (!candidates.length) candidates.push({ id: 'vault-empty', title: 'No matching vault files', icon: 'carbon:search' })
    if (result.truncated) candidates.push({ id: 'vault-limit', title: 'Search limit reached; use an exact vault-relative path', icon: 'carbon:search' })
    return candidates
  }
}

module.exports = VaultFileStrategy
