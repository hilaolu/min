const assert = require('node:assert/strict')
const test = require('node:test')

const { createWebviewGestures } = require('../js/webviewGestures.js')

function createHarness (options = {}) {
  const calls = []
  const scheduled = []
  const warnings = []
  let wheelListener
  const zoomError = options.zoomError || null
  const gestures = createWebviewGestures({
    browserSession: { tabs: { getSelected: () => 'tab-1' } },
    cancelSchedule: timer => calls.push(['cancel', timer.delay]),
    logger: { warn: error => warnings.push(error) },
    navigator: { platform: 'Linux' },
    schedule: function (callback, delay) {
      const timer = { callback, delay }
      scheduled.push(timer)
      return timer
    },
    webviews: {
      adjustZoom: (...args) => calls.push(['adjust-zoom', ...args]),
      bindIPC: function (name, listener) {
        assert.equal(name, 'wheel-event')
        wheelListener = listener
      },
      getScrollState: function (tabId, x, y, callback) {
        callback(null, {
          isInFrame: options.isInFrame === true,
          left: 0,
          right: 0
        })
      },
      getZoom: (tabId, callback) => callback(zoomError, 1),
      goBackIgnoringRedirects: tabId => calls.push(['back', tabId]),
      goForward: tabId => calls.push(['forward', tabId]),
      setZoom: (...args) => calls.push(['set-zoom', ...args])
    }
  })
  gestures.initialize()
  return {
    calls,
    emitWheel: function (overrides = {}) {
      wheelListener('tab-1', JSON.stringify({
        clientX: 1,
        clientY: 2,
        ctrlKey: false,
        defaultPrevented: false,
        deltaX: 200,
        deltaY: 1,
        metaKey: false,
        ...overrides
      }))
    },
    gestures,
    runLowVelocityTimer: () => scheduled.find(timer => timer.delay === 70).callback(),
    warnings
  }
}

test('Tab Content gestures preserve disabled indicators and semantic zoom limits', function () {
  const harness = createHarness()

  assert.equal(harness.gestures.showBackArrow(), undefined)
  assert.equal(harness.gestures.showForwardArrow(), undefined)
  harness.gestures.zoomWebviewIn('tab-1')
  harness.gestures.zoomWebviewOut('tab-1')
  harness.gestures.resetWebviewZoom('tab-1')

  assert.deepEqual(harness.calls, [
    ['adjust-zoom', 'tab-1', 0.2, 0.5, 3],
    ['adjust-zoom', 'tab-1', -0.2, 0.5, 3],
    ['set-zoom', 'tab-1', 1]
  ])
})

test('Tab Content swipe navigation respects thresholds and iframe suppression', function () {
  const navigation = createHarness()
  navigation.emitWheel()
  navigation.runLowVelocityTimer()
  assert.equal(navigation.calls.some(call => call[0] === 'forward'), true)

  const iframe = createHarness({ isInFrame: true })
  iframe.emitWheel()
  iframe.runLowVelocityTimer()
  assert.equal(iframe.calls.some(call => call[0] === 'forward' || call[0] === 'back'), false)
})

test('Tab Content swipe navigation contains zoom-query failures', function () {
  const zoomError = new Error('zoom query failed')
  const harness = createHarness({ zoomError })
  harness.emitWheel()
  harness.runLowVelocityTimer()

  assert.deepEqual(harness.warnings, [zoomError])
  assert.equal(harness.calls.some(call => call[0] === 'forward' || call[0] === 'back'), false)
})
