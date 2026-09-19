# Tab Picker port — incremental stages

Source-grounded behavior, intentional deviations and acceptance gates are in
[TAB_PICKER_SPEC.md](TAB_PICKER_SPEC.md). The plugin's `>p` searches saved PDF
URLs; the Min stages below instead implement the requested vault PDF picker.
The source audit found lossy Markdown parsing (including PDF geometry comments
leaking into notes). Legacy files are therefore imported read-only; Min never
rewrites them. The PDF backend replacement stage was prioritized by the user's
subsequent request. Web highlights remain a separate, pending stage.

## Stage 1: explicit file commands

Implemented: `>m folder/note.md` (the plugin's `>n` naming becomes `>m`)
and `>p folder/paper.pdf` in Min's command palette. Paths are literal,
relative to the configured vault; spaces need no quotes. Select the candidate
to open through existing vault routing, editor ownership and leave guards.
Missing files or an unavailable vault use the existing routing error page.
No filesystem access or web search is added to the palette.

Stage 1 provided explicit paths only; stage 2 adds filename search below.

## Stage 2: file picker candidates

Implemented: `>m [query]` and `>p [query]` search relative filenames, including
subfolders, case-insensitively. Empty queries list files. Both modes appear in
the `>` command list. Explicit paths remain available even if not found within
the scan budget. No file contents are indexed or sent to web search.

The browser-chrome-only main-frame API returns at most 20 files, inspects at
most 2,000 directory entries and descends at most 32 levels per request. A
limit message explains incomplete results. No persistent index/cache is kept.
Symlinks are excluded through existing vault resolution. New requests cancel
older scans from the same chrome; root changes invalidate in-flight scans.
The palette discards stale replies on query/mode changes and close, and shows
loading, error and empty-result states. Selecting a file uses existing routing.

Node coverage includes filtering, encoding, symlinks, missing roots, limits,
IPC caller/frame checks, root changes, UI states and stale-response races.
Interactive picker/keyboard and large-vault performance still need manual
verification. This is not annotation persistence acceptance.

## Stage 3: annotation storage contract

Implemented for PDF records in `main/annotationStore.js` and
`main/pdfAnnotations.js`. Contract:

- Files: `<vault>/.min-annotations/<sha256(source URL)>.json`.
- Envelope: `{version:1, source, annotations}`; each record carries `uid`,
  `sourceType:'pdf'`, and plugin-shaped `data` (text/context, notes, color,
  zero-based page index and native EmbedPDF rect/segmentRects).
- Source identity uses URL normalization and removes the fragment; scheme,
  port and ALL query parameters remain significant. This deliberately avoids
  the plugin's filename collisions and lossy query allowlist. File moves and
  changed query identities do not migrate records automatically.
- Maximum 1 MiB per file, 1,000 records, 100,000 characters per text field,
  10,000 segments per record; finite bounded geometry and unique IDs required.
- SHA-256 revision comparison prevents stale app/external-editor overwrites;
  per-file queues serialize writes and replacement is atomic. This is not an
  external-process compare-and-swap or protection against a concurrently
  hostile filesystem administrator. Symlink storage paths are rejected.
  Reads use bounded file handles and strict UTF-8 decoding; unavailable roots
  are errors rather than empty stores. Identical saves preserve file metadata.
- Narrow top-frame PDF-wrapper IPC; source is derived in main, never accepted
  as a save argument. Vault PDFs additionally require their existing resource
  association. Loads bind subsequent writes to frame/source/root generation.
  Root switching drains in-progress writes and invalidates old bindings.
- Private tabs cannot read/write saved annotations. Reading the PDF itself
  remains available. No vault configured also leaves the PDF readable.
- `main/annotationLegacy.js` strictly imports supported tab-picker Markdown;
  PDF geometry comments are removed from notes. Ambiguous/malformed input is
  rejected without changing source files. Version-1 backup JSON can also be
  imported. Exact source match is required; duplicate IDs abort the import.

Web legacy records can be parsed in isolation but web runtime persistence is
not enabled. Export is lossless Min JSON, not a claim of bidirectional legacy
Markdown compatibility.

## Stage 4: web highlights

Add selection capture, save/delete and reload/re-anchoring via narrow IPC.
Test hostile pages, navigation races, changed text, duplicates, private-mode
behavior and reopen persistence. Unresolved anchors must remain recoverable.

## Stage 5: replace PDF.js with EmbedPDF and add highlights

Implemented with pinned `@embedpdf/snippet`/`@embedpdf/models` 2.14.2, matching
tab-picker. PDF.js and its old page assets/dependency are removed. The existing
wrapper address and `>p` routing remain unchanged. Assets/WASM load locally;
remote UI fonts and fallback-font downloads are disabled. Non-embedded fonts
outside PDFium's built-in coverage still need a local fallback-font strategy.

Select PDF text and choose **Highlight selection**. Select a saved highlight
in the sidebar to edit its note/color or delete it. Each selected page receives
its own native geometry record; the combined selection text is retained on
each record. Saves are acknowledged before applying visual changes. Failures
retain the draft, display an error, and offer retry/export. Save/Discard/Cancel
guards cover Min-managed leave/close workflows. Legacy Markdown and JSON
imports are explicit file selections; source PDFs and legacy notes are never
overwritten. Native non-highlight annotation tools are disabled rather than
offering edits that would not persist.

Vault PDF requests remain credential-free and source-authorized. Ordinary web
PDF fetches retain the existing Min response/CORS policy. Local `file:` PDFs
use a main-owned read of only the wrapper's represented `.pdf`, with a PDF
signature check, regular-file check, no final symlink, and 256 MiB limit; the
page cannot supply another path. Browser Find uses EmbedPDF's search engine;
download/print actions are adapted to the new viewer.

### Verification

- Node store/import/IPC tests cover round trips, conflicts, queues, malformed
  input, caller/frame denial, root changes, private mode and local PDF reads.
- Production Electron page tests cover actual painted PDF pixels, real mouse
  text selection, highlight creation/save/delete, legacy import, note/color
  persistence, reopen hydration into the native annotation layer, invariant
  stored geometry across zoom/rotation, browser Find, dirty-PDF Cancel/Save,
  failed-Save close prevention, preserved conflicting disk changes, unchanged
  PDF bytes, and local-file/vault viewing in normal/private sessions.
- Build, transport suite, full-app vault suite and performance smoke pass.
- Latest checks: `npm test` passed 190 Node tests and JavaScript lint;
  `npm run build`, all three vault Electron suites, the performance smoke,
  and `git diff --check` passed. Electron tests used 41.2.0 on `DISPLAY=:0`.
  GLib/ResizeObserver/deprecated-navigation and existing transport CSP warnings
  were non-fatal. npm reported existing/transitive dependency audit findings;
  no broad dependency/security upgrade was attempted in this stage.
  A root-transition regression specifically verifies that prepared PDF Save
  finishes in the old vault while new annotation reads are denied.
- Physical printing, network PDF redirects/authentication, multi-page drag
  selection, visual geometry across all rotation/zoom combinations, packaged
  releases and broad manual accessibility remain unverified. These are not
  implied by the automated passes above.

Stages 1–2 and the PDF storage/backend/highlight slice are implemented. Stage 4
(web capture/re-anchoring) remains pending; the complete web/PDF port is not
claimed finished by this PDF-specific stage.
