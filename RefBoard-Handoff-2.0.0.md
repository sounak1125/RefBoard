# RefBoard - Handoff (2.0.0 development, post-1.1.3)

Paste this file into a fresh chat or tool to resume without re-explaining. Supersedes `RefBoard-Handoff-1.1.1.md` and carries forward these unchanged primitives from it and the earlier architecture brief: renderer = single-file `index.html` executed by `<script type="module">`; Electron host = `main.js` plus `preload.js` through `contextBridge`; board UI = hand-drawn `<canvas>`; `state.items` is discriminated by `kind`; decoded/source image records live in the global `images` `Map`; notes persist Markdown in `it.text`; the active note editor is a `contenteditable` DOM overlay; known bug classes include board-unit-at-zoom math, font-pixel floors, canvas/CSS baseline and alignment drift, stale module packaging, lifecycle overlap, and bitmap lifetime errors; shared behavior belongs in single-source helper modules with contract tests; memory work inherits the lazy-decode and decoded-bitmap demotion stage.

## Current shipped version

- Latest public release: `1.1.3`.
- Shipped identity: tag `v1.1.3` = `d9061cf19f5bef70ffb5297aaddd41599281db63`.
- Current repository identity: `main` = `origin/main` = `778bc789e0a118e41769911c4d7d18584cb726f4`; `main` is 21 commits ahead of `v1.1.3`, so `main` != shipped tag. `package.json` says `2.0.0`, but there is no `v2.0.0` tag or public 2.0.0 release.
- Git state at handoff creation: dirty. Modified: `.gitignore`, `README.md`, `index.html`, `scripts/animatics-timeline-model.mjs`, `scripts/animatics.mjs`, `scripts/test-animatics-contract.mjs`, `scripts/test-animatics-timeline-model.mjs`. Untracked feature work: `scripts/perf-overlay.mjs`, `scripts/stress-generate.mjs`. This handoff file is the only additional file created by the handoff task.
- Releases shipped since the 1.1.1 handoff: 2, `v1.1.2` and `v1.1.3`. Both GitHub releases are published, not drafts or prereleases, and each has the expected three updater assets.
- Public 1.1.3 installer coherence: confirmed. Published `RefBoard-Setup-1.1.3.exe` is `93,497,589` bytes; its computed SHA512 is `tTcM5W+6Mk/j9pJTEl9PYN0Gc4KMws4v6otM10TozC4QAhGosh0NrNSEu0So4D60orFP7a22P9IqRV+tNSM5FA==`, exactly matching the published `latest.yml`.
- Local artifact warning: `dist-release/RefBoard-Setup-1.1.3.exe` is a different `114,678,813` byte development build. Its local SHA512 `xWkQdJac87ju+9WHJ1QlQyED1ztIqqywXNt4LDUhkNubNUj9/EL6I/vQEh4zDf9dy/6pC28wKlzkvgV9gpUjBQ==` matches the local `dist-release/latest.yml`, but it is not the public 1.1.3 asset. Its embedded `package.json` still says `1.1.3` while its renderer already contains Animatics. `bootstrapper/payload/RefBoard-Setup.exe` is this same development binary. Delete and rebuild both artifact trees before any 2.0.0 ship.

## Release lineage

- `1.1.2` (`ea94ae9b0fa5b30be47702222581f3b524edb04e`) - Shipped disk-backed streamed board opening, image residency control, full-source cropped export with exact dimensions, drawing shortcuts and controls, normalize-by-width/height, ordered and template-based image exports, safer thumbnails, landing black-block fix, note cursor cleanup, and extreme-zoom group fixes. Work was committed directly on `main`; there was no feature-branch merge for this release.
- `1.1.3` (`d9061cf19f5bef70ffb5297aaddd41599281db63`) - Shipped stable zoom-tier image rendering, demand-based full/proxy selection, prewarming, and smoother quality transitions without visible popping. `codex/smooth-image-transitions` was merged into `main` with `--ff-only` at `8852155a88026ea6e77cd49a9947c030bb4c0417`, then the release metadata commit was made on `main`.
- `2.0.0` development snapshot (`778bc789e0a118e41769911c4d7d18584cb726f4` plus the dirty worktree listed above) - Not shipped. Adds the Animatics workspace and persistence inside `.refboard`; image, video, text, and audio timeline content; multi-track selection, marquee, clipboard, linking, trim, razor split, snap, overwrite, gap close, history, track resize/reorder/visibility/lock/mute/solo, In/Out and fixed/automatic sequence duration; inline text and drawing overlays; audio trim, gain, fades, curves, waveforms, and preview mute; preview pan/zoom/fit/lock, aspect, quality, counter, frame stepping, and transform preservation; MP4/H.264 plus audio through bundled `ffmpeg-static`; Premiere Pro XML with collected source media; After Effects JSX project builder with collected media; Board Save As; six themes; Classic Grid and Focus Flow home layouts; Floating Compact and Always Visible toolbars; structured What's New with persistent Settings access; cinematic installer UI and Electron bootstrapper; installer artwork; square thumbnails; and current uncommitted performance work for timeline virtualization, scrub proxies, compositor-based drag ghosts, a dev-only performance HUD, and generated stress boards. All post-1.1.3 tracked commits were made directly on `main`; no 2.0 feature branch was merged.

## New runtime modules added

### RefBoard product runtime

- `scripts/board-open-stream.js` - Main-side scanner and random-access reader for streamed `.refboard` core, preview, and image records.
- `scripts/shell-integration.js` - Main-side testable predicate for detecting a genuinely installed Windows build before shell integration behavior.
- `scripts/export-order.mjs` - Renderer helper for visual/selection ordering, export selection reconciliation, padded numbering, and safe final filenames.
- `scripts/image-residency.mjs` - Renderer controller for decoded-image admission, touch tracking, and demotion under a pixel budget.
- `scripts/image-render-demand.mjs` - Renderer policy for proxy/full render tiers, screen demand, navigation prewarm, and focus transition timing.
- `scripts/animatics-timeline-model.mjs` - Renderer-pure timeline operations: selection, snapping, tracks, gaps, clipboard, links, split/overwrite, waveform reduction, history, and the dirty-worktree clip virtualization helpers.
- `scripts/animatics-visual-transform.mjs` - Renderer-pure normalization and framing math that carries board crop/flip/rotation into Animatics and exports.
- `scripts/animatics-audio-model.mjs` - Renderer-pure dB/gain conversion, fade curves, envelopes, and waveform display math.
- `scripts/animatics-premiere-export.mjs` - Renderer-pure Premiere timeline model and Final Cut Pro XML generation.
- `scripts/animatics-after-effects-export.mjs` - Renderer-pure After Effects project model and JSX builder generation.
- `scripts/animatics.mjs` - Renderer Animatics workspace, UI, timeline interaction, preview, persistence adapter, media collection, and export orchestration.
- `scripts/perf-overlay.mjs` - Untracked renderer-only development HUD for FPS, paint time, JS heap, and board/Animatics counts; refuses to enable in packaged builds.

### Installer and bootstrapper runtime

- `build/installer-ui/app.js` - Browser-safe cinematic five-scene installer reel and staged install progress UI; uses `window.RefBoardInstaller` when hosted.
- `bootstrapper/main.js` - Separate Electron main process that hosts the reel, runs bundled `RefBoard-Setup.exe /S`, waits for its real exit, launches installed RefBoard, and owns frameless window controls.
- `bootstrapper/preload.js` - Separate context-isolated `RefBoardInstaller` bridge exposing `start`, `onComplete`, `launch`, `minimize`, and `close`.
- `bootstrapper/sync-ui.js` - Build-time copier from `build/installer-ui/` into ignored `bootstrapper/ui/`, keeping the visual source single-sourced.

### Development-only runtime and tooling

- `scripts/serve-installer-preview.mjs` - Local HTTP server for previewing the cinematic installer UI.
- `scripts/stress-generate.mjs` - Untracked generator for real large `.refboard` stress fixtures with mixed board images and embedded Animatics clips, text, audio, and huge sources.

### Full renderer import list in `index.html`

- `./scripts/note-dom.mjs`
- `./scripts/clipboard-copy-order.mjs`
- `./scripts/navigation-guards.mjs`
- `./scripts/image-residency.mjs`
- `./scripts/image-render-demand.mjs`
- `./scripts/export-order.mjs`
- `./scripts/animatics.mjs`
- `./scripts/perf-overlay.mjs`

Build assertion: passing on `codex/predist-hardening`. All eight direct renderer imports and the tracked transitive Animatics imports are covered by `package.json > build.files`, including `scripts/perf-overlay.mjs`. `scripts/check-build-files.mjs` now recursively resolves local static and dynamic imports, evaluates real glob coverage, prints each uncovered module, and exits nonzero. It is wired directly into both `npm test` and `predist`. Positive guard run exited `0`; temporarily removing `scripts/note-dom.mjs` from `build.files` produced a clear per-file failure and exited `1`, then the entry was restored.

## Test suite

- `npm test` command count: 29, the build-files guard plus the existing 28 suites. All 29 are explicitly chained in `package.json` and passed on the dirty 2.0.0 worktree on 2026-07-19.
- `scripts/check-build-files.mjs`
- `scripts/test-group-model.mjs`
- `scripts/test-group-marquee-selection.mjs`
- `scripts/test-export-order.mjs`
- `scripts/test-shell-integration.mjs`
- `scripts/test-thumbnail-preview.mjs`
- `scripts/test-landing-layout.mjs`
- `scripts/test-toolbar-mode.mjs`
- `scripts/test-theme-system.mjs`
- `scripts/test-draw-panel-contract.mjs`
- `scripts/test-selection-tools-contract.mjs`
- `scripts/test-note-roundtrip.mjs`
- `scripts/test-note-parsers.mjs`
- `scripts/test-image-decode-queue.mjs`
- `scripts/test-image-residency.mjs`
- `scripts/test-image-render-stability.mjs`
- `scripts/test-cropped-export.mjs`
- `scripts/test-clipboard-copy-order.mjs`
- `scripts/test-board-save-format.mjs`
- `scripts/test-board-save-as-contract.mjs`
- `scripts/test-board-open-stream.mjs`
- `scripts/test-navigation-guards.mjs`
- `scripts/test-animatics-timeline-model.mjs`
- `scripts/test-animatics-visual-transform.mjs`
- `scripts/test-animatics-audio-model.mjs`
- `scripts/test-animatics-premiere-export.mjs`
- `scripts/test-animatics-after-effects-export.mjs`
- `scripts/test-animatics-contract.mjs`
- `scripts/test-changelog-format.mjs`

Separate Electron smoke suites are not wired into `npm test` and must be run explicitly. All seven passed at this handoff:

- `scripts/smoke-animatics-transform.mjs`
- `scripts/smoke-animatics-sequence.mjs`
- `scripts/smoke-animatics-linked-drag.mjs`
- `scripts/smoke-animatics-track-controls.mjs`
- `scripts/smoke-animatics-audio-workflow.mjs`
- `scripts/smoke-theme-system.mjs`
- `scripts/smoke-landing-layout.js`

Exact commands:

```powershell
npm test
npm run test:animatics-smoke
npm run test:theme-smoke
npm run test:landing-smoke
```

## ⚠️ Verification debt

- No current 2.0.0 package exists. The existing `dist-release` inner installer is a mislabeled 1.1.3-metadata development build, and the existing bootstrapper wraps it. Neither is releasable.
- The current dirty worktree has not been packaged. Runtime module coverage now passes through `scripts/check-build-files.mjs` in both `npm test` and `predist`, but a fresh packaged and installed 2.0.0 build is still required to validate the asar and Electron runtime.
- No fresh install, 1.1.3-to-2.0 auto-update, uninstall/reinstall, file-association, Explorer-thumbnail, first-run What's New, or persisted-settings migration test has been performed against a clean 2.0.0 installer.
- The bootstrapper has a built `bootstrapper/dist-installer/RefBoard-Installer-1.0.0.exe`, but there is no evidence of a clean end-to-end test with a correctly versioned 2.0 payload. Its progress is timed to 94 percent and only completion is tied to the NSIS child exit. Launch uses guessed install paths.
- MP4 export has not been verified end-to-end from the packaged app with representative stills, video, audio, transforms, drawings, text, In/Out, 24/30/60 fps, and all aspect ratios. Failure modes include missing unpacked `ffmpeg.exe`, temp-frame disk exhaustion, audio desync, incorrect range endpoints, or an export that never finishes.
- Premiere and After Effects tests validate generated XML/JSX structure, not import into actual current Adobe applications. Failure modes include media relink prompts, wrong transforms, wrong track order, unsupported text properties, incorrect audio envelopes, or JSX that does not create the expected `.aep`.
- The newest uncommitted performance changes are the highest interaction risk: clip virtualization, scrub-proxy caching/eviction, playhead layout caching, and transform-only drag ghosts. Likely failures are clips disappearing while scrolling, stale thumbnails/waveforms, dropped selection during drag, incorrect target tracks, blurred or stale preview frames, leaked `ImageBitmap`s, or a proxy remaining after scrub settle.
- Large stress fixtures exist, but no controlled baseline, memory ceiling, FPS target, or before/after result is recorded. The performance HUD is diagnostic only.
- Structured What's New release-note rendering is fixed in `scripts/ship-release.ps1`. `-DryRun` renders the current version to Markdown and returns before authentication, artifact checks, or any `gh` call. The 2.0.0 dry run exited `0` and contained a headline, summary, titled groups, and readable bullets with no `@{headline=...}` leakage.
- Highest-risk tracked modules: `scripts/animatics.mjs`, `main.js`, `preload.js`, `scripts/animatics-timeline-model.mjs`, `scripts/animatics-premiere-export.mjs`, `scripts/animatics-after-effects-export.mjs`, `scripts/board-open-stream.js`, `scripts/image-residency.mjs`, `scripts/image-render-demand.mjs`, and the save/open code in `index.html`.
- First suspects by symptom: blank app -> `index.html` imports and `package.json > build.files`, especially `scripts/perf-overlay.mjs`; missing or corrupt board media -> `scripts/board-open-stream.js`, `scripts/board-save-format.js`, main save/open IPC, and Animatics media refs; timeline interaction -> `scripts/animatics.mjs` then `scripts/animatics-timeline-model.mjs`; MP4 failure -> main export IPC and `ffmpeg-static` unpacking; Adobe mismatch -> the matching exporter module plus main asset writer; theme/home/toolbar regression -> `index.html`; bootstrap/install regression -> `bootstrapper/main.js`, `bootstrapper/preload.js`, `build/installer-ui/app.js`, and `bootstrapper/sync-ui.js`.
- Bisect tracked 2.0 regressions across `d9061cf19f5bef70ffb5297aaddd41599281db63..778bc789e0a118e41769911c4d7d18584cb726f4`. Before bisecting, test `778bc789e0a118e41769911c4d7d18584cb726f4` with the dirty worktree reverted or stashed safely, because current performance changes are not committed. For shipped-only regressions, use `69a0d5e25551fc3a2bc40a042b3eaff48c19106d..ea94ae9b0fa5b30be47702222581f3b524edb04e` for 1.1.2 and `ea94ae9b0fa5b30be47702222581f3b524edb04e..d9061cf19f5bef70ffb5297aaddd41599281db63` for 1.1.3.

## Process rules reinforced this session

1. `Edited + npm test green` does not prove the edit landed. Read every changed file back and search for a unique new token before build. `node --check` and tests can succeed against old code.
2. Avoid fragile PowerShell whole-block string replacement. Anchor on one unique line, assert exactly one match, use `apply_patch` for source edits, then verify the resulting text.
3. JSON must be UTF-8 without BOM. PowerShell 5.1 `Set-Content -Encoding utf8` can add a BOM and break `JSON.parse` or make sync scripts silently skip work.
4. `asar extract-file` CLI output can be a false negative. Use the Node API, for example `require('@electron/asar').extractFile(asarPath, 'main.js')`, and inspect the exact packaged bytes and module list.
5. A fresh install only tests current-version What's New. Test the updater path by closing RefBoard, seeding `%APPDATA%\RefBoard\whats-new.json` with `{ "lastSeenVersion": "1.0.5" }`, then launching the installed build.
6. Only the real installed executable tells the truth. Always install-test the actual generated `.exe`; unpacked dev mode and green tests do not validate NSIS, updater assets, shell registration, or asar contents.
7. Delete stale draft releases and stale artifact directories before re-shipping. Do not trust `--clobber` or an old `dist-release` directory to distinguish the intended build.
8. Every renderer import, including transitive imports, must be present in `package.json > build.files`. `scripts/check-build-files.mjs` now enforces this in `npm test` and `predist`; keep the guard green and still inspect the release asar.
9. RefBoard 2.0 now has two installers. Build and verify the inner NSIS updater artifact first, copy that exact verified binary into `bootstrapper/payload/RefBoard-Setup.exe`, then build and test the outer bootstrapper. Record both versions and hashes.
10. The outer bootstrapper is an optional user-facing release asset, not a replacement for `latest.yml`, `RefBoard-Setup-2.0.0.exe`, and its blockmap. Existing installed clients require the three updater assets.
11. `scripts/publish-local-dist.ps1 -ReplaceAssets` deletes release assets outside its three-name allowlist. If the bootstrapper is a fourth asset, upload it after `npm run release:ship` or update the script to preserve and validate it.
12. Structured changelog data requires structured release-note generation. Run `powershell -File scripts/ship-release.ps1 -DryRun` and inspect its Markdown before creating or editing a GitHub release; DryRun must remain free of `gh` calls.
13. Performance work needs a recorded fixture, device, before/after measurement, and acceptance threshold. A HUD or subjective smoothness check is not a benchmark.
14. Commit release candidates before building them, then build from a clean `main` whose exact commit will receive the tag. Do not ship a dirty worktree or a binary whose embedded version differs from its filename.

## Known/cosmetic issues

- Center and right note alignment can drift by 1 to 2 pixels because canvas `measureText` and CSS `text-align` do not produce identical placement. Proper fix: share line metrics and explicit x positions between the canvas renderer and the DOM editor.
- Numbers are flush-left while bullets are inset, so mixed-list markers do not share one left edge. Proper fix: define one marker-column layout in `note-dom.mjs` and use the same metrics in canvas note drawing.
- ChatGPT numbered lists paste as bullets because the clipboard path often supplies no `<ol>`. Proper fix: add conservative ordered-list inference from plain text without corrupting ordinary numbered prose.
- The bootstrapper progress bar is staged animation, not byte-level NSIS progress, and waits at 94 percent for the child process. Proper fix: expose native installer phase/progress events through a controlled IPC protocol.
- The bootstrapper guesses `%LOCALAPPDATA%\Programs\RefBoard\RefBoard.exe` and `%ProgramFiles%\RefBoard\RefBoard.exe` when launching. Proper fix: have the installer write or return the authoritative installed executable path.
- Both the outer bootstrapper and inner NSIS setup are unsigned, so Windows SmartScreen can warn twice. Proper fix: Authenticode-sign both binaries with the same trusted certificate and timestamp service.

## Open backlog

### Infra/cleanup

- [x] Added `scripts/check-build-files.mjs`, a recursive static/dynamic local import validator with glob-aware `build.files` coverage, and wired it into `npm test` and `predist` in `c3d6a6f`.
- [x] Added `scripts/perf-overlay.mjs` to `build.files` without disturbing adjacent entries in `55ffd6a`.
- [x] Fixed structured `headline`, `summary`, and section rendering in `scripts/ship-release.ps1`; added a no-network `-DryRun` path in `7cfd6a9`.
- [ ] Wire `npm run build:thumb-handler` into `predist` or another deterministic release build step when the DLL source changes.
- [ ] Extract `evaluateWhatsNew` from `main.js` into a pure helper and test cumulative aggregation, de-duplication, fresh installs, skipped versions, and structured entries.
- [ ] Remove or deliberately retain the semantically duplicated 1.0.6/1.1.0 icon and Explorer-preview changelog content, then re-test aggregation.
- [ ] Commit the current `.gitignore` additions for `stress-out/` and `stress-out-smoke/` with the performance tooling.
- [ ] Decide whether the public bootstrapper version follows RefBoard (`2.0.0`) or has an independent version (`1.0.0`), then make filenames, UI, payload validation, and release notes unambiguous.
- [ ] Add bootstrapper build validation that reads the inner asar version, checks it equals the intended RefBoard version, and records the payload SHA512.
- [ ] Update `scripts/publish-local-dist.ps1` if the bootstrapper should survive `-ReplaceAssets`; otherwise keep the required upload-after-ship ordering.

### Animatics/2.0.0

- [ ] Finish, review, and commit timeline virtualization, scrub proxies, drag transforms, the performance overlay, stress generator, and their tests.
- [ ] Generate controlled stress results for board and Animatics workloads, including peak memory, steady-state FPS, worst paint time, proxy eviction, and close/reopen cleanup.
- [ ] Package a clean 2.0.0 inner installer and verify MP4 export with `ffmpeg-static` from the installed app.
- [ ] Import real exported timelines into supported Premiere Pro 2025/2026 and After Effects versions; verify transforms, text, drawing overlays, track order, audio fades, and media relinking.
- [ ] Build the bootstrapper with the exact verified 2.0.0 inner installer, then test install, failure, retry, completion hold, launch, close, uninstall, and reinstall.
- [ ] Verify backward-compatible opening and saving of pre-Animatics boards, and confirm 2.0 boards retain Animatics audio/video media across Save, Save As, reopen, and auto-save.
- [ ] Verify all six themes, both home layouts, both toolbar modes, settings persistence, What's New access, and responsive behavior on the real installed build.

### Bugs-need-repro

- [ ] Double-clicking a `.refboard` reportedly opens it but is "buggy". Capture exact steps, expected/actual behavior, logs, whether RefBoard was already running, whether the current board was dirty, and whether the target was already open. `onOpenBoardPath -> openBoardFromPath -> openBoardFromPathImpl -> openBoardPayloadFromDesktop -> applyBoardPayload` now handles `failed` and preserves `cancelled`, so do not guess without a repro.
- [ ] Capture any report of timeline clips disappearing or preview quality sticking with the generated stress board, then test the clean `778bc78` state before blaming the uncommitted virtualization/proxy work.

### Known/accepted-don't-chase

- [ ] Do not chase the 1 to 2 pixel note alignment drift without replacing the split canvas/CSS metric path.
- [ ] Do not normalize mixed bullet/number indentation with isolated magic offsets; fix the shared marker-column model.
- [ ] Do not force ordered-list paste when the clipboard contains no reliable ordered-list signal.
- [ ] Do not treat the bootstrapper's timed progress as real progress; it is accepted until native progress IPC is designed.
- [ ] Do not treat unsigned SmartScreen warnings as an app logic regression; signing both executables is the proper fix.

## Standard ship sequence

1. Start from a release branch and inspect the exact state:

   ```powershell
   git switch -c codex/release-2.0.0
   git status --short --branch
   git log -1 --format='%H %s'
   ```

   If that branch already exists, use `git switch codex/release-2.0.0`. Do not build from the current dirty worktree. Preserve and commit intended work; do not discard user changes.

2. Read back every edited source and verify unique new tokens. For the current work, at minimum:

   ```powershell
   rg -n "timelineVisibleTimeRange|SCRUB_PROXY_EDGE|initPerfOverlay" index.html scripts/animatics.mjs scripts/animatics-timeline-model.mjs scripts/perf-overlay.mjs
   ```

3. Set root `package.json` to `2.0.0`. Decide and set `bootstrapper/package.json` to the public bootstrapper version. Update `release-highlights.json` with structured New, Improved, and Fixed content using plain hyphens and UTF-8 without BOM.

4. Sync and verify changelog data:

   ```powershell
   node scripts/sync-changelog.mjs
   node scripts/test-changelog-format.mjs
   ```

5. Dry-run the structured release notes and verify the output is human-readable and is not `@{headline=...}` before allowing release creation:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\ship-release.ps1 -DryRun
   ```

6. Require the recursive renderer import guard to pass, then manually spot-check all eight direct imports and the transitive Animatics imports:

   ```powershell
   node scripts/check-build-files.mjs
   ```

7. Run all unit/contract and Electron smoke suites:

   ```powershell
   npm test
   npm run test:animatics-smoke
   npm run test:theme-smoke
   npm run test:landing-smoke
   ```

8. If `build/thumbnail-handler/RefBoardThumbnailHandler.cs` changed, rebuild and verify the DLL before committing:

   ```powershell
   npm run build:thumb-handler
   ```

9. Commit the release candidate, merge its branch into `main` with fast-forward only, push, and require a clean tree:

   ```powershell
   git add -A
   git diff --cached --check
   git diff --cached --stat
   git commit -m "release 2.0.0: Animatics and cinematic installer"
   git switch main
   git merge --ff-only codex/release-2.0.0
   git push origin main
   git status --short --branch
   ```

10. Remove only the two resolved artifact directories after verifying their exact paths equal the repository's `dist-release` and `bootstrapper/dist-installer`. Then rebuild the inner NSIS installer from clean `main`:

    ```powershell
    $repo = (Resolve-Path '.').Path
    $innerOut = Join-Path $repo 'dist-release'
    $outerOut = Join-Path $repo 'bootstrapper\dist-installer'
    if (([System.IO.Path]::GetFullPath($innerOut)) -ne (Join-Path $repo 'dist-release')) { throw 'Bad inner output path' }
    if (([System.IO.Path]::GetFullPath($outerOut)) -ne (Join-Path $repo 'bootstrapper\dist-installer')) { throw 'Bad outer output path' }
    if (Test-Path -LiteralPath $innerOut) { Remove-Item -LiteralPath $innerOut -Recurse -Force }
    if (Test-Path -LiteralPath $outerOut) { Remove-Item -LiteralPath $outerOut -Recurse -Force }
    npx electron-builder --win --config.directories.output=dist-release
    ```

11. Inspect the inner asar with the Node API. Confirm embedded version `2.0.0`, unique release tokens, every runtime module, and unpacked ffmpeg:

    ```powershell
    node -e "const a=require('@electron/asar'),p='dist-release/win-unpacked/resources/app.asar',pkg=JSON.parse(a.extractFile(p,'package.json')); const files=a.listPackage(p).map(x=>x.replace(/\\/g,'/')); const need=['/scripts/note-dom.mjs','/scripts/clipboard-copy-order.mjs','/scripts/navigation-guards.mjs','/scripts/image-residency.mjs','/scripts/image-render-demand.mjs','/scripts/export-order.mjs','/scripts/animatics.mjs','/scripts/animatics-timeline-model.mjs','/scripts/animatics-visual-transform.mjs','/scripts/animatics-audio-model.mjs','/scripts/animatics-premiere-export.mjs','/scripts/animatics-after-effects-export.mjs','/scripts/perf-overlay.mjs']; if(pkg.version!=='2.0.0')throw Error('embedded version '+pkg.version); for(const f of need)if(!files.includes(f))throw Error('missing '+f); console.log('asar runtime complete')"
    Test-Path 'dist-release\win-unpacked\resources\app.asar.unpacked\node_modules\ffmpeg-static\ffmpeg.exe'
    ```

12. Install and test the real inner `dist-release\RefBoard-Setup-2.0.0.exe`. Cover new/open/save/Save As/reopen, a 1.1.x board, a media-heavy 2.0 board, Animatics editing, MP4, Premiere, After Effects, themes, both home layouts, both toolbar modes, What's New, file association, Explorer thumbnail, close prompts, and auto-update initialization. Seed `%APPDATA%\RefBoard\whats-new.json` for the updater-path test.

13. Verify the inner `.exe` SHA512 against `dist-release/latest.yml` and record filename, size, hash, and clean Git commit. Do not accept filename/version coherence alone.

14. Copy only the verified inner installer into the bootstrapper payload, synchronize UI, and build the outer installer:

    ```powershell
    Copy-Item -LiteralPath 'dist-release\RefBoard-Setup-2.0.0.exe' -Destination 'bootstrapper\payload\RefBoard-Setup.exe' -Force
    Push-Location bootstrapper
    npm ci
    npm run dist
    Pop-Location
    ```

15. Verify the outer bootstrapper contains the same payload bytes, then run it on a clean test account or VM. Confirm the cinematic UI, window controls, real silent install, 94-percent hold, failure/retry, 100-percent completion, launch path, installed version `2.0.0`, uninstaller, and SmartScreen expectations.

16. Reconfirm root Git identity immediately before creating the release:

    ```powershell
    git status --short --branch
    git rev-parse HEAD
    git rev-parse origin/main
    ```

    Require a clean tree and identical hashes.

17. Delete any stale `v2.0.0` draft before re-shipping only after inspecting it, then create the draft and upload the three updater assets:

    ```powershell
    gh release view v2.0.0
    gh release delete v2.0.0 --yes
    npm run release:ship
    ```

    Skip the delete command when no stale draft exists. `release:ship` must point at `dist-release` and use exact `RefBoard-Setup-2.0.0.exe`, `.blockmap`, and `latest.yml` names.

18. Upload the verified outer bootstrapper as the optional fourth asset after the three-asset upload, unless the publishing script has first been updated to preserve it:

    ```powershell
    gh release upload v2.0.0 bootstrapper\dist-installer\RefBoard-Installer-2.0.0.exe --clobber
    ```

19. Inspect the draft asset names, sizes, and release notes. Download or stream the draft/public `latest.yml` and setup `.exe`, recompute SHA512, and require an exact match. Confirm the bootstrapper payload hash equals the verified inner setup hash.

20. Publish only after all checks pass:

    ```powershell
    gh release edit v2.0.0 --draft=false
    git fetch origin --tags
    git rev-parse HEAD
    git rev-parse origin/main
    git rev-parse v2.0.0
    ```

    Require `HEAD` = `origin/main` = `v2.0.0`, then verify an installed 1.1.3 client sees and installs the 2.0.0 update. Finish with `git status --short --branch` and retain the recorded hashes and verification notes.
