# Codex goal — Vault mode, revision 2

Copy this goal. It supersedes the previous goal's non-Markdown `file://` delegation and “URL-router-only” approach.

```text
/goal Implement Vault Mode revision 2 from docs/vault/README.md, SPEC.md, ARCHITECTURE.md, CONTRACTS.md, and IMPLEMENTATION.md. Read all five before coding.

The key requirement: vault:// is a REAL read-only Electron resource protocol, not just an address-bar alias. “Other files as is” means HTTP-style Response(status, headers, original file bytes) at the vault URL. No localhost server, file:// redirect, per-image blob conversion, or extra tab for an image request.

Implement these behaviors:
- Persist one configured on-disk vault root. Use canonical vault://local/... URLs and the documented vault://test.jpg root-file shorthand.
- Register the standard/secure/fetch/stream-capable vault scheme before app readiness alongside Min's existing scheme registration; install its real handler in every relevant tab session.
- Serve authorized regular-file GET/HEAD requests with exact bytes, correct MIME, no-store, explicit errors, bounded streaming, and single byte-range support. Keep GET/HEAD read-only. Raw Markdown/PDF fetches return source bytes, never viewer HTML.
- Keep viewer selection separate and top-level-only: folders open the file-tree/search page; Markdown opens Cherry in a normal Min tab. Packaged internal-page wrappers are fine for these views. Other files remain vault:// resources, not public file:// navigation.
- Make relative, parent-relative, root-relative, canonical, and shorthand Markdown images actually render through the protocol. Resolve preview URLs against the represented note URL, not the packaged editor location. Preserve original Markdown references on save.
- Reuse Min's PDF viewer with the vault URL as source; PDF.js must read protocol bytes. Preserve existing HTTP(S)/file:// behavior and existing filtering/download request listeners.
- Keep one editable tab per canonical Markdown disk path across windows and restore. Main owns file associations and validates resource readers and IPC callers. Enforce root confinement, symlink policy, scoped CORS/CSP, and deny untrusted read/write access without disabling sandboxing or web security.
- Save Markdown source through a narrow saveCurrent(text) IPC operation, using serialized baseline comparison and atomic replacement. Preserve edits on conflicts/failures, acknowledge only the submitted snapshot, and guard close/reload/navigation/window-close/quit before destroying dirty editors.
- Exclude vault-backed raw documents and wrappers from browsing-history text indexing. Keep root changes and restored associations safe.

Stay KISS: no new browser-chrome sidebar, second tab system, database, generic VFS/RPC framework, write REST API, or unrelated refactor. Follow the vertical slices in IMPLEMENTATION.md; real image loading is required, not optional polish.

Add focused unit tests and real Electron integration tests. Verify JPEG bytes/MIME, all five Markdown image examples with nonzero natural image dimensions, raw-vs-navigation separation, ranges/errors, PDF rendering from vault bytes, caller/path security, one-tab ownership, save races, and dirty lifecycle. Run npm test, npm run build, and the focused integration command. Report actual runtime versions, test results, and any unexecuted tests or deviations honestly. Complete SPEC.md's acceptance criteria rather than only a mocked protocol skeleton.
```
