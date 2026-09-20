# Markdown picker live index

`>m` searches an in-memory index of `.md` relative filenames/paths,
case-insensitively. Headings, frontmatter, aliases, and contents are not read.
PDF search is unchanged.

The first Markdown search starts a Chokidar watcher and waits for its initial
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
