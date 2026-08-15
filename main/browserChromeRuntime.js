const RUNTIME_ARGUMENT_PREFIX = '--min-browser-chrome-runtime='

const RUNTIME_CONFIGURATION_KEYS = [
  'appName',
  'appVersion',
  'developmentMode',
  'initialTask',
  'initialWindow',
  'launchWindow',
  'platform',
  'windowId'
]

function invalidRuntimeConfiguration (message) {
  const error = new Error(message)
  error.code = 'INVALID_BROWSER_CHROME_RUNTIME_CONFIGURATION'
  return error
}

function normalizeRuntimeConfiguration (configuration) {
  if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)) {
    throw invalidRuntimeConfiguration('Browser Chrome runtime configuration must be an object')
  }

  const normalized = {
    appName: configuration.appName,
    appVersion: configuration.appVersion,
    developmentMode: configuration.developmentMode,
    initialTask: configuration.initialTask == null ? null : configuration.initialTask,
    initialWindow: configuration.initialWindow,
    launchWindow: configuration.launchWindow,
    platform: configuration.platform,
    windowId: configuration.windowId
  }

  const stringKeys = ['appName', 'appVersion', 'platform', 'windowId']
  stringKeys.forEach(function (key) {
    if (typeof normalized[key] !== 'string' || normalized[key].length === 0) {
      throw invalidRuntimeConfiguration(`Browser Chrome runtime configuration requires ${key}`)
    }
  })
  if (normalized.initialTask !== null && typeof normalized.initialTask !== 'string') {
    throw invalidRuntimeConfiguration('Browser Chrome runtime configuration initialTask must be a string or null')
  }
  ;['developmentMode', 'initialWindow', 'launchWindow'].forEach(function (key) {
    if (typeof normalized[key] !== 'boolean') {
      throw invalidRuntimeConfiguration(`Browser Chrome runtime configuration requires boolean ${key}`)
    }
  })

  return Object.freeze(normalized)
}

function createRuntimeArgument (configuration) {
  const normalized = normalizeRuntimeConfiguration(configuration)
  return RUNTIME_ARGUMENT_PREFIX + encodeURIComponent(JSON.stringify(normalized))
}

function readRuntimeArgument (argv) {
  const argument = argv.find(value => value.startsWith(RUNTIME_ARGUMENT_PREFIX))
  if (!argument) {
    throw invalidRuntimeConfiguration('Browser Chrome runtime configuration argument is missing')
  }

  let parsed
  try {
    parsed = JSON.parse(decodeURIComponent(argument.slice(RUNTIME_ARGUMENT_PREFIX.length)))
  } catch (error) {
    throw invalidRuntimeConfiguration('Browser Chrome runtime configuration argument is malformed')
  }

  return normalizeRuntimeConfiguration(parsed)
}

module.exports = {
  createRuntimeArgument,
  normalizeRuntimeConfiguration,
  readRuntimeArgument,
  RUNTIME_ARGUMENT_PREFIX,
  RUNTIME_CONFIGURATION_KEYS
}
