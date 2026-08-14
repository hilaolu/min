const formatEnglishDate = require('util/dateFormat.js')

function formatRelativeDate (date) {
  var currentTime = Date.now()
  var startOfToday = new Date()
  startOfToday.setHours(0)
  startOfToday.setMinutes(0)
  startOfToday.setSeconds(0)
  var timeElapsedToday = currentTime - startOfToday.getTime()
  var msPerDay = (24 * 60 * 60 * 1000)

  var relativeDateRanges = [
    [0, 60000, 'Just now'],
    [60000, 300000, 'A few minutes ago'],
    [300000, 3600000, 'In the past hour'],
    [3600000, timeElapsedToday, 'Today'],
    [timeElapsedToday, timeElapsedToday + msPerDay, 'Yesterday'],
    [timeElapsedToday + msPerDay, 604800000, 'In the past week'],
    [604800000, 2592000000, 'In the past month']
  ]

  var diff = Date.now() - date
  for (var i = 0; i < relativeDateRanges.length; i++) {
    if (relativeDateRanges[i][0] <= diff && relativeDateRanges[i][1] >= diff) {
      return relativeDateRanges[i][2]
    }
  }
  return formatEnglishDate(new Date(date), { includeDay: false })
}

module.exports = formatRelativeDate
