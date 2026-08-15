const publicPlaceFields = [
  'id',
  'url',
  'title',
  'color',
  'visitCount',
  'lastVisit',
  'isBookmarked',
  'tags'
]

function projectPlace (item, extraFields = []) {
  if (!item) return null

  const result = {}
  publicPlaceFields.concat(extraFields).forEach(function (field) {
    if (item[field] === undefined) return
    if (Array.isArray(item[field])) {
      result[field] = item[field].slice()
    } else if (item[field] && typeof item[field] === 'object') {
      result[field] = Object.assign({}, item[field])
    } else {
      result[field] = item[field]
    }
  })
  return result
}

class PlacesCache {
  constructor ({ calculateScore, getSearchTextCache, tagIndex }) {
    this.calculateScore = calculateScore
    this.getSearchTextCache = getSearchTextCache
    this.tagIndex = tagIndex
    this.items = []
    this.byURL = new Map()
    this.byId = new Map()
    this.sorted = true
  }

  createSummary (item) {
    const summary = projectPlace(item)
    summary.searchTextCache = this.getSearchTextCache(summary)
    return summary
  }

  add (item, { sort = true } = {}) {
    const summary = this.createSummary(item)
    this.items.push(summary)
    this.byURL.set(summary.url, summary)
    if (summary.id !== undefined) this.byId.set(summary.id, summary)
    if (summary.isBookmarked) this.tagIndex.addPage(summary)
    if (sort) {
      this.sort()
    } else {
      this.sorted = false
    }
    return summary
  }

  upsert (item) {
    const oldItem = this.byURL.get(item.url)
    if (!oldItem) return this.add(item)

    const summary = this.createSummary(item)
    const index = this.items.indexOf(oldItem)
    this.items[index] = summary
    this.byURL.set(summary.url, summary)
    if (oldItem.id !== undefined) this.byId.delete(oldItem.id)
    if (summary.id !== undefined) this.byId.set(summary.id, summary)
    this.tagIndex.onChange(oldItem, summary)
    this.sort()
    return summary
  }

  removeByURL (url) {
    const item = this.byURL.get(url)
    if (!item) return false
    this.tagIndex.removePage(item)
    this.byURL.delete(url)
    if (item.id !== undefined) this.byId.delete(item.id)
    this.items.splice(this.items.indexOf(item), 1)
    return true
  }

  removeByIds (ids) {
    ids.forEach(id => {
      const item = this.byId.get(id)
      if (item) this.removeByURL(item.url)
    })
  }

  reset () {
    this.items.splice(0)
    this.byURL.clear()
    this.byId.clear()
    this.tagIndex.reset()
    this.sorted = true
  }

  sort () {
    this.items.sort((a, b) => this.calculateScore(b) - this.calculateScore(a))
    this.sorted = true
  }

  getByURL (url) {
    return this.byURL.get(url) || null
  }

  getById (id) {
    return this.byId.get(id) || null
  }

  getPublicByURL (url) {
    return projectPlace(this.getByURL(url))
  }

  getAllPublic () {
    return this.items.map(item => projectPlace(item))
  }

  getRecentPublic ({ after, excludeURLs = [], limit = 4, metrics } = {}) {
    const resultLimit = Number.isFinite(limit) ? Math.max(0, limit) : 4
    const excluded = excludeURLs instanceof Set ? excludeURLs : new Set(excludeURLs)
    const candidates = this.sorted
      ? this.items
      : this.items.slice().sort((a, b) => this.calculateScore(b) - this.calculateScore(a))
    const results = []
    let candidatesVisited = 0

    for (let index = 0; index < candidates.length && results.length < resultLimit; index++) {
      const item = candidates[index]
      candidatesVisited++
      if (Number.isFinite(after) && item.lastVisit <= after) continue
      if (excluded.has(item.url)) continue
      results.push(projectPlace(item))
    }

    if (metrics) {
      metrics.candidatesVisited = candidatesVisited
      metrics.resultCount = results.length
      metrics.usedSortedCache = this.sorted
    }
    return results
  }
}

module.exports = { PlacesCache, projectPlace, publicPlaceFields }
