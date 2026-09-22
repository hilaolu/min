# Annotation performance investigation

Measured on September 22, 2026 with Electron 41.2.0 on Linux using
`DISPLAY=:0` and `--no-sandbox`. These are single-run, instrumented measurements,
not cross-machine benchmarks. The baseline below predates the render-on-load fix.

## Render-on-load fix

Web annotations now restore once at `window.load`, including after full reloads
and redirects. Ordinary DOM mutations do not re-anchor them. Explicit annotation
Reload rebuilds anchors; annotation creation/edits/deletion update immediately.
All saved anchors are resolved against one text index before note-host insertion;
live Ranges are reused for rendering and hit testing. Empty notes need no host.
The only mutation observer runs while editing to rescue a detached draft, never
to index or repaint. Same-document URL changes clear stale highlights without
re-anchoring or permitting writes to the new URL.

The same 5,000-paragraph benchmark after this change measured:

| Annotations | Initial index builds / lookups | Initial index + locate time | 5 idle seconds: builds / lookups | 10 outside clicks: builds / lookups |
| --- | --- | --- | --- | --- |
| 10 | 1 / 10 | 16 ms | 0 / 0 | 0 / 0 |
| 100 | 1 / 100 | 51 ms | 0 / 0 | 0 / 0 |

Rectangle hit testing still occurs on clicks; these numbers do not measure its
cost. Actual Cloudflare challenges were not exercised; local full-redirect and
reload regression tests cover the document lifecycle. The PDF retention finding
below remains separate and is not changed by this webpage fix.

Evidence: `/tmp/min-annotation-perf-onload-results.json`,
`/tmp/min-annotation-perf-onload.log`.

## Webpage annotations

Fixture: 5,000 paragraphs, 505,000 text characters, unique annotation quotes
with 32-character before/after context. Notes were empty. The temporary preload
wrapped `textIndex` and `locate` with counters and `performance.now()` timers;
load/save IPC was mocked. Measurements used the production 1.5-second timer.

| Annotations | Initial index builds | Initial index + locate time | Index builds / lookups over 5 idle seconds | Idle index + locate time | 10 outside clicks: index builds / lookups | Click index + locate time |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | 0 | 0 ms | 0 / 0 | 0 ms | 0 / 0 | 0 ms |
| 10 | 11 | 75 ms | 6 / 60 | 104 ms | 10 / 100 | 74 ms |
| 100 | 101 | 506 ms | 6 / 600 | 286 ms | 10 / 1000 | 418 ms |

Ten keyup events with a collapsed selection caused no indexing or lookups.
The timing columns cover only these two functions, not layout, DOM updates,
painting, IPC, or the whole event. Hidden-tab behavior was not measured.

### Baseline findings and original proposals

1. **Idle re-anchoring does work without document changes.** `paint()` indexes
   and locates once for notes and again for highlights every timer tick. Prefer
   coalesced mutation-driven invalidation, with visibility gating. An observer
   must ignore annotation-owned DOM changes to avoid a self-triggering loop;
   retain source-URL checks independently, including SPA navigation.
2. **Initial anchoring rebuilds the entire index per annotation.**
   `renderNotes()` inserts a shadow host even for empty notes. Each insertion
   can split a text node, invalidating its index. Avoid empty note hosts until
   editing, and batch range resolution before insertion. Do not simply reuse
   stale node offsets after splitting text nodes.
3. **Unrelated clicks rescan and resolve every quote.** `hitAnnotation()` walks
   the entire body, then performs anchor searches and rectangle reads. Cache
   resolved ranges by document/annotation generation and invalidate on content
   changes. Rectangle caching needs separate scroll/resize/layout invalidation.
4. **Each lookup does repeated linear searches.** `locate()` searches the full
   text for quote uniqueness and linearly finds its start/end nodes. Share
   anchoring results between notes, highlights and hit testing; consider binary
   search of node offsets only after measuring the remaining cost. Duplicate
   quote ambiguity must still fail safely.

Temporary evidence (not required by application/runtime):
`/tmp/min-annotation-perf-prepare.js`, `/tmp/min-annotation-perf-harness.js`,
`/tmp/min-annotation-perf-results.json`, `/tmp/min-annotation-perf-run.log`.

## PDF annotation retention

`render()` deletes and reimports every highlight and note box on every save.
Companion boxes get new UUIDs each time. EmbedPDF with `autoCommit: false`
retains deleted annotations in its `byUid` store; unfiltered `getAnnotations()`
returns these records too.

A production-page test with one highlight and one note showed:

| Saves after initial note | Live annotations | Deleted records | Total records |
| --- | --- | --- | --- |
| 0 | 2 | 0 | 2 |
| 1 | 2 | 1 | 3 |
| 5 | 2 | 5 | 7 |
| 10 | 2 | 10 | 12 |

Thus repeated saves retain additional records even though visible annotation
count is unchanged. Retained heap bytes and long-session latency were not
measured. Investigate stable companion IDs and incremental updates instead of
whole-document delete/reimport. Preserve source-PDF immutability, protected
highlight geometry and session-only note layout; do not enable PDF commits just
to clear deleted records.

Temporary evidence: `/tmp/min-pdf-retention.js`, `/tmp/min-pdf-retention.log`.
Both normal and private production-page tests passed in that run.
