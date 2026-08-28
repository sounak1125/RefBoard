# RefBoard

A clean minimal moodboard & reference app for Windows. **Made by Sounak.**
Images are kept in original quality, stored only on your own PC.

## GitHub & auto-updates

Installed RefBoard apps **check GitHub Releases on startup** and download updates automatically.
When you ship a new version, users get a toast: *"Update ready — restart RefBoard to install"*.

### One-time GitHub setup

1. Create a repo on GitHub named **RefBoard** (or rename `owner` / `repo` in `package.json` → `build.publish`).
2. In this folder, run:

```bash
git init
git add .
git commit -m "Initial RefBoard release"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/RefBoard.git
git push -u origin main
```

3. Create the first release (builds the installer and uploads it):

Follow **Shipping a new version** below (build into `dist/`, then `npm run release:ship`, then publish the draft).
Do not create releases by pushing a `v*` tag — that Actions path is unreliable.

### Shipping a new version

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
5. Refresh the bootstrapper payload and build it. This needs
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
   refreshes the payload and rebuilds it when it does not — so step 5 is only
   needed when you want the installer built before this point. It re-checks the
   hash after rebuilding and uploads nothing if it still disagrees. Pass
   `-NoBootstrapperRebuild` to make a stale payload an error instead of a
   rebuild, or `-SkipPayloadCheck` to skip the whole thing when re-uploading
   assets for a release whose installer you deliberately are not touching.

   Requires `gh auth login` (repo scope). Review the draft on GitHub, then publish it so installed apps can auto-update:

```powershell
gh release edit v1.0.3 --draft=false
```

   (Use your new version tag, e.g. `v1.1.0`.) Do **not** ship by pushing a `v*` tag — the Actions release workflow is unreliable and can break auto-update.

## For you (Sounak)

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

All the app logic lives in `index.html`. After editing it:

```
npm run dist
```

That produces a fresh installer in `dist\`. Bump `"version"` in `package.json` before tagging a release.

### Where the branding lives

- Installer welcome & finish pages: `build\installer.nsh`
- Installer sidebar art (164×314 BMP): `build\installerSidebar.bmp`
- License/about page shown during install: `build\license.txt`
- App icon: `build\icon.png`
- In-app: bottom-left corner credit + the `?` shortcuts panel footer (in `index.html`)

## For people installing it

Download **RefBoard-Setup-x.x.x.exe** from [GitHub Releases](https://github.com/sounak1125/RefBoard/releases) and run it.
Because the app isn't code-signed (certificates cost money), Windows SmartScreen may show
"Windows protected your PC" — click **More info → Run anyway**. That's normal
for free community apps.

Keep the app installed from a **release build** (not a raw zip) so auto-update works.

## Features

- **Paste** images with `Ctrl+V` from anywhere — web, Photoshop, screenshots, Explorer
- **Drag & drop** files or images straight from web pages (multi-drop packs in a square grid)
- **Original quality always** — exact original bytes stored, never recompressed
- **Copy back out** with `Ctrl+C` at full resolution (multi-select = one combined image)
- **Arrange**: drag, corner-resize (aspect locked), `P` auto-packs a tidy grid
- **Navigate**: wheel zoom at cursor, middle/right/space/Alt drag to pan, `F` fit
- **Always on top** with `Ctrl+T` — pin it over your painting app, PureRef style
- **Settings** (right-click → Settings & tools): rotate, crop, flip, grayscale, notes, snapping, eyedropper
- **Export** board as PNG (1×/2×/4×, transparent/dark/white) or the exact original files
- **Save/share** whole boards as a single `.refboard` file with originals embedded
- Auto-saves continuously; undo/redo; multi-select; right-click menu; press `?` for all shortcuts
- **Auto-update** from GitHub Releases when a new version is published

## Tech

Single-file HTML5/JavaScript app (no frameworks), packaged as a Windows app
with Electron + electron-builder (NSIS installer). Boards persist in IndexedDB
under `%AppData%\RefBoard`.
