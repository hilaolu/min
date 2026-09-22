# Annotation storage: tab-picker format

This replaces the earlier Min-specific Markdown/JSON storage contract.
Web-page annotations use the format in `tab-picker/src/utils/markdown-utils.ts`:

```markdown
| Field | Value |
| --- | --- |
| Title | Page title |
| URL | https://example.com/article |
| Tags | #annotation |

## Annotations

%% annotation: highlight-id | color: ffcd45 %%
<pre>context before</pre>
<pre>highlighted text</pre>
<pre>context after</pre>

Optional Markdown note
```

Untyped markers are web-page annotations, not PDFs. Existing explicit PDF
markers/geometry remain supported for the PDF reader.

- Default folder: `Archives/Annotations`, relative to the configured vault.
  An explicitly saved Settings folder is respected, not silently changed.
- The Settings folder is the sole location for annotation loading, discovery,
  search and saving. Neither the direct scan nor the watcher snapshot searches
  other vault folders. A missing configured folder yields no annotations;
  there are no compatibility aliases, migrations or fallback locations for
  `Archive/Annotations` or `.min-annotations`. Invalid configured records
  produce an error rather than being replaced by records from another folder.
- Layout: `<folder>/<hostname>/<encodeURIComponent(pathname + query)>.md`.
  Root `/` becomes `/index` when no query remains. Web URLs use tab-picker's
  resource-query allowlist, sorted parameters and trailing-slash normalization.
  Min continues to ignore page fragments for annotation identity.
- New web records use the page title. Existing table title, URL and tags survive
  edits. Empty files remain after final deletion, preventing archived copies
  from resurrecting deleted highlights.
- Old hashed JSON and Min-specific Markdown are not loaded or migrated.
  Existing vault files are not bulk-rewritten, renamed or deleted.
- Source collision checks, revision conflicts, bounded reads, atomic saves,
  symlink denial and private-tab restrictions remain in place. Ambiguous block
  delimiters are rejected rather than written as corrupt annotation records.

The local reference directory is `~/obsidian/Archives/Annotations` (plural).
It was inspected read-only. No personal annotation contents are copied into tests.
