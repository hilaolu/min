# Markdown picker live index

`>m` searches an in-memory index of `.md` relative filenames/paths,
case-insensitively. Headings, frontmatter, aliases, and contents are not read.
`>p` and `>a` share the watcher and an annotation metadata cache. `>p` searches
annotated PDFs; `>a` searches annotated web pages and opens their original URL.
Both match title, source URL and tags, not highlight bodies or filenames.

The first picker search starts a Chokidar watcher and waits for its initial
recursive scan. Later searches reuse the index; additions, deletions, and
renames update it incrementally. Content changes need no index update.
There is no 2,000-entry or 32-level scan cutoff. Searches return the first
20 valid matches in path order, with a limit indicator when more exist.
Watcher events affect subsequent searches; an already displayed result list
is not pushed updates until the picker searches again.

Symlinks are not followed. Returned candidates are revalidated through the
existing vault resolver; the watcher is not an access-control boundary.
Successful root changes close the old watcher and discard its index. Canceled
changes retain it. Approved application shutdown also closes the watcher.
Watcher errors fail searches rather than silently serving a partial index;
the next request retries with a fresh watcher and initial scan.

Index memory scales with Markdown path count and length; watcher overhead also
depends on directory count. Initial traversal scales with vault entries.
Queries filter paths linearly and sort matching paths, then validate up to
21 valid candidates. No index is persisted. Very large vaults can encounter
OS watcher limits; polling, periodic reconciliation, and full-text indexing
are not implemented.

## Annotation indexing and storage

Annotation discovery reads Markdown plus old native JSON records. It excludes
`.obsidian`, `.git`, `.trash`, and `node_modules` path components. Normal
Markdown files are not annotation candidates. Mixed legacy PDF/webpage records
are classified as PDF resources, not duplicated into `>a`.

The first annotation query builds metadata from the shared inventory (without
another directory walk). Subsequent queries reuse it without rereading records.
File events invalidate that metadata; the next query rebuilds it, coalescing
change bursts and concurrent queries. This first implementation rereads records
on a rebuild, rather than maintaining a per-file parsed-record cache. Only
title, URL, tags and annotation counts are retained, not highlight text/geometry.
PDF source availability is checked again before returning results. Local PDFs
remain supported, but remote PDFs need no local PDF copy.

New PDF saves go to `<annotation store path>/<sha256(source URL)>.md`, relative
to the vault. The folder defaults to `Annotations` and is configurable in
Settings → Vault; its entire subtree is excluded from `>m`. The versioned
Markdown format stores readable fenced quote/context/note sections and hidden
source/geometry metadata. It round-trips whitespace, markup and PDF coordinates
without loss. Source query parameters are preserved; fragments are excluded
from identity. Existing `.json` is read-only fallback: a successful save writes
Markdown and leaves JSON untouched. An empty Markdown record overrides old
JSON/legacy highlights. Malformed Markdown fails closed rather than falling
back to JSON. Imports accept native Markdown, legacy Markdown and old JSON.
Legacy plugin Markdown is not rewritten. Export remains JSON for recovery.

This adds the annotated-webpage picker, not webpage highlight creation or
restoration in the browser. Index rebuilds are lazy, and open result lists are
not pushed updates. Markdown format compatibility with the Obsidian plugin's
writer is not claimed; legacy import remains supported.

Focused Electron picker smoke (after `npm run build`):
`DISPLAY=:0 node_modules/.bin/electron --no-sandbox test/electronVaultApp.js --picker-only`.
