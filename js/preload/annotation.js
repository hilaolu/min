/* Annotation functionality for Min browser */

// IPC communication for annotation features
var annotationSettings = {
  enabled: false,
  serverUrl: '',
  username: '',
  password: ''
}

// Function to get annotation settings via IPC
function getAnnotationSettings(callback) {
  ipc.send('getAnnotationSettings')

  // Listen for the response
  ipc.once('annotationSettingsReceived', function (e, settings) {
    annotationSettings = settings || {}
    if (callback) {
      callback(annotationSettings)
    }
  })
}

// Initialize annotation functionality when page loads
if (process.isMainFrame) {
  window.addEventListener('load', function (e) {
    setTimeout(function () {
      // Get annotation settings and demonstrate IPC is working
      getAnnotationSettings(function (settings) {
        console.log('Annotation settings received via IPC:', settings)

        // Show alert to demonstrate IPC is working
        if (settings.enabled) {
          alert('Annotation sync is ENABLED!\n\nServer: ' + settings.serverUrl + '\nUsername: ' + settings.username + '\n\nIPC communication is working!')
        } else {
          alert('Annotation sync is DISABLED\n\nIPC communication is working!\n\nGo to Settings > Annotations to enable and configure.')
        }
      })
    }, 1000) // Wait 1 second after page load
  })
}

// Export function for use in other scripts
window.annotationAPI = {
  getSettings: getAnnotationSettings
}