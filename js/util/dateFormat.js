const fullDateFormatter = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'long',
  day: 'numeric'
})
const monthAndYearFormatter = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'long'
})

function formatEnglishDate (date, options = {}) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new RangeError('Invalid date')
  }

  if (options.includeDay === false) {
    return monthAndYearFormatter.format(date)
  }

  return fullDateFormatter.format(date)
}

module.exports = formatEnglishDate
