# Performance review

## Scope

Reviewed core history/bookmark search, tab/task rendering, page preloads, main
process persistence, and build/package configuration starting at `ec3a797e`.
Existing `docs/vault/` edits and the untracked `tab-picker/` tree were excluded.
This is a targeted code review, not a whole-app profile. Follow-up status and
measurements are recorded individually below; unimplemented ideas are not gains.

## Implemented: score only the requested bookmark tags

`js/searchbar/bookmarkManager.js:169` requests similar bookmarks for the selected
tags. Previously, `js/places/tagIndex.js:getSuggestedItemsForTags` scored and
sorted **every associated tag for every eligible bookmark**, only to discard
unrequested tags afterward. Common title/URL terms make this expensive even for
a one-tag query. This runs synchronously in the shared Places service renderer,
so it can delay other history requests as well as bookmark suggestions.

The scorer now optionally looks up just the distinct requested tags. Unfiltered
ranking remains available to the bookmark editor. Queries with no selected tags,
an unknown tag, or a tag below the existing two-document threshold return before
scanning pages. No persistent cache or invalidation mechanism was introduced.

Per-term scoring changes from iterating all associated tags to looking up the
selected tags. Per-page sorting likewise handles only selected tags. Scoring
formulas, thresholds, duplicate-query semantics, final bookmark ranking, stable
ties, and the 20-result limit are preserved, including zero-valued postings left
by deletions. Page tokenization and the final matching-bookmark sort still scale
with the history size; this does not make the whole query constant-time.

### Measurements

`node scripts/benchmarkPerformance.js`, Node 20.19.5 on this Linux workspace.
The new `bookmarkTags` workload uses synthetic ASCII titles/URLs, 56 distinct
tags, five warm-ups and the median of 15 samples per query. Index construction is
outside the timed section. Both runs used the same fixture and returned the same
result counts. Times are CPU workload measurements, not end-to-end UI latency.

| History entries (bookmarks) | Query | Before | After | Speedup |
| --- | --- | ---: | ---: | ---: |
| 1,000 (909) | One tag | 149.71 ms | 11.62 ms | 12.9× |
| 1,000 (909) | Two tags | 151.21 ms | 16.96 ms | 8.9× |
| 5,000 (4,545) | One tag | 761.36 ms | 60.65 ms | 12.6× |
| 5,000 (4,545) | Two tags | 771.16 ms | 94.40 ms | 8.2× |
| 5,000 (4,545) | Unknown tag | 771.22 ms | Below 0.01 ms reporting resolution | — |

The speedup will vary with tag distribution and query size. These numbers do not
establish a corresponding speedup for ordinary history search or browser startup.

## Further opportunities

### 1. Task overlay — search optimized; incremental rendering deferred

Search previously performed a document-wide selector lookup for each task/tab,
and split the same query inside the tab loop. `taskOverlaySearch.js` now uses two
scoped DOM scans to create short-lived ID maps and tokenizes the query once.
The maps are rebuilt per search, so drops, deletions and synchronized renders
cannot leave retained references to detached DOM. Match ordering, visible focus,
collapse expansion and the empty-query reset path are preserved.

The Electron smoke compares the old selector loop and new implementation in a
real DOM, forcing layout after alternating queries (two warm-ups, seven samples).
At 200 tabs, medians were **3.0 → 2.0 ms**; at 2,000, **120.4 → 16.9 ms**. Visible
IDs and focused matches agree. These measurements exclude construction, paint
and Sortable work. Four new Node tests cover filtering, bounded query counts,
DOM replacement/removal/moves and input/reset integration. All 364 Node tests,
lint, build, Electron performance and diff checks passed.

`taskOverlay.render` still rebuilds all tasks and Sortable instances on show,
empty search and visible synchronization events. Incremental rendering remains
deferred: it needs full drag/focus/cross-window acceptance coverage, not just this
isolated filter benchmark.

### 2. Compact history deletions in one pass — implemented

`js/places/placesCache.js:removeByIds` previously called `indexOf` and `splice`
for each removed record, taking O(KN) array work for K deletions from N entries.
Expiration invokes this after 20 seconds and hourly thereafter.

It now updates lookup maps/tag counts once per existing ID, collects the removed
objects, and compacts the shared array in one O(N) pass. Duplicate/missing IDs,
undefined IDs, survivor ordering/object identity, sorted state, and tag-removal
order are covered. Empty/missing-only batches avoid scanning entirely.

The new `placesDeletion` benchmark excludes cache construction and uses five
warm-ups/15 samples. Removing 10,000 alternating records from 20,000 took
**33.41 → 3.19 ms** median; 500 from 1,000 took **0.18 → 0.10 ms**. This measures
cache mutation, not IndexedDB deletion time. All 356 Node tests, app/script lint,
the Electron performance smoke and diff checks passed. The operation-count
regression failed against the original repeated-scan implementation.

Follow-up refinement: compaction now runs in `finally`, so a later tag-cleanup
exception cannot leave already-removed records in the array but absent from its
lookup maps. The original error still propagates. Regression coverage exercises
each failure position, sorted/unsorted caches, and retry without duplicate tag
removals. This is not a rollback of tag-index internals or database writes.
All 366 Node tests, lint, build, Electron performance and diff checks passed;
the repeated 20,000-entry/10,000-deletion benchmark measured 2.76 ms median.
Packaging, Markdown and cross-platform tests were not rerun for this refinement.

### 3. Markdown packaging — unused variants excluded; runtime unchanged

`scripts/createPackage.js` now excludes nine unused Cherry ESM/core/engine/stream
JS distributions. It retains the full UMD editor, CSS, all fonts, addons, package
metadata and legal comments. Nothing changes in the development installation.
The excluded files total **13,863,070 bytes (13.22 MiB)**. Applying the existing
release minifier to copies of those nine files did not reduce them further, so
these bytes are additional to the previous minification savings. Compressed
installer size and whole-app package size have not been measured.

The Node regression uses electron-builder's actual dependency-file matcher with
the production configuration. `test/fixtures/stageMarkdown.js` copies the editor
resources through that matcher and applies the production release minifier.
`test/electronMarkdown.js` now accepts `--app-root=<staged directory>` and blocks
HTTP(S) requests, asserting none are needed. Source and staged editor acceptance
both passed, including keyboard behavior, edit/save/conflict handling and layout.
Only `cherry-markdown.js` remains among the staged top-level distribution scripts.
All 365 Node tests, lint, build, packaging-script syntax and diff checks passed.
Both Electron runs emitted existing GLib and missing optional ECharts warnings.

Reproduce asset staging with `node test/fixtures/stageMarkdown.js`, then run
`DISPLAY=:0 node_modules/.bin/electron --no-sandbox test/electronMarkdown.js
--app-root=<directory from staging output>`. This does not build an installer.

Replacing the full runtime with core-plus-selected-plugins remains deferred:
core is not feature-equivalent, and would need additional diagram/math/asset
compatibility tests. No editor parse-time improvement is claimed here.

### 4. Avoid redundant positive reader detection — implemented

`js/preload/readerDetector.js` previously scanned every paragraph at both
`interactive` and `load`, even after reporting `canReader`. A per-document flag
now skips the redundant positive scan/notification. Negative pages still retry
at load; new documents start with fresh state. Detection thresholds are unchanged.

The 25,000-paragraph regression performs 25,000 text reads instead of 50,000.
Four new Node tests cover positive/negative pages, deferred content, navigation
isolation, ready states and subframes. The Electron smoke loads a positive page,
a negative page, an article populated by a deferred script, and another positive
document: notification counts are **[1, 0, 1, 1]**. All 360 Node tests, lint, build,
Electron performance and diff checks passed after correcting a test formatting
error. No wall-clock reader-detection speedup is claimed.

### 5. Search-result deduplication — measured, index deferred

`js/searchbar/searchbarPlugins.js:92` scans every plugin's result array for each
new URL, giving quadratic insertion work across a result batch. The new
`searchbarDeduplicationCPUOnly` workload runs the production plugin manager with
stub DOM nodes and pre-normalized unique URL keys across three plugins. With five
warm-ups/15 samples, Node VM medians were **0.05 ms for 10 results**, **0.28 ms for
30**, and **159.07 ms for a 1,000-result stress batch**. This is bookkeeping CPU
only, not real browser rendering or URL parsing.

Current Places/full-text results share a four-item allowance, search suggestions
are capped at three, and related instant answers at three. Large bookmark/history
lists render directly rather than using this deduplicator. Task/bang command rows
do not supply URLs and skip the duplicate check. There is no demonstrated large
URL batch in those callers, so adding another persistent index is deferred.
If result limits grow, revisit a URL-key reference-count map with tests for plugin
reset, top-answer replacement, text-fragment normalization and `allowDuplicates`;
a naive global Set would mishandle those lifecycles.

## Bookmark-fix verification

- Baseline: all 346 Node tests and JavaScript lint passed.
- New tests first passed the three behavior comparisons and failed the two
  operation-count/early-exit checks against the old implementation.
- After refinement, `npm test`: all 353 Node tests and JavaScript lint passed.
  The seven new tests use an independent legacy scorer (not the optimized
  implementation) and cover varied/Unicode tags, exclusions/thresholds, ties,
  result limits, mutations/reset, zero postings, and unrelated tag work.
- Explicit Standard lint of `scripts/benchmarkPerformance.js` passed.
- `npm run build` passed.
- `DISPLAY=:0 npm run test:electron-performance` passed, including a new real
  Places database/service test returning the expected 20 bookmark suggestions
  without leaking internal scoring/body fields. Electron emitted a GLib schema
  warning, but the test completed successfully.
- Before/after benchmark runs and `git diff --check` passed.

Follow-up verification is recorded in the individual sections above. Manual UI
profiling, real-user history workloads, full installer packaging and cross-platform
builds were not run. Incremental overlay rendering and a smaller Cherry runtime
remain explicitly deferred rather than being treated as completed optimizations.
