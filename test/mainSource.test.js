const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const mainSource = fs.readFileSync(path.resolve(__dirname, '../main/main.js'), 'utf-8')

test('command palette lifecycle IPC handlers are registered once', function () {
  const channels = [
    'initCommandPaletteOverlay',
    'showCommandPaletteOverlay',
    'hideCommandPaletteOverlay',
    'destroyCommandPaletteOverlay'
  ]

  channels.forEach(function (channel) {
    const registration = `ipc.on('${channel}'`
    assert.equal(mainSource.split(registration).length - 1, 1, `${channel} should have one listener`)
  })
})
