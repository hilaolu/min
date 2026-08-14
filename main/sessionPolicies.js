function createSessionPolicies (policies) {
  const installedSessions = new WeakSet()

  function install (session) {
    if (installedSessions.has(session)) {
      return false
    }

    policies.forEach(policy => policy.install(session))
    installedSessions.add(session)
    return true
  }

  return { install }
}

module.exports = createSessionPolicies
