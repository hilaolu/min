# Memory review

Reviewed tab/view ownership, history-service startup and caches, page preloads,
preview retention, and filtering at `69827b22`. This is a targeted source review
and isolated heap measurement, **not a whole-browser RSS profile**. Existing
`docs/vault/` edits and the untracked `tab-picker/` tree were left untouched.

## Implemented: release disabled filtering data

`main/filtering.js` retained the entire parsed EasyList/EasyPrivacy/custom list
after tracker blocking was disabled. An in-flight load could also finish and
install its data while disabled. Separately, the parser's process-wide separator
cache retained strings from every list it had matched, even after replacement.

The policy now:

- Releases its active list on disable and teardown.
- Invalidates outstanding generations: obsolete reads are not parsed, and
  obsolete chunked parsing stops at its next scheduled chunk. Existing waiters
  still settle; late callbacks cannot reinstall an obsolete list.
- Owns separator caches weakly by filter-list object, allowing unused caches to
  be collected without flushing another active list's cache.
- Keeps active level changes (third-party/all requests) on the same list, and
  preserves content-type blocking, exceptions and atomic list publication.

**Trade-off:** re-enabling rereads/reparses the lists. Until ready it behaves like
initial enable, rather than using the old rules retained across disable. No
partially parsed list is published. This is not a recommendation to disable
blocking: loading additional ads/trackers can increase page memory substantially.

### Measurement

`scripts/benchmarkFilteringMemory.js` uses only bundled filters, no user profile
or network requests. Each of three cycles enables filtering, evaluates 60,842
synthetic host-rule requests to warm separator caches, disables filtering, and
measures `heapUsed` after yielding and two explicit garbage collections. All
cycles, before and after, blocked the same 59,313 requests.

Measured with Electron **44.4.5**, its bundled Node **24.21.0**, on Linux. The
baseline used the original two modules from `69827b22` with the same workload.
Values below are medians of growth above each process's initial disabled heap:

| State                             |    Before |     After |
| --------------------------------- | --------: | --------: |
| Enabled, after matching workload  | 21.13 MiB | 20.51 MiB |
| Disabled, after matching workload | 21.11 MiB |  3.64 MiB |

This is approximately **17.5 MiB less retained heap after disabling**, not an
equivalent guaranteed RSS reduction. Compiler/fixture overhead remains; the heap
does not return completely to its cold baseline. Initial investigation with the
system Node 20 produced larger numbers; those are not the Electron result above.

Median load times were 335.56 ms before / 395.17 ms after; the 60,842-request
matching batches took 884.72 / 888.93 ms. Three cycles are diagnostic, not a
startup or latency guarantee. Releasing caches necessarily loses their warmth.

Reproduce with a supported Node version:

```sh
node --expose-gc scripts/benchmarkFilteringMemory.js
# Use the actual installed Electron/V8 runtime instead:
DISPLAY=:0 ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron \
  --expose-gc scripts/benchmarkFilteringMemory.js
```

### Verification

- 391/391 Node tests pass using Electron's bundled Node:
  `DISPLAY=:0 ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron --test test/*.test.js`.
  The initial `npm test` under system Node 20.19.5 passed 390 tests but failed
  the project's Node >=22.12.0 requirement; its chained lint did not run.
- `npm run lint:js`, separate benchmark-script lint, parser syntax check,
  `npm run build`, and `git diff --check` pass.
- `DISPLAY=:0 node_modules/.bin/electron --no-sandbox test/electronPerformance.js`
  passes, including real request blocking/redirects. It emitted a GLib schema
  warning but exited successfully.
- A differential comparison against the original parser checked **243,368**
  bundled-list decisions across script/image/XHR/popup requests, same-site and
  third-party contexts, subdomains and misleading hostname prefixes: **zero
  mismatches**. The committed focused tests additionally cover separator and
  wildcard matching, exception caches, cancellation, late reads/builds, teardown
  and rapid disable/re-enable.

Whole-app RSS/peak-memory profiling, long-running browsing and cross-platform
acceptance were not performed.

## Further opportunities and refinement status

Candidates 1–3 are source-derived opportunities, not implemented or measured.
The ownership refinements below are verified with lifecycle/count checks, not
whole-app memory measurements.

1. **Many background tabs / inactive tasks — defer or discard content.**
   `js/browserUI.js:presentOpenedTab` creates WebContents even for new background
   tabs. `switchToTask` only changes selection; it does not unload the previous
   task. `js/webviews.js:setSelected` already supports recreating missing views,
   as used by lazy session restoration. An opt-in background-load policy or
   inactive-tab discard could avoid page/renderer allocations. It needs explicit
   protection for unsaved forms/editors, media/WebRTC, downloads, popup adoption,
   navigation history and cross-window ownership. Blindly destroying hidden
   views risks data loss; first measure per-process memory with representative
   sites and verify restoration, not just URL persistence.

2. **Idle app / no browser windows — retire the Places service.**
   `main/main.js` initializes Places on startup and destroys it on quit;
   `main/placesManager.js:initialize` creates a hidden BrowserWindow. Draining
   writes and retiring it when no clients remain could remove an idle renderer
   and its history cache, particularly while the macOS app stays open without
   browser windows. `connect` already supports recreation. This requires client
   lifetime accounting, reconnect tests and durable completion of pending writes.

3. **Large history/bookmark libraries — reduce resident search metadata.**
   `js/places/placesService.js:loadHistoryInMemory` loads every summary, and
   `PlacesCache.createSummary` retains normalized title/URL strings in addition
   to public metadata and ID/URL indexes. Investigate a more compact search
   representation or a bounded hot cache with an IndexedDB fallback. Do not
   simply truncate history or lose old-bookmark search. Full page bodies are
   already excluded from the summary cache, and the service is shared across
   browser windows; duplicating the cache per window would be a regression.

4. **Implemented: dispose orphaned pending popups.**
   `main/pendingPopups.js` tracks unadopted views by their originating Browser
   Chrome/window. Closure, renderer crash, popup self-destruction and final
   teardown release the pending entries; adopted views survive owner cleanup.
   A shared listener set per owner avoids per-popup listener accumulation. Wrong
   owners cannot consume pending popups, and failed tab registration destroys its
   view instead of orphaning it. No expiry timer can kill a legitimate delayed
   popup. Regression tests cover 100 pending popups, independent owners, adoption,
   all cleanup paths, and the real view-manager command/event wiring.

5. **Implemented: repeated Places reconnects — release provisional listeners.**
   `main/placesManager.js` now detaches its named sender-destroyed/port-close
   callbacks and pending-array entry before transfer or discard. Remote port
   closure detaches without closing again; transfer failure closes its port and
   invalidates the service, cleaning remaining pending connections. Active
   transferred ports keep their existing ownership; readiness and IPC are unchanged.
   `test/placesManager.test.js` verifies 100 sequential successful connections to
   one long-lived sender: its destroyed-listener count and each transferred
   port's close-listener count are zero after every transfer, including before
   `postMessage`. Pending sender death, remote port close, load/transfer failure,
   service teardown, window closure and renderer crash also release provisional
   listeners without duplicate closes. Plain-object stubs remain supported.
   These are isolated listener-count checks, not whole-app MB savings or proof
   that an entire service renderer was leaked.

6. **Implemented: dispose closed Browser Chrome WebContents.**
   Review confirmed that BaseWindow closure left Chrome alive and did not run
   its session-saving `beforeunload` hook. After vault-close approval the window
   manager now closes Chrome gracefully while ownership is still registered,
   respects an unload veto, and disposes Chrome on forced closure as well. Tab
   content remains independently owned so closing one window does not destroy
   tabs that can move to another. Closed Chrome is excluded from live-window
   queries. Stable WebContents references are necessary during destruction:
   Electron clears `WebContentsView.webContents` when its contents die; pending
   popup cleanup now handles this too.
   `DISPLAY=:0 node_modules/.bin/electron --no-sandbox test/electronWindowLifecycle.js`
   verifies three open/close cycles, three synchronous unload notifications while
   ownership is valid, pending-popup disposal, forced closure, and **zero retained
   WebContents**. The original implementation failed the first disposal assertion.
   This is a lifecycle count, not an RSS claim. Unit tests cover cancelled close,
   unload veto, repeat close requests, and preservation of other tab contents.
   The full app/Vault smoke timed out at its initial `>m note` palette lookup,
   before lifecycle assertions; the same failure reproduced with the original
   window/view modules from `ef546d97`. The build and focused lifecycle smoke pass.

Existing bounds worth preserving: previews are limited to three 256-KiB encoded
images, the task overlay destroys Sortable/DOM state when hidden, closed-tab
restore stacks are bounded, and restored tab content is created lazily. Removing
Chromium isolation or forcing frequent GC is not a substitute for fixing object
and process lifetimes.
