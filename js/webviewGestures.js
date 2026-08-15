function createWebviewGestures (options) {
  const {
    browserSession,
    cancelSchedule = clearTimeout,
    logger = console,
    navigator,
    schedule = setTimeout,
    webviews
  } = options

  let swipeGestureDistanceResetTimeout = null
  let swipeGestureScrollResetTimeout = null
  let swipeGestureLowVelocityTimeout = null
  const swipeGestureDelay = 100
  const swipeGestureScrollDelay = 750
  const swipeGestureVelocityDelay = 70

  let horizontalMouseMove = 0
  let verticalMouseMove = 0
  let leftMouseMove = 0
  let rightMouseMove = 0
  let beginningScrollLeft = null
  let beginningScrollRight = null
  let isInFrame = false
  let hasShownSwipeArrow = false
  let initialZoomKeyState = null
  let initialSecondaryKeyState = null
  const webviewMinZoom = 0.5
  const webviewMaxZoom = 3.0
  let initialized = false

  function resetDistanceCounters () {
    horizontalMouseMove = 0
    verticalMouseMove = 0
    leftMouseMove = 0
    rightMouseMove = 0
    hasShownSwipeArrow = false
    initialZoomKeyState = null
    initialSecondaryKeyState = null
  }

  function resetScrollCounters () {
    beginningScrollLeft = null
    beginningScrollRight = null
    isInFrame = false
  }

  function onSwipeGestureLowVelocity () {
    // Scroll position cannot be detected in an iframe, so do not navigate from it.
    if (isInFrame) return

    webviews.getZoom(browserSession.tabs.getSelected(), function (error, result) {
      if (error) {
        logger.warn(error)
        return
      }
      const minScrollDistance = 150 * result

      if ((leftMouseMove / rightMouseMove > 5) || (rightMouseMove / leftMouseMove > 5)) {
        if (leftMouseMove - beginningScrollRight > minScrollDistance && Math.abs(horizontalMouseMove / verticalMouseMove) > 3) {
          if (beginningScrollRight < 5) {
            resetDistanceCounters()
            resetScrollCounters()
            webviews.goForward(browserSession.tabs.getSelected())
          }
        }

        if (rightMouseMove + beginningScrollLeft > minScrollDistance && Math.abs(horizontalMouseMove / verticalMouseMove) > 3) {
          if (beginningScrollLeft < 5) {
            resetDistanceCounters()
            resetScrollCounters()
            webviews.goBackIgnoringRedirects(browserSession.tabs.getSelected())
          }
        }
      }
    })
  }

  const webviewGestures = {
    // Swipe indicators remain disabled until Browser Window attachment can present them reliably.
    showBackArrow: function () {},
    showForwardArrow: function () {},
    zoomWebviewBy: function (tabId, amount) {
      webviews.adjustZoom(tabId, amount, webviewMinZoom, webviewMaxZoom)
    },
    zoomWebviewIn: function (tabId) {
      return webviewGestures.zoomWebviewBy(tabId, 0.2)
    },
    zoomWebviewOut: function (tabId) {
      return webviewGestures.zoomWebviewBy(tabId, -0.2)
    },
    resetWebviewZoom: function (tabId) {
      webviews.setZoom(tabId, 1.0)
    },
    destroy: function () {
      const timers = [
        swipeGestureDistanceResetTimeout,
        swipeGestureScrollResetTimeout,
        swipeGestureLowVelocityTimeout
      ]
      timers.filter(Boolean).forEach(cancelSchedule)
      swipeGestureDistanceResetTimeout = null
      swipeGestureScrollResetTimeout = null
      swipeGestureLowVelocityTimeout = null
    },
    initialize: function () {
      if (initialized) return
      initialized = true
      webviews.bindIPC('wheel-event', function (tabId, eventData) {
        const event = JSON.parse(eventData)

        if (event.defaultPrevented) return

        verticalMouseMove += event.deltaY
        horizontalMouseMove += event.deltaX
        if (event.deltaX > 0) {
          leftMouseMove += event.deltaX
        } else {
          rightMouseMove += event.deltaX * -1
        }

        const platformZoomKey = navigator.platform === 'MacIntel' ? event.metaKey : event.ctrlKey
        const platformSecondaryKey = navigator.platform === 'MacIntel' ? event.ctrlKey : false

        if (beginningScrollLeft === null || beginningScrollRight === null) {
          webviews.getScrollState(browserSession.tabs.getSelected(), event.clientX, event.clientY, function (error, result) {
            if (error) {
              logger.warn(error)
              return
            }
            if (beginningScrollLeft === null || beginningScrollRight === null) {
              beginningScrollLeft = result.left
              beginningScrollRight = result.right
            }
            isInFrame = isInFrame || result.isInFrame
          })
        }

        if (initialZoomKeyState === null) initialZoomKeyState = platformZoomKey
        if (initialSecondaryKeyState === null) initialSecondaryKeyState = platformSecondaryKey

        if (Math.abs(event.deltaX) >= 20 || Math.abs(event.deltaY) >= 20) {
          if (swipeGestureLowVelocityTimeout) cancelSchedule(swipeGestureLowVelocityTimeout)
          swipeGestureLowVelocityTimeout = schedule(onSwipeGestureLowVelocity, swipeGestureVelocityDelay)

          if (horizontalMouseMove < -150 && Math.abs(horizontalMouseMove / verticalMouseMove) > 2.5 && !hasShownSwipeArrow) {
            hasShownSwipeArrow = true
            webviewGestures.showBackArrow()
          } else if (horizontalMouseMove > 150 && Math.abs(horizontalMouseMove / verticalMouseMove) > 2.5 && !hasShownSwipeArrow) {
            hasShownSwipeArrow = true
            webviewGestures.showForwardArrow()
          }
        }

        if (swipeGestureDistanceResetTimeout) cancelSchedule(swipeGestureDistanceResetTimeout)
        if (swipeGestureScrollResetTimeout) cancelSchedule(swipeGestureScrollResetTimeout)
        swipeGestureDistanceResetTimeout = schedule(resetDistanceCounters, swipeGestureDelay)
        swipeGestureScrollResetTimeout = schedule(resetScrollCounters, swipeGestureScrollDelay)

        if (platformZoomKey && initialZoomKeyState) {
          if (verticalMouseMove > 50) {
            verticalMouseMove = -10
            webviewGestures.zoomWebviewOut(browserSession.tabs.getSelected())
          }

          if (verticalMouseMove < -50) {
            verticalMouseMove = -10
            webviewGestures.zoomWebviewIn(browserSession.tabs.getSelected())
          }
        }
      })
    }
  }

  return webviewGestures
}

let productionWebviewGestures = null

function getProductionWebviewGestures () {
  if (!productionWebviewGestures) {
    throw new Error('Tab Content gestures have not been initialized')
  }
  return productionWebviewGestures
}

module.exports = {
  createWebviewGestures,
  destroy: (...args) => getProductionWebviewGestures().destroy(...args),
  initialize: function (options) {
    if (!productionWebviewGestures) productionWebviewGestures = createWebviewGestures(options)
    return productionWebviewGestures.initialize()
  },
  resetWebviewZoom: (...args) => getProductionWebviewGestures().resetWebviewZoom(...args),
  showBackArrow: (...args) => getProductionWebviewGestures().showBackArrow(...args),
  showForwardArrow: (...args) => getProductionWebviewGestures().showForwardArrow(...args),
  zoomWebviewBy: (...args) => getProductionWebviewGestures().zoomWebviewBy(...args),
  zoomWebviewIn: (...args) => getProductionWebviewGestures().zoomWebviewIn(...args),
  zoomWebviewOut: (...args) => getProductionWebviewGestures().zoomWebviewOut(...args)
}
