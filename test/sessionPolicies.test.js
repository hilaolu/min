const assert = require('node:assert/strict')
const test = require('node:test')

const createSessionPolicies = require('../main/sessionPolicies.js')

test('session policies install in composition order exactly once per session', function () {
  const calls = []
  const policies = createSessionPolicies([
    { install: session => calls.push(['protocol', session.id]) },
    { install: session => calls.push(['filtering', session.id]) },
    { install: session => calls.push(['permissions', session.id]) }
  ])
  const defaultSession = { id: 'default' }
  const privateSession = { id: 'private' }

  assert.equal(policies.install(defaultSession), true)
  assert.equal(policies.install(defaultSession), false)
  assert.equal(policies.install(privateSession), true)

  assert.deepEqual(calls, [
    ['protocol', 'default'],
    ['filtering', 'default'],
    ['permissions', 'default'],
    ['protocol', 'private'],
    ['filtering', 'private'],
    ['permissions', 'private']
  ])
})
