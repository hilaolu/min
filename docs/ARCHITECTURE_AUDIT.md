# Architecture audit

## Scope

Targeted review of the tracked application at `b63ac29a`: application composition,
renderer dependencies, settings/vault IPC boundaries, build scripts, and their
tests. Existing edits in `docs/vault/` and the untracked `tab-picker/` tree were
excluded. This is not an exhaustive security or dependency audit.

## Architecture worth preserving

- `main/index.js` is a composition root: it wires factory-created window,
  view, settings, vault, and session-policy services through explicit dependencies.
  Keep feature-specific policies outside the application lifecycle module.
- `js/rendererHost.js` exposes browser capabilities behind an adapter; renderer
  tests can use an in-memory host rather than Electron globals.
- Vault navigation, confined path resolution, resource transport, and annotation
  storage already have separate modules. Avoid replacing these with a general
  service framework or a second source of tab state.

## Findings

### 1. Build completion and publication were not owned by the builder — fixed

`scripts/buildBrowser.js` returned before its streams completed, logged Browserify
errors without failing the CLI, and opened the live bundle for writing before
compilation succeeded. A real missing dependency reproduced exit status zero.
`scripts/watch.js` also started a new asynchronous build for every change, allowing
multiple builds to write the same output concurrently.

The builder now returns a promise and uses a stream pipeline to propagate both
input and output failures. It stages the bundle beside the destination and renames
it only after successful completion, preserving the last good bundle on failure.
Temporary output is cleaned up on success and handled failure. The CLI reports
errors with a nonzero exit status; imported callers own error handling.

A small, separately tested build queue serializes browser rebuilds and coalesces
changes received during each build into one follow-up build. Watch mode reports a
failure and continues processing subsequent changes. This separates compilation,
publication, scheduling, and CLI error policy without changing bundlers.

Browser watch mode also queues file additions and removals, so adding a missing
dependency can recover a failed build. Initial discovery is ignored to avoid
redundant builds after the startup build.

Limits: publication protection applies to `dist/bundle.js`, not the intermediate
`dist/build.js` or the other build products. Serialization is per watcher, not a
cross-process lock. Abrupt process termination can leave a temporary directory;
this is not a crash-durable transaction.

### 2. Renderer dependency cycles remain — follow-up

A static literal-`require` inventory found two cyclic components within tracked
`main/`, `js/`, and `scripts/` sources:

- `browserUI.js`, `navbar/tabBar.js`, `navbar/tabEditor.js`, and
  `navbar/contentBlockingToggle.js`. For example, browser UI imports the tab bar,
  whose drop handler imports browser UI to create a tab.
- `commandPalette.js`, its two Vim command strategies, and
  `commandPaletteCommands.js`. The Google command reads input by importing the
  production palette singleton, while the palette imports the strategies that
  load the command registry.

Some edges are lazy imports, so these are not all import-time execution cycles.
Nevertheless, they make UI modules harder to instantiate independently. The tab
bar/editor also access DOM elements during module loading. A focused follow-up
should pass narrow action callbacks into these components and pass command
arguments into actions rather than reading the owning palette singleton. Add
independent-instance tests before changing initialization order.

### 3. Settings authorization depends on the preload boundary — follow-up

`js/util/settings/settingsMain.js` validates setting keys/values, but its
`settings:connect` and `settings:set` handlers do not validate the sender/frame.
`settingsPreload.js` gates the exposed API to internal pages; vault/file IPC has
additional main-owned caller checks. This is a defense-in-depth inconsistency,
not a demonstrated remote exploit.

Define an explicit settings caller policy in main, preserving the trusted chrome
and internal-page consumers. Test denied subframes, unrelated web contents, and
navigation before tightening access; simply allowing only the Settings page would
break other legitimate consumers.

### 4. Runtime versions disagree — follow-up

`.nvmrc` specifies Node 15.7.0, CI specifies Node 20, and the tests use `node:test`.
`package.json` also declares Electron 42.0.1 in `electronVersion` but installs
41.2.0 as its development dependency. Choose and document a supported toolchain
matrix, then align development and packaging versions in a separate tested change.

## Verification

- Baseline: 300 Node tests and JavaScript lint passed.
- New regressions first demonstrated the missing promise and false-success exit
  status, including a real Browserify missing-dependency failure.
- Build tests cover awaitable completion, preservation of the old bundle while
  building, source/output/publication failures, and temporary-output cleanup.
- Queue tests cover burst coalescing, non-overlap, changes during follow-up builds,
  recovery from synchronous/asynchronous errors, and watcher integration with
  injected edit/add/remove events and initial-scan suppression (no background
  watcher is started).
- After the change: all 311 Node tests, application lint, explicit script lint,
  and `npm run build` passed on Linux with Node 20.19.5.
- `DISPLAY=:0 node_modules/.bin/electron --no-sandbox test/electronVaultApp.js`
  failed waiting for the annotated-PDF result from `>p Report` at line 77. Running
  the original tracked build script produced a byte-identical browser bundle and
  reproduced the same failure. This pre-existing smoke-test blocker remains
  unresolved; later assertions in that test were not reached.
- The Electron smoke was not rerun after the watcher-event refinement, which
  changes no application code.
- Other Electron suites, manual filesystem-watcher testing, cross-platform builds,
  and release packaging were not run.

Relevant commands: `npm test`, `npm run build`, and explicit Standard lint of
`scripts/buildBrowser.js`, `scripts/buildQueue.js`, and `scripts/watch.js` (scripts
are not included in the existing `lint:js` glob).
