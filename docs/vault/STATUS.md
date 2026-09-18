# Implementation status

Revision 2 now includes production pages and navigation, not only transport. **Full SPEC acceptance is not yet claimed**: the verification gaps below must not be inferred to pass. SPEC.md and CONTRACTS.md have not been weakened.

## Implemented

- Typed absolute-directory entry in Settings (no system picker), validated in main and privately persisted in `vault-root.json`. Root changes stop admission, prepare dirty notes, close vault consumers, revoke associations, then persist the new root. Cancel retains the old root.
- Settings reloads the saved path through a Settings-only main-frame API, including when the saved directory is temporarily unavailable. The field uses compact Folder/Save labels.
- The Settings controller is isolated and tested for delayed loading, duplicate submissions, failures and cancellation. Reapplying the active folder is a no-op: it preserves open editors and does not rewrite configuration.
- Pre-ready privileged scheme registration and idempotent per-session `protocol.handle` installation.
- Confined regular-file reads, canonical/shorthand addresses, no symlinks below the root, exact bytes, MIME, HEAD, single ranges, bounded streaming/cancellation, no-store, explicit errors, scoped CORS and sandboxed active documents.
- Main-owned resource-navigation associations. Single-use request approvals cross from Min's existing request-header listener into the protocol handler; renderer headers alone cannot authorize reads. Existing filtering/download listeners remain installed.
- Raw resource navigation remains `vault://`; history text extraction and userscripts exclude vault content.
- Production top-level routing to the folder tree/search/breadcrumb/Refresh page, Cherry editor, existing PDF viewer, or unchanged raw resource. Missing/unavailable targets show an actionable Settings/path error.
- Main-owned canonical-path editor reservations across windows. Aliases, wrapper restore addresses and links use the same routing. Duplicate new tabs are retired and the owner window/task/tab is focused.
- Cherry resolves preview references without changing source. Unsafe HTML is disabled, executable URL schemes are rejected, and Vim interception is disabled in the editor.
- Narrow top-frame read/list/save/open IPC; 8 MiB UTF-8 editor limit; queued baseline comparison and atomic replacement. No-op saves do not rewrite files. Failed saves/conflicts preserve buffers; acknowledgements mark only submitted snapshots saved. This is not an external-process compare-and-swap.
- Save/Discard/Cancel preparation freezes editing during decisions. Tab/task close, navigation, reload, window close and quit await preparation. Cancel resumes editing. Cherry 0.11's `getMarkdown()` can be stale until its preview debounce fires, so saves/dirty checks read its live CodeMirror document.
- History restores raw-resource authorization. PDF wrapper associations authorize only their represented PDF, using credential-free vault requests. Fragment navigation preserves editor authority. Note buffers are not stored in session JSON.

## Remaining acceptance/verification gaps

- Actual audio/video playback and inert SVG image rendering have not been tested. Media MIME/range tests alone do not establish playback acceptance.
- Hostile HTTP(S) caller integration, a full malicious-Markdown corpus, and complete existing HTTP(S)/file/external-PDF/Save Page regression workflows have not been exercised. Existing file/data/child-frame denial tests remain passing.
- Cold process/session restore races, task-close UI workflows, all popup variants, and Windows/macOS canonical-path/case behavior still need end-to-end tests.
- No broad manual UX/accessibility or packaged-release regression pass has been performed. Packaged Electron 42.0.1 was not executed.

## Verification

Commands:

```sh
npm test
npm run build
DISPLAY=:0 npm run test:electron-vault
DISPLAY=:0 npm run test:electron-vault-pages
DISPLAY=:0 npm run test:electron-vault-app
npx --no-install standard pages/markdown/editor.js pages/vault/browser.js
git diff --check
```

The original transport suite remains transport coverage; its manually associated fixture is not Cherry acceptance. No localhost server, file redirects, blob conversion, or sandbox/web-security disabling is used.

The production-page suite uses the production view manager, protocol, preload, folder page, Cherry and PDF.js in normal/private sessions. It verifies folder expansion/recursive search, all five actual Cherry images with nonzero natural dimensions, raw Markdown fetches without tab creation, source-preserving saves, save races, failed writes/conflicts, failed-Save close prevention, Cancel guards, cross-window ownership, a.txt → b.txt → Back, explicit PDF-wrapper navigation, painted PDF canvas pixels and denial of unrelated PDF-consumer reads.

The full-app suite boots production main and browser chrome. It tests actual tab creation, Ctrl+S, Ctrl+W cancellation, native window-close/quit cancellation, reload prevention, cross-window shorthand deduplication, and Settings root changes with Cancel and Save/close-before-commit. Native dialog choices are scripted; production pages and lifecycle handlers are real.

Latest results: `npm test` passed 153 Node tests and lint (including the new page controllers); build and all three Electron suites passed after refinement. Settings tests cover persisted-path loading in a fresh main instance, unavailable directories, caller denial, no-op saves, async UI races and visible path restoration after reopening Settings. Note unit tests cover source bytes, BOM/CRLF, no-op inode preservation, writes, conflicts/retry, serialized saves, size/type rejection and symlinks. `git diff --check` passed.

Runtime: host Node 20.19.5/npm 10.8.2; Electron 41.2.0, Chromium 146.0.7680.179, embedded Node 24.14.0. Cherry is pinned to 0.11.10; its npm engine declaration requires Node >=22 (host installation warned, browser build/tests pass). On NixOS the installed Electron executable and crashpad handler use locally patched ELF interpreter/RPATHs, without changing versions or disabling sandbox/web security. GPU acceleration is disabled in integration tests only. GLib, deprecated navigation API and CSP-blocked generated image-document style warnings occur without assertion failures.
