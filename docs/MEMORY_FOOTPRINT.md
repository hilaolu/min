# Memory reduction: closed task switcher

## Implemented

Closing the task switcher removed its DOM but left `sortableInstances` alive
until the next render. Sortable retains each task's tab container through its
instances, registry and document listeners. Consequently, the detached tab rows,
their event handlers and associated rendering data remained reachable while the
switcher was closed.

`js/taskOverlay/taskOverlay.js` now shares cleanup between rendering and closing:
destroy all Sortables, drop their references, then remove the rows. Closing still
waits for the existing 250 ms transition. Reopening cancels the pending close
timer: a rapid hide/reopen/hide cannot let an older callback shorten the newer
transition or accumulate redundant cleanup timers. Reopening already rebuilt
the overlay, so this adds no extra rebuild.
The browser's tabs/session and page renderers are unchanged; no tabs are unloaded.

## Measured scenario

Linux, Electron 44.4.5 / bundled Node 24.21.0, ten synthetic tasks containing
2,000 tabs. The fixture uses the production overlay, row builders and Sortable
with real DOM, but stubs browser actions/session and URL helpers. It creates no
page renderers or external favicon requests. Closing callbacks are advanced
deterministically; snapshots wait for idle work, flush layout and force GC.

Three fresh-process before/after pairs compared the overlay at `fbc115588665`
with the initial cleanup change. The table reports **additional retained resources
after closing, relative to each process's pre-open snapshot**, not total browser
memory.

| Retained resource                         |   Before |    After |
| ----------------------------------------- | -------: | -------: |
| Detached tab rows referenced by Sortables |    2,000 |        0 |
| DOM nodes                                 |   12,180 |        0 |
| Event listeners                           |   10,144 |        0 |
| V8 used heap                              | 0.78 MiB | 0.08 MiB |
| Chromium-reported embedder heap           | 4.57 MiB | 0.14 MiB |

All three runs round to these values: approximately **0.70 MiB less V8 heap and
4.43 MiB less embedder heap** in this scenario. Heap statistics come from CDP
`Runtime.getHeapUsage`; embedder memory is a separate, experimental native-heap
metric. These are not RSS measurements or evidence of a universal percentage
reduction. Savings depend on the number/content of rows. Browser allocator
reservations, GPU memory and real page-renderer memory were not measured.

A subsequent validation returned the same DOM/listener counts but a 0.29 MiB
embedder-heap delta, illustrating the variability of exact byte measurements.

Repeated rapid open/close/reopen cycles also returned DOM-node and listener
counts to baseline, including after the timer-cancellation refinement. The smoke
asserts resource cleanup and transition timing, not exact byte counts.

## Verification and reproduction

- Three Node regressions cover cleanup ordering, repeated close, and reopening
  before a pending close callback fires. All failed against the old overlay.
- A fourth regression reproduces premature cleanup during hide/reopen/hide:
  it failed against the initial fix and passes with close-timer cancellation.
- The real-DOM smoke failed on all three old-source runs and passed on all three
  initial cleanup runs. Final runs also cover rapid reclosing and confirm that
  DOM-node/listener counts return to baseline after repeated cycles.
- All **381 Node tests**, JavaScript lint, full build, existing Electron
  performance smoke and `git diff --check` passed.
- The host's Node 20.19.5 fails the project's Node >=22.12.0 requirement; Node
  tests were run with Electron's bundled Node instead. Electron emitted the
  workspace's GLib schema warning but completed successfully.
- Manual drag/drop input, cross-platform runs and whole-app RSS profiling were
  not performed. This is a focused retention fix, not an exhaustive memory audit.

```sh
ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron --test test/*.test.js
DISPLAY=:0 node_modules/.bin/electron --no-sandbox test/electronTaskOverlay.js
```

For comparison without changing the working tree, save the old overlay source
with `git show fbc115588665:js/taskOverlay/taskOverlay.js` and pass its path as
`--overlay-source=/path/to/old-overlay.js` to the Electron smoke. It prints the
measurements before failing the cleanup assertions, as expected.
