// Index the current DOM once per search, rather than scanning the whole document
// for each tab. Rebuilding these short-lived maps avoids stale nodes after drops,
// deletions, or a synchronized render in another window.
function filterTaskOverlay (container, tasks, search) {
  const taskElements = new Map()
  const tabElements = new Map()
  container.querySelectorAll('.task-container').forEach(el => taskElements.set(el.getAttribute('data-task'), el))
  container.querySelectorAll('.task-tab-item').forEach(el => tabElements.set(el.getAttribute('data-tab'), el))
  const words = search.split(' ')
  let totalMatches = 0

  tasks.forEach(function (task) {
    const taskElement = taskElements.get(String(task.id))
    if (!taskElement) return
    let taskMatches = 0
    task.tabs.forEach(function (tab) {
      const tabElement = tabElements.get(String(tab.id))
      if (!tabElement) return
      const text = (task.name + ' ' + tab.title + ' ' + tab.url).toLowerCase()
      const matches = words.every(word => text.includes(word))
      tabElement.hidden = !matches
      if (matches) {
        taskMatches++
        totalMatches++
        tabElement.classList.toggle('fakefocus', totalMatches === 1)
      }
    })
    taskElement.hidden = taskMatches === 0
    if (taskMatches > 0) taskElement.classList.remove('collapsed')
  })
  return totalMatches
}

module.exports = filterTaskOverlay
