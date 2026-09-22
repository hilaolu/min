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

### 2. Renderer dependency cycles — fixed

A static literal-`require` inventory originally found two cyclic components within tracked
`main/`, `js/`, and `scripts/` sources:

- `browserUI.js`, `navbar/tabBar.js`, `navbar/tabEditor.js`, and
  `navbar/contentBlockingToggle.js`. Browser UI imported the tab bar, whose drop
  handler imported browser UI to create a tab.
- `commandPalette.js`, its two Vim command strategies, and
  `commandPaletteCommands.js`. The Google command read input by importing the
  production palette singleton, while the palette imported the strategies that
  loaded the command registry.

The tab bar and content-blocking button now emit tab-creation requests, which
Browser UI handles through the same workflow as other tab actions. They no longer
import their controller. The tab bar/editor's own DOM lookup and listener setup
now run from explicit, idempotent `initialize()` calls in `js/default.js`.

Google commands accept explicit queries rather than consulting the production
palette singleton; selecting Google in the command menu prompts for a query.
Generic command candidates capture their own arguments. Tests cover independent
module instances, initialization, dropped URLs/files, bug-report requests, and
query isolation.

A follow-up static inventory of 167 source files and 448 dependency edges found
no cycles or self-loops. This includes lazy literal requires but excludes dynamic
loading and dependencies outside `main/`, `js/`, and `scripts/`. Other legacy UI
modules still have import-time effects; this is not a wholesale renderer rewrite.

### 3. Settings authorization depended on the preload boundary — fixed

At audit time, `js/util/settings/settingsMain.js` validated setting keys/values,
but its `settings:connect` and `settings:set` handlers did not validate the
sender/frame. `settingsPreload.js` gated the exposed API to internal pages, unlike
vault/file IPC's additional main-owned caller checks. The finding was a
defense-in-depth inconsistency, not a demonstrated remote exploit.

`main/settingsAccess.js`, wired at the composition root, now requires live,
main-owned chrome/tab contents and their current main frame. Only packaged chrome,
Settings, reader, and themed error pages may read settings. Chrome and Settings
may write validated preferences; the reader may write only its three preferences;
error pages are read-only. Unknown callers fail closed, including when no policy
is configured.

Snapshots, mutations, and broadcasts use that policy. Queued writes recheck
ownership, frame identity, and URL before touching storage. Trusted main-process
calls remain independent of renderer authorization. Per-renderer notification
failures are logged without misreporting an already-durable write as failed or
blocking updates to other recipients. Unit tests and a dedicated
Electron test bypass preload gates to exercise denied foreign contents,
subframes, navigation, and scoped updates against the main-process boundary.

### 4. Runtime versions disagreed — fixed

`.nvmrc` now selects Node 20, matching CI and the Nix development shell. The
packaging Electron declaration now matches the installed development version,
41.2.0, rather than selecting an untested 42.0.1 runtime. The README records the
toolchain and upgrade checks. Tests guard local/CI Node-major consistency and
development/packaging Electron-version equality. This aligns the existing tested
runtime; it does not upgrade Electron or certify every target platform.

### 5. Electron app acceptance fixture drift — fixed

The failing annotated-PDF assertion expected a query parameter that the annotation
identity policy intentionally removes. The web-annotation fixture also lived
outside the configured annotation folder. The test now expects the canonical PDF
URL and writes/updates web annotations under the default annotation folder. No
production annotation behavior was changed to accommodate the test.

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
- The initial build-pipeline change passed 311 Node tests, application lint,
  explicit script lint, and `npm run build` on Linux with Node 20.19.5.
- `DISPLAY=:0 node_modules/.bin/electron --no-sandbox test/electronVaultApp.js`
  failed waiting for the annotated-PDF result from `>p Report` at line 77. Running
  the original tracked build script produced a byte-identical browser bundle and
  reproduced the same failure. Finding 5 explains and fixes that fixture drift.
- After the remaining fixes: all 324 Node tests, application lint, and the full
  build passed. `test/electronSettings.js` and the complete
  `test/electronVaultApp.js` both passed with `DISPLAY=:0` and `--no-sandbox`.
  The tested Electron binary reports 41.2.0. Electron emitted existing GLib schema
  and navigation-API deprecation warnings; neither test failed.
- Other Electron suites, manual filesystem-watcher testing, cross-platform builds,
  and release packaging have not been verified for these changes.

Relevant commands: `npm test`, `npm run build`, and explicit Standard lint of
`scripts/buildBrowser.js`, `scripts/buildQueue.js`, and `scripts/watch.js` (scripts
are not included in the existing `lint:js` glob).
