# Release audit — RefBoard 2.1.4

Date: 2026-09-27. Scope: the changes since 2.1.3, the split-view image bounce,
renderer crash recovery, dependency/source review, all named smoke scripts,
and Windows release packaging. Two agents covered runtime smoke tests and
security/code review. This records tested behavior, not a guarantee that every
bug or vulnerability has been found. The release is prepared as a draft.

## Fixes included

- Split view keeps image scale stable and moves the board from its actual painted
  position. Removing the canvas height transition fixes the downward stretch and
  upward bounce after opening. Hover timers, partial titlebar reveals, closing,
  and reversals no longer reset the opening position. The unused split-progress
  CSS path was replaced by the captured board offset.
- Renderer crashes no longer leave a streamed save permanently reserving its
  target. Tokens are invalidated immediately; cleanup waits for pending
  initialization or image writes before rolling back and closing handles.
  Commits already in progress finish normally. A Save As dialog that outlives a
  crash cannot create an orphaned session when it returns.
- Label controls use explicit add/apply/remove actions with Undo. Label colors
  survive file reload and session recovery without leaking between boards.
- Successful saves remove temporary .bak files; interrupted saves retain their
  recovery safeguards. Failed file initialization closes its handles.
- Installer launch failures leave the installer available for Retry launch.

## Automated verification

- `npm test`: all 68 commands passed on the final app source, including save
  concurrency, abort/rollback, the new crash lifecycle cases, 42 file-handle
  fault cases, split motion, clipboard, and installer retries.
- All 43 named smoke scripts passed (44 executions
  because grid rendering runs with GPU and software). It covers board I/O,
  legacy conversion, saves, history, labels, search, layouts, pinning, groups,
  snapping, crop/export, clipboard, image sharpness, worker loading, zoom,
  and split view. Final results are recorded in the local smoke summary.
- Split smoke uses three stacked images at 25% zoom plus 120 notes. Eight
  opening/closing cases check image-edge motion and scale through 450 ms after
  settling, including hover-hide overlap and an interrupted titlebar reveal.
- A real isolated Electron renderer was forcibly crashed after appending image
  data. Automatic reload succeeded, the last committed board remained
  byte-for-byte identical, and a new save to the same path succeeded.
- Two old harness assumptions were corrected: the landing test now waits for its
  normal fade to finish, and Show in folder targets the primary WebContentsView
  with bounded evaluation instead of the unused BrowserWindow renderer.
- Clipboard restoration checks compare PNG dimensions/pixels rather than PNG
  encoding bytes, since native clipboard writes can re-encode an identical
  image. Text/custom formats retain exact byte checks with bounded diagnostics.

## Security and old-code review

- Fresh root and bootstrapper `npm audit --json` each reported zero known
  dependency vulnerabilities. GitHub's Dependabot-alert endpoint was unavailable
  because repository alerts are disabled; it was not treated as a clean scan.
- Reviewed Electron isolation/navigation restrictions, external URL schemes,
  dynamic text rendering, IPC token ownership, export/drag path boundaries,
  container image ranges, split sender/animation checks, and installer process
  launch/retry handling. No confirmed exploitable issue was found in these paths.
- No further demonstrably obsolete production module was found. Legacy board
  readers and compatibility paths remain because their smoke tests still
  exercise supported files. The earlier unused-import cleanup is included.

## Release artifacts

App, bootstrapper, and both lockfiles are version 2.1.4. Structured release notes
are in `release-highlights.json` and `changelog.json`. Builds use publishing
explicitly disabled, then the matching setup is copied into the bootstrapper.

`npm run release:verify` checks the packaged runtime against the checkout, both
package/UI versions, the actual embedded setup hash, and the update feed's
filename, size, and SHA-512 hash. It writes `dist/release-2.1.4-manifest.json`
and `dist/SHA256SUMS-2.1.4.txt`. Final verification after committing records the
source commit with `sourceDirty: false`.

The packaged app receives label and split smoke checks. The packaged installer
UI was launched in a temporary profile and verified at 2.1.4 with an enabled
Install control and working slides. That check does not start installation.

The draft contains the setup, blockmap, latest.yml, and matching bootstrapper.
No public update is published as part of this preparation.

## Remaining manual checks before publishing

- Install the actual setup and upgrade an existing Windows installation, then
  exercise the installed app and auto-update path. These change the machine's
  installed application/Explorer integration and were not performed here.
- Complete native drag-and-drop into another application. Automated coverage
  verifies staging and file contents, not another application's drop handling.

## Local evidence

- `%TEMP%/refboard-all-smoke-QYbnFe/summary.json` and its per-script logs.
- `%TEMP%/refboard-2.1.4-final-build.log` (unit suite and app build).
- `%TEMP%/refboard-2.1.4-bootstrapper-build.log`.
- `%TEMP%/refboard-2.1.4-real-crash.log` and
  `%TEMP%/refboard-2.1.4-installer-smoke.log`.
- `dist/release-2.1.4-manifest.json` and `dist/SHA256SUMS-2.1.4.txt`.
