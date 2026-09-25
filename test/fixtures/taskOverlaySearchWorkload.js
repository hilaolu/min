// Serialized into an Electron renderer by electronPerformance.js. Measures
// filtering plus forced layout, not task construction, paint or Sortable work.
module.exports = function taskOverlaySearchWorkload (filter) {
  function legacyFilter (container, tasks, search) {
    let total = 0
    tasks.forEach(task => {
      const taskElement = document.querySelector(`.task-container[data-task="${task.id}"]`)
      let matches = 0
      task.tabs.forEach(tab => {
        const el = document.querySelector(`.task-tab-item[data-tab="${tab.id}"]`)
        const text = (task.name + ' ' + tab.title + ' ' + tab.url).toLowerCase()
        const match = search.split(' ').every(word => text.includes(word))
        el.hidden = !match
        if (match) {
          matches++
          total++
          el.classList.toggle('fakefocus', total === 1)
        }
      })
      taskElement.hidden = matches === 0
      if (matches) taskElement.classList.remove('collapsed')
    })
    return total
  }

  return [200, 2000].map(tabCount => {
    const container = document.createElement('main')
    const tasks = Array.from({ length: 10 }, (_, id) => {
      const taskElement = document.createElement('section')
      taskElement.className = 'task-container collapsed'
      taskElement.setAttribute('data-task', id)
      container.appendChild(taskElement)
      const tabs = Array.from({ length: tabCount / 10 }, (_, i) => {
        const tab = { id: `${id}-${i}`, title: i % 2 === 0 ? 'Needle' : 'Plain', url: 'https://example.com' }
        const el = document.createElement('div')
        el.className = 'task-tab-item'
        el.setAttribute('data-tab', tab.id)
        el.textContent = tab.title
        taskElement.appendChild(el)
        return tab
      })
      return { id, name: `Group ${id}`, tabs }
    })
    document.body.appendChild(container)
    const measure = fn => {
      const samples = []
      let resultCount
      for (let run = 0; run < 9; run++) {
        const start = performance.now()
        resultCount = fn(container, tasks, run % 2 === 0 ? 'needle' : 'plain')
        if (container.offsetHeight === 0) throw new Error('Expected laid-out search results')
        if (run >= 2) samples.push(performance.now() - start)
      }
      return {
        medianMs: Number(samples.sort((a, b) => a - b)[3].toFixed(2)),
        resultCount,
        visible: Array.from(container.querySelectorAll('.task-tab-item:not([hidden])'), el => el.getAttribute('data-tab')),
        focus: Array.from(container.querySelectorAll('.task-tab-item:not([hidden]).fakefocus'), el => el.getAttribute('data-tab'))
      }
    }
    try {
      return { tabCount, before: measure(legacyFilter), after: measure(filter) }
    } finally {
      container.remove()
    }
  })
}
