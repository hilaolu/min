# Content search

In the three-pane vault file explorer, press `/`, enter a query, then press
Enter. Files beneath the current directory are searched recursively. Use arrows
or `j`/`k` to select a hit and update the preview; Enter opens the file. Press
`/` to edit the query or Escape to cancel an active scan and restore the directory.

Search uses the already-installed `quick-score` npm package locally; no
external executable is required. For example, `python` finds a file containing
“Learn Python” even when its filename has no matching characters. Search ranks
one best matching snippet per file and shows its line number. The preview
highlights the actual matched characters. It is a snapshot from the search;
rerun search after editing a file.

Matching is case-insensitive. Contiguous literal matches rank first. An
abbreviation match must score at least 0.75 and have a compact span no greater
than three times the query length. Abbreviations are not spelling correction.
Enable **Exact phrase** to disable abbreviation matching. Queries must be
nonempty and single-line.

**Top** defaults to 50 ranked results; choose 25, 100, or 500 as needed, then
press Find again. The status reports how many matching files were found, not
only how many are displayed.

Only UTF-8 text is searched. Binary formats, including PDFs, are skipped, as
are files containing NUL bytes, files with invalid UTF-8, and inaccessible
files. Symlinks are forbidden and never followed.

Search is bounded to 20,000 directory entries, 10 seconds, the first 4 MiB per
file, and 32 MiB of file data in total. The interface gives explicit notices
when any bound causes partial coverage and reports skipped entries; narrow the
search to a subfolder when necessary. No content index is persisted and no data
leaves the computer.
