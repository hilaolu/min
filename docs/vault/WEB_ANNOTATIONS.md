# Webpage annotations

Configure a vault in Settings, then open an HTTP(S) page in a normal tab.
Select page text to show a floating color palette beside the selection, then
choose a color to highlight it. Like tab-picker, the palette is a single row of
16 square swatches. Highlights have a 13.3%-opacity background and a 2px colored
underline, preserving the page's text color. Click a highlight for the **📝 Edit
Notes / 🗑️ Delete** menu. Notes are always displayed immediately after their
highlight, wrapping in full without truncation (including line breaks). Click a
note or **Edit Notes** to edit it in place alongside the highlighted text, with
**Save** and **Cancel**. The editor participates in the page layout, not a modal
or floating popup. Deleting asks for confirmation and removes the displayed note.
There is no fixed annotation button. Escape or clearing the selection dismisses
the palette. Highlights, saved notes, and deletions persist as Markdown in the
vault's **Annotation store path**, configured under **Settings → Vault**
(default: `Annotations`). Nested relative folders such as `Research/Annotations`
are supported and created on the first save. `>m` excludes the configured folder
and its descendants, but not similarly named sibling folders.
The `>a` picker discovers these records as well as legacy tab-picker annotations.

The configured folder is the only native annotation store; hidden folders are
not scanned or used as a fallback. Changing the setting does not move or delete
existing files. To relocate records, move them into the configured folder
yourself. Reload annotation tabs after changing the setting; stale editors
cannot write to the new destination.

Highlights are restored using surrounding
text; ambiguous or missing quotes remain in storage rather than highlighting
an unrelated occurrence. Dynamic page text is periodically re-anchored.

Private tabs cannot read or write vault annotations. Conflicting disk edits stop
saving instead of overwriting another writer; copy unsaved notes before using
**Reload**. Navigating with pending edits prompts before leaving. After an
in-page URL change, reload the page before annotating its new address.

Current limitations: iframe and editable-field
selections are unsupported. This is local autosave, not collaborative syncing.
PDFs retain their existing annotation editor.
