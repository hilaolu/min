# Hardcoded Vim preferences

`editor.js` installs the requested nonrecursive movement/deletion mappings and
insert-mode Ctrl+C escape mapping in Cherry's bundled Vim emulator. `jj` is
ordinary text, not an escape mapping. Ctrl+C moves
two word ends in normal mode (use the application copy menu to copy).
The bundled emulator retains its native Ctrl+C copy handling for selections.
The editor uses the light theme regardless of the system theme; surrounding
page controls still follow the system theme.

Compatibility limits in pinned Cherry 0.11.10:

- `hidden` is not a Vim option here: each note already has its own editor tab;
  the existing autosave and unsaved-change handling are unchanged.
- `tabstop`, `softtabstop`, `shiftwidth`, and `expandtab` are not wired through
  Cherry's CodeMirror 6 adapter. These settings are not applied.
- `clipboard=unnamed` is not supported by the bundled Vim option API. Clipboard
  behavior remains unchanged; no additional clipboard permissions are granted.

Cherry does not expose its Vim API. Initialization uses its bundled Ex prompt
bridge, restoring the original prompt immediately afterwards. The Electron
Markdown smoke test checks this integration; revisit it when upgrading Cherry.
