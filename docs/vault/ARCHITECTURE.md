# Vault mode architecture

Revision 2 — implement both tab navigation and a real resource protocol. Raw resources must not be replaced by `file://` navigation.

## 1. Separate viewer selection from resource serving

```text
User opens a vault URL                 A page requests a vault resource
        |                                        |
Min top-level navigation policy        session.protocol.handle('vault', ...)
        |                                        |
resolve + classify                     authorize + resolve + serve
   /        |       \                             |
folder   Markdown   other                Response(status, headers, bytes)
   |        |       |                             |
Vault    Cherry     load original         <img>, media, fetch, PDF.js
page     page       vault URL
```

Use existing Min tabs. Folder and Markdown viewers can remain packaged pages:

```text
min://app/pages/vault/index.html?url=<encoded canonical vault URL>
min://app/pages/markdown/index.html?url=<encoded canonical vault URL>
```

These wrappers keep application JavaScript separate from user-controlled file bytes. They do not replace or impersonate the `vault` resource protocol. Source-URL presentation may reuse the existing PDF convention.

Top-level Markdown navigation launches Cherry; fetching the identical Markdown URL returns its original source bytes. A subresource request never opens a tab. The resource handler does not use MIME guesses or `Accept` to decide to launch an editor.

## 2. Minimal module layout

```text
main/vault.js
  configured root and confined path resolver
  directory listing/search metadata
  open-note ownership, read/save, narrow IPC

main/vaultProtocol.js
  real per-session protocol handler
  raw responses, MIME, HEAD/ranges, read-side request policy
  (may live in main/vault.js if still small)

js/vault.js
  Min navigation/open-or-focus and Save/lifecycle integration

js/preload/vault.js
  gated APIs for the packaged Vault/Markdown pages

pages/vault/{index.html,vault.js,vault.css}
pages/markdown/{index.html,markdown.js,markdown.css}
```

Use ordinary functions/factories and injected dependencies. No generic server, VFS, service framework, extra tab store, asset registry, or per-image blob loader.

## 3. Register and install the real protocol

Register `vault` **before app ready**, alongside `min` in the existing one-time scheme-registration call. Request `standard`, `secure`, `supportFetchAPI`, and `stream`; leave CSP bypass and service workers disabled and keep CORS enabled. The standard scheme is needed for hierarchical URL/resource behavior. [E1][E2]

After readiness, install `ses.protocol.handle('vault', handler)` through Min's existing session-policy installer. Cover `persist:webcontent`, private partitions, and any actual session used by the editor/PDF consumer; installation is idempotent. Registration only on Electron's default session is insufficient. [E1]

`handle()` returns a `Response`/promise, not an external redirect or operating-system protocol launch. “HTTP-style” describes status, headers, and body; it does not require a socket, DNS, TLS, or localhost server. [E1]

## 4. File transport

Conceptual boundary:

```js
async function serveVaultResource (request, approvedContext) {
  // approvedContext comes from validated main-owned request metadata.
  const target = await resolveVaultURL(request.url, approvedContext.root)
  return responseForFile(request, target)
}
```

`responseForFile()` follows CONTRACTS.md. It streams bytes, preserves MIME and range semantics, and emits no viewer markup. The implementation may read a confined file with Node streams or use Electron `net.fetch(pathToFileURL(validatedPath))` internally. Electron supports `file:` fetches in main. [E3]

Using a file URL **inside the handler as its backing reader** is allowed. Sending a `Location: file://...` response or changing the tab/image to a file URL is not. Rebuild response headers where needed; do not assume a backing `net.fetch()` automatically implements HEAD, Range, MIME, and security headers exactly as required. Prove those behaviors in the pinned runtime.

Keep the raw handler deterministic: all regular files, including `.md`, are raw resources. Directory resource fetches return `409`; directory navigation is intercepted by Min and listing uses the page bridge. This avoids a second raw-vs-viewer query API.

## 5. Main-frame navigation integration

One open-or-focus workflow handles typed/pasted addresses, tree/note links, restored tabs, and programmatic navigation. Intercept folder/Markdown **top-level navigation only** before it reaches a raw load. Revalidate wrapper URLs before associating an editor; a crafted `?url=` is not permission.

Other regular files load at their canonical vault URL. Add `vault` to app-handled protocol checks so Min does not offer to launch an external application.

Do not assume every navigation passes through `urlParser.parse()` or `webviews.update()`: inspect page-initiated links, history/back/forward, popups, and restore. Do not invent `request.resourceType` or `request.webContents` on a standard protocol Request; use documented navigation/webRequest metadata for the actual Electron version.

**Compose with existing request listeners.** Min already installs filtering in `onBeforeRequest` and PDF/download handling in `onHeadersReceived`. Adding another independent listener can replace existing policy; Electron uses the last listener for a WebRequest event. [E4] Inject the narrow vault decision into the existing chain instead of replacing filtering or adding a general middleware framework.

## 6. Markdown image and link resolution

The packaged page receives its canonical document URL from `readCurrent()`. Use that address as the base for preview references. Do not use the wrapper's `location.href` as the base.

```text
source:    vault://local/Projects/note.md
reference: images/detail.jpg
resolved:  vault://local/Projects/images/detail.jpg

reference: ../assets/shared.png
resolved:  vault://local/assets/shared.png
```

Normalize the documented shorthand first. Validate relative references, then use normal URL resolution and the shared confinement policy. A small Cherry-supported URL/render hook may rewrite rendered `src`/`href` attributes; the original Markdown stays unchanged. Verify the hook against the pinned Cherry release. Do not regex-rewrite the entire Markdown document.

Keep packaged script/style URLs pointing to bundled app assets. Prefer resolving only user-content links over a global `<base>` that could redirect editor JavaScript/CSS into the vault.

The renderer CSP must explicitly permit the required `vault:` images/media and scoped fetches, while scripts remain packaged-only. Handle supported raw-HTML image/srcset references with the same sanitation and resolution rules, or disable those syntax forms explicitly rather than leaving a bypass.

## 7. Reuse PDF rendering, not file-URL delegation

Keep `js/pdfViewer.js` and the existing PDF page. Its represented source is `vault://local/reference.pdf`; PDF.js fetches that resource through the new handler. An inline PDF subresource receives `application/pdf` bytes, never the PDF viewer's HTML.

Integrate with Min's existing PDF-open event for top-level navigation only. Verify custom-scheme header handling in the actual Electron runtime; if necessary add a small explicit PDF-open path that preserves the vault source. Do not create a second PDF renderer or fall back to public `file://` navigation.

Permit narrowly scoped cross-origin PDF reads from the packaged viewer. For vault PDF sources prefer credential-free requests; preserve current credential behavior for HTTP(S) PDFs. Range headers and response headers must survive this path.

## 8. Read authorization and origin boundaries

Protocol responses are new read authority, distinct from save IPC. Authorize reads before emitting bytes, not just before writes.

Use trusted main-owned WebContents/frame/request metadata to admit approved vault tab navigations and resources from registered packaged Vault/Markdown/PDF viewers. Block unrelated HTTP(S)/file pages and unauthorized child-frame fetches or image embeds. A missing or forged `Origin`/`Referer` is not authorization. CORS is not a substitute for checking the actual request. [E5]

If `protocol.handle()` in the pinned Electron release lacks sufficient trusted requester metadata, enforce the check in the existing WebRequest policy before dispatch; do not fabricate Request fields or trust a renderer-supplied flag. Verify that both paths are covered in integration tests.

Use exact allowed origins for CORS, not `*`. Approved internal callers may read without cookies; expose the range/length headers PDF.js needs. Reject unapproved preflights. A public raw-file origin never receives preload editor APIs, even when loading HTML or SVG that claims to be an editor.

User-authored HTML/SVG is not executable app code. Apply restrictive CSP/sandbox response headers for active document formats without changing their bytes, while allowing inert SVG image rendering. Keep untrusted scripts, frames, forms, and outbound execution disabled. Do not solve asset loading by disabling web security, CSP, or the Electron sandbox. [E5]

## 9. Root confinement, settings, and writes

Use the single resolver specified in CONTRACTS.md for protocol reads, listing, Markdown reads/writes, aliases, and links. A selected root is canonicalized once; reject traversed symlinks below it. Allow legitimate parent-relative note references within the root, but never filesystem escape.

Keep one optional persisted root. Root-changing permission belongs to Settings and main, not Markdown. Existing generic settings handlers must not let an editor change the root behind open-note associations; protect that key/workflow explicitly and avoid broad path broadcasts.

Saving stays small: an editor owns a canonical path and baseline; main serializes re-read/compare/atomic-write and acknowledges the exact snapshot. Renderer dirty state compares current text with the saved snapshot. File-protocol GET/HEAD cannot mutate the note. No new write REST API is needed.

## 10. Lifecycle and history

Guard every destructive editor path before mutating the tab model or destroying WebContents. Wait for any in-flight save. Freeze edits while committing a leave/save decision or recheck dirty state before closing; a successful older save cannot authorize dropping newer edits.

One canonical disk path has one reserved/open editor across windows, including during restore. Roll back failed reservations and release authority on navigation/destroy. Revoke stale root/request associations on configuration changes.

Explicitly exclude raw vault documents, Vault/Markdown pages, and PDF wrappers representing vault URLs from browsing-history text indexing. Retain normal Min session restore of addresses, not Markdown buffers. Disable generic userscripts on vault-backed content; prevent browser Vim key handling from fighting Cherry editing.

## 11. Checkout integration map and references

Source locations inspected on 2026-09-18; re-read them before patching:

| Location | Integration |
| --- | --- |
| `main/minInternalProtocol.js` | Existing one-time `min` scheme registration; add `vault` to the same registration |
| `main/index.js`, `main/sessionPolicies.js`, `main/main.js` | Feature composition, per-session install, session-created handling |
| `main/filtering.js`, `main/download.js` | Existing WebRequest callbacks, PDF response path, scoped response policy |
| `main/viewManager.js`, `js/webviews.js` (plus proposed `js/vault.js`) | Main-frame routing, protocol allowlist, lifetime/ownership |
| `js/pdfViewer.js`, `pages/pdfViewer/embedViewer.js` | Vault source passed to EmbedPDF/PDFium, no raw-asset redirect; see TAB_PICKER_PORT.md for annotation storage |
| `js/util/urlParser.js`, `js/navbar/tabEditor.js` | Canonical/source address presentation |
| Settings schema/page, `scripts/buildPreload.js`, `js/menuRenderer.js` | Root selection, gated bridge, Save command |
| `js/places/historyPolicy.js`, `js/userscripts.js` | Vault-backed content exclusions |

The inspected `package.json` lists Electron `42.0.1` for packaging and `41.2.0` as the development dependency. Confirm actual test/package runtimes; do not assume newly documented fields exist in both or silently upgrade Electron to make a design work.

External references (implementation guidance, not substitutes for the contracts):

- [E1: Electron protocol](https://www.electronjs.org/docs/latest/api/protocol)
- [E2: CustomScheme privileges](https://www.electronjs.org/docs/latest/api/structures/custom-scheme)
- [E3: Electron net](https://www.electronjs.org/docs/latest/api/net)
- [E4: Electron WebRequest](https://www.electronjs.org/docs/latest/api/web-request)
- [E5: Electron security](https://www.electronjs.org/docs/latest/tutorial/security)
- [E6: URL Standard](https://url.spec.whatwg.org/)
- [E7: HTTP semantics, including HEAD and byte ranges](https://www.rfc-editor.org/rfc/rfc9110.html)
