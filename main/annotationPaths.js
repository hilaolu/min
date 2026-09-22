const defaultFolder = 'Archives/Annotations'

// Same resource-query allowlist and filename identity as tab-picker.
const resourceParameters = new Set(('aid article article_id articleid category category_id categoryid cid doc doc_id docid gid id iid item item_id name nid page page_id pageid pid post post_id postid tag tag_id taxonomy term term_id uid user user_id userid vid video video_id videoid action component controller layout mode module option path q query route s search start task view attachment_id author author_name cat category_name catid itemid p pagename paged post_type f fid forum forum_id forumid t thread thread_id threadid tid topic topic_id topicid u curid diff oldid title information_id manufacturer_id product product_id productid sku v').split(' '))

function canonicalSource (source) {
  const url = new URL(source)
  if (!['http:', 'https:', 'file:', 'vault:'].includes(url.protocol) || url.username || url.password) throw new Error('Unsupported annotation source')
  if (['http:', 'https:'].includes(url.protocol)) {
    for (const key of [...url.searchParams.keys()]) {
      if (!resourceParameters.has(key.toLowerCase())) url.searchParams.delete(key)
    }
    url.searchParams.sort()
    if (url.pathname.length > 1 && url.pathname.endsWith('/')) url.pathname = url.pathname.slice(0, -1)
  }
  url.hash = ''
  return url.href
}

function sourcePath (source) {
  const url = new URL(canonicalSource(source))
  const host = normalizeFolder(url.hostname || 'local')
  const pathname = url.pathname + url.search
  return host + '/' + encodeURIComponent(pathname === '/' || !pathname ? '/index' : pathname) + '.md'
}

function normalizeFolder (value) {
  if (typeof value !== 'string') throw new Error('Enter a vault-relative annotation folder')
  const folder = value.trim().replace(/\/$/, '')
  const hasControl = Array.from(folder).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  // Use portable directory names and keep the store inside visible vault paths.
  const invalidComponent = folder.split('/').some(part =>
    !part || part.startsWith('.') || /[\\:*?"<>|]/.test(part) || /[. ]$/.test(part) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) || part === 'node_modules')
  if (!folder || folder.length > 240 || hasControl || invalidComponent) {
    throw new Error('Use a vault-relative folder without hidden, reserved, or parent path components')
  }
  return folder
}

function isInFolder (relativePath, folder) {
  return relativePath === folder || relativePath.startsWith(folder + '/')
}

module.exports = { defaultFolder, normalizeFolder, isInFolder, canonicalSource, sourcePath }
