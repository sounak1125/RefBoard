# Release audit — 2026-09-27

Scope: RefBoard 2.1.3 development changes, including the label workflow,
temporary backups and split animation. Two agents independently covered runtime smoke tests
and security/dead code. This records tested behavior; it is not a guarantee that
every bug or vulnerability has been found. No release was published.

## Issues fixed during this audit

- Restore label colors when opening another board, clear inherited colors when
  the opened file has none, and include colors in crash-recovery session data.
  The label smoke now leaves the current board before reopening its saved file;
  opening the current path had previously bypassed the actual load.
- Close container and legacy sidecar handles when new-file initialization fails.
  Forty-two fault-injection cases exercise truncate, write, sync, cleanup failure,
  and caller ownership after success across both formats.
- Handle synchronous and asynchronous installer launch failures. Wait for the
  process to spawn before quitting; failed launches keep the installer open with
  Retry launch. Tests cover failed/rejected calls, retries and duplicate requests.
- Remove six unused main-process imports and the unused bootstrapper shell import.
  Dynamically used renderer functions and compatibility modules were retained.

## Verification passed

- `npm test`: all 68 commands passed after the fixes, including file replacement,
  crash recovery, concurrent saves, session abort, clipboard, container/sidecar
  integrity, installer retry, and the new handle lifecycle checks.
- Twenty isolated Electron smoke invocations covered keyboard guards, autosave
  failure, undo memory, multiple windows, split view, save/open, view/theme
  persistence, image edit isolation, lossless JPEG/WebP crop exports, content-aware
  worker cancellation, clipboard, landing layout, search, groups, grid rendering,
  drag-out staging and zoom. History checks used 2,000 items; the 500-image zoom
  check reported zero renderer errors or quality downgrades.
- Six additional final smoke runs passed: labels from source and the packaged
  executable, label context menus, legacy/sidecar conversion, incremental saves,
  and aborted saves. Label checks include real file reload, session color data,
  mixed selections, explicit removal, Undo/Redo, filtering and keyboard controls.
- Root and bootstrapper `npm audit --json`: zero known dependency vulnerabilities
  reported. Reviewed navigation restrictions, external URL handling, IPC session
  ownership, file boundaries, Electron isolation and dynamic text rendering;
  no confirmed exploitable issue was identified in the inspected paths.
- An isolated Windows unpacked build completed with publishing disabled. Its
  label smoke passed, final runtime files matched source, and inline script
  syntax checks passed. The build stayed outside the release output directory.
- `git diff --check` passed.

## Split animation follow-up

Two agents separately investigated frame pacing and renderer layout. On the
tested Windows display, a nominal 16 ms main-process timer produced roughly
31 ms layout updates while display frames arrived every 6.3 ms. Changing canvas
width also reset its unchanged height, clearing the backing surface twice per
step. After closing, a separate CSS height transition briefly squeezed the board.

The slide now uses primary-renderer animation frames, a monotonic clock, a
400 ms easing curve with smooth acceleration, and a single completion deadline
for hidden or stalled renderers. Sender and animation identity checks reject
unrelated or stale callbacks. Native bounds are applied only when changed.
The primary canvas keeps its full backing surface while clipping follows the
divider; its top moves with the slide without stretching its height. The
minimap updates independently of full-board redraws.

The final 121-item development smoke measured 6.2/6.3 ms median opening/closing
layout intervals, with 43/43 and 52/52 observed display frames advancing the
slide. Canvas dimension writes dropped from 26/22 to 2/2. These measurements
describe this machine, not a guaranteed refresh rate on every device.
Motion and 450 ms of post-close samples showed no canvas stretching beyond
one CSS pixel of DPI rounding. Reopening, divider movement, item preservation,
and renderer error checks passed. The rebuilt Windows app also passed the
enhanced split smoke. CI now runs this regression check on pushes.

Additional unit cases cover stale frame IDs, wrong senders, reversal, cancellation,
failed loading, fallback completion, frame-loop cleanup, stable canvas sizing,
and both titlebar policies.

## Remaining release checks

- Run the actual installer and upgrade an existing installation on Windows.
  Installer error handling has automated coverage; end-to-end installation and
  auto-update execution were not exercised by this audit.
- Manually complete native drag-and-drop into another application. Automated
  coverage verifies the staged files, not another application's drop handling.
- Follow `MAINTAINING.md` for versioning, release notes, installer payload refresh
  and packaging before publishing. This audit did not update release artifacts.

Local final test/build logs are in the Windows temporary directory as
`refboard-release-final-tests.log` and `refboard-release-final-build.log`.
Split follow-up logs use `refboard-smooth-final-tests.log` and
`refboard-smooth-final-build.log`.
