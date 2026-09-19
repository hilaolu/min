# Tab-picker → Min: source findings and port contract

Scope: Markdown/PDF picking and web/PDF annotation persistence only. This is
not a port of every tab-picker mode. Source paths below are relative to
`tab-picker/`. Observed plugin behavior is distinct from required Min behavior.
This source-audit document predates implementation. Current implementation and
verification are tracked in TAB_PICKER_PORT.md. The subsequent user request
replaces the planned PDF.js adapter with tab-picker's EmbedPDF/PDFium backend.

## 1. Observed picker behavior

Evidence: `src/ui/TabPicker/TabPickerModal.ts:98–151,223–302` and
`src/ui/TabPicker/TabPickerDataSource.ts:45–127,219–297`.

| Behavior | `>n` | `>p` |
| --- | --- | --- |
| Source | Vault Markdown, excluding annotation files | Annotation-store records whose URL is PDF-like or which contain PDF annotations |
| Empty query | First 10 in vault order | Up to 10 saved PDF candidates; otherwise a non-actionable placeholder |
| Search | Case-insensitive substring of path/name, tags, aliases, title or headings | Title, URL, path, filename and tags; substring score, otherwise ordered fuzzy subsequence score |
| Limit | 20 matches | 20 saved matches, with possible direct URL candidate |
| Selection | New Obsidian leaf, `openFile` | New EmbedPDF leaf, URL state |

Prefixes are case-sensitive and require no delimiter (`>nfoo` works). Bare
`>` enters mode selection with no suggestions. PDF direct input gets an
`https://` prefix if absent; this is not strong URL validation. Equal-score
ordering has no explicit tie-breaker. The selection handler ignores modifiers;
Ctrl-K/Ctrl-L are navigation bindings, not alternate opening actions.

**Important:** plugin `>p` is not a filesystem PDF picker.

## 2. Observed annotation model and storage

Evidence: `src/types/index.ts:3–31`, `src/services/AnnotationManager.ts:21–165`,
`src/utils/markdown-utils.ts:17–186`, `src/utils/url-utils.ts:12–40`,
`src/utils/annotation-url.ts:8–136`.

Each annotation has `uid`, `url`, `title`, optional `sourceType` (`webpage` or
`pdf`), and `data`: `color`, `notes`, `text`, `textBefore`, `textAfter`.
PDF data additionally carries `pageIndex`, `rect`, `segmentRects`. Rectangles
use `{origin:{x,y},size:{width,height}}`, stored directly from EmbedPDF.
The inspected source does not establish a conversion to PDF.js coordinates.

The default store is `Annotations`. A resource maps to:

```text
Annotations/<hostname>/<encodeURIComponent(pathname + canonical query)>.md
```

Root pathname becomes `/index`. URL canonicalization drops query parameters
outside the explicit resource/CMS allowlist, sorts retained parameters and
removes a non-root trailing slash. Invalid URLs pass through canonicalization.
Canonicalization itself retains fragments; the web capture caller strips them.
Filenames omit scheme, port and fragment, so distinct sources can collide.

Generated Markdown:

```markdown
| Field | Value |
| --- | --- |
| Title | Example |
| URL | https://example.org/article |
| Tags | #annotation |

## Annotations

%% annotation: example-id | color: ffeb3b %%
<pre>preceding context</pre>
<pre>selected text</pre>
<pre>following context</pre>

Optional note
```

PDF markers append ` | sourceType: pdf | pageIndex: N` before ` %%`.
If both geometry fields exist, the three pre blocks are followed by:

```text
%% annotation-rect: <JSON rectangle> %%
%% annotation-segments: <JSON rectangle array> %%
```

Save reads the existing file, parses it, replaces/adds by UID, and regenerates
the entire file; existing parsed title/URL/tags win. Load resolves the same
path and filters parsed records by canonical URL equality. Missing files load
as an empty list. Delete parses/regenerates without that UID and leaves empty
files in place. Storage failures reject; there is no evidenced atomic-write or
conflict protocol in this manager.

### Compatibility hazards (do not reproduce as Min guarantees)

- UID parser accepts only letters, digits and hyphens; serializer does not
  enforce that restriction.
- Empty text and empty notes cause a record to disappear on parse.
- Raw pre contents, marker-like notes and escaped table pipes are not safely
  round-trippable. Unknown document structure is not preserved by regeneration.
- Invalid geometry JSON is silently dropped; parsed geometry lacks schema
  validation. Serialization requires both geometry fields.
- **PDF geometry comments also become notes:** parser takes everything after
  the third closing pre tag as notes without removing the geometry comments.
  Repeated parse/save can duplicate metadata into notes.
- Source filename collisions and lossy query normalization mean filename alone
  cannot authorize a write or establish source identity.

## 3. Observed capture, restoration and editing

### Web

Evidence: `preload/annotation.js:106–180,193–223,400–467,592–669,748–832`,
`preload/annotationMarker.js:108–179,402–550`,
`src/bridge/BridgeController.ts:18–85`, `src/webview-injection.ts:232–253`.

Selection/mouseup exposes a color popover. Capture stores trimmed text and up
to 128 characters on either side, assigns a UID, paints and requests save.
Failed creation rolls back the paint. Initialization loads annotations for the
current URL and attempts to paint them. Restoration normalizes whitespace and
case; it tries before+text+after, before+text, text+after, then the first text
match. Repeated text can therefore anchor incorrectly. Failed anchors are logged.

Clicking a highlight opens editing. Notes can be saved; color is selected on
creation, with no separate color-edit persistence found. Failed note saves do
not restore the previous in-memory note. Delete removes local paint/state
before asynchronous persistence and lacks a rejection handler.

The plugin's page queue/console-ping bridge is an implementation detail, not
a security boundary suitable for copying into Min.

### PDF

Evidence: `src/pdf/embedpdf-reader.ts:140–175,195–370,377–426`,
`src/pdf/embedpdf-highlight-bridge.ts:45–99`, `src/pdf/EmbedPdfView.ts:70–93`.

Opening the reader loads/imports PDF highlights, suppressing persistence events
during hydration. Selection capture uses only the first formatted selection,
a UUID and default color `#FFCD45`; it stores native EmbedPDF geometry and
selected text. Failed explicit creation removes the native highlight and
shows a notice. Native create/delete events also write/delete storage; their
failures are logged. A context menu deletes selected highlights.

PDF notes/context start empty. No PDF notes editor or persistence handler for
post-creation color/note updates was found. Multi-page aggregation and geometry
behavior across rotation/zoom have not been demonstrated by this inspection.

## 4. Required Min behavior (not all implemented)

1. `>m [query]` opens vault `.md`; `>p [query]` opens vault `.pdf`. Extension
   matching and filename search are case-insensitive. Empty queries list files.
   Commands accept whitespace-delimited queries; `>mfoo` is not shorthand.
   Paths are literal vault-relative paths, including spaces, not shell strings.
2. These modes must not send filenames or queries to web search. Selection uses
   existing vault routing and Markdown ownership/leave guards; the PDF stage
   now replaces PDF.js with EmbedPDF/PDFium at the same wrapper address.
   Loading, unavailable vault, no matches and scan truncation are visible.
3. This first picker slice deliberately does not reproduce Obsidian metadata
   search, annotation exclusion, fuzzy ranking or saved remote-PDF discovery.
   Remote PDF URL picking is outside this slice, not silently claimed as parity.
4. Web and PDF users must be able to create highlights, edit notes, delete,
   save to the configured vault and restore after reopening the same source.
   Stable IDs, text, notes, color and anchors/geometry must survive persistence.
5. Min must not overwrite legacy plugin files until compatibility fixtures
   establish safe handling. Malformed/ambiguous legacy input must remain intact
   and produce a visible diagnostic, not silently lose records. Legacy import
   support and new storage encoding are separate contracts to settle in stage 3.
6. Main owns storage and source identity. Page-supplied filenames/URLs must not
   grant vault access. Require current-document authorization, frame checks,
   bounded validated payloads, confined paths, serialized atomic writes and
   stale-document/root-change rejection. Save failure retains recoverable edits;
   deletion is acknowledged only after persistence succeeds.
7. No implicit annotation writes in private browsing. Explicit private-mode
   persistence UX must be specified before enabling it. No network service is
   required for annotation storage.
8. Unresolved or ambiguous web anchors remain recoverable, not silently placed
   on the first repeated quote. PDF geometry must have an explicit coordinate
   space independent of viewport zoom/rotation. The replacement backend stores
   native EmbedPDF coordinates, so no cross-engine conversion is required.

## 5. Progressive acceptance gates

| Stage | Deliverable and stop condition |
| --- | --- |
| Source/spec (this increment) | Picker, persistence and UI evidence above; separate observations from requirements |
| 1–2: file picking (pre-existing work) | Validate literal paths, search limits, stale replies, caller checks and opening routes; manual keyboard/large-vault checks remain separate |
| 3: storage compatibility | Golden web/PDF plugin fixtures; repeated round trips; malformed/duplicate markers, pipes, pre terminators, geometry-as-notes, URL collisions, empty records; decide lossless new encoding and legacy import policy before writes |
| 4: web integration | Capture/edit/delete/reopen, repeated/changed text, malicious pages, iframe denial, navigation races, failed writes and private-mode checks |
| 5: PDF backend replacement | EmbedPDF/PDFium capture/edit/delete/reopen, multi-page selections, zoom/rotation geometry, legacy import and failure recovery |

Stage 3 must specify source identity (including query/fragment policy), schema,
storage path, size limits, conflict behavior and import/export guarantees before
implementation. These are explicitly unresolved design choices, not inferred
from the plugin's unsafe edge cases. Stages 4–5 depend on that gate.

Inspection verification: the plugin's `node --test
tests/annotation-manager.test.mjs` passed 3 tests covering URL identity. These
are not PDF round-trip or interactive UI coverage. Min verification for each
increment is recorded separately; no full feature acceptance is implied.
