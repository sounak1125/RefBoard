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

Follow **Shipping a new version** below (build into `dist-release`, then `npm run release:ship`, then publish the draft).
Do not create releases by pushing a `v*` tag — that Actions path is unreliable.

### Shipping a new version

1. Edit the app (`index.html`, etc.).
2. Bump `"version"` in `package.json` (e.g. `1.0.0` → `1.1.0`).
3. Put user-facing bullets in `release-highlights.json` (the `highlights` array).
   `npm run dist` / `sync-changelog.mjs` copies them into `changelog.json` for in-app What's New.
4. Build the installer into `dist-release` (not the default `dist/`):

```powershell
npx electron-builder --win --config.directories.output=dist-release
```

   Or run `node scripts/sync-changelog.mjs` first if you skip `npm run dist` (that command does not run `predist`).
5. Create a **draft** GitHub release and upload auto-update assets (`latest.yml`, setup `.exe`, `.blockmap`):

```powershell
npm run release:ship
```

   Requires `gh auth login` (repo scope). Review the draft on GitHub, then publish it so installed apps can auto-update:

```powershell
gh release edit v1.0.3 --draft=false
```

   (Use your new version tag, e.g. `v1.1.0`.) Do **not** ship by pushing a `v*` tag — the Actions release workflow is unreliable and can break auto-update.

## For you (Sounak)

- **Share via GitHub Releases** — link users to the latest `RefBoard-Setup-x.x.x.exe` on your repo’s Releases page.
- **Run without installing:** `dist\win-unpacked\RefBoard.exe` after `npm run dist`
- **Dev mode:** `npm start` (no auto-update in dev builds)

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
