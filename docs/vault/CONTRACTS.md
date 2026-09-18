# Vault mode contracts

Revision 2. These behaviors are normative. Function/channel names are illustrative; keep equivalent implementations equally narrow.

## 1. URL and identity

Canonical resource address:

```text
vault://local/<vault-relative-path>
```

`local` is fixed and reserved. The root is `vault://local/`; emitted folder URLs end in `/`. Paths preserve filename case. Neither credentials nor ports are allowed. Query parameters may be ignored as cache-busting metadata; fragments are presentation-only. Neither selects a disk file or grants authority. No query parameter makes a read into a write or switches raw assets to HTML.

The user's literal root-file shorthand is supported:

```text
vault://test.jpg       => vault-relative file test.jpg
vault://reference.pdf  => vault-relative file reference.pdf
```

This is an explicit alias rule, not a network lookup. Accept a simple lowercase ASCII filename with an extension in the authority and an empty path or `/`, with no credentials/port. Reject `.`/`..`, separators, encoded separators, and non-filename authorities. At the raw handler, return the same file response directly, not a `file://` or viewer redirect. Apply the same authorization and confinement as canonical requests.

All generated links and document bases use `vault://local/...`. A standard URL treats `test.jpg` as the authority in the short form; filenames with case-sensitive/Unicode/encoded components belong in the canonical path, not a hostname. [ARCHITECTURE.md, E6] Do not infer nested paths from arbitrary hosts: use `vault://local/assets/test.jpg`, not `vault://assets/test.jpg`. A root file literally named `local` is `vault://local/local`.

Normalize aliases before resolving relative references. Strip query/fragment for canonical disk identity. Dedupe editor ownership by the resolved disk path, not raw URL spelling. Hard-link identity merging is not required in v1; platform canonical path/case behavior must be tested.

## 2. One confined resolver

Conceptual result, main-only:

```text
resolveVaultURL(input, capturedRoot) -> {
  vaultURL: canonical URL,
  relativePath: path relative to root,
  absolutePath: canonical validated disk path,
  kind: directory | markdown | file
}
```

Parse the URL and normalize the allowed alias. Split URL path segments, then percent-decode each segment exactly once. URL parsing alone does not decode the pathname. Reject malformed encodings, NUL, decoded `/` or `\` in a segment, OS absolute/drive/UNC tricks, and platform-specific invalid components. Never perform another percent-decoding pass downstream. A literal `%2e` filename represented by `%252e` stays a literal filename.

Root-relative `/assets/a.png` and safe `../assets/a.png` note references are supported. A note-reference helper resolves dot segments against the current document directory and rejects root underflow where observable before URL normalization. Browser normalization may erase dot segments before a protocol sees them; the invariant is that the final filesystem resolution can never escape the root, not that every original spelling remains observable. Do not reject all parent-relative references.

Use `path.relative`/canonical path checks, not a string-prefix test. A configured root is canonicalized when selected; reject symlink traversal below it in v1. Revalidate relevant path components before each file operation and immediately before save replacement. No caller appends unchecked segments to a validated path. Symlink-swap races from an actively hostile local process need OS-level facilities for stronger guarantees; do not claim path checks alone are an OS sandbox.

Both the raw protocol and listing/read/save operations use this resolver. Existence, regular-file type, permissions, and current root association are checked before I/O. Do not read devices, FIFOs, or arbitrary application bundle paths as vault files.

## 3. Navigation vs. resource contract

```text
Top-level Min navigation:
  directory -> Vault internal page
  Markdown  -> Cherry internal page, open-or-focus
  PDF       -> existing PDF integration, preserving vault source URL
  other     -> load the vault URL unchanged

Actual GET/HEAD protocol request:
  regular file (including Markdown/PDF) -> raw file representation
  directory                            -> 409, not a UI shell
```

Only navigation policy selects viewers. The handler must not open tabs, return Cherry HTML for fetches, or invoke an external protocol application. Never decide main-frame identity from an untrusted query, `Accept` header, or undocumented Request field.

## 4. Raw response contract

Implement `ses.protocol.handle('vault', handler)`. For an **authorized** file GET with no Range:

```text
request URL: vault://local/test.jpg
status:      200
Content-Type: image/jpeg
Content-Length: <file byte length>
Cache-Control: no-store
X-Content-Type-Options: nosniff
body: exact JPEG bytes from disk
```

The same contract holds for `vault://test.jpg`. Do not include `Location: file://...`, substitute HTML/JSON, text-decode binary data, create a blob/data URL per image, or open another tab. A main-process backing read using `net.fetch(pathToFileURL(...))` is allowed, provided the outgoing protocol response still meets this contract.

Use a reliable MIME lookup or a small correct tested mapping with fallback `application/octet-stream`. Required fixtures include:

| Extension | Content-Type |
| --- | --- |
| `.jpg`, `.jpeg` | `image/jpeg` |
| `.png` | `image/png` |
| `.gif` | `image/gif` |
| `.webp` | `image/webp` |
| `.svg` | `image/svg+xml` |
| `.pdf` | `application/pdf` |
| `.md`, `.markdown` | `text/markdown; charset=utf-8` |
| `.txt` | `text/plain; charset=utf-8` |
| `.html`, `.htm` | `text/html; charset=utf-8`, with untrusted-document policy |
| `.mp4`, `.mp3` | `video/mp4`, `audio/mpeg` respectively |
| Unknown binary | `application/octet-stream` |

Do not force `Content-Disposition: attachment` on inline images, PDF, or media. Unknown types may receive the normal browser download behavior. Explicit download commands may use their own download operation; raw fetching still returns bytes.

HEAD returns the corresponding GET metadata, including full byte length, with **no body**. Ignore Range on HEAD. Support streaming/backpressure for large files and close the underlying stream on cancellation/error. Do not read every attachment fully into memory or impose the editor's Markdown-size limit on raw resources.

### Ranges

Support one `bytes=start-end`, `bytes=start-`, or `bytes=-suffixLength` range on GET. A valid range returns `206`, `Accept-Ranges: bytes`, accurate `Content-Range`, the selected byte length, and exactly those bytes. An unsatisfiable valid single range returns `416` with `Content-Range: bytes */<full-length>`. Malformed single byte ranges return `400`. Multiple ranges or unsupported range units may be ignored with a full `200` response; multipart assembly is not required.

Do not assert that file-backed `net.fetch` handles these automatically. Test the installed runtime, or implement the small bounded stream range path. See ARCHITECTURE.md E7 for HTTP semantics.

### Errors and methods

| Situation | Status / effect |
| --- | --- |
| No usable configured root | `503` |
| Malformed URL/encoding, credentials, port, invalid shorthand | `400` |
| Caller denied, outside-root candidate, rejected symlink, permission denial | `403` |
| Missing target | `404` |
| Unsupported method | `405`, `Allow: GET, HEAD, OPTIONS` |
| Directory/non-regular resource fetched as a file | `409` |
| Unexpected I/O failure | `500` |

Errors are small non-executable text responses without absolute filesystem details, never a successful `200` viewer page. HEAD errors have no body. GET/HEAD and cache-busting queries never mutate files. POST/PUT/PATCH/DELETE must not save or change configuration. Authorized OPTIONS may return `204` for the scoped read-side CORS policy and serves no file bytes.

## 5. Resource caller and CORS contract

Authorize raw reads **before** sending any bytes. Trust a main-owned request/tab/frame association, not just a URL scheme, session membership, `Origin`, or `Referer`.

Allow Min-authorized top-level vault navigation and required resource requests from registered packaged Vault/Markdown/PDF consumers. A Markdown consumer can load confined local image/media references; the PDF consumer reads its associated vault PDF. Reject unrelated web/file pages, untrusted raw vault documents attempting privileged reads, and unauthorized child frames. A raw `<img>` from an unrelated web page is denied, even if its browser does not send an Origin header.

Use request metadata actually supported by the installed Electron version. If authorization is enforced in WebRequest before protocol dispatch, compose it into Min's existing listeners and test both normal/private partitions. Do not invent trusted fields on a Fetch Request or weaken policy because a field is absent.

For approved packaged callers, CORS allows the exact packaged origin (currently `min://app`) and GET/HEAD, with Range when preflighted. Expose `Content-Length`, `Content-Range`, and `Accept-Ranges`. Prefer credentials omitted and keep vault PDF reads credential-free; existing HTTP(S) PDF credential behavior stays unchanged. Do not use `Access-Control-Allow-Origin: *`, reflect arbitrary origins, or let an OPTIONS request itself create authority. Apply equivalent CORS headers to authorized errors so errors remain observable to the correct caller.

The editor CSP allows needed `vault:` image/media/connect destinations but not user-file JavaScript. Preserve `webSecurity`, sandboxing, and context isolation. Raw HTML/SVG responses remain on the untrusted resource origin with restrictive document CSP/sandbox headers; no scripts, forms, child frames, or editor bridge authority. Inert SVG image rendering must still pass its test.

## 6. Preview references and source preservation

Conceptual helper:

```text
resolveNoteReference(reference, canonicalDocumentURL) -> safe URL or rejection
```

Use the represented file URL returned by main, not the packaged page URL. Canonicalize the short form first. Respect encoded path segments, normalize safe dot segments, preserve fragment presentation, and apply root confinement. Relative and root-relative references must resolve to canonical `vault://local/...` URLs.

Apply resolution to rendered image/media URLs and note links using Cherry's supported hooks or equivalent narrowly scoped rendering logic. Do not rewrite Markdown source, globally change the page base, load image bytes with IPC, or replace assets with data/blob/file URLs. Packaged application scripts/styles remain app resources.

Same-note `#fragment` navigation stays in the note. Links to another Markdown file use open-or-focus; links to images/media use raw vault URLs; PDF links use existing PDF rendering with vault bytes. External HTTP(S) links open normal web tabs. Block executable URL schemes and sanitize/disable unsafe raw HTML.

## 7. Page APIs

Directory page, illustrative API:

```js
window.vaultBrowser.listCurrent()
// -> { url, entries: [{ name, relativePath, url, kind }] }
window.vaultBrowser.search(query)
// -> [{ name, relativePath, url, kind }]
window.vaultBrowser.open(vaultURL)
// -> normal Min navigation/open-or-focus; input is validated in main
```

Markdown page:

```js
window.markdownFile.readCurrent()
// -> { markdown, displayPath, vaultURL }
window.markdownFile.saveCurrent(markdown)
// -> { ok: true } or a structured error
window.markdownFile.open(vaultURL)
// -> normal Min navigation/open-or-focus for a clicked local link
```

`readCurrent()` associates the actual opened disk snapshot with the editor's save baseline. It does not need to be replaced with a fetch merely because raw Markdown fetches are supported. There is deliberately no `save(path, text)`, generic `fs`, or image-byte bridge.

Main validates the live tab, actual top-level sender frame, exact packaged page, current document association, root, payload type, and documented Markdown size cap. Strip unneeded absolute paths from page results. Register associations from trusted navigation, not simply by seeing a crafted packaged-page URL.

Use structured errors for caller denial, missing association, root change, read/write failure, size limit, and `MARKDOWN_EXTERNAL_CHANGE`. Names may follow existing Min conventions; the UI must distinguish conflicts from ordinary write failure.

## 8. Save and destructive lifecycle

Per editor, main stores its canonical path, baseline text, and save queue. Within that queue: revalidate the association/path, reread current disk contents, compare to baseline, reject an observed conflict, atomically write the submitted snapshot, then advance baseline and acknowledge. No write side effects happen on a rejected operation.

The page captures `snapshot = cherry.getMarkdown()` before saving and sets `savedText = snapshot` only after success. It never marks a later buffer clean by reading Cherry again after the await. A failed queue operation must not poison subsequent retries. No-op saves/open-close cycles must not reformat or rewrite unchanged source.

One canonical path has one pending/open editor application-wide. Reserve before async creation, focus the existing owner, roll back creation failures, and release on final close/disassociation. Canonical/shorthand/wrapper aliases and restored tabs use the same rule.

Before close/reload/navigation/task-close/window-close/quit or view recreation, run one prepare-to-leave workflow **before** tab-state deletion/WebContents destruction. Wait for in-flight saves. Dirty notes offer Save/Discard/Cancel; failed/conflicting Save keeps the buffer/tab. Freeze edits during the final save-and-leave or recheck for newer edits before destruction. Async unload work after destruction is not a save guarantee.

Explicitly exclude vault-backed raw documents and wrappers from history text indexing. Configuration changes and session restore revalidate all file/read/write associations; no stale authority may resolve against a newly selected root.
