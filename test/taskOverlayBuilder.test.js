const assert = require('node:assert/strict')
const test = require('node:test')
const createHarness = require('./fixtures/taskOverlayHarness.js')

test('task summaries preserve recency, stable ties, and the newest favicon appearance', function () {
  const title = 'A long title for the most recently active tab in this task'
  const tabs = Object.freeze([
    { title: 'Old A', lastActivity: 5, favicon: { url: 'a.png', luminance: 10 } },
    { title: 'B', lastActivity: 20, favicon: { url: 'b.png', luminance: 50 } },
    { title: 'New A', lastActivity: 20, favicon: { url: 'a.png', luminance: 100 } },
    { title, lastActivity: 50 },
    { title: 'Later tied title', lastActivity: 50 }
  ].map(tab => Object.freeze(tab)))
  const before = JSON.stringify(tabs)
  const { render, metrics } = createHarness(tabs)
  const result = render()

  assert.equal(result.children[0].className, 'task-last-tab-title')
  assert.equal(result.children[0].textContent, title.substring(0, 40) + '...')
  const icons = result.children[1]
  assert.equal(icons.className, 'task-favicons')
  assert.deepEqual(icons.children.map(icon => icon.src), ['b.png', 'a.png'])
  assert.deepEqual(icons.children.map(icon => icon.classList.contains('dark-favicon')), [true, false])
  assert.equal(JSON.stringify(tabs), before)
  assert.deepEqual(metrics, { snapshots: 1, sorts: 1 })
})

test('task summaries omit favicons when none exist and do not borrow an older title', function () {
  const { render } = createHarness([
    { title: 'Older title', lastActivity: 5 },
    { title: '', lastActivity: 10, favicon: null }
  ])
  const result = render()
  assert.equal(result.children.length, 1)
  assert.equal(result.children[0].textContent, '')
})

test('empty tasks render a blank summary without throwing', function () {
  const { render, metrics } = createHarness([])
  const result = render()
  assert.equal(result.children.length, 1)
  assert.equal(result.children[0].className, 'task-last-tab-title')
  assert.equal(result.children[0].textContent, '')
  assert.deepEqual(metrics, { snapshots: 1, sorts: 1 })
})

test('large task summaries match the previous stable-sort and deduplication order', function () {
  for (const uniqueIcons of [1, 20, 500]) {
    const tabs = Array.from({ length: 500 }, (_, index) => ({
      title: `Tab ${index}`,
      lastActivity: (index * 37) % 101,
      favicon: index % 7 === 0 ? null : { url: `icon-${index % uniqueIcons}`, luminance: index % 100 }
    }))
    const ordered = tabs.slice().sort((a, b) => b.lastActivity - a.lastActivity)
    const favicons = ordered.filter(tab => tab.favicon).map(tab => tab.favicon)
    const expected = favicons.filter((icon, index) => favicons.findIndex(other => other.url === icon.url) === index)
    const { render, metrics } = createHarness(tabs)
    const result = render()
    assert.equal(result.children[0].textContent, ordered[0].title)
    assert.deepEqual(result.children[1].children.map(icon => icon.src), expected.map(icon => icon.url))
    assert.deepEqual(result.children[1].children.map(icon => icon.classList.contains('dark-favicon')), expected.map(icon => icon.luminance < 70))
    assert.deepEqual(metrics, { snapshots: 1, sorts: 1 })
  }
})
