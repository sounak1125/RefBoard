# Release audit — RefBoard 2.1.6

Date: 2026-10-27. Scope: the one change since 2.1.5 (the drag-pan jump fix), the
tests and smokes that cover it, a dependency audit, and Windows release
packaging. This records tested behavior, not a guarantee that every bug has been
found. As with 2.1.5, this audit was written after the release was published
(2026-10-27 07:16 UTC); everything under "Automated verification" and "Release
artifacts" was run before publishing, except the dependency audit,
`release:verify` and the feed checks, which ran afterwards and are noted as such.

## Changes included

- **Drag-pan no longer jumps when the zoom changes mid-drag** (PR #71). The pan
  rebuilt the view from a pointerdown snapshot on every move (`tx = tx0 + dx`).
  A wheel zoom during the drag shifts `tx` to keep the cursor anchored; the next
  move restored `tx0` under the new scale, throwing the board by
  *(board x under cursor) × (scale change)*: about 444 px for one wheel notch at
  100% with the cursor over board x = 3000, about 8,900 px at 2000%. Each move now
  adds its own delta to the live view. This covers the hand tool, middle button,
  Space/Alt + drag and right-button pans; right-drag context-menu suppression
  still measures distance from the press. Middle-button panning hit this most,
  because most mice send a wheel tick while the wheel button is held.

No file format, IPC, network or dependency change. `index.html` is the only app
source file touched.

## Compatibility

- Boards are unchanged in format and open in 2.1.5 and earlier exactly as before.

## Automated verification

- `npm test`: all 70 commands passed as part of `npm run dist` on the release
  commit, including the new `test-pan-zoom-contract.mjs` (all three pan entry
  points remember the last pointer position instead of snapshotting the view;
  pointermove adds its own delta). It fails on the 2.1.5 code.
- `smoke-pan-zoom.mjs` (new, `test:pan-zoom-smoke`, added to CI) runs the real app
  at 2000% with board point (3000, 2000) under the cursor, holds the middle button,
  drags, zooms out one wheel notch and then in two, mid-gesture. After every move
  the grabbed board point sat 0.000 px from the cursor. On the 2.1.5 code it fails
  after the first zoom, 12,597 px off. Input is synthetic `PointerEvent` /
  `WheelEvent` dispatched in the page, not CDP mouse input.
- Electron smokes on the fix branch (dev source), run one at a time: view
  persist, minimap, keyboard guards, snap drag, steady-view flicker and
  annotations. All passed.
- CI on PR #71 and PR #72: the `test` job and the `smoke` job (the full `ci.yml`
  smoke list, including the new smoke) passed on both.
- By hand: the fix was tried in `npm start` with a real mouse before merging and
  reported working. Not repeated on the packaged build.

## Security and dependency review

- Fresh `npm audit`, run after publishing: 5 findings at the root (4 high, 1
  moderate) and 4 in the bootstrapper (3 high, 1 moderate). Apart from Electron
  (below), all are in the build chain: `http-cache-semantics` (`electron-builder`
  → `@electron/get` → `got`), `undici` (`node-gyp` under `@electron/rebuild`, and
  `@electron/get` under `electron`, used to download the runtime), `fast-uri`, and
  `sharp` (icon generation only). Dependencies are unchanged from 2.1.5 apart
  from the version field.
- `npm audit --omit=dev` reports zero for both, but that excludes Electron, which
  is a dev dependency in `package.json` and is also the runtime packaged into the
  app. **2.1.6 ships Electron 44.4.5**, which carries two advisories published
  after 2.1.5 shipped:
  - GHSA-jr5w-w6x2-84p9 (high, published 2026-10-23, fixed in 44.9.1): mitigation
    for compromised eMudhra intermediate certificates. It affects TLS trust for the
    app's own connections: the auto-update check against GitHub, and the fetch
    when a web image is dropped onto the board. The setup is not code-signed
    (`signExecutable: false`), and `electron-updater` checks the downloaded setup
    only against the sha512 in `latest.yml`, which arrives over that same TLS. In
    principle, a network attacker holding a certificate from those intermediates
    could serve a different update. No exploitation is known. This was found after
    publishing; the next release should move Electron to 44.9.1 or later, which
    is inside the declared `^44.4.5` range.
  - GHSA-x562-297c-g43g (medium, published 2026-10-22, fixed in 44.5.0): pointer
    lock permission requests attributed to the wrong frame. RefBoard never calls
    `requestPointerLock`.
- New input paths: none. The change is pointer arithmetic in the pan handler.

## Release artifacts

App, bootstrapper and both lockfiles are version 2.1.6 (PR #72). Release notes
are in `release-highlights.json` and synced into `changelog.json`;
`test-changelog-format` passed. The setup was copied into the bootstrapper
payload; its SHA-256 matched the built setup before the bootstrapper build, and
the copy packed into `dist/bootstrapper/win-unpacked/resources` matched after it.
`release:ship` checked the payload again before uploading.

`npm run release:verify` on commit `c9318aa`, run after publishing, reported
`sourceDirty: false`, `packagedSourcesMatch`, `bootstrapperPayloadMatches` and
`updateFeedMatches` all true, and wrote `dist/release-2.1.6-manifest.json` and
`dist/SHA256SUMS-2.1.6.txt`:

```
0b782ff734664b36b5fcfea657c72e19a716f53beec52406334bf2be3f09036b  RefBoard-Setup-2.1.6.exe
090fd5e2b6367b00aa2a64b11b65b661b3f0467e4861a59c01433225d5053232  RefBoard-Setup-2.1.6.exe.blockmap
d5df7fdc670675d7fd8e54bb64955caf2355b636620bd1b77d2954963e94ddee  latest.yml
a31e6dbeb32b2eb872719ad3f0702249d2da7d5e0b903038c48dda5c618dd348  bootstrapper/RefBoard-Installer-2.1.6.exe
```

The packaged `dist/win-unpacked/RefBoard.exe` opened to the Home screen with a
fresh profile. Its `app.asar` contains the new pan code and not the old line.
It passed the annotations, tags and split-view smokes. `smoke-pan-zoom.mjs` was
not run against it: unlike those three, it does not accept
`REFBOARD_SMOKE_EXECUTABLE`. The draft carried four assets whose sizes and
SHA-256 digests on GitHub matched the local files. After publishing,
`releases/latest/download/latest.yml` served `version: 2.1.6`, byte-identical to
`dist/latest.yml`; the setup's download link answered 200 with a
`Content-Length` of 104,691,766; GitHub
lists v2.1.6 as the latest release; and tag `v2.1.6` points at `c9318aa`.

## Known issues not addressed

- Zooming while dragging an *item* makes it drift away from the cursor. The move
  branch measures the drag from the pointerdown screen position, which a zoom
  invalidates. Milder than the pan jump; separate code path.
- Grabbing the board during a fit or search view animation (up to 320 ms) loses
  the pan input until the animation ends. It no longer jumps.

## Remaining manual checks

- Install the setup over an existing 2.1.5 installation, and let auto-update take
  an installed 2.1.5 to 2.1.6. Neither was performed; auto-update is now live.
- Launch the bootstrapper installer UI. It was not launched for this release.
- The pan fix on the packaged build with a real mouse, and a trackpad pinch
  (Ctrl + wheel) or pen during a drag. The by-hand check used the dev build and a
  mouse only.
- Native drag-and-drop into another application, as in 2.1.5.

## Local evidence

- `dist/release-2.1.6-manifest.json` and `dist/SHA256SUMS-2.1.6.txt`.
- The unit-suite, build and bootstrapper logs were kept in this session's
  temporary scratch directory and are not retained.
