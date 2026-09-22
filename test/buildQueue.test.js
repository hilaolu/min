const assert = require('node:assert/strict')
const EventEmitter = require('node:events')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

const createBuildQueue = require('../scripts/buildQueue.js')

function deferred () {
  const result = {}
  result.promise = new Promise((resolve, reject) => {
    result.resolve = resolve
    result.reject = reject
  })
  return result
}

test('build queue coalesces a synchronous burst of requests', async function () {
  let builds = 0
  const requestBuild = createBuildQueue(() => { builds++ }, assert.fail)
  const pending = requestBuild()
  assert.equal(requestBuild(), pending)
  assert.equal(requestBuild(), pending)
  await pending
  assert.equal(builds, 1)

  await requestBuild()
  assert.equal(builds, 2)
})

test('build queue serializes builds and retains changes received during each build', async function () {
  const started = [deferred(), deferred()]
  const gates = [deferred(), deferred()]
  let builds = 0
  let active = 0
  let maxActive = 0
  const requestBuild = createBuildQueue(async function () {
    const index = builds++
    active++
    maxActive = Math.max(maxActive, active)
    if (gates[index]) {
      started[index].resolve()
      await gates[index].promise
    }
    active--
  }, assert.fail)

  const pending = requestBuild()
  await started[0].promise
  assert.equal(requestBuild(), pending)
  assert.equal(requestBuild(), pending)
  assert.equal(builds, 1)

  gates[0].resolve()
  await started[1].promise
  assert.equal(requestBuild(), pending)
  assert.equal(requestBuild(), pending)
  assert.equal(builds, 2)

  gates[1].resolve()
  await pending
  assert.equal(builds, 3)
  assert.equal(maxActive, 1)
  assert.equal(active, 0)
})

test('build queue reports synchronous errors and accepts later requests', async function () {
  const failure = new Error('build failed')
  const errors = []
  let builds = 0
  const requestBuild = createBuildQueue(function () {
    if (++builds === 1) throw failure
  }, error => errors.push(error))

  await requestBuild()
  assert.deepEqual(errors, [failure])
  await requestBuild()
  assert.equal(builds, 2)
})

test('build queue continues queued work after an asynchronous failure', async function () {
  const firstBuild = deferred()
  const started = deferred()
  const failure = new Error('bundle failed')
  const errors = []
  let builds = 0
  const requestBuild = createBuildQueue(function () {
    if (++builds === 1) {
      started.resolve()
      return firstBuild.promise
    }
  }, error => errors.push(error))

  const pending = requestBuild()
  await started.promise
  assert.equal(requestBuild(), pending)
  firstBuild.reject(failure)
  await pending
  assert.deepEqual(errors, [failure])
  assert.equal(builds, 2)

  await requestBuild()
  assert.equal(builds, 3)
})

function createWatcherHarness (build) {
  const errors = []
  const watchers = new Map()
  const modules = {
    path,
    chokidar: {
      watch: function (directory, options) {
        const watcher = new EventEmitter()
        watchers.set(directory, { watcher, options })
        return watcher
      }
    },
    './buildMain.js': () => {},
    './buildPreload.js': () => {},
    './buildBrowserStyles.js': () => {},
    './buildQueue.js': createBuildQueue,
    './buildBrowser.js': build
  }
  const scriptPath = require.resolve('../scripts/watch.js')
  vm.runInNewContext(fs.readFileSync(scriptPath, 'utf8'), {
    __dirname: path.dirname(scriptPath),
    require: name => {
      assert.ok(Object.hasOwn(modules, name), `Unexpected dependency: ${name}`)
      return modules[name]
    },
    console: { log: () => {}, error: (...args) => errors.push(args) }
  })
  return { errors, ...watchers.get(path.resolve(__dirname, '../js')) }
}

test('browser watcher awaits queued builds and recovers when a missing file is added', async function () {
  const firstBuild = deferred()
  const started = deferred()
  const failure = new Error('bundle failed')
  let builds = 0
  const { errors, watcher } = createWatcherHarness(function () {
    if (++builds === 1) {
      started.resolve()
      return firstBuild.promise
    }
  })
  const onChange = watcher.listeners('change')[0]
  const onAdd = watcher.listeners('add')[0]
  assert.equal(typeof onAdd, 'function')
  const pending = onChange()
  await started.promise
  assert.equal(onAdd(), pending)
  assert.equal(builds, 1)
  firstBuild.reject(failure)
  await pending
  assert.equal(builds, 2)
  assert.deepEqual(errors, [['Error while building browser:', failure]])
})

test('browser watcher observes file edits, additions and removals but ignores the initial scan', async function () {
  let builds = 0
  const { errors, watcher, options } = createWatcherHarness(() => { builds++ })
  assert.equal(options.ignoreInitial, true)
  assert.equal(options.ignored, path.resolve(__dirname, '../js/preload'))
  assert.equal(builds, 0)

  for (const event of ['add', 'change', 'unlink']) {
    assert.equal(watcher.listenerCount(event), 1, event)
    await watcher.listeners(event)[0]('example.js')
  }

  assert.equal(builds, 3)
  assert.deepEqual(errors, [])
  assert.equal(watcher.listenerCount('addDir'), 0)
  assert.equal(watcher.listenerCount('unlinkDir'), 0)
})
