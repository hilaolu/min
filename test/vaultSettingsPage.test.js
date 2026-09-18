const assert = require('node:assert/strict')
const test = require('node:test')
const initializeVaultSettings = require('../pages/settings/vaultSettings.js')

function deferred () {
  const controls = {}
  const promise = new Promise((resolve, reject) => {
    controls.resolve = resolve
    controls.reject = reject
  })
  return { promise, resolve: controls.resolve, reject: controls.reject }
}

function element () {
  const listeners = new Map()
  return {
    disabled: false,
    textContent: '',
    value: '',
    addEventListener: (type, listener) => listeners.set(type, listener),
    async dispatch (type, event = { preventDefault: () => {} }) {
      const listener = listeners.get(type)
      return listener ? listener(event) : undefined
    }
  }
}

function fixture () {
  const elements = {
    'vault-root-form': element(),
    'vault-root-path': element(),
    'select-vault-root': element(),
    'vault-root-status': element()
  }
  return {
    document: { getElementById: id => elements[id] },
    form: elements['vault-root-form'],
    input: elements['vault-root-path'],
    button: elements['select-vault-root'],
    status: elements['vault-root-status']
  }
}

test('loads the initially saved vault path', async () => {
  const page = fixture()
  const initialization = initializeVaultSettings(page.document, {
    getRoot: async () => ({ ok: true, directory: '/saved/vault' }),
    selectRoot: async () => ({ ok: true, directory: '/unused' })
  })

  assert.equal(page.button.disabled, true)
  await initialization

  assert.equal(page.input.value, '/saved/vault')
  assert.equal(page.button.disabled, false)
})

test('does not replace input changed while loading the saved path', async () => {
  const page = fixture()
  const root = deferred()
  const initialization = initializeVaultSettings(page.document, {
    getRoot: () => root.promise,
    selectRoot: async () => ({ ok: true, directory: '/unused' })
  })

  page.input.value = '/typed/by/user'
  await page.input.dispatch('input')
  root.resolve({ ok: true, directory: '/saved/vault' })
  await initialization

  assert.equal(page.input.value, '/typed/by/user')
})

test('disables the form and ignores duplicate submits during a save', async () => {
  const page = fixture()
  const save = deferred()
  let saveCalls = 0
  await initializeVaultSettings(page.document, {
    getRoot: async () => ({ ok: true, directory: '' }),
    selectRoot: async value => {
      saveCalls++
      assert.equal(value, '/typed')
      return save.promise
    }
  })
  page.input.value = '/typed'
  await page.input.dispatch('input')

  const firstSubmit = page.form.dispatch('submit')
  const secondSubmit = page.form.dispatch('submit')
  assert.equal(page.input.disabled, true)
  assert.equal(page.button.disabled, true)
  assert.equal(page.status.textContent, 'Saving…')
  assert.equal(saveCalls, 1)

  save.resolve({ ok: true, directory: '/canonical' })
  await firstSubmit
  await secondSubmit

  assert.equal(page.input.value, '/canonical')
  assert.equal(page.status.textContent, 'Saved')
  assert.equal(page.input.disabled, false)
  assert.equal(page.button.disabled, false)
})

test('preserves input and re-enables the form after a failed save', async () => {
  const page = fixture()
  await initializeVaultSettings(page.document, {
    getRoot: async () => ({ ok: true, directory: '' }),
    selectRoot: async () => ({ ok: false, error: 'Could not save folder.' })
  })
  page.input.value = '/keep/this'
  await page.input.dispatch('input')

  await page.form.dispatch('submit')

  assert.equal(page.input.value, '/keep/this')
  assert.equal(page.status.textContent, 'Could not save folder.')
  assert.equal(page.input.disabled, false)
  assert.equal(page.button.disabled, false)
})

test('preserves input and reports Unchanged when saving is canceled', async () => {
  const page = fixture()
  await initializeVaultSettings(page.document, {
    getRoot: async () => ({ ok: true, directory: '' }),
    selectRoot: async () => ({ ok: false, canceled: true })
  })
  page.input.value = '/keep/this'
  await page.input.dispatch('input')

  await page.form.dispatch('submit')

  assert.equal(page.input.value, '/keep/this')
  assert.equal(page.status.textContent, 'Unchanged')
  assert.equal(page.input.disabled, false)
  assert.equal(page.button.disabled, false)
})

test('reports a failed load but allows a retry submission', async () => {
  const page = fixture()
  let saveCalls = 0
  await initializeVaultSettings(page.document, {
    getRoot: async () => ({ ok: false }),
    selectRoot: async value => {
      saveCalls++
      assert.equal(value, '/retry')
      return { ok: true, directory: '/retry/canonical' }
    }
  })

  assert.equal(page.status.textContent, 'Unable to load folder.')
  assert.equal(page.button.disabled, false)
  page.input.value = '/retry'
  await page.input.dispatch('input')
  await page.form.dispatch('submit')

  assert.equal(saveCalls, 1)
  assert.equal(page.input.value, '/retry/canonical')
  assert.equal(page.status.textContent, 'Saved')
})
