const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

function createDatabase (initialRecords = []) {
  const records = initialRecords.map(item => ({ ...item }))
  let nextId = records.reduce((maximum, item) => Math.max(maximum, item.id || 0), 0) + 1

  function urlCollection (url) {
    return {
      delete: function () {
        const index = records.findIndex(item => item.url === url)
        if (index >= 0) records.splice(index, 1)
        return Promise.resolve()
      },
      first: () => Promise.resolve(records.find(item => item.url === url))
    }
  }

  const places = {
    orderBy: function () {
      return {
        reverse: function () {
          return {
            each: function (visit) {
              records.forEach(item => visit({ ...item }))
              return Promise.resolve()
            }
          }
        }
      }
    },
    put: function (item) {
      if (!item.id) item.id = nextId++
      const index = records.findIndex(record => record.id === item.id)
      if (index >= 0) records[index] = { ...item }
      else records.push({ ...item })
      return Promise.resolve(item.id)
    },
    update: function (id, changes) {
      const item = records.find(record => record.id === id)
      Object.assign(item, changes)
      return Promise.resolve(1)
    },
    where: function (field) {
      if (field === 'url') return { equals: urlCollection }
      if (field === 'lastVisit') {
        return {
          below: function (time) {
            let predicate = item => item.lastVisit < time
            return {
              and: function (additionalPredicate) {
                predicate = item => item.lastVisit < time && additionalPredicate(item)
                return {
                  delete: function () {
                    for (let index = records.length - 1; index >= 0; index--) {
                      if (predicate(records[index])) records.splice(index, 1)
                    }
                    return Promise.resolve()
                  },
                  primaryKeys: () => Promise.resolve(records.filter(predicate).map(item => item.id))
                }
              }
            }
          }
        }
      }
      throw new Error(`unsupported index ${field}`)
    }
  }

  return {
    db: {
      places,
      transaction: (mode, table, callback) => Promise.resolve(callback())
    },
    records
  }
}

async function loadService (initialRecords = []) {
  const database = createDatabase(initialRecords)
  const tokenizeCalls = []
  const fullTextCalls = []
  const timers = []
  let connection
  const tagIndex = {
    addPage: function () {},
    autocompleteTags: () => [],
    getAllTagsRanked: () => [],
    getSuggestedItemsForTags: () => [],
    getSuggestedTags: () => [],
    onChange: function () {},
    removePage: function () {},
    reset: function () {}
  }
  const context = vm.createContext({
    console: { error: function () {}, warn: function () {} },
    db: database.db,
    Dexie: { Promise },
    fullTextPlacesSearch: function (text, respond, options) {
      fullTextCalls.push({ options, respond, text })
      return Promise.resolve()
    },
    getSearchTextCache: item => ({ title: item.title.toLowerCase(), url: item.url.toLowerCase() }),
    module: { exports: {} },
    require: function (request) {
      if (request === 'electron') return { ipcRenderer: {} }
      if (request === './placesCache.js') return require('../js/places/placesCache.js')
      if (request === './placesServiceConnection.js') {
        return function (options) { connection = options }
      }
      throw new Error(`unexpected require ${request}`)
    },
    searchPlaces: (text, respond) => respond([]),
    setInterval: function () {},
    setTimeout: work => { timers.push(work) },
    tagIndex,
    tokenize: text => {
      tokenizeCalls.push(text)
      return text.split(/\s+/)
    }
  })
  const source = fs.readFileSync(path.resolve(__dirname, '../js/places/placesService.js'), 'utf8')
  vm.runInContext(source, context, { filename: 'placesService.js' })
  await connection.ready
  return { connection, database, fullTextCalls, timers, tokenizeCalls }
}

function request (service, data) {
  const responses = []
  return Promise.resolve(service.connection.handleRequest(data, response => responses.push(response)))
    .then(() => responses)
}

test('unchanged revisits persist visit metadata without retokenizing or rewriting the body', async function () {
  const stored = {
    id: 1,
    url: 'https://example.com',
    title: 'Example',
    visitCount: 3,
    lastVisit: 10,
    extractedText: 'stable body',
    searchIndex: ['stable', 'body'],
    isBookmarked: false,
    tags: []
  }
  const service = await loadService([stored])

  await request(service, {
    action: 'updatePlace',
    callbackId: 1,
    flags: { isNewVisit: true },
    pageData: { url: stored.url, title: 'Updated', extractedText: 'stable body' }
  })

  assert.deepEqual(service.tokenizeCalls, [])
  assert.equal(service.database.records[0].visitCount, 4)
  assert.equal(service.database.records[0].title, 'Updated')
  assert.equal(service.database.records[0].extractedText, 'stable body')

  await request(service, {
    action: 'updatePlace',
    callbackId: 2,
    pageData: { url: stored.url, extractedText: 'changed body' }
  })
  assert.deepEqual(service.tokenizeCalls, ['changed body'])
})

test('cleanup removes expired rows from storage and the resident summary cache', async function () {
  const service = await loadService([{
    id: 1,
    url: 'https://expired.example',
    title: 'Expired',
    visitCount: 1,
    lastVisit: 0,
    extractedText: 'large',
    searchIndex: ['large'],
    isBookmarked: false,
    tags: []
  }])

  await service.timers[0]()
  const responses = await request(service, {
    action: 'getPlace',
    callbackId: 3,
    pageData: { url: 'https://expired.example' }
  })

  assert.equal(service.database.records.length, 0)
  assert.equal(responses[0].result, null)
})

test('Places suggestions preserve score order, exclusions, bounds, and public projection', async function () {
  const now = Date.now()
  const records = Array.from({ length: 5 }, (_, index) => ({
    id: index + 1,
    url: `https://example.com/${index + 1}`,
    title: `Example ${index + 1}`,
    visitCount: 1,
    lastVisit: now - (5 - index) * 1000,
    extractedText: 'large private body',
    searchIndex: ['large'],
    isBookmarked: false,
    tags: []
  }))
  const service = await loadService(records)

  const responses = await request(service, {
    action: 'getPlaceSuggestions',
    callbackId: 8,
    options: { excludeURLs: [records[4].url], limit: 2 }
  })

  assert.deepEqual(Array.from(responses[0].result, item => item.id), [4, 3])
  assert.equal(responses[0].result.length, 2)
  assert.equal('extractedText' in responses[0].result[0], false)
})

test('a newer full-text request completes the superseded request exactly once', async function () {
  const service = await loadService()
  const firstResponses = []
  const secondResponses = []

  service.connection.handleRequest({
    action: 'searchPlacesFullText', callbackId: 4, text: 'first', options: { limit: 4 }
  }, response => firstResponses.push(response))
  service.connection.handleRequest({
    action: 'searchPlacesFullText', callbackId: 5, text: 'second', options: { limit: 2 }
  }, response => secondResponses.push(response))

  assert.equal(service.fullTextCalls[0].options.isCancelled(), true)

  service.fullTextCalls[0].respond([{ id: 1 }], null)
  service.fullTextCalls[1].respond([{ id: 2 }], null)

  assert.equal(firstResponses.length, 1)
  assert.equal(firstResponses[0].error.code, 'PLACES_QUERY_SUPERSEDED')
  assert.equal(secondResponses.length, 1)
  assert.equal(secondResponses[0].callbackId, 5)
  assert.equal(secondResponses[0].result[0].id, 2)
})

test('full-text supersession is isolated to each Browser Window connection', async function () {
  const service = await loadService()
  const firstResponses = []
  const secondResponses = []
  const firstContext = {}
  const secondContext = {}

  service.connection.handleRequest({
    action: 'searchPlacesFullText', callbackId: 6, text: 'first', options: { limit: 4 }
  }, response => firstResponses.push(response), firstContext)
  service.connection.handleRequest({
    action: 'searchPlacesFullText', callbackId: 7, text: 'second', options: { limit: 4 }
  }, response => secondResponses.push(response), secondContext)

  assert.equal(service.fullTextCalls[0].options.isCancelled(), false)
  assert.equal(service.fullTextCalls[1].options.isCancelled(), false)

  service.fullTextCalls[0].respond([{ id: 1 }], null)
  service.fullTextCalls[1].respond([{ id: 2 }], null)
  assert.equal(firstResponses[0].result[0].id, 1)
  assert.equal(secondResponses[0].result[0].id, 2)
})
