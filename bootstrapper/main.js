'use strict';

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');

// -----------------------------------------------------------------------------
// RefBoard cinematic bootstrapper
//
// Shows the build/installer-ui reel in a frameless window, then runs the real
// NSIS installer (RefBoard-Setup-<ver>.exe) silently underneath. The renderer
// (app.js) drives its own smooth timed progress bar; this process just tells it
// when the real install has actually finished so the bar can snap to 100%.
//
// The packaged NSIS setup is bundled as an extraResource at:
//   process.resourcesPath/RefBoard-Setup.exe   (packaged)
//   ./payload/RefBoard-Setup.exe                (dev, if you drop one there)
// -----------------------------------------------------------------------------

let win = null;

// Where the reel lives. In the packaged bootstrapper we copy installer-ui into
// the app root as ./ui. In dev we point straight at the repo's build/installer-ui.
function resolveUiIndex() {
  const packaged = path.join(__dirname, 'ui', 'index.html');
  if (fs.existsSync(packaged)) return packaged;
  // dev fallback: repo build/installer-ui (two levels up from bootstrapper/)
  const dev = path.join(__dirname, '..', 'build', 'installer-ui', 'index.html');
  return dev;
}

// Locate the bundled real installer.
function resolveSetupExe() {
  const candidates = [
    path.join(process.resourcesPath || '', 'RefBoard-Setup.exe'),
    path.join(__dirname, 'payload', 'RefBoard-Setup.exe'),
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1120,
    height: 720,
    frame: false,
    resizable: false,
    show: false,
    backgroundColor: '#131419',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(resolveUiIndex());
  win.once('ready-to-show', () => win.show());
}

// -----------------------------------------------------------------------------
// Install orchestration
// -----------------------------------------------------------------------------

let installStarted = false;

function runSilentInstall() {
  return new Promise((resolve) => {
    const setup = resolveSetupExe();

    if (!setup) {
      // No bundled installer found — resolve as a soft failure so the UI can
      // still complete its animation in dev/preview without a real payload.
      resolve({ ok: false, reason: 'setup-not-found' });
      return;
    }

    // NSIS silent switches: /S = silent. electron-builder NSIS also supports
    // --allusers / --currentuser; we let it use its configured default (perMachine:false).
    let child;
    try {
      child = spawn(setup, ['/S'], { windowsHide: true });
    } catch (err) {
      resolve({ ok: false, reason: 'spawn-failed', error: String(err) });
      return;
    }

    child.on('error', (err) => {
      resolve({ ok: false, reason: 'process-error', error: String(err) });
    });

    child.on('exit', (code) => {
      resolve({ ok: code === 0, code });
    });
  });
}

// The renderer calls this when the user clicks Install. We kick off the real
// install and, when it truly finishes, notify the renderer so its bar can
// resolve to 100% and flip to "Launch". The renderer owns the timed animation;
// we own the truth about completion.
ipcMain.handle('installer:start', async () => {
  if (installStarted) return { alreadyRunning: true };
  installStarted = true;

  const result = await runSilentInstall();

  if (win && !win.isDestroyed()) {
    win.webContents.send('installer:complete', result);
  }
  return result;
});

// Launch the freshly installed RefBoard, then quit the bootstrapper.
ipcMain.handle('installer:launch', async () => {
  // Per-user install path used by electron-builder NSIS (perMachine:false).
  const localAppData = process.env.LOCALAPPDATA || '';
  const guesses = [
    path.join(localAppData, 'Programs', 'RefBoard', 'RefBoard.exe'),
    path.join(process.env.ProgramFiles || '', 'RefBoard', 'RefBoard.exe'),
  ];
  const exe = guesses.find((p) => p && fs.existsSync(p));

  if (exe) {
    spawn(exe, [], { detached: true, stdio: 'ignore' }).unref();
  } else if (localAppData) {
    // Fallback: open the Programs folder so the user can find it.
    shell.openPath(path.join(localAppData, 'Programs', 'RefBoard'));
  }

  setTimeout(() => app.quit(), 400);
  return { launched: Boolean(exe) };
});

// Window chrome controls (your app.js calls minimize / close).
ipcMain.on('window:minimize', () => win && win.minimize());
ipcMain.on('window:close', () => app.quit());

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
