# Maintaining RefBoard

[Back to RefBoard](../README.md)

Commands in this guide run from the repository root on Windows. Release builds check GitHub Releases on startup by default and download updates automatically. Development builds do not auto-update.

## Shipping a new version

1. Edit the app (`index.html`, etc.).
2. Bump `"version"` to the same number in **both** `package.json` and
   `bootstrapper/package.json`.

   The bootstrapper names its output from its *own* version
   (`artifactName: RefBoard-Installer-${version}.exe`), while `release:ship` reads the
   root version and looks for `RefBoard-Installer-<root version>.exe`. Leave the two
   apart and step 5 builds the installer under the old name, `release:ship` cannot find
   it, and the release ships with no installer at all. That is a **warning, not an
   error** — the upload succeeds and the missing installer is easy to miss.
3. Replace the contents of `release-highlights.json` with the release headline, summary, and categorized changes. Use this format every time:

```json
{
  "headline": "A short release headline",
  "summary": "One sentence explaining the update.",
  "sections": {
    "new": [
      {
        "title": "Feature name",
        "description": "What it lets people do."
      }
    ],
    "improved": [
      {
        "title": "Improvement name",
        "description": "What now feels better."
      }
    ],
    "fixed": [
      {
        "title": "Bug that was fixed",
        "description": "What now works correctly."
      }
    ]
  }
}
```

   Keep unused sections as empty arrays (`[]`). Do not add labels such as `"Bug fixes:"` as list items—the modal creates the New, Improved, and Fixed headings automatically. `npm run dist` / `sync-changelog.mjs` copies this release into `changelog.json` for the in-app What's New screen.

   You can also collect a change from a git commit. The text before `|` becomes the title and the text after it becomes the description:

```powershell
git commit -m "[highlight:new] Feature name | What it lets people do."
git commit -m "[highlight:improved] Improvement name | What now feels better."
git commit -m "[highlight:fixed] Bug name | What now works correctly."
```
4. Build the installer into `dist/`:

```powershell
npm run dist
```

   That runs `predist` first: `npm test`, then `sync-changelog.mjs`, which copies
   `release-highlights.json` into `changelog.json`. If you call `electron-builder`
   directly instead, run `node scripts/sync-changelog.mjs` yourself — `predist`
   will not fire. Do not redirect the output elsewhere: `release:ship` reads
   `dist`, and the bootstrapper writes to `dist/bootstrapper`, so a different
   output directory splits the two artifacts apart.

   `dist/` keeps older builds and `latest.yml` is not version-stamped, so check
   that the feed describes the version you just built:

```powershell
Get-Content dist\latest.yml -TotalCount 1
```
5. Refresh the bootstrapper payload and build it. **Do not skip this on a new
   version** — step 6 will not do it for you, and says so only in a warning
   (see the trap below). This needs
   `bootstrapper/package.json` already bumped in step 2, or the output carries the
   previous version's name. `release:ship` uploads `RefBoard-Installer-<ver>.exe`
   alongside the setup, and the payload does not update itself — a stale one ships
   the previous version inside a correctly named installer:

```powershell
Copy-Item dist\RefBoard-Setup-2.0.9.exe bootstrapper\payload\RefBoard-Setup.exe -Force
Push-Location bootstrapper; npm run dist; Pop-Location
```

   (Use your own version.) Output: `dist\bootstrapper\RefBoard-Installer-<ver>.exe`.
   Confirm the payload matches the setup you just built:

```powershell
(Get-FileHash dist\RefBoard-Setup-2.0.9.exe).Hash -eq (Get-FileHash bootstrapper\payload\RefBoard-Setup.exe).Hash
```
6. Create a **draft** GitHub release and upload auto-update assets (`latest.yml`, setup `.exe`, `.blockmap`):

```powershell
npm run release:ship
```

   `release:ship` checks that the bootstrapper wraps the setup in `dist/`, and
   refreshes the payload and rebuilds it when it does not. It re-checks the
   hash after rebuilding and uploads nothing if it still disagrees. Pass
   `-NoBootstrapperRebuild` to make a stale payload an error instead of a
   rebuild, or `-SkipPayloadCheck` to skip the whole thing when re-uploading
   assets for a release whose installer you deliberately are not touching.

   **The trap: that rebuild only fires when `RefBoard-Installer-<ver>.exe`
   already exists.** The artifact name is version-stamped, so on a version you
   have not built the bootstrapper for, it never does. `Sync-BootstrapperPayload`
   warns and returns instead:

```
WARNING: No RefBoard-Installer-2.0.11.exe built - the bootstrapper will be skipped.
```

   The other three assets upload, the script prints `Draft release is ready`, and
   it **exits 0**. Nothing fails. The release just quietly carries no installer —
   which is what happened cutting 2.0.11 in one pass, with both versions
   correctly bumped. Step 5 is not optional; a re-run of `release:ship` after
   building the bootstrapper fixes it, because assets upload with `--clobber`.

   Requires `gh auth login` (repo scope).
7. Check the draft before you publish it. Confirm it carries **four** assets:

```powershell
gh release view v2.0.11 --json assets -q '[.assets[].name]'
```

   Expect `latest.yml`, `RefBoard-Setup-<ver>.exe`, `RefBoard-Setup-<ver>.exe.blockmap`
   and `RefBoard-Installer-<ver>.exe`. Three means the bootstrapper was skipped.

   Then **install it and launch it.** The suite and CI run against the repo, where
   every file is present; only the packaged asar can be missing one. RefBoard
   2.0.11 shipped with `scripts/recent-works.js` left out of `build.files` and
   died on startup with `Cannot find module './scripts/recent-works'` — 50 green
   checks, green CI, verified asset hashes, and an app that could not open.
   `npm test` now walks `main.js` and `preload.js` as well as `index.html`, and
   matches `require()` as well as `import`, so that particular hole is closed.
   Launching the build is still the only thing that proves it runs.
8. Publish, so installed apps can auto-update:

```powershell
gh release edit v1.0.3 --draft=false
```

   (Use your new version tag, e.g. `v1.1.0`.) Do **not** ship by pushing a `v*` tag — the Actions release workflow is unreliable and can break auto-update.

   If you publish something broken, pull `latest.yml` off the release first — that
   stops auto-update resolving it at all, and clients stay where they are while
   you build the fix. It is reversible; the file is still in your `dist\`:

```powershell
gh release delete-asset v2.0.11 latest.yml --yes
```

## Development reference

- **Share via GitHub Releases** — link users to the latest `RefBoard-Setup-x.x.x.exe` on your repo’s Releases page.
- **Run without installing:** `dist\win-unpacked\RefBoard.exe` after `npm run dist`
- **Dev mode:** `npm start` (no auto-update in dev builds)

### Performance overlay (dev only)

Live FPS / frame-time / JS heap / item counts HUD for stress-testing. **Default OFF.** Inert in packaged (installed) builds — it cannot appear in production even if toggled.

**Enable** (unpackaged / `npm start` only):

| Method | How |
|--------|-----|
| Keyboard | `Ctrl+Shift+F12` (toggle) |
| Console | `window.__PERF_OVERLAY__ = true` |
| URL | `?perf=1` or `#perf` (if the window URL includes them) |

**Disable:** `Ctrl+Shift+F12` again, or `window.__PERF_OVERLAY__ = false`.

When off, no overlay rAF runs. Implementation: `scripts/perf-overlay.mjs`.

### Rebuilding after changing the app

The renderer lives in `index.html`, with supporting modules in `scripts/` and
Electron integration in `main.js` and `preload.js`. To rebuild after editing:

```
npm run dist
```

That produces a fresh setup installer in `dist\`. Follow the release steps above
to keep both package versions in sync and build the matching bootstrapper.

### Where the branding lives

- Installer welcome & finish pages: `build\installer.nsh`
- Installer sidebar art (164×314 BMP): `build\installerSidebar.bmp`
- License/about page shown during install: `build\license.txt`
- App icon: `build\icon.png`
- In-app: bottom-left corner credit + the `?` shortcuts panel footer (in `index.html`)
