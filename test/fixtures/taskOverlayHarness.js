const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const source = fs.readFileSync(path.join(__dirname, '../../js/taskOverlay/taskOverlayBuilder.js'), 'utf8')

// Exercise the production summary builder without measuring DOM layout/paint.
module.exports = function createTaskOverlayHarness (tabs) {
  const metrics = { snapshots: 0, sorts: 0 }
  const dependencies = {
    'tabState.js': { tasks: { getLastActivity: () => Date.now() } },
    'browserUI.js': {},
    'searchbar/searchbarUtils.js': { getRealTitle: title => title },
    'util/urlParser.js': {},
    'util/searchEngine.js': {},
    'util/dateFormat.js': () => ''
  }
  const context = {
    module: { exports: {} },
    require: name => {
      if (!Object.hasOwn(dependencies, name)) throw new Error(`Unexpected dependency: ${name}`)
      return dependencies[name]
    },
    document: {
      createElement: () => {
        const classes = new Set()
        return {
          children: [],
          textContent: '',
          appendChild (child) { this.children.push(child) },
          classList: { add: name => classes.add(name), contains: name => classes.has(name) }
        }
      }
    }
  }
  vm.runInNewContext(source, context, { filename: 'taskOverlayBuilder.js' })
  const task = {
    id: 'test-task',
    tabs: {
      get: () => {
        metrics.snapshots++
        const snapshot = tabs.map(tab => ({ ...tab }))
        snapshot.sort = function (compare) {
          metrics.sorts++
          return Array.prototype.sort.call(this, compare)
        }
        return snapshot
      }
    }
  }
  return { metrics, render: () => context.TaskOverlayBuilder.create.task.infoContainer(task) }
}
