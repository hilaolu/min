const schemaV1 = {
  places: '++id, &url, title, color, visitCount, lastVisit, pageHTML, extractedText, *searchIndex, isBookmarked, *tags, metadata',
  readingList: 'url, time, visitCount, pageHTML, article, extraData'
}

const schemaV2 = {
  places: '++id, &url, visitCount, lastVisit, *searchIndex',
  readingList: 'url, time, visitCount, pageHTML, article, extraData'
}

module.exports = { schemaV1, schemaV2 }
