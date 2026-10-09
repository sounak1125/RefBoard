# Release audit — RefBoard 2.1.5

Date: 2026-10-09. Scope: the changes since 2.1.4 (annotations rework and the
Export images / Settings menu fix), the smoke scripts that cover them, a
dependency audit, and Windows release packaging. This records tested behavior,
not a guarantee that every bug has been found. Unlike 2.1.4, this audit was
written after the release was published (2026-10-09 17:35 UTC); everything under
"Automated verification" and "Release artifacts" was run before publishing,
except the two smokes and the dependency audit noted as run afterwards.

## Changes included

- **Brush and highlighter** (Draw → Annotate). Strokes are a new board item kind,
  `ink`, drawn above images and notes; image pixels are never touched. The nib
  tapers at both ends and thins with speed, or follows real pen pressure.
  Strokes written within 1.4 s and 140 screen px of each other join one item.
  The highlighter keeps its own colour (default yellow) and blends multiply plus
  a faint screen pass.
- **Links between images.** With the arrow tool, a drag from one image or note
  onto a different one makes a link with `fromId`/`toId`, drawn as a Blender-style
  cubic curve square to each edge. `syncLinks` re-routes every link from its items
  before each frame, so moves, resizes, rotation, undo and reopen keep it attached.
  Ends unplug and re-plug by dragging; deleting an item deletes its links. A drag
  within one item, or onto empty board, stays a plain arrow.
- **Arrow restyle.** Tapered shaft, swept head, contrast outline; the selection
  bar sets colour, width, solid/dotted, heads and outline as one undo step.
  Annotation tools keep their own screen-relative widths (arrow and brush 3 px,
  highlighter 16 px) instead of sharing the pen width.
- **Double-click guard.** A double-click with an annotation tool armed, or on an
  annotation, no longer refits the view.
- **Menu fix.** `.ui-select-menu` sits above modals again (z-index 190 → 280); the
  split-view polish (`c28d4da`, first shipped in 2.1.3) had raised `.modal` to
  260 and hidden it.

Geometry lives in `scripts/annotation-geometry.mjs`, added to `build.files`.

## Compatibility

- Boards containing brush strokes lose those strokes when opened in RefBoard
  2.1.4 or earlier: older `normalizeItem` treats the unknown `ink` kind as an
  image with no source and drops it. The release notes say so.
- Links open in older versions as straight arrows at their last position. Older
  versions also clamp arrow width to 1–12 board units, so an arrow drawn while
  zoomed far out comes out thinner there.
- Existing arrows render in the new style, with the outline on.

## Automated verification

- `npm test`: all 69 commands passed as part of `npm run dist` on the release
  commit, including the new `test-annotation-geometry.mjs` (stroke outlines and
  taper, link sides, sockets, curves and socket spreading, pressure, halo colour,
  build wiring) and the updated snap-engine sandbox.
- Electron smokes on the final annotation source: annotations, image edit
  isolation, board history, spatial index, board search, minimap, snap drag, and
  group nudge/resize. Draw/zoom continuity and corner rotate were re-run after
  publishing on `main` at the release commit; both passed.
- `smoke-annotations.mjs` (new, `test:annotations-smoke`, added to CI) drives real
  CDP mouse input: handwriting merge, highlighter colour and width, link create /
  follow / unplug / re-plug / delete + undo, a plain arrow inside one image,
  selection-bar restyle + undo, stroke hit tests, a brush double-tap, and
  save/reopen. The double-tap assertion was confirmed to fail with the guard removed.
- `smoke-image-edit-isolation.js` changed one assertion: an arrow now carries its
  own 3 px screen width rather than the pen's 2. Its intent, that an arrow never
  inherits the eraser width, is unchanged.
- Draw time on the 2,000-item spatial smoke stayed at 0.29 ms with links
  re-routed every frame.
- Not run for this release: the other named smoke scripts that 2.1.4 ran in full
  (landing layouts, board I/O, legacy conversion, saves, pinning, crop/export,
  clipboard, sharpness, worker loading, zoom flicker, and others). None of their
  code paths changed, apart from the shared item model and selection bar.

## Security and dependency review

- Fresh `npm audit` reports 10 findings at the root (2 high) and 9 in the
  bootstrapper (1 high), all in dev dependencies: the `electron-builder` chain
  (`app-builder-lib`, `@electron/get`, `global-agent`, `roarr`, `sprintf-js`,
  `http-cache-semantics`) and `sharp` (librsvg, used only for icon generation).
  `npm audit --omit=dev` reports zero for both. The packaged `app.asar` was
  listed: it contains only `electron-updater`, `koffi` and their dependencies, and
  none of the flagged packages. The `electron-builder` fix is a major upgrade to
  26.5.0 and was not taken in this release.
- New input paths reviewed: board files and the item clipboard both pass through
  `normalizeItem`, which coerces ink stroke values and link handles to finite
  numbers and link ids to strings or null. Colours from a file reach only canvas
  `fillStyle`/`strokeStyle` and a hex parser. The brush cursor's SVG data URL
  takes its colour from the picker and the fixed swatch list, never from a file.
  No confirmed exploitable issue was found.
- Not bounded: the number of strokes or points in an ink item. A crafted board
  with very large stroke arrays costs memory and paint time, like any other
  oversized board payload.

## Release artifacts

App, bootstrapper and both lockfiles are version 2.1.5 (PR #69). Release notes
are in `release-highlights.json` and synced into `changelog.json`;
`test-changelog-format` passed. The setup was copied into the bootstrapper
payload, and its hash matched the built setup before the bootstrapper build.

`npm run release:verify` on commit `cb85180` reported `sourceDirty: false`,
`packagedSourcesMatch`, `bootstrapperPayloadMatches` and `updateFeedMatches` all
true, and wrote `dist/release-2.1.5-manifest.json` and `dist/SHA256SUMS-2.1.5.txt`:

```
3704475c1a54f795f6b1b113b0f7212010de4a7b59df0f039f61d02e099f3c76  RefBoard-Setup-2.1.5.exe
0967056d50e2065f1fd30fbfcf6cb0d168639fe6a7e2d70627429f98eb61ae69  RefBoard-Setup-2.1.5.exe.blockmap
c7bd8c127d6f164cda39cb3ce0f35d20397365d5c723c44b37fa2b391822391f  latest.yml
515e23b4a10b52eb65699f56caf3cbecd74efe703b88dcaaaad77d7a12d1b9c3  bootstrapper/RefBoard-Installer-2.1.5.exe
```

The packaged `dist/win-unpacked/RefBoard.exe` passed the annotations, tags and
split-view smokes. The draft carried four assets whose sizes matched the local
builds. After publishing, `releases/latest/download/latest.yml` served
`version: 2.1.5`, and tag `v2.1.5` points at `cb85180`.

## Remaining manual checks

- Install the setup over an existing 2.1.4 installation and let auto-update take
  an installed 2.1.4 to 2.1.5. Neither was performed; auto-update is now live.
- Launch the bootstrapper installer UI. It was not launched for this release.
- Pen-tablet pressure and the highlighter on real reference images. Automated
  input is mouse only; the highlighter blend was chosen from rendered
  comparisons on gradient test images.
- Native drag-and-drop into another application, as in 2.1.4.

## Local evidence

- `dist/release-2.1.5-manifest.json` and `dist/SHA256SUMS-2.1.5.txt`.
- The unit-suite and build log from `npm run dist` was kept in this session's
  temporary scratch directory and is not retained.
