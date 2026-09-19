# Vault mode implementation plan

Revision 2. Build the real resource protocol first; rendering Markdown images is a required vertical slice, not later polish. Read CONTRACTS.md before coding.

## Stage 1 — root, URL resolver, and real protocol

1. Inspect current composition, session creation, protocol registration, filtering/download WebRequest listeners, and actual Electron runtime versions.
2. Add controlled Settings root selection/persistence and one confined resolver. Protect root mutation from generic untrusted settings writes. Canonical URLs are flat: `vault://`, `vault://example.md`, and `vault://Projects/note.md`. Treat `local` as an ordinary first path component; there is no special authority or shorthand.
3. Register `vault` with the existing one-time pre-ready scheme registration. Keep the scheme nonstandard to prevent host lowercasing, while enabling secure/fetch/stream behavior without CSP bypass. Install a real `ses.protocol.handle('vault', ...)` for each relevant session.
4. Serve authorized regular files as binary-safe responses. Implement/test MIME, GET, HEAD, single ranges, streaming/cancellation, `no-store`, errors, and unsupported methods.
5. Compose read authorization with existing request policy. Do not replace Min's filtering or download listeners. Do not add an HTTP server, resource registry, `file://` redirect, or per-image IPC pipeline.
6. Before building Cherry, prove an approved packaged fixture can render an actual JPEG `<img>` and fetch its bytes at `vault://test.jpg`. Also prove case and encoded Unicode are preserved in both the first and later path components, and that an unrelated web fixture is denied.

This stage cannot be replaced by merely teaching the address bar to rewrite vault URLs.

## Stage 2 — tab navigation and file-browser page

1. Add one navigation/open-or-focus integration using existing Min tab workflows.
2. Only top-level folder and Markdown navigation select packaged internal viewers. Resource requests are never routed to viewers. Recognize `vault` as app-handled rather than launching an external application.
3. Cover browser-issued navigation, clicked links, popups, back/forward, direct wrapper URLs, and session restore; do not assume one URL parser sees all of them.
4. Add the Vault page's tree, breadcrumb, filename/path search, Refresh, and narrow list/search/open API.
5. For other regular files, navigate to their canonical vault resource URL without rewriting to `file://`.
6. Exclude vault-backed raw and packaged pages from history text indexing. Recheck root availability after restore.

Keep UI inside normal tab pages. A watcher/database is unnecessary; a bounded asynchronous metadata scan and Refresh are sufficient initially.

## Stage 3 — Cherry and real Markdown image rendering

1. Package a pinned Cherry Markdown editor build separately from browser chrome and generic preload code. Verify the selected version's public API and hooks.
2. Create the packaged Markdown page and main-owned file association. `readCurrent()` returns the Markdown snapshot and its canonical vault URL.
3. Establish one-editor-per-canonical-path ownership across windows, including reservations, restore, wrapper spellings, failed creation, and close cleanup.
4. Resolve image/media/link references against the represented note path by temporarily placing the entire path under an internal virtual authority. Never treat its first component as a host. Rewrite preview URLs only, never saved source or a global application asset base.
5. Make relative, parent-relative, root-relative, and canonical images render via the actual protocol. Preserve case and encoded Unicode across the entire path. Configure CSP/CORS/request authorization without disabling security.
6. Keep user HTML sanitized; disable unsupported raw-HTML URL forms rather than bypassing the resolver. Verify packaged editor assets still load from the application bundle.

Do not defer images until after v1. A successful mock resolver or unit test is not proof that Chromium can load the image in the real viewer.

## Stage 4 — saving and dirty lifecycle

1. Track the exact saved snapshot in the page. Preserve existing relative references and avoid rewriting unchanged files.
2. Implement `saveCurrent(markdown)` with main-owned path selection, string/size validation, per-note serialization, baseline comparison, and existing `write-file-atomic`.
3. Route Min's Cmd/Ctrl+S and a page Save control to the same operation; ordinary Save Page and PDF download behavior remain unchanged.
4. Show clean/dirty/saving/error/conflict states. Never mark newer edits clean when an older save completes. Preserve the buffer on rejection and allow retries.
5. Add one prepare-to-leave workflow before tab-state deletion or WebContents destruction. Cover tab/task/window close, quit, reload, back/forward, navigation away, and view recreation.
6. Wait for in-flight saves and prevent typing-during-final-save from being discarded. Test Save/Discard/Cancel and conflicts. Only then allow root changes to close/revoke old consumers and select a new root.

## Stage 5 — PDF/media response integration and regression

1. Reuse Min's existing PDF page with a vault source URL. Ensure PDF.js fetches raw `application/pdf` bytes through the real handler, not a file URL or viewer document.
2. Keep viewer selection top-level-only. Reuse the existing PDF-open event/header policy where supported; add a narrow vault-PDF navigation path if the pinned runtime requires it.
3. Verify scoped cross-origin, credential-free vault PDF reads and byte-range headers. Keep current credential behavior for HTTP(S) PDFs.
4. Exercise image/media raw navigation, a media byte-range request, unknown-type download behavior, reload/cache behavior, and normal/private tab partitions.
5. Test raw HTML/SVG as untrusted content and inert SVG images. Verify raw content cannot acquire editor or listing authority.
6. Run focused unit/integration tests, `npm test`, and `npm run build`. Document the integration test command and actual Electron version used. Do not silently upgrade Electron or replace unrelated architecture.

## Required fixtures and test matrix

Create a temporary test vault, never use the user's real notes for destructive tests:

```text
vault-fixture/
  test.jpg
  assets/shared.png
  assets/diagram.svg
  Projects/note.md
  Projects/images/detail.jpg
  reference.pdf
  clip.mp4                 # a tiny valid fixture or documented generated sample
  unknown.bin
  hostile.html
  space and Unicode fixtures
outside-fixture/
  secret.txt
```

Use small licensed/generated fixtures; do not embed large media files in the repo. Create symlinks during tests when supported by the OS. Generate controlled save failures in a temporary directory.

| Area | Required assertions |
| --- | --- |
| URL/path | Canonical root/root-file/nested paths; no special `local` component or shorthand; query/fragment excluded from identity; case and encoded Unicode preserved in first and later components; virtual-authority relative resolution; valid `../` within root; no root escape, decoded separator bypass, drive/UNC/ADS trick, sibling-prefix error, or symlink traversal |
| Raw GET | JPEG/PNG/PDF/Markdown/unknown bytes exactly equal disk; correct MIME; no file redirect, HTML substitution, per-image IPC, or tab creation |
| HTTP-style metadata | HEAD body empty and length correct; 206 range bytes correct; 416 bounds header; malformed range policy; no-store; 400/403/404/405/409/503; no read-side mutation |
| Streaming | Large-file memory remains bounded; cancellation/error closes stream; single range does not require whole-file buffering |
| Actual image rendering | All five SPEC.md Markdown examples render; image `complete` is true and `naturalWidth`/`naturalHeight` are nonzero; request URL is vault-backed; no unexpected new tab |
| Source preservation | Preview rewrites only rendered URLs; saving leaves original relative Markdown references intact; unchanged open/close does not rewrite file |
| Request context | Markdown GET fetch is raw text while top-level navigation opens Cherry; directory fetch is 409 while navigation opens tree; PDF subresource stays bytes |
| Sessions | Protocol works in normal/private consumer sessions; duplicate install is safe; stale-root requests/associations cannot read new-root data |
| PDF/media | PDF viewer source is canonical vault URL; PDF.js renders a page from protocol bytes; range fetch/media behavior works without `file://` fallback |
| Open identity | Wrapper/restore/double-open routes reserve one owner across windows; failed creation rolls back; close releases ownership |
| Save | Exact source, canonical path, serialized compare/write, observed external-change rejection, retry after failure, typing during save remains dirty |
| Leave | Clean/dirty/in-flight states; Save/Discard/Cancel; failed Save keeps tab; edits during final save not lost; reload/back/forward/task/window/quit guard |
| Authorization | Web/file/child-frame fetches and embeds denied; no-Origin is not a bypass; spoofed headers/query cannot grant access; raw hostile HTML/SVG gets no bridge/scripts; scoped CORS and inert images both work |
| Regressions | HTTP(S), ordinary file URLs, external PDF open/save/find, ordinary Save Page, filtering/download listeners, history exclusion, session restore |

## Test strategy and completion reporting

Use unit tests for pure resolution/response/queue policy and focused Electron integration tests for real protocol registration, subresource loads, CORS/CSP, viewer routing, and lifecycle. Respect the runtime's actual request metadata; tests should reveal missing assumptions rather than relying on invented properties.

If UI/integration execution is unavailable, report that limitation and exact unexecuted tests; do not claim image/PDF rendering was verified from mocks alone. Record commands/results and remaining deviations in the final implementation handoff.

Definition of done: all SPEC.md acceptance criteria pass, security/data-loss cases are covered, and ordinary Min behavior remains green. Optional polish such as a watcher or additional editor modes must not displace the raw-resource and image requirements.
