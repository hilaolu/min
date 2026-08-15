function getUpdateGroups (fields) {
  if (!fields) return new Set(['title', 'url', 'audio', 'permissions', 'security'])
  const groups = new Set()
  fields.forEach(function (field) {
    if (['title', 'url', 'loaded', 'private'].includes(field)) groups.add('title')
    if (field === 'url') groups.add('url')
    if (['muted', 'hasAudio'].includes(field)) groups.add('audio')
    if (field === 'permissions') groups.add('permissions')
    if (field === 'secure') groups.add('security')
  })
  return groups
}

function reconcileKeyedChildren ({ container, create, elements, items, update }) {
  const desiredIds = new Set(items.map(item => item.id))
  const operations = { created: 0, moved: 0, preserved: 0, removed: 0 }

  Object.keys(elements).forEach(function (id) {
    if (desiredIds.has(id)) return
    const element = elements[id]
    if (element.parentNode === container) container.removeChild(element)
    delete elements[id]
    operations.removed++
  })

  items.forEach(function (item, index) {
    let element = elements[item.id]
    let created = false
    if (!element) {
      element = create(item)
      elements[item.id] = element
      operations.created++
      created = true
    } else {
      operations.preserved++
    }
    update(element, item, created)
    const elementAtIndex = container.children[index]
    if (elementAtIndex !== element) {
      container.insertBefore(element, elementAtIndex || null)
      operations.moved++
    }
  })

  return operations
}

module.exports = { getUpdateGroups, reconcileKeyedChildren }
