// Coalesce changes received during a build into one subsequent build. The
// returned promise drains the queue; errors are reported without stopping it.
function createBuildQueue (build, onError) {
  let requested = false
  let pending = null

  async function run () {
    try {
      while (requested) {
        requested = false
        try {
          await build()
        } catch (error) {
          onError(error)
        }
      }
    } finally {
      pending = null
    }
  }

  return function requestBuild () {
    requested = true
    if (!pending) pending = Promise.resolve().then(run)
    return pending
  }
}

module.exports = createBuildQueue
