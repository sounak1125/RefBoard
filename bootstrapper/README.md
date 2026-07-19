# RefBoard Cinematic Bootstrapper

Wraps your existing `build/installer-ui/` reel in a real windowed app that runs the
NSIS installer silently underneath. Produces `RefBoard-Installer-<ver>.exe` — the
single file users download and run. It shows the cinematic UI; the real install
happens invisibly behind it.

## How the pieces fit

    RefBoard-Installer-1.0.0.exe   (this bootstrapper — what users run)
        │  frameless window loads your installer-ui reel
        │  user clicks Install
        └─ runs bundled RefBoard-Setup-<ver>.exe /S   (your normal NSIS installer, silent)
               └─ real install happens; bar completes when it truly exits

Your NSIS installer is UNCHANGED. This wraps around whatever it produces.

## One-time setup

1. Drop these files into a `bootstrapper/` folder at the root of your RefBoard repo
   (next to package.json). Structure:

       RefBoard/
         build/installer-ui/     <- your existing reel (source of truth)
         bootstrapper/
           main.js
           preload.js
           package.json
           sync-ui.js
           README.md
           payload/              <- you create this; put the real setup here

2. Apply the two edits in APP-JS-CHANGES.md to build/installer-ui/app.js.

3. From bootstrapper/:  npm install

## Each time you build

1. Build your normal RefBoard NSIS installer as usual (from the repo root):

       npx electron-builder --win --config.directories.output=dist-release

2. Copy the produced setup into the bootstrapper payload, renamed generically:

       Copy-Item dist-release\RefBoard-Setup-1.1.3.exe bootstrapper\payload\RefBoard-Setup.exe

3. Build the bootstrapper (from bootstrapper/):

       npm run dist

   Output: bootstrapper/dist-installer/RefBoard-Installer-<ver>.exe

`npm run dist` auto-runs sync-ui.js, which copies build/installer-ui -> bootstrapper/ui
so the reel is always current. You never hand-copy the UI.

## Test without building (fast iteration on the UI)

From bootstrapper/:

    npm start

This opens the real frameless window with your reel. If you drop a real
payload/RefBoard-Setup.exe in first, clicking Install performs a genuine silent
install. With no payload, the bar animates and completes (dev/preview mode) so you
can check the look and flow.

## Known things to decide before public release

- CODE SIGNING. Both this bootstrapper and your NSIS setup are unsigned
  (signExecutable:false). Unsigned, Windows SmartScreen warns users on first run.
  Fine for testing; get a cert before wide release.
- The launch step guesses the install path (%LOCALAPPDATA%\Programs\RefBoard\
  RefBoard.exe for perMachine:false). If you change perMachine or install dir,
  update resolveSetupExe/launch guesses in main.js.
- Progress is a smooth timed bar that holds at 94% until the real process exits,
  then completes. It does not read true byte-level NSIS progress (NSIS /S doesn't
  expose it cleanly). This matches the "NVIDIA-like" feel you asked for.
- The bootstrapper version (package.json "version") is separate from RefBoard's
  version. Bump it when you change the bootstrapper itself.
