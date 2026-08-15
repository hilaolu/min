var places = require('places/places.js')
var autocomplete = require('util/autocomplete.js')
const remoteMenu = require('remoteMenuRenderer.js')
const rendererHost = require('rendererHost.js')

const bookmarkEditor = {
  currentInstance: null,
  getTagElement: function (tag, selected, onClick, options = {}) {
    var el = document.createElement('button')
    el.className = 'tag'
    el.textContent = tag
    if (selected) {
      el.classList.add('selected')
      el.setAttribute('aria-pressed', true)
    } else {
      el.classList.add('suggested')
      el.setAttribute('aria-pressed', false)
    }
    el.addEventListener('click', function () {
      onClick()
      if (el.classList.contains('selected') && options.autoRemove !== false) {
        el.remove()
      } else {
        el.classList.remove('suggested')
        el.classList.add('selected')
      }
    })
    if (options.onModify) {
      el.addEventListener('contextmenu', function () {
        remoteMenu.open([
          [
            {
              label: 'Rename Tag',
              click: async function () {
                const newName = rendererHost.promptForTagRename()

                if (!newName) {
                  return
                }

                await places.changeTag(tag, 'rename', newName)
                options.onModify()
              }
            },
            {
              label: 'Delete Tag',
              click: async function () {
                await places.changeTag(tag, 'delete')
                options.onModify()
              }
            },
            {
              label: 'Delete Bookmarks with Tag',
              click: async function () {
                await places.changeTag(tag, 'delete-bookmarks')
                options.onModify()
              }
            }
          ]
        ])
      })
    }
    return el
  },
  render: async function (url, options = {}) {
    bookmarkEditor.currentInstance = {}
    bookmarkEditor.currentInstance.bookmark = await places.getItem(url)

    var editor = document.createElement('div')
    editor.className = 'bookmark-editor searchbar-item'

    if (options.simplified) {
      editor.className += ' simplified'
    }

    if (!options.simplified) {
      // title input
      var title = document.createElement('span')
      title.className = 'title wide'
      title.textContent = bookmarkEditor.currentInstance.bookmark.title
      editor.appendChild(title)

      // URL
      var URLSpan = document.createElement('div')
      URLSpan.className = 'bookmark-url'
      URLSpan.textContent = bookmarkEditor.currentInstance.bookmark.url
      editor.appendChild(URLSpan)
    }

    // tag area
    var tagArea = document.createElement('div')
    tagArea.className = 'tag-edit-area'
    editor.appendChild(tagArea)

    if (!options.simplified) {
      // save button
      var saveButton = document.createElement('button')
      saveButton.className = 'action-button always-visible i carbon:checkmark'
      saveButton.tabIndex = -1
      editor.appendChild(saveButton)
      saveButton.addEventListener('click', function () {
        editor.remove()
        bookmarkEditor.currentInstance.onClose(bookmarkEditor.currentInstance.bookmark)
        bookmarkEditor.currentInstance = null
      })
    }

    // delete button
    var delButton = document.createElement('button')
    delButton.className = 'action-button always-visible bookmark-delete-button i carbon:trash-can'
    delButton.tabIndex = -1
    editor.appendChild(delButton)
    delButton.addEventListener('click', function () {
      editor.remove()
      bookmarkEditor.currentInstance.onClose(null)
      bookmarkEditor.currentInstance = null
    })

    var tags = {
      selected: [],
      suggested: []
    }

    // show tags
    bookmarkEditor.currentInstance.bookmark.tags.forEach(function (tag) {
      tagArea.appendChild(bookmarkEditor.getTagElement(tag, true, function () {
        places.toggleTag(bookmarkEditor.currentInstance.bookmark.url, tag)
      }))
    })
    tags.selected = bookmarkEditor.currentInstance.bookmark.tags

    places.getSuggestedTags(bookmarkEditor.currentInstance.bookmark.url).then(function (suggestions) {
      tags.suggested = tags.suggested.concat(suggestions)

      tags.suggested.filter((tag, idx) => {
        return tags.suggested.indexOf(tag) === idx && !tags.selected.includes(tag)
      }).slice(0, 3).forEach(function (tag, idx) {
        tagArea.appendChild(bookmarkEditor.getTagElement(tag, false, function () {
          places.toggleTag(bookmarkEditor.currentInstance.bookmark.url, tag)
        }))
      })
      // add option for new tag
      var newTagInput = document.createElement('input')
      newTagInput.className = 'tag-input'
      newTagInput.placeholder = 'Add tag...'
      newTagInput.spellcheck = false
      tagArea.appendChild(newTagInput)

      newTagInput.addEventListener('keypress', function (e) {
        if (e.keyCode !== 8 && e.keyCode !== 13) {
          places.getAllTagsRanked(bookmarkEditor.currentInstance.bookmark.url).then(function (results) {
            autocomplete.autocomplete(newTagInput, results.map(r => r.tag))
          })
        }
      })

      newTagInput.addEventListener('change', function () {
        var val = this.value
        if (!tags.selected.includes(val)) {
          places.toggleTag(bookmarkEditor.currentInstance.bookmark.url, val)
          tagArea.insertBefore(bookmarkEditor.getTagElement(val, true, function () {
            places.toggleTag(bookmarkEditor.currentInstance.bookmark.url, val)
          }), tagArea.firstElementChild)
        }
        this.value = ''
      })

      if (options.autoFocus) {
        newTagInput.focus()
      }
    })

    return editor
  },
  show: function (url, replaceItem, onClose, options) {
    if (bookmarkEditor.currentInstance) {
      if (bookmarkEditor.currentInstance.editor && bookmarkEditor.currentInstance.editor.parentNode) {
        bookmarkEditor.currentInstance.editor.remove()
      }
      if (bookmarkEditor.currentInstance.onClose) {
        bookmarkEditor.currentInstance.onClose(bookmarkEditor.currentInstance.bookmark)
      }
      bookmarkEditor.currentInstance = null
    }
    bookmarkEditor.render(url, options).then(function (editor) {
      replaceItem.hidden = true
      replaceItem.parentNode.insertBefore(editor, replaceItem)
      bookmarkEditor.currentInstance.editor = editor
      bookmarkEditor.currentInstance.onClose = onClose
    })
  }
}

module.exports = bookmarkEditor
