const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const { createRequire } = require('node:module')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')

const yieldTurn = () => new Promise(resolve => setImmediate(resolve))

// Forced collections belong only in this isolated measurement process.
function retainedHeap () {
  global.gc()
  global.gc()
  return process.memoryUsage().heapUsed
}

function loadSource (source, productionModule, globals = {}, expression = 'module.exports') {
  const context = vm.createContext({
    module: { exports: {} },
    // Resolve dependencies beside production even when the source is in /tmp.
    require: createRequire(productionModule),
    Buffer,
    process,
    setImmediate,
    clearImmediate,
    setTimeout,
    clearTimeout,
    ...globals
  })
  return vm.runInContext(fs.readFileSync(source, 'utf8') + '\n' + expression, context, { filename: source })
}

function runGenerator (iterator) {
  function step (method, value) {
    let next
    try {
      next = iterator[method](value)
    } catch (error) {
      return Promise.reject(error)
    }
    if (next.done) return Promise.resolve(next.value)
    return Promise.resolve(next.value).then(
      value => step('next', value),
      error => step('throw', error)
    )
  }
  return step('next')
}

async function fullText (source, productionModule) {
  const count = 100000
  let metadataScanCalls = 0
  let lateScanBytes
  let beforeBodiesBytes
  let queriedIds
  const tags = []
  tags.join = function () {
    metadataScanCalls++
    // Sample near the end of candidate scanning, NOT a true peak.
    if (metadataScanCalls === count) lateScanBytes = retainedHeap() - baseline
    return ''
  }
  const summaries = Array.from({ length: count }, (_, id) => ({
    id,
    url: `https://record${id}.example/`,
    title: `Record ${id}`,
    lastVisit: (id * 17) % 1009,
    visitCount: 1,
    tags
  }))
  const db = {
    transaction: (mode, table, generator) => runGenerator(generator()),
    places: {
      where (index) {
        if (index === 'searchIndex') {
          return {
            equals (token) {
              assert.ok(token === 'alpha' || token === 'beta')
              return {
                // No fixture-level posting arrays survive either query.
                primaryKeys: () => Promise.resolve(Array.from({ length: count }, (_, id) => id))
              }
            }
          }
        }
        assert.equal(index, 'id')
        return {
          anyOf (ids) {
            queriedIds = Array.from(ids)
            return {
              toArray: () => new Promise(resolve => {
                setImmediate(() => {
                  beforeBodiesBytes = retainedHeap() - baseline
                  resolve(Array.from(ids, id => ({ id, extractedText: 'alpha beta' })))
                })
              })
            }
          }
        }
      }
    }
  }
  const query = loadSource(source, productionModule, {
    historyInMemoryCache: summaries,
    calculateHistoryScore: item => item.lastVisit,
    nonLetterRegex: /[^\s0-9A-Za-z]/g,
    Dexie: { Promise },
    db
  }, 'fullTextQuery')
  await yieldTurn()
  // Empty-query baseline: fixture and VM exist, but no query has been started.
  const baseline = retainedHeap()
  const result = await query(['alpha', 'beta'], { limit: 4 })

  // Independent stable-sort verification allocates only AFTER both samples.
  const expectedIds = summaries.slice().sort((a, b) => b.lastVisit - a.lastVisit)
    .slice(0, 12).map(item => item.id)
  assert.deepEqual(queriedIds, expectedIds)
  assert.equal(metadataScanCalls, count)
  assert.equal(result.candidateCount, count)
  assert.equal(result.documentsLoaded, 12)
  assert.equal(result.documents.length, 12)
  assert.deepEqual(Array.from(result.documents, document => document.id), expectedIds)
  const tokenMatchCounts = { ...result.tokenMatchCounts }
  assert.deepEqual(tokenMatchCounts, { alpha: count, beta: count })
  assert.ok(Number.isFinite(lateScanBytes))
  assert.ok(Number.isFinite(beforeBodiesBytes))
  return {
    candidateCount: result.candidateCount,
    documentsLoaded: result.documentsLoaded,
    tokenMatchCounts,
    metadataScanCalls,
    queriedIds,
    lateScanBytes,
    beforeBodiesBytes
  }
}

async function writeVaultFiles (root) {
  for (let id = 0; id < 8; id++) {
    const bytes = Buffer.alloc(4 * 1024 * 1024, 'x')
    bytes.write(`record-${id} needle `, 0, 'utf8')
    await fs.promises.writeFile(path.join(root, `record-${id}.txt`), bytes)
  }
}

async function vault (source, productionModule) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'min-search-memory-'))
  try {
    await writeVaultFiles(root)
    const search = loadSource(source, productionModule)
    // The writer has returned; no file-sized fixture buffers cross the baseline.
    await yieldTurn()
    const baseline = retainedHeap()
    const baselineMemory = process.memoryUsage()
    const result = await search(root, 'vault://', 'needle', () => true, { exact: true })
    await yieldTurn()
    const retainedHeapBytes = retainedHeap() - baseline
    const memory = process.memoryUsage()

    assert.equal(result.ok, true)
    assert.equal(result.entries.length, 8)
    assert.equal(result.total, 8)
    let retainedChars = 0
    for (const entry of result.entries) {
      assert.ok(!path.isAbsolute(entry.relativePath))
      const snippet = entry.passage.text
      assert.ok(snippet.length < 1000)
      assert.equal(entry.passage.ranges.length, 1)
      for (const [start, end] of entry.passage.ranges) {
        assert.equal(snippet.slice(start, end), 'needle')
      }
      retainedChars += snippet.length
    }
    const serialized = JSON.stringify(result)
    assert.ok(!serialized.includes(root))
    return {
      results: result.entries.length,
      retainedChars,
      digest: createHash('sha256').update(serialized).digest('hex'),
      retainedHeapBytes,
      retainedExternalBytes: memory.external - baselineMemory.external,
      retainedArrayBufferBytes: memory.arrayBuffers - baselineMemory.arrayBuffers
    }
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true })
  }
}

async function main () {
  assert.equal(typeof global.gc, 'function', 'Run with --expose-gc')
  const [workload, ...options] = process.argv.slice(2)
  assert.ok(workload === 'full-text' || workload === 'vault', 'Workload must be full-text or vault')
  assert.ok(options.length <= 1 && options.every(option => option.startsWith('--source=')),
    'Usage: benchmarkSearchMemory.js <full-text|vault> [--source=/absolute/module.js]')
  const productionModule = path.resolve(__dirname, workload === 'full-text'
    ? '../js/places/fullTextSearch.js'
    : '../main/vaultContentSearch.js')
  const source = options.length ? options[0].slice('--source='.length) : productionModule
  assert.ok(path.isAbsolute(source), '--source must be an absolute path')
  const measurements = await (workload === 'full-text' ? fullText : vault)(source, productionModule)
  console.log(JSON.stringify({
    versions: process.versions,
    workload,
    source,
    metric: 'Post-GC memory deltas in bytes; NOT RSS nor true peak. lateScanBytes samples heapUsed near the end of candidate scanning; beforeBodiesBytes samples heapUsed during a pending body read. Vault samples live results; external memory includes arrayBuffers, so do not sum those fields.',
    ...measurements
  }))
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
