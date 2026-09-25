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

### 1. Avoid rebuilding the entire task overlay

`js/taskOverlay/taskOverlay.js:185` empties the DOM, destroys all Sortable
instances, and rebuilds every task/tab. Visible `state-sync-change` events invoke
it at line 396. Search also performs a document-wide selector lookup for each tab
at line 294 and splits the same query inside the tab loop.

Use keyed task/tab element maps and batch relevant updates; at minimum, reuse
element references and tokenize the query once. This needs real Electron
layout/paint measurements with hundreds or thousands of tabs, plus focus,
selection, dragging, and cross-window synchronization tests. Existing task-summary
CPU benchmarks do not measure this DOM workload.

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

### 3. Narrow the Markdown editor's shipped/runtime assets

`pages/markdown/index.html:26` loads Cherry's full UMD distribution. Locally that
file is 13,011,135 bytes; the package also contains ESM, core, stream and engine
variants. `scripts/createPackage.js` excludes source maps and minifies staged JS,
but does not explicitly select just the required Cherry distribution/assets.

First inspect a staged release and exclude unused variants while retaining
licenses, CSS/fonts and dynamically loaded assets. Separately investigate a
core-plus-required-plugins build to reduce parse/initialization work: the local
core file is 2,313,477 bytes, but it is **not** assumed feature-equivalent to the
full editor. These are development file sizes, not measured release savings.
Validate offline editing, diagrams, math, highlighting, assets and saved Markdown
before replacing the runtime bundle. The PDF bundle already has a dedicated
asset-pruning pipeline; do not assume repeating that work helps here.

### 4. Avoid redundant positive reader detection

`js/preload/readerDetector.js:5` reads every paragraph's text; lines 48 and 51 run
the scan at both `interactive` and `load`. Once a document has reported
`canReader`, there is currently no negative status to revoke it. Consider skipping
the second scan after a positive first result, while retaining the load-time retry
for initially negative pages. Test deferred content, navigation and large articles
before changing scheduling.

### 5. Index search-result deduplication if larger result sets justify it

`js/searchbar/searchbarPlugins.js:92` scans every plugin's result array for each
new URL, giving quadratic insertion work across a result batch. A URL-key
reference-count map could avoid the scans, but normal search result sets are small,
so this is lower priority. Test plugin reset, top-answer replacement, text-fragment
normalization and `allowDuplicates`; a naive global Set would mishandle these
lifecycles. Measure first rather than adding state for an insignificant saving.

## Verification

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

Other Electron suites, manual UI profiling, real-user history workloads, release
packaging and cross-platform builds were not run for this change.
