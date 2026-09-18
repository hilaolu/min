# Vault mode product specification

Revision 2 — real resource responses are mandatory. See [CONTRACTS.md](CONTRACTS.md) for normative transport details.

## 1. Configuration

Persist one optional absolute local directory as the vault root. Settings provides typed absolute-directory entry, validated in main; do not open a system directory picker.

No usable root produces an actionable internal navigation error; a raw resource request gets an appropriate error status. It must not guess a directory or contact the network.

Root changes are controlled: stop admitting new vault work, resolve dirty notes, close vault-backed tabs (including PDF wrappers), revoke their associations, and only then commit the new root. Cancel leaves the old root active. In-flight operations must not switch to the new root halfway through. Use a captured root/version check internally if necessary, without a multiple-vault framework.

## 2. Public URLs

Canonical form:

```text
vault://local/
vault://local/Projects/
vault://local/Projects/idea.md
vault://local/assets/sketch.png
```

`local` means the single configured vault, not a network host. All app-generated URLs use this canonical form, preserving filename case in the path. The literal `vault://test.jpg` is accepted as a root-file shorthand for `vault://local/test.jpg`; its intentionally limited syntax is specified in CONTRACTS.md.

Folder, Markdown, and PDF wrappers retain the canonical `vault://` source address. Other file navigation stays on its `vault://` resource; it must not be converted to `file://` or a per-file viewer URL.

## 3. Navigation and resource requests are different operations

| Target | Top-level Min navigation | Authorized GET/HEAD resource request |
| --- | --- | --- |
| Directory | Packaged Vault browser page in a normal tab | `409` for raw directory reads; listing uses the narrow page API |
| Regular `.md` / `.markdown` file, case-insensitive extension | Packaged Cherry editor, open-or-focus | Original Markdown bytes with Markdown MIME type, never editor HTML |
| PDF | Existing Min PDF viewer with the vault URL as source | Original PDF bytes, `application/pdf` |
| Image, media, text, or another regular file | Keep the vault URL and let Min/Chromium consume its response | Original bytes with the correct MIME type |
| Missing target | Actionable not-found page | `404` |
| Invalid/escaping target or unsupported symlink | Reject | `400` or `403` as specified |

**Do not turn an image/fetch request into tab navigation.** Viewer selection runs only for top-level navigation. The raw protocol serves regular files deterministically and does not decide whether to launch Cherry. No local HTTP server is required.

## 4. Raw resource behavior

A request to `vault://local/test.jpg` returns `200`, `Content-Type: image/jpeg`, and the exact disk bytes. The shorthand has the same file response, not a `Location: file://...` redirect. Direct image navigation, `<img src>`, and an authorized `fetch()` must all work.

GET and HEAD are required, along with bounded streaming and single byte-range support for PDF/media consumers. Use useful MIME types, accurate byte lengths, explicit errors, and `Cache-Control: no-store` for v1. Do not manufacture an HTML wrapper for a successful binary request or decode binary data as text.

POST/PUT/PATCH/DELETE are not save APIs and must not mutate files. Save remains authorized IPC. OPTIONS is permitted only for the read-side CORS policy.

## 5. Vault browser tab

Provide a file tree, breadcrumb, filename/path search, and Refresh entirely inside the page. Folder navigation may reuse the page. Markdown clicks open/focus one editor; other file clicks navigate to the resource's vault URL, with PDF using the existing PDF viewer integration.

Search covers filenames/paths in the configured vault, including unexpanded folders. Substring matching is sufficient; no content index is needed. Refresh may rescan; a watcher is optional. File creation and attachment upload are not required.

## 6. Markdown rendering, links, and images

Cherry must display/edit UTF-8 Markdown, with clean/dirty/saving/error state and Cmd/Ctrl+S. Rendering must not rewrite Markdown source. In particular, a relative image reference must remain relative in the saved `.md` file.

Given this vault:

```text
test.jpg
assets/shared.png
Projects/note.md
Projects/images/detail.jpg
```

`Projects/note.md` must render all of these in its preview:

```markdown
![Sibling](images/detail.jpg)
![Parent](../assets/shared.png)
![Root](/test.jpg)
![Canonical](vault://local/test.jpg)
![Shorthand](vault://test.jpg)
```

Resolve relative references against `vault://local/Projects/note.md`, **not** `min://app/pages/markdown/index.html`. Parent-relative paths that stay inside the vault are valid. Encoded filenames, spaces, Unicode, `%`, and `#` must round-trip correctly. Rendering an image must not open a new tab, call a per-image IPC byte loader, or replace the source with a blob/data/file URL.

Relative Markdown links use the same resolver and open-or-focus rule. Image/PDF/media links keep vault resource URLs. Fragment-only note links remain within the note; external HTTP(S) links open ordinary web tabs. Keep unsafe executable links and unsanitized HTML out of the editor. Edit/preview/split controls may use Cherry's own modes.

## 7. One editor and safe saving

At most one editable Min tab owns a canonical Markdown disk path application-wide. All navigation, tree/link clicks, aliases, and restore routes use one open-or-focus workflow. Reserve before async tab creation; release on failure or final close. This is not an external filesystem lock.

Main owns the file association. `saveCurrent(markdown)` accepts text, not a destination path. Serialize baseline comparison and atomic replacement in one per-note queue. An observed external change produces a conflict without overwriting the external file. A failed save preserves the dirty buffer. The baseline-check/write pair is not a race-proof compare-and-swap against unrelated applications.

Only the exact acknowledged snapshot is marked saved. Typing while saving leaves newer text dirty. Closing, navigation, reload, task/window close, and quit must await a safe Save/Discard/Cancel outcome before destroying the editor. Opening/closing an unchanged note must not rewrite it.

## 8. Security and privacy

Constrain every resource read and write to the configured root. Reject symlink traversal below that root in v1. Arbitrary web pages, file pages, raw vault HTML/SVG documents, and child frames receive no editor/listing/write authority. Raw content must never be served from the trusted packaged-editor origin.

Do not make the vault globally readable by websites. Authorize resource callers before serving bytes; CORS alone does not prevent cross-origin image embedding. Keep CSP, sandboxing, and web security enabled. Allow the actual editor's vault images/media and scoped PDF fetches without granting wildcard cross-origin access. Active local HTML/SVG stays untrusted with restrictive response policy, not executable editor privileges.

Explicitly exclude vault-backed documents and wrappers, including PDFs representing a vault URL, from browsing-history text extraction. Do not store note buffers in browser session JSON. Session restore revalidates file associations.

## 9. Acceptance criteria

1. Vault selection persists; cancellation/root changes never rebind old notes to new files.
2. Folder URLs open a usable tree/search page in normal Min tabs.
3. Markdown navigation opens Cherry; two equivalent file identities cannot own two editors.
4. Cmd/Ctrl+S atomically writes Markdown source to the original approved file.
5. Failed saves and conflicts preserve the dirty buffer; newer edits stay dirty after an older save completes.
6. Dirty close/reload/navigation/window-close/quit cannot silently discard edits.
7. `vault://local/test.jpg` and `vault://test.jpg` serve byte-identical JPEG responses with the right MIME type, not `file://` redirects.
8. All five Markdown image examples above visibly render; assert image completion and nonzero natural dimensions in Electron.
9. Preview URL resolution leaves saved Markdown references unchanged.
10. An authorized fetch of a `.md` resource receives Markdown, not the Cherry page; resource requests never create tabs.
11. HEAD, valid/unsatisfiable byte ranges, unknown MIME types, and 400/403/404/405/409/503 errors follow CONTRACTS.md.
12. PDF.js renders a PDF by reading its `vault://` response; raw PDF requests are not replaced with viewer HTML.
13. Image/media resources work in relevant normal/private tab sessions without loading whole large files into memory.
14. Path encoding and valid parent-relative links work; traversal, path tricks, and symlinks never escape the root.
15. Untrusted callers cannot read/embed vault resources or invoke writes; active raw HTML/SVG cannot acquire editor privileges.
16. Vault-backed contents are excluded from browsing-history text indexing.
17. Existing HTTP(S), ordinary `file://`, external PDFs, Save Page, filtering, and session behavior remain intact.
18. There is no new browser-chrome sidebar, localhost server, generic VFS, database, or second tab system.
