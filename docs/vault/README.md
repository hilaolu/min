# Vault mode

## Goal

See [STATUS.md](STATUS.md) for implemented behavior, verification results, and remaining acceptance gaps.

Turn Min into a small local Markdown workspace without adding another application shell.

One configured on-disk directory is the vault. A **real, read-only Electron `vault` protocol** serves its files as responses with status, MIME headers, and unchanged file bytes. Folder navigation opens a file browser; Markdown navigation opens Cherry. Both are normal Min tabs.

**Revision 2 — 2026-09-18:** “Other files as is” means serving their bytes at `vault://`, including requests made by Markdown images. It does **not** mean converting navigation to `file://`, launching another tab for an image, or returning viewer HTML for every request. This revision supersedes the previous delegation-only design.

For example, an authorized request to `vault://example.md` must return `200`, `Content-Type: text/markdown; charset=utf-8`, and the Markdown bytes. `vault://Projects/note.md` identifies a nested file and `vault://` identifies the root; there is no special `local` authority or shorthand form. There is no HTTP server, listening port, or network upload: “HTTP-style response” means an Electron protocol `Response`.

## Keep two concerns separate

| Concern | Behavior |
| --- | --- |
| Top-level folder navigation | Packaged Vault browser page in a Min tab |
| Top-level Markdown navigation | Packaged Cherry editor page in a Min tab |
| Image, media, PDF, fetch, or other resource request | Real `vault` protocol returns the file representation |
| Save | Narrow, authorized IPC writes the editor's associated Markdown file |

Packaged `min://app/...` viewer pages may still wrap folder/Markdown navigation for a clean trust boundary. **Those wrappers do not replace the resource protocol.** Relative images must resolve against the represented vault document, not the packaged viewer location.

Read in order:

1. [SPEC.md](SPEC.md) — product behavior and acceptance criteria.
2. [ARCHITECTURE.md](ARCHITECTURE.md) — implementation boundaries and Min integration.
3. [CONTRACTS.md](CONTRACTS.md) — URLs, responses, assets, authorization, saves, and lifecycle.
4. [IMPLEMENTATION.md](IMPLEMENTATION.md) — vertical slices and test matrix.
5. [GOAL.md](GOAL.md) — ready-to-paste Codex `/goal`.

## Design principles

- Reuse Min's tabs and existing PDF viewer, but have PDF.js read the original `vault://` resource.
- Serve non-Markdown resources directly; no per-image IPC/blob conversion or `file://` redirect.
- Keep raw GET/HEAD reads separate from viewer selection and authorized writes.
- Main owns root confinement and one-editor-per-canonical-path ownership.
- Save Markdown source atomically, preserve dirty edits on error, and guard destructive lifecycle actions.
- No database, generic VFS/RPC framework, background index service, or second tab store.

## Non-goals for v1

Obsidian plugins, backlinks/graph view, full-text note indexing, multiple vaults, file create/rename/move/delete, attachment uploads, synchronization, and editing outside the root are out of scope. A permanent browser-chrome sidebar and a localhost server are also out of scope. Rendering existing Markdown images **is required**, not deferred attachment management.
