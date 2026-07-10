'use strict';
const { app, BrowserWindow, Menu, ipcMain, dialog, clipboard, shell, nativeImage } = require('electron');
const { autoUpdater } = require('electron-updater');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

if (!app.requestSingleInstanceLock()) app.quit();

let win = null;
let closing = false;
let pendingOpenPath = null;

const MAX_RECENT = 24;

function recentWorksPath() {
  return path.join(app.getPath('userData'), 'recent-works.json');
}

function thumbnailsDir() {
  return path.join(app.getPath('userData'), 'thumbnails');
}

function recentIdForPath(filePath) {
  return crypto.createHash('sha256').update(path.resolve(filePath).toLowerCase()).digest('hex').slice(0, 16);
}

function extractArgvBoardPath(argv) {
  return argv.slice(1).find(a => /\.refboard$/i.test(a) && !a.startsWith('-')) || null;
}

async function ensureThumbDir() {
  await fs.mkdir(thumbnailsDir(), { recursive: true });
}

async function loadRecentWorks() {
  try {
    const raw = await fs.readFile(recentWorksPath(), 'utf8');
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

async function saveRecentWorks(list) {
  await fs.mkdir(path.dirname(recentWorksPath()), { recursive: true });
  await fs.writeFile(recentWorksPath(), JSON.stringify(list, null, 2), 'utf8');
}

function whatsNewStorePath() {
  return path.join(app.getPath('userData'), 'whats-new.json');
}

function changelogPath() {
  return path.join(__dirname, 'changelog.json');
}

function parseSemver(v) {
  const m = String(v || '').trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return [0, 0, 0];
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function semverGt(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return true;
    if (pa[i] < pb[i]) return false;
  }
  return false;
}

async function loadWhatsNewStore() {
  try {
    const raw = await fs.readFile(whatsNewStorePath(), 'utf8');
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

async function saveWhatsNewStore(data) {
  await fs.mkdir(path.dirname(whatsNewStorePath()), { recursive: true });
  await fs.writeFile(whatsNewStorePath(), JSON.stringify(data, null, 2), 'utf8');
}

let changelogCache = null;

async function loadChangelog() {
  if (changelogCache) return changelogCache;
  try {
    const raw = await fs.readFile(changelogPath(), 'utf8');
    const data = JSON.parse(raw);
    changelogCache = data && typeof data === 'object' ? data : {};
  } catch {
    changelogCache = {};
  }
  return changelogCache;
}

async function markWhatsNewSeen(version) {
  await saveWhatsNewStore({ lastSeenVersion: version });
}

async function evaluateWhatsNew() {
  const current = app.getVersion();
  const store = await loadWhatsNewStore();
  const lastSeen = store.lastSeenVersion ?? null;

  if (lastSeen !== null && !semverGt(current, lastSeen)) {
    return { show: false };
  }

  const changelog = await loadChangelog();
  const highlights = changelog[current];
  if (!Array.isArray(highlights) || !highlights.length) {
    return { show: false };
  }

  return { show: true, version: current, highlights };
}

function notifyRenderer(msg) {
  if (!win) return;
  const safe = JSON.stringify(msg);
  win.webContents.executeJavaScript(`window.__pinToast && window.__pinToast(${safe})`).catch(() => {});
}

let manualUpdateCheck = false;

function setupAutoUpdate() {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-available', () => notifyRenderer({ type: 'update', phase: 'downloading' }));
  let __updLastPct = -1;
  autoUpdater.on('download-progress', p => {
    const pct = Math.round(p.percent || 0);
    if (pct !== __updLastPct) { __updLastPct = pct; notifyRenderer({ type: 'update', phase: 'progress', percent: pct }); }
  });
  autoUpdater.on('update-downloaded', () => notifyRenderer({ type: 'update', phase: 'ready' }));
  autoUpdater.on('update-not-available', () => notifyRenderer({ type: 'update', phase: 'uptodate' }));
  autoUpdater.on('error', (err) => {
    if (manualUpdateCheck) notifyRenderer({ type: 'update', phase: 'error', message: String(err?.message || err) });
  });
}

function setupIpc() {
  ipcMain.handle('choose-folder', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Choose export folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (r.canceled || !r.filePaths.length) return null;
    return r.filePaths[0];
  });

  ipcMain.handle('get-default-export-dir', async () => {
    return path.join(app.getPath('documents'), 'RefBoard Exports');
  });

  ipcMain.handle('write-export-files', async (_, { dir, files }) => {
    await fs.mkdir(dir, { recursive: true });
    const used = new Set();
    let count = 0;
    for (const f of files) {
      let name = path.basename(String(f.name || ''));
      if (!name || name === '.' || name === '..') name = 'image';
      const ext = path.extname(name);
      const stem = path.basename(name, ext);
      let final = name;
      let i = 2;
      while (used.has(final.toLowerCase())) {
        final = `${stem}_${i}${ext}`;
        i++;
      }
      used.add(final.toLowerCase());
      const buf = Buffer.from(f.data, 'base64');
      const target = path.resolve(dir, final);
      if (target !== path.resolve(dir) && target.startsWith(path.resolve(dir) + path.sep)) {
        await fs.writeFile(target, buf);
        count++;
      }
    }
    return { count, dir };
  });

  ipcMain.handle('save-board-file', async (_, { defaultName, data, filePath }) => {
    let target = filePath;
    if (!target) {
      const r = await dialog.showSaveDialog(win, {
        title: 'Save RefBoard board',
        defaultPath: path.join(app.getPath('documents'), defaultName),
        filters: [{ name: 'RefBoard board', extensions: ['refboard'] }],
      });
      if (r.canceled || !r.filePath) return { saved: false };
      target = r.filePath;
    }
    await fs.writeFile(target, data, 'utf8');
    refreshShellIcons(target);
    return { saved: true, filePath: target };
  });

  ipcMain.handle('open-board-dialog', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Open RefBoard board',
      filters: [{ name: 'RefBoard board', extensions: ['refboard'] }],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths.length) return null;
    const filePath = r.filePaths[0];
    const data = await fs.readFile(filePath, 'utf8');
    return { filePath, data };
  });

  ipcMain.handle('read-board-file', async (_, filePath) => {
    const data = await fs.readFile(filePath, 'utf8');
    return { filePath, data };
  });

  ipcMain.handle('get-recent-works', async () => loadRecentWorks());

  ipcMain.handle('add-recent-work', async (_, entry) => {
    if (!entry?.path) return loadRecentWorks();
    const filePath = path.resolve(entry.path);
    await ensureThumbDir();
    const id = recentIdForPath(filePath);
    let list = await loadRecentWorks();
    const existing = list.find(w => w.id === id || path.resolve(w.path) === filePath);
    let thumbnail = entry.thumbnail || existing?.thumbnail || null;
    if (entry.thumbnailBase64) {
      thumbnail = `${id}.jpg`;
      try {
        const buf = Buffer.from(entry.thumbnailBase64, 'base64');
        await fs.writeFile(path.join(thumbnailsDir(), thumbnail), buf);
      } catch {
        thumbnail = existing?.thumbnail || null;
      }
    }
    const title = entry.title || path.basename(filePath, path.extname(filePath));
    const now = Date.now();
    let lastEdited = entry.lastEdited;
    if (lastEdited == null) lastEdited = existing?.lastEdited;
    if (lastEdited == null) {
      try {
        const stat = await fs.stat(filePath);
        lastEdited = stat.mtimeMs;
      } catch {
        lastEdited = now;
      }
    }
    list = list.filter(w => w.id !== id && path.resolve(w.path) !== filePath);
    list.unshift({
      id,
      path: filePath,
      title,
      thumbnail,
      itemCount: entry.itemCount || 0,
      lastOpened: now,
      lastEdited,
    });
    const kept = new Set(list.slice(0, MAX_RECENT).map(w => w.thumbnail).filter(Boolean));
    for (const w of list.slice(MAX_RECENT)) {
      if (w.thumbnail && !kept.has(w.thumbnail)) {
        await fs.unlink(path.join(thumbnailsDir(), w.thumbnail)).catch(() => {});
      }
    }
    list = list.slice(0, MAX_RECENT);
    await saveRecentWorks(list);
    return list;
  });

  ipcMain.handle('remove-recent-work', async (_, filePath) => {
    if (!filePath) return loadRecentWorks();
    const resolved = path.resolve(filePath);
    const id = recentIdForPath(resolved);
    let list = await loadRecentWorks();
    const removed = list.find(w => w.id === id || path.resolve(w.path) === resolved);
    list = list.filter(w => w.id !== id && path.resolve(w.path) !== resolved);
    if (removed?.thumbnail) {
      await fs.unlink(path.join(thumbnailsDir(), removed.thumbnail)).catch(() => {});
    }
    await saveRecentWorks(list);
    return list;
  });

  ipcMain.handle('touch-recent-work-edited', async (_, filePath) => {
    if (!filePath) return loadRecentWorks();
    const resolved = path.resolve(filePath);
    const id = recentIdForPath(resolved);
    const now = Date.now();
    let list = await loadRecentWorks();
    const idx = list.findIndex(w => w.id === id || path.resolve(w.path) === resolved);
    if (idx === -1) {
      let lastEdited = now;
      try {
        const stat = await fs.stat(resolved);
        lastEdited = stat.mtimeMs;
      } catch { /* keep now */ }
      list.unshift({
        id,
        path: resolved,
        title: path.basename(resolved, path.extname(resolved)),
        thumbnail: null,
        itemCount: 0,
        lastOpened: now,
        lastEdited,
      });
    } else {
      list[idx] = { ...list[idx], lastEdited: now };
    }
    list = list.slice(0, MAX_RECENT);
    await saveRecentWorks(list);
    return list;
  });

  ipcMain.handle('get-thumbnail-data', async (_, filename) => {
    if (!filename || /[\\/]/.test(filename)) return null;
    try {
      const buf = await fs.readFile(path.join(thumbnailsDir(), filename));
      return buf.toString('base64');
    } catch {
      return null;
    }
  });

  ipcMain.handle('clipboard-read-image', async () => {
    const img = clipboard.readImage();
    if (img.isEmpty()) return null;
    return img.toPNG().toString('base64');
  });

  const NOTE_CLIP_FORMAT = 'application/x-refboard-note+json';

  ipcMain.handle('clipboard-write-notes', async (_, { payload, plainText } = {}) => {
    try {
      clipboard.write({ text: String(plainText ?? '') });
      clipboard.writeBuffer(NOTE_CLIP_FORMAT, Buffer.from(String(payload ?? ''), 'utf8'));
      return { ok: true };
    } catch {
      return { ok: false };
    }
  });

  ipcMain.handle('clipboard-read-notes', async () => {
    try {
      const buf = clipboard.readBuffer(NOTE_CLIP_FORMAT);
      if (!buf?.length) return null;
      return buf.toString('utf8');
    } catch {
      return null;
    }
  });

  ipcMain.handle('open-external', async (_, url) => {
    const s = String(url ?? '').trim();
    if (!/^https?:\/\//i.test(s)) return { ok: false };
    try {
      await shell.openExternal(s);
      return { ok: true };
    } catch {
      return { ok: false };
    }
  });

  ipcMain.handle('get-pending-open-path', () => {
    const p = pendingOpenPath || extractArgvBoardPath(process.argv);
    pendingOpenPath = null;
    return p || null;
  });

  ipcMain.on('close-confirmed', () => {
    closing = true;
    if (win && !win.isDestroyed()) win.close();
  });

  ipcMain.on('window-minimize', () => {
    if (win && !win.isDestroyed()) win.minimize();
  });

  ipcMain.on('window-maximize', () => {
    if (!win || win.isDestroyed()) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });

  ipcMain.on('window-close', () => {
    if (win && !win.isDestroyed()) win.webContents.send('close-request');
  });

  ipcMain.handle('window-is-maximized', () => {
    return !!(win && !win.isDestroyed() && win.isMaximized());
  });

  ipcMain.handle('install-update', () => {
    if (!app.isPackaged) return { ok: false };
    closing = true;
    autoUpdater.quitAndInstall();
    return { ok: true };
  });

  ipcMain.handle('get-app-icon-data-url', () => appIconDataUrl(32));

  ipcMain.handle('get-app-info', () => ({
    version: app.getVersion(),
    productName: app.getName(),
    isPackaged: app.isPackaged,
  }));

  ipcMain.handle('whats-new-check', () => evaluateWhatsNew());

  ipcMain.handle('whats-new-dismiss', async () => {
    await markWhatsNewSeen(app.getVersion());
    return { ok: true };
  });

  ipcMain.handle('updater-init', async (_, { checkOnStartup } = {}) => {
    if (!app.isPackaged || !checkOnStartup) return { ok: true, skipped: true };
    try {
      await autoUpdater.checkForUpdates();
      return { ok: true };
    } catch {
      return { ok: false };
    }
  });

  ipcMain.handle('check-for-updates', async () => {
    if (!app.isPackaged) return { ok: false, reason: 'dev' };
    manualUpdateCheck = true;
    try {
      await autoUpdater.checkForUpdates();
      return { ok: true };
    } catch {
      return { ok: false, reason: 'error' };
    } finally {
      manualUpdateCheck = false;
    }
  });
}

function appIconPath() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'icon.png');
  return path.join(__dirname, 'build', 'icon.png');
}

function appIconIcoPath() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'icon.ico');
  return path.join(__dirname, 'build', 'icon.ico');
}

function appIconDataUrl(size = 32) {
  const img = nativeImage.createFromPath(appIconPath());
  if (img.isEmpty()) return null;
  return img.resize({ width: size, height: size }).toDataURL();
}

function thumbnailHandlerPaths() {
  const dll = app.isPackaged
    ? path.join(process.resourcesPath, 'RefBoardThumbnailHandler.dll')
    : path.join(__dirname, 'build', 'thumbnail-handler', 'bin', 'RefBoardThumbnailHandler.dll');
  const script = app.isPackaged
    ? path.join(process.resourcesPath, 'scripts', 'register-thumb-handler.ps1')
    : path.join(__dirname, 'scripts', 'register-thumb-handler.ps1');
  return { dll, script };
}

function refreshShellIcons(filePath) {
  if (process.platform !== 'win32') return;
  try {
    const escaped = filePath ? filePath.replace(/'/g, "''") : '';
    const itemArg = filePath
      ? `$item = [System.Runtime.InteropServices.Marshal]::StringToHGlobalUni('${escaped}'); `
      : '';
    const itemNotify = filePath
      ? '[RefBoardShellNotify]::SHChangeNotify(0x00002000, 0x00001000, $item, [IntPtr]::Zero); '
      : '';
    execFile('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      `Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class RefBoardShellNotify {
  [DllImport(""shell32.dll"")] public static extern void SHChangeNotify(int eventId, uint flags, IntPtr item1, IntPtr item2);
}
"@
${itemArg}${itemNotify}[RefBoardShellNotify]::SHChangeNotify(0x08000000, 0x00001000, [IntPtr]::Zero, [IntPtr]::Zero)`,
    ], { windowsHide: true }, () => {});
  } catch { /* ignore */ }
}

function registerFileTypeIntegration() {
  if (process.platform !== 'win32') return;
  const { dll, script } = thumbnailHandlerPaths();
  if (!fsSync.existsSync(dll) || !fsSync.existsSync(script)) return;
  const exePath = process.execPath;
  const iconArg = fsSync.existsSync(appIconIcoPath()) ? appIconIcoPath() : appIconPath();
  execFile('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-DllPath', dll,
    '-Action', 'install',
    '-AppExePath', exePath,
    '-DefaultIconPath', iconArg,
  ], { windowsHide: true }, (err) => {
    if (err) console.warn('RefBoard file icon registration skipped:', err.message);
    else refreshShellIcons();
  });
}

async function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: '#141519',
    title: 'RefBoard',
    icon: appIconPath(),
    frame: false,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  Menu.setApplicationMenu(null);
  await win.loadFile('index.html');
  win.webContents.openDevTools();

  win.webContents.on('will-navigate', e => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // Only local features are used (system fonts + clipboard). Block privacy/device
  // permissions; everything not listed (local-fonts, clipboard-*, fullscreen,
  // persistent-storage) stays allowed so nothing the app relies on breaks.
  const ses = win.webContents.session;
  const BLOCKED_PERMISSIONS = new Set([
    'geolocation', 'camera', 'microphone', 'media', 'notifications',
    'midi', 'midiSysex', 'push', 'background-sync', 'speaker-selection',
    'hid', 'serial', 'usb', 'bluetooth', 'idle-detection',
    'display-capture', 'window-management',
  ]);
  ses.setPermissionRequestHandler((_wc, perm, cb) => cb(!BLOCKED_PERMISSIONS.has(perm)));
  ses.setPermissionCheckHandler((_wc, perm) => !BLOCKED_PERMISSIONS.has(perm));

  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keydown' && input.control && !input.alt && !input.shift
        && input.key.toLowerCase() === 't') {
      e.preventDefault();
      const on = !win.isAlwaysOnTop();
      win.setAlwaysOnTop(on, 'floating');
      notifyRenderer(on ? 'Pinned on top of other windows' : 'Unpinned');
    }
  });

  win.on('closed', () => { win = null; });

  const sendMaximizeState = () => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('window-maximize-changed', win.isMaximized());
    }
  };
  win.on('maximize', sendMaximizeState);
  win.on('unmaximize', sendMaximizeState);
  win.webContents.on('did-finish-load', sendMaximizeState);

  win.on('close', (e) => {
    if (closing) return;
    e.preventDefault();
    win.webContents.send('close-request');
  });
}

app.on('second-instance', (_e, argv) => {
  const filePath = extractArgvBoardPath(argv);
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
    if (filePath) win.webContents.send('open-board-path', filePath);
  } else if (filePath) {
    pendingOpenPath = filePath;
  }
});

app.on('open-file', (e, filePath) => {
  e.preventDefault();
  if (/\.refboard$/i.test(filePath)) {
    if (win && !win.isDestroyed()) win.webContents.send('open-board-path', filePath);
    else pendingOpenPath = filePath;
  }
});

app.whenReady().then(async () => {
  const argvPath = extractArgvBoardPath(process.argv);
  if (argvPath) pendingOpenPath = argvPath;
  setupIpc();
  await createWindow();
  registerFileTypeIntegration();
  setupAutoUpdate();
});
app.on('window-all-closed', () => app.quit());
