const assert = require('node:assert/strict')
const test = require('node:test')

const { getUpdateGroups, reconcileKeyedChildren } = require('../js/navbar/tabBarProjection.js')

function createContainer () {
  return {
    children: [],
    insertBefore: function (element, sibling) {
      const oldIndex = this.children.indexOf(element)
      if (oldIndex >= 0) this.children.splice(oldIndex, 1)
      const index = sibling ? this.children.indexOf(sibling) : this.children.length
      this.children.splice(index, 0, element)
      element.parentNode = this
    },
    removeChild: function (element) {
      this.children.splice(this.children.indexOf(element), 1)
      element.parentNode = null
    }
  }
}

test('keyed Tab Bar reconciliation preserves unaffected nodes across close and reorder', function () {
  const container = createContainer()
  const elements = {}
  const create = item => ({ id: item.id, state: {} })
  const update = (element, item) => { element.state = { ...item } }
  reconcileKeyedChildren({ container, create, elements, items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], update })
  const originalA = elements.a
  const originalC = elements.c

  const operations = reconcileKeyedChildren({
    container,
    create,
    elements,
    items: [{ id: 'c', title: 'C' }, { id: 'a', title: 'A' }],
    update
  })

  assert.equal(elements.a, originalA)
  assert.equal(elements.c, originalC)
  assert.deepEqual(container.children.map(element => element.id), ['c', 'a'])
  assert.equal(operations.created, 0)
  assert.equal(operations.preserved, 2)
  assert.equal(operations.removed, 1)

  const freshContainer = createContainer()
  const freshElements = {}
  reconcileKeyedChildren({
    container: freshContainer,
    create,
    elements: freshElements,
    items: [{ id: 'c', title: 'C' }, { id: 'a', title: 'A' }],
    update
  })
  assert.deepEqual(container.children.map(element => element.state), freshContainer.children.map(element => element.state))
})

test('field-specific Tab updates do not select unrelated presentation groups', function () {
  assert.deepEqual(Array.from(getUpdateGroups(['title'])), ['title'])
  assert.deepEqual(Array.from(getUpdateGroups(['muted'])), ['audio'])
  assert.deepEqual(Array.from(getUpdateGroups(['secure'])), ['security'])
  assert.deepEqual(Array.from(getUpdateGroups(['permissions'])), ['permissions'])
  assert.deepEqual(Array.from(getUpdateGroups(['url'])).sort(), ['title', 'url'])
})
