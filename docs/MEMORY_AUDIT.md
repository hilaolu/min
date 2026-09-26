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

All five original candidates now have a scoped implementation. Candidate 1 uses
opt-in new-background-tab deferral, not destructive suspension of active pages.
Candidate 3 has an isolated retained-heap comparison.
The ownership refinements below are verified with lifecycle/count checks, not
whole-app memory measurements.

1. **Implemented safe subset: defer new background tabs only when opted in.**
   The strictly boolean `deferBackgroundTabs` setting defaults to `false`. The
   settings checkbox, “Load new background tabs only when selected,” applies to
   future tabs without a restart. `js/browserUI.js:presentOpenedTab` preserves
   Browser Session model and tab-bar creation, but skips `webviews.add` only for
   explicit HTTP(S), non-private tabs opened with `openInBackground === true`,
   with no existing popup view to adopt. The policy reads the stored tab data.
   Foreground tabs, blank tabs, internal/file/vault/about/data URLs, private tabs
   and popup adoption stay eager. The existing `webviews.setSelected` creates
   missing content on selection; closing an unselected deferred tab never needs
   to create its content.

   **Trade-off:** background pages and downloads wait until selection; opening
   many links no longer preloads their pages. Changing the setting does not load
   or unload already open tabs. There are no timers or suspension, and no
   already-running tabs are unloaded. Automatic inactive-tab discard remains
   intentionally unimplemented because it risks losing forms/editors, media,
   WebRTC, downloads and navigation state; URL persistence is not restoration.

   **Verification scope:** `test/backgroundTabs.test.js` exercises the policy and
   real Browser Session / Browser UI / webviews lifecycle with a bounded stub
   transport, including deferred model/rendered-tab counts, selection, early
   closure and live setting changes. `test/settings.test.js` covers defaults,
   strict validation and persistence. The built-app smoke
   `DISPLAY=:0 node_modules/.bin/electron --no-sandbox test/electronBackgroundTabs.js`
   verifies the real Settings checkbox and 20 background model/DOM tabs with
   **zero new WebContents or page requests**. Selecting one creates exactly one
   WebContents/request; reselection and closing another never-selected tab create
   no extra content. Destroying nonexistent content is idempotent, while existing
   content still requires the correct owner. These are allocation/request counts,
   not a renderer RSS measurement. Build, project lint and focused tests pass.
   Standalone lint/format of the legacy settings JS/HTML still reports pre-existing
   globals/style issues outside this feature; those unrelated sections were not
   reformatted. The new checkbox section matches Prettier's output.

2. **Implemented: start Places on demand and retire it after clients leave.**
   Places is created on its first connection, not unconditionally at startup or
   during installer handling. Its service tracks ports, initialization, request
   promises and background maintenance writes. With no clients or outstanding
   work, a cancellable 30-second idle grace period begins. Before notifying main,
   it stops maintenance timers so a write cannot start while retirement is in
   transit. A new connection/work item resumes maintenance if retirement loses
   the race. Main accepts retirement only from the current service's main frame
   and latest connection generation, with no pending transfers. An in-transit
   new port therefore cannot be destroyed by an obsolete idle notification.

   Closing Chrome now actually disconnects its ports (refinement 6). The hidden
   window, WebContents and resident history cache can then be released, especially
   while the macOS app stays resident without browser windows. The window registry
   retains control of non-macOS quit behavior; closing the last hidden service
   does not implicitly quit a resident app. Reconnection creates the service and
   reloads durable history. Live clients keep it warm. This trades cold reconnect
   latency for idle memory, and does not change force-quit/crash guarantees.
   The developer's Places inspector also wakes an absent service on demand;
   the built-app background-tab fixture verifies that menu path.

   Fake-clock tests cover initialization/failure, overlapping work, closed ports,
   errors, teardown, maintenance pause/resume, stale generations/windows/frames,
   queued transfers and recreation. The real IPC/IndexedDB smoke
   `DISPLAY=:0 node_modules/.bin/electron --no-sandbox test/electronPlacesIdle.js`
   observed **zero idle WebContents**, recreation and **22 durable records** after
   retirement, including 20 requests posted immediately before disconnection
   without waiting for acknowledgements and a background write completed after
   disconnection. Retirement took about 50 seconds: startup maintenance runs at
   20 seconds and restarts the 30-second grace period. Counts are not whole-app
   RSS measurements; native macOS lifecycle acceptance has not been run on this
   Linux workspace.

3. **Implemented: large history/bookmark libraries — inline search metadata.**
   `PlacesCache.createSummary` now copies the normalized strings returned by
   `getSearchTextCache(item)` into `summary.searchTitle` and `summary.searchURL`,
   rather than retaining a nested `{ title, url }` object per summary. The helper
   API still returns `{ title, url }`; ordinary search reads the inline fields.
   Public projections expose neither field. Normalized-string caches, all
   history/bookmarks, ID/URL maps, bookmark indexes, matching and ranking are
   preserved. No hot-cache bound, history trimming, index removal or per-window
   duplication was introduced; full page bodies remain excluded.

   **Measurement:** `scripts/benchmarkPlacesMemory.js` generates synthetic 20k
   and 100k libraries without user data or network access. Its baseline subclasses
   `PlacesCache` and overrides only `createSummary` to retain the nested layout;
   the inline case uses the actual production class. Both use real normalization,
   bookmark indexing, sorting, arrays and ID/URL maps. Each layout/count runs in
   three fresh `process.execPath --expose-gc` subprocesses, preserving
   `ELECTRON_RUN_AS_NODE=1`. The metric is median `heapUsed` growth from an empty
   cache after yielding and two explicit GCs, **not RSS or peak memory**.

   Electron **44.4.5**, bundled Node **24.21.0**, V8 **15.2.124.28-electron.0**,
   Linux, produced these exact byte measurements:

   | Summaries | Nested baseline | Production inline | Saved bytes | Reduction |
   | --------: | --------------: | ----------------: | ----------: | --------: |
   |    20,000 |      10,095,616 |         9,691,376 |     404,240 |     4.00% |
   |   100,000 |      48,619,696 |        46,706,376 |   1,913,320 |     3.94% |

   Both layouts retained exactly **20,000 / 100,000 summaries**, the same counts
   in each ID/URL map, **2,000 / 10,000 indexed bookmarks**, and **40,000 / 200,000
   normalized strings**. Post-measurement assertions verify every public field
   and normalized string, map identity and ordered search-result digests across
   layouts. Empty and normalized-title searches return all 20k/100k old records;
   bookmark searches return all 2k/10k bookmarks, including the oldest record in
   a targeted search. Prefix, out-of-order and nonmatching queries also agree.
   The script fails unless median inline heap is lower in both cases. Savings
   vary with runtime and data; these are not whole-browser memory guarantees.

   Reproduce:

   ```sh
   DISPLAY=:0 ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron \
     --expose-gc scripts/benchmarkPlacesMemory.js
   ```

   **Verification:** 40/40 focused Node tests (`placesCache`, `placesSearch`,
   `placesService`, `fullTextSearch`) pass under Electron's bundled Node. Tests
   cover normalization, title updates and URL replacement, projection privacy,
   all 20k old records remaining searchable, and unchanged ranking/boost/tie
   behavior. Changed-JS Standard lint (including both benchmark scripts),
   Prettier's audit check and the scoped diff whitespace check pass.
   `DISPLAY=:0 node_modules/.bin/electron --no-sandbox test/electronPerformance.js`
   passes, including ordinary-search and bookmark-suggestion `publicOnly`
   assertions for both new fields (a GLib schema warning was nonfatal).
   `scripts/benchmarkPerformance.js` also passes under Electron's Node. The
   existing preload bundle was used; no rebuild, full test suite, whole-app RSS
   profile or cross-platform check was performed for this refinement.

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

## Combined verification after refinements

- **439/439** Node tests pass using Electron's bundled Node 24.
- Project JS lint and `npm run build` pass.
- Electron performance, window lifecycle, deferred background tabs, Places idle
  and Settings authority smokes pass with `DISPLAY=:0`, using synthetic data and
  temporary profiles. GLib schema and deprecated navigation-method warnings do
  not fail these checks.
- The full-app/Vault palette failure and legacy settings lint/format limitations
  above remain; those checks are not claimed as passing. Native macOS behavior,
  long-running browsing and whole-browser RSS still need profiling.

## Additional review at `f2653298`: idle Command Palette

`main/commandPaletteOverlay.js` detached the palette on hide but retained its
WebContents until **all** browser windows closed. Closing its owning window while
another window remained open also left the presentation alive. This is separate
from the task switcher cleanup above.

The presentation now destroys its hidden view after **30 seconds** without a
reopen. Quick reopen reuses the view and cancels retirement; repeated hidden
updates cannot postpone retirement. A final owner-window close disposes it
immediately. Ownership transfers remove the old close listener. Hidden state
discards copied input/candidate payloads, and teardown resets readiness/state so
an obsolete load callback cannot ready a replacement view. An unused view from a
failed attachment also retires.

Only the display-only presentation is disposed. Browser Chrome still owns input,
commands and REPL state; tabs, forms, downloads and page renderers are untouched.
Keyboard focus still returns to Chrome synchronously, before the palette loads.
**Trade-off:** reopening after retirement must load the local presentation again,
so visual readiness can be slower than a warm reopen. There is no tab suspension,
forced production GC, reduced sandboxing or change to site isolation.

### Measurement and verification

`test/electronCommandPaletteMemory.js` uses the real presentation module, window
registry, overlay HTML and sandboxed preload with two minimal Chrome fixtures and
one synthetic tab. It uses a temporary profile, local/data URLs and no user data
or network. The overlay HTML is loaded as a local file, not a full Min session;
renderer sharing in other configurations can differ. The smoke shortens idle
retirement to one second; fake-clock unit tests verify the production 30 seconds.

On Linux / Electron 44.4.5 / bundled Node 24.21.0, three fresh processes completed
three open/hide/retire cycles each:

- All **9 cycles** returned from **4 to 3 WebContents**, leaving both Chrome
  fixtures and the tab alive. The palette renderer PID disappeared from Electron
  app metrics in every cycle. Cold reopen rendered fresh candidates and accepted
  keys sent immediately, without waiting for overlay readiness.
- Summing Linux `/proc/<pid>/smaps_rollup` PSS across Electron's app-metrics
  processes, the hidden-to-retired decrease was **20.3–22.1 MiB**, median
  **21.3 MiB** (21,844 KiB). PSS apportions shared pages rather than counting each
  process's entire working set as independently saved memory.
- These are observed within-fixture decreases, **not a controlled whole-browser
  savings claim**. Background reclamation and allocator noise contribute: the
  original module's comparison also fell 3.4 MiB over the wait while retaining
  **4 WebContents and the palette PID**. It failed the disposal assertion, as
  expected. The regression asserts lifetimes/counts, not byte thresholds.
- All six new Node regressions failed against the original module. With the
  change, **445/445 Node tests**, project JS lint, the full build, and real Electron
  window-lifecycle and built-app background-tab smokes pass. Additional checks
  cover ownership transfer, failed attachment, quick reopen, hidden payloads,
  teardown before loading completes and explicit disposal/recreation.
- An initial repeated smoke read keyboard state before asynchronous input was
  observed. It now waits only for observation, without delaying or resending the
  keys; all three subsequent fresh runs passed. The later pre-load-disposal
  extension also passes. Electron's GLib schema warning remains nonfatal.

Reproduce:

```sh
DISPLAY=:0 ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron \
  --test test/commandPalettePresentation.test.js
DISPLAY=:0 node_modules/.bin/electron --no-sandbox test/electronCommandPaletteMemory.js
# Optional regression comparison; expected to fail the idle-disposal assertion:
baseline=$(mktemp --suffix=.js)
git show f2653298:main/commandPaletteOverlay.js > "$baseline"
DISPLAY=:0 node_modules/.bin/electron --no-sandbox test/electronCommandPaletteMemory.js \
  --presentation-source="$baseline"
```

Long-running real browsing, cross-platform acceptance, cold-open latency and
whole-browser memory profiling were not performed for this change. Existing
`docs/vault/` work and the untracked `tab-picker/` tree remain untouched.

### Follow-up: the four additional candidates, implemented in order

1. **Repeated permission requests in a long-lived tab.**
   `main/permissionManager.js` now installs one navigation/destroyed listener
   pair per WebContents, tracked weakly. Navigation revokes records as before;
   destruction also detaches the navigation listener. A 1,000-request workload
   now retains **1 of each listener instead of 1,000**, including after repeated
   navigation cycles. Once a pending request is granted, its callback is removed
   from the retained record. Grants are published before invoking the callback,
   so synchronous navigation/destruction cannot reinstall a stale record.

   Destruction now always removes pending/granted records, even with no browser
   windows left. The renderer notification loop still sends no IPC in that case.
   Previously this shutdown guard skipped data cleanup too, retaining callbacks
   and grants in a resident application. Nine focused tests cover these cases,
   duplicate notification rejection, media types, cross-tab reuse, revocation,
   IPC authorization and pointer-lock focus-before-response. Six fail against
   the original implementation. Counts demonstrate bounded retention, not MB
   savings or native OS permission-dialog acceptance.

2. **Long sessions opening/closing many distinct tabs.**
   `js/previewImageManager.js` no longer retains a permanent generation counter
   for every tab ever invalidated. Invalidation marks the pending capture Promise
   in a WeakSet instead; settled/cleared requests can be collected. Navigation
   still coalesces an outstanding capture until it settles, while explicit clear
   permits a replacement immediately. Old completions cannot overwrite a new
   capture or delete its pending entry. `webviews.destroy` now clears previews
   for ordinary closure as well as crashes.

   Instrumented-map tests show **zero retained entries after 10,000 closed-ID
   invalidate/clear pairs**, versus 10,000 before. Tests also cover both old/new
   completion orders, ID reuse, retry after errors, private-tab exclusion, the
   three-image/30-second bounds, and deferred-tab closure without loading it.
   This is an allocation-count regression, not a whole-renderer byte measurement.

   Pre-commit review additionally registers the request **before** dispatching
   capture/options callbacks, so synchronous invalidation and reentrant requests
   cannot bypass deduplication. Synchronous errors now follow the same cleanup
   and retry path as rejected captures. Completion rechecks private-tab status;
   looking up expired, removed or private-tab images releases their cache entries
   instead of only returning null. Four additional regressions failed before
   this refinement and pass after it; no periodic cleanup timer was added.

3. **Broad full-text queries over large history libraries.**
   `js/places/fullTextSearch.js` converts each posting array to a Set as its read
   resolves instead of retaining all arrays alongside all Sets. A worst-first
   heap retains only the existing candidate margin, preserving encounter order
   on score ties. Every match is still counted; no history records are excluded.
   Posting entries are cleared before loading the selected full documents.
   Token frequencies, metadata/body matching, document boosting, snippets and
   public projections are unchanged. For malformed NaN history scores, selection
   falls back to the original full sort to preserve its non-transitive behavior;
   that exceptional path does not have the normal candidate-memory bound.

   Differential tests cover mixed/ascending/reversed inputs, ties and fractional
   or large limits. In a synthetic 100,000-summary, two-token query with limit 4,
   both versions count all 100,000 matches and select exactly the same 12 IDs.
   The benchmark samples **post-GC heap above the empty-query fixture**, not true
   peak memory or RSS. Three fresh processes per version produced these medians:

   | Sampling point                      | Before bytes | After bytes |
   | ----------------------------------- | -----------: | ----------: |
   | Near the end of candidate scan      |    3,891,324 |   2,657,696 |
   | While selected body read is pending |    3,897,016 |      24,396 |

   This is about **1.18 MiB less at the scan sample** and **3.69 MiB less during
   body loading** in this workload. The baseline uses the original module from
   `f2653298` with the same fixture, scoring and database stub. Real IndexedDB
   behavior is additionally covered by the Electron performance smoke.

4. **Content search through large vault files.**
   The sliced-string hypothesis was confirmed in **external V8 memory**, not
   `heapUsed`: eight short passages kept eight decoded 4-MiB files alive.
   `main/vaultContentSearch.js` now copies a passage only when it enters the
   retained top results. The copy round-trips through UTF-16LE to preserve exact
   code units, even when clipping bisects a surrogate pair; UTF-8 would replace
   these boundary characters. Matching, ranking, highlights, cancellation,
   path/security checks and the 4-MiB/file, 32-MiB/scan limits are unchanged.

   With eight synthetic files, both implementations return the same eight
   results and **2,520 snippet characters**, with identical serialized-result
   SHA-256 digests. Three fresh processes per version gave:

   | Post-GC growth with results alive   | Before bytes | After bytes |
   | ----------------------------------- | -----------: | ----------: |
   | V8 external memory                  |   33,554,432 |   4,194,304 |
   | JavaScript heap                     |      124,928 |     132,308 |
   | ArrayBuffers (included in external) |            0 |           0 |

   That is **28 MiB less retained external memory**, at a roughly 7-KiB heap cost
   for small owned strings. It is not a zero-retention or RSS claim: this runtime
   still retains 4 MiB of external memory in the fixture. The small copies add
   allocation/encoding work only for accepted results, not every scanned file.

#### Follow-up verification and reproduction

Measurements above use Electron **44.4.5**, Node **24.21.0**, V8
**15.2.124.28-electron.0** on Linux. `scripts/benchmarkSearchMemory.js` uses only
synthetic records and its own temporary files; it leaves user data untouched.
Forced GC is confined to the benchmark, never production. External memory
includes ArrayBuffers: do not add those two reported columns together.

```sh
DISPLAY=:0 ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron \
  --expose-gc scripts/benchmarkSearchMemory.js full-text
DISPLAY=:0 ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron \
  --expose-gc scripts/benchmarkSearchMemory.js vault
# Compare either workload with its original source, without replacing app files:
baseline=$(mktemp --suffix=.js)
git show f2653298:main/vaultContentSearch.js > "$baseline"
DISPLAY=:0 ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron \
  --expose-gc scripts/benchmarkSearchMemory.js vault --source="$baseline"
# For full-text, export js/places/fullTextSearch.js and select full-text instead.
```

- **467/467 Node tests** pass after the pre-commit refinement, using Electron's
  bundled Node; none skipped.
- Project JS lint, benchmark-script lint, full build and existing performance
  benchmarks pass.
- Electron performance, vault content search, built-app background tabs, window
  lifecycle and palette lifecycle/memory smokes pass with `DISPLAY=:0`. The GLib
  schema and existing navigation-method deprecation warnings remain nonfatal.
- Cross-platform/native permission UX, sustained real browsing, actual peak
  memory and whole-app RSS gains were not measured. Unrelated work is preserved.
