document.title = l('bookmarksPageTitle') + ' | Min'

const bookmarksList = document.getElementById('bookmarks-list')
const noBookmarks = document.getElementById('no-bookmarks')
const searchInput = document.getElementById('bookmark-search')
const importButton = document.getElementById('import-bookmarks')
const exportButton = document.getElementById('export-bookmarks')

let allBookmarks = []

// Load and display bookmarks
async function loadBookmarks() {
  try {
    const items = await places.getAllItems()
    allBookmarks = items.filter(item => item.isBookmarked)
    displayBookmarks(allBookmarks)
  } catch (error) {
    console.error('Error loading bookmarks:', error)
  }
}

// Display bookmarks in the list
function displayBookmarks(bookmarks) {
  if (bookmarks.length === 0) {
    bookmarksList.hidden = true
    noBookmarks.hidden = false
    return
  }

  bookmarksList.hidden = false
  noBookmarks.hidden = true
  
  bookmarksList.innerHTML = ''
  
  bookmarks.forEach(bookmark => {
    const bookmarkElement = createBookmarkElement(bookmark)
    bookmarksList.appendChild(bookmarkElement)
  })
}

// Create a bookmark element
function createBookmarkElement(bookmark) {
  const item = document.createElement('div')
  item.className = 'bookmark-item'
  
  const favicon = document.createElement('img')
  favicon.className = 'bookmark-favicon'
  favicon.src = `https://www.google.com/s2/favicons?domain=${new URL(bookmark.url).hostname}&sz=16`
  favicon.onerror = () => {
    favicon.style.display = 'none'
  }
  
  const content = document.createElement('div')
  content.className = 'bookmark-content'
  
  const title = document.createElement('div')
  title.className = 'bookmark-title'
  title.textContent = bookmark.title || bookmark.url
  
  const url = document.createElement('div')
  url.className = 'bookmark-url'
  url.textContent = bookmark.url
  
  content.appendChild(title)
  content.appendChild(url)
  
  if (bookmark.tags && bookmark.tags.length > 0) {
    const tags = document.createElement('div')
    tags.className = 'bookmark-tags'
    
    bookmark.tags.forEach(tag => {
      const tagElement = document.createElement('span')
      tagElement.className = 'bookmark-tag'
      tagElement.textContent = tag
      tags.appendChild(tagElement)
    })
    
    content.appendChild(tags)
  }
  
  const actions = document.createElement('div')
  actions.className = 'bookmark-actions'
  
  const editButton = document.createElement('button')
  editButton.className = 'bookmark-action'
  editButton.innerHTML = '<i class="i carbon:edit"></i>'
  editButton.title = 'Edit bookmark'
  editButton.onclick = (e) => {
    e.stopPropagation()
    editBookmark(bookmark)
  }
  
  const deleteButton = document.createElement('button')
  deleteButton.className = 'bookmark-action'
  deleteButton.innerHTML = '<i class="i carbon:trash-can"></i>'
  deleteButton.title = 'Delete bookmark'
  deleteButton.onclick = (e) => {
    e.stopPropagation()
    deleteBookmark(bookmark)
  }
  
  actions.appendChild(editButton)
  actions.appendChild(deleteButton)
  
  item.appendChild(favicon)
  item.appendChild(content)
  item.appendChild(actions)
  
  item.onclick = () => {
    window.location.href = bookmark.url
  }
  
  return item
}

// Search functionality
searchInput.addEventListener('input', (e) => {
  const searchTerm = e.target.value.toLowerCase()
  const filteredBookmarks = allBookmarks.filter(bookmark => 
    bookmark.title.toLowerCase().includes(searchTerm) ||
    bookmark.url.toLowerCase().includes(searchTerm) ||
    (bookmark.tags && bookmark.tags.some(tag => tag.toLowerCase().includes(searchTerm)))
  )
  displayBookmarks(filteredBookmarks)
})

// Import bookmarks
importButton.addEventListener('click', async () => {
  try {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.html'
    input.onchange = async (e) => {
      const file = e.target.files[0]
      if (file) {
        const text = await file.text()
        bookmarkConverter.import(text)
        loadBookmarks() // Reload after import
      }
    }
    input.click()
  } catch (error) {
    console.error('Error importing bookmarks:', error)
  }
})

// Export bookmarks
exportButton.addEventListener('click', async () => {
  try {
    const html = await bookmarkConverter.exportAll()
    const blob = new Blob([html], { type: 'text/html' })
    const url = URL.createObjectURL(blob)
    
    const a = document.createElement('a')
    a.href = url
    a.download = 'bookmarks.html'
    a.click()
    
    URL.revokeObjectURL(url)
  } catch (error) {
    console.error('Error exporting bookmarks:', error)
  }
})

// Edit bookmark (simplified - could be enhanced)
function editBookmark(bookmark) {
  // This could open a modal or redirect to a bookmark editor
  alert('Edit functionality would be implemented here')
}

// Delete bookmark
async function deleteBookmark(bookmark) {
  if (confirm('Are you sure you want to delete this bookmark?')) {
    try {
      await places.updateItem(bookmark.url, { isBookmarked: false })
      loadBookmarks() // Reload after deletion
    } catch (error) {
      console.error('Error deleting bookmark:', error)
    }
  }
}

// Initialize the page
loadBookmarks() 