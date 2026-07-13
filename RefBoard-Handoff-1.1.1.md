# RefBoard — Handoff (post-1.1.1)

Paste into a new chat to resume without re-explaining. Supersedes the 1.1.0 brief;
carry forward the architecture / subsystem / gotcha sections from that doc unchanged
(notes, board-unit-at-zoom bugs, font-px floors, baseline, alignment, memory Stage 4).
This file only records what changed at 1.1.1 and what's still open.

---

## Current shipped version: 1.1.1 (published, live via auto-update)

- Git: `main` at `69a0d5e`, tag `v1.1.1`, pushed, clean. Tag == HEAD == origin/main.
- GitHub release published (not draft), 3 assets: `latest.yml`, `RefBoard-Setup-1.1.1.exe`, `.exe.blockmap`.
- Installer verified: SHA512 of shipped .exe matches `latest.yml` (coherent build).

## What shipped in 1.1.1

**Save / clipboard performance + safety**
- Saves stream images through main process (no giant JSON string built in renderer).
- Atomic writes: temp file first, previous board intact if save fails.
- Save previews render directly at 640/360 (no 8192px composites).
- Bounded 64 MB encode cache for unchanged images (fallback/browser saves).
- Single-flight saves; edits during a save stay marked unsaved.
- Single untouched PNG copy uses the original file directly.
- Multi-item clipboard composite capped at 4096px (~75% less peak canvas memory).
- Files: index.html, main.js, preload.js, scripts/board-save-format.js.

**Navigation / lifecycle**
- Reopening the already-open board reuses the decoded bitmap (no re-read/re-decode).
- Different-board opens release old bitmaps before decoding new ones.
- Save completion no longer waits on Recent Works thumbnail generation (background).
- Home/open ops queued (no overlap/drop); close prompts deduped.
- Close/Home saves time out after 2 min and keep the board open instead of hanging.
- File-dialog path checked before reading the large board file.
- Files: index.html, main.js, package.json, scripts/navigation-guards.mjs (+ test).

**Thumbnail double-R fix**
- Root cause: handler embedded a logo AND Explorer overlaid its own -> two R's.
- Fix: handler + composite output the board preview content-only; Explorer supplies
  the single lower-right R. RefBoardThumbnailHandler.cs, scripts/file-icon-composite.js.
- DLL rebuilt (`npm run build:thumb-handler` -> build/thumbnail-handler/bin/*.dll).
- Verified: single R on the installed build after resaving a board.

**Cumulative "What's New" (new in 1.1.1)**
- `evaluateWhatsNew` in main.js now aggregates highlights across every changelog
  version newer than `lastSeenVersion` (updaters), with de-duplication; fresh
  installs (lastSeen null) see the current version only.
- Modal CSS: `.wn-card` capped at `calc(100vh - var(--titlebar-h) - 40px)`, flex
  column; `.wn-highlights` scrolls with a styled scrollbar. Fixes the tall-list
  top-clipping when a 1.0.x user sees many versions at once.

---

## Process lessons from this session (IMPORTANT — add to permanent rules)

1. **"Edited + npm test green" does NOT mean the change landed.** A main.js edit
   silently failed to save TWICE this session; node --check and npm test passed
   anyway because they were running the OLD code. ALWAYS read the file back after
   an edit (`Select-String` for a unique token from the new code) BEFORE building.

2. **PowerShell here-string edits are fragile.** Whole-block string matches failed
   on trailing-whitespace / line-ending mismatches. Prefer anchoring on ONE unique
   line, assert match count == 1, write UTF-8 **without BOM**
   (`New-Object System.Text.UTF8Encoding($false)`), then verify.

3. **BOM breaks JSON.** `Set-Content -Encoding utf8` (PS 5.1) prepends a BOM that
   makes `JSON.parse` throw. sync-changelog silently read `{}` and skipped. Write
   JSON as UTF-8-no-BOM.

4. **`asar extract-file` CLI can print nothing (false negative).** Verify packaged
   asar contents via the Node API:
   `require('@electron/asar').extractFile(asarPath, 'main.js').includes(token)`.

5. **A fresh install can't test cumulative What's New.** It shows current-version-only
   under both old and new logic. To test the updater path, seed the store:
   `%APPDATA%\RefBoard\whats-new.json` = `{ "lastSeenVersion": "1.0.5" }` (app closed),
   then launch.

6. **Rule #7 still king:** only installing the real .exe told the truth. Install-test
   caught the single-R confirmation and the What's New dupe/sizing bug.

7. **Delete stale drafts before re-shipping.** `ship-release.ps1` creates a draft off
   an `untagged-*` ref; the git tag is only created on publish (un-draft). If a stale
   draft exists with same-named assets, `gh release delete v1.1.1 --yes` first, then
   re-ship — deterministic, vs trusting "removes old files first".

---

## changelog.json data note (cleanup candidate, not urgent)

- 1.0.6 and 1.1.0 both contain the identical two lines ("New app icon…",
  "RefBoard files now show a preview thumbnail…"). Harmless now that
  evaluateWhatsNew de-dupes, but the source data is redundant. Optional: trim 1.1.0's
  entry to only its NEW items. Don't do it without re-testing the aggregation.

---

## Open backlog

**Cleanup / infra**
- [ ] `predist` guard: fail build if any `<script type="module">` import isn't in
      `build.files` (prevents the 1.1.0 blank-page bug class). STILL OPEN.
- [ ] `ship-release.ps1`: confirm it matches `RefBoard-Setup-$version.exe` exactly,
      not a `*.exe` glob (stale-asset risk). Didn't bite this release but unverified.
- [ ] DLL rebuild is NOT wired into predist/dist. `build:thumb-handler` is standalone;
      you must run it manually before packaging or electron-builder ships whatever DLL
      is on disk. Consider adding it to predist.
- [ ] Extract `evaluateWhatsNew` pure logic into scripts/whats-new-eval.mjs, import
      into main.js, add test-whats-new.mjs to the `npm test` chain (matches the
      note-dom / navigation-guards pattern). Right now the aggregation+dedup logic
      has NO committed test — it was verified with throwaway harnesses only.

**Bugs (need a repro)**
- [ ] Double-clicking a `.refboard` opens it but is "buggy" — needs a specific repro.
      `onOpenBoardPath` -> `applyBoardPayload` returns `'ok'|'cancelled'|'failed'`;
      may not handle those returns.

**Known / accepted (don't chase)**
- Center/right note alignment drifts 1–2px (measureText vs CSS text-align).
- Numbers flush-left, bullets inset — different left edges in mixed lists.
- ChatGPT numbered lists paste as bullets (no `<ol>` reaches clipboard).

---

## Release process (unchanged, with the fixes above folded in)

1. Bump `package.json`.
2. Edit `release-highlights.json` — plain hyphens, NO em-dashes; write UTF-8 **no BOM**.
3. `node scripts/sync-changelog.mjs` (exits early if version already filled).
4. `npm test`.
5. **`npm run build:thumb-handler`** if the handler changed (NOT auto-run by dist).
6. `Remove-Item -Recurse -Force dist-release`.
7. `npx electron-builder --win --config.directories.output=dist-release`.
8. **Install and test the real .exe** (rule #7). For What's New updater path, seed
   whats-new.json as above.
9. Verify packaged asar has your changes (Node asar API, not CLI).
10. Commit all release files; delete any stale draft; `npm run release:ship`.
11. Verify draft assets (3, correct version); `gh release edit vX.Y.Z --draft=false`.
12. `git fetch --tags`; confirm tag == HEAD == origin/main.
