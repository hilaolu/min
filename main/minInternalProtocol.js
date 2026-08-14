const { pathToFileURL } = require('url')

function createProtocolPolicy ({ net, path, protocol, rootDir, Response }) {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'min',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true
      }
    }
  ])

  function registerBundleProtocol (ses) {
    ses.protocol.handle('min', (req) => {
      let { host, pathname } = new URL(req.url)

      if (pathname.charAt(0) === '/') {
        pathname = pathname.substring(1)
      }

      if (host !== 'app') {
        return new Response('bad', {
          status: 400,
          headers: { 'content-type': 'text/html' }
        })
      }

      // NB, this checks for paths that escape the bundle, e.g.
      // app://bundle/../../secret_file.txt
      const pathToServe = path.resolve(rootDir, pathname)
      const relativePath = path.relative(rootDir, pathToServe)
      const isSafe = relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath)

      if (!isSafe) {
        return new Response('bad', {
          status: 400,
          headers: { 'content-type': 'text/html' }
        })
      }

      return net.fetch(pathToFileURL(pathToServe).toString())
    })
  }

  return { install: registerBundleProtocol }
}

module.exports = createProtocolPolicy
