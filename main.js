'use strict';
const { app, BrowserWindow, Menu, ipcMain, dialog, clipboard, shell, nativeImage } = require('electron');
const { autoUpdater } = require('electron-updater');
const { scanBoardHandle, readBoardImageBytes, readBoardImageBytesFromHandle, readBoardPreview, rewriteBoardFilePreview } = require('./scripts/board-open-stream');
const { replaceBoardFile, recoverBoardFileIfMissing } = require('./scripts/board-file-replace');
const { boardRenameFailureText, renameBoardFile } = require('./scripts/board-rename');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { boardHeaderPrefix, boardImageParts } = require('./scripts/board-save-format');
const { isInstalledWindowsBuild } = require('./scripts/shell-integration');
const zorder = require('./scripts/win32-zorder');
const { refreshShellIcons } = require('./scripts/win32-shell-notify');
const { capRecentWorks, pinsRemaining, sortRecentWorks } = require('./scripts/recent-works');

if (!app.requestSingleInstanceLock()) app.quit();

const windows = new Set();
const MAX_BOARD_WINDOWS = 4;
let closing = false;
let pendingOpenPath = null;
let appDownloadStatus = { phase: 'idle', percent: 0 };

function focusedWindow() {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && windows.has(focused) && !focused.isDestroyed()) return focused;
  for (const candidate of windows) {
    if (candidate && !candidate.isDestroyed()) return candidate;
  }
  return null;
}

function windowForEvent(event) {
  const fromSender = BrowserWindow.fromWebContents(event.sender);
  if (fromSender && windows.has(fromSender) && !fromSender.isDestroyed()) return fromSender;
  return focusedWindow();
}

const pinByWindow = new WeakMap();

function nativeHwndId(win) {
  try {
    const buf = win.getNativeWindowHandle();
    if (!buf) return '';
    if (buf.length >= 8) return buf.readBigUInt64LE(0).toString();
    return String(buf.readUInt32LE(0));
  } catch {
    return '';
  }
}

function pinSnapshot(win) {
  const state = pinByWindow.get(win);
  if (!state || !win || win.isDestroyed()) {
    return { mode: 'off', alwaysOnTop: false };
  }
  return {
    mode: state.mode,
    targetTitle: state.targetTitle || undefined,
    targetId: state.targetId || undefined,
    alwaysOnTop: !!win.isAlwaysOnTop(),
  };
}

function sendPinState(win) {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('pin-state-changed', pinSnapshot(win));
}

function toastPin(win, msg) {
  if (!win || win.isDestroyed()) return;
  const safe = JSON.stringify(msg);
  win.webContents.executeJavaScript(`window.__pinToast && window.__pinToast(${safe})`).catch(() => {});
}

function clearPinWatch(state) {
  if (state?.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
}

function unpinWindow(win, { silent = false } = {}) {
  if (!win) return pinSnapshot(win);
  const prev = pinByWindow.get(win);
  clearPinWatch(prev);
  if (process.platform === 'win32') {
    const our = nativeHwndId(win);
    if (our) zorder.detach(our);
  }
  if (!win.isDestroyed()) win.setAlwaysOnTop(false);
  pinByWindow.set(win, { mode: 'off' });
  sendPinState(win);
  if (!silent) toastPin(win, 'Unpinned');
  return pinSnapshot(win);
}

function pinAlways(win) {
  if (!win || win.isDestroyed()) return { mode: 'off', alwaysOnTop: false };
  const prev = pinByWindow.get(win);
  if (prev?.mode === 'always') return unpinWindow(win);
  clearPinWatch(prev);
  if (process.platform === 'win32') {
    const our = nativeHwndId(win);
    if (our) zorder.detach(our);
  }
  win.setAlwaysOnTop(true, 'floating');
  pinByWindow.set(win, { mode: 'always' });
  sendPinState(win);
  toastPin(win, 'Pinned on top of other windows');
  return pinSnapshot(win);
}

function pinAbove(win, targetId) {
  if (!win || win.isDestroyed()) return { mode: 'off', alwaysOnTop: false };
  const prev = pinByWindow.get(win);
  if (prev?.mode === 'above' && prev.targetId === String(targetId || '')) return unpinWindow(win);
  if (process.platform !== 'win32') {
    return { ...pinSnapshot(win), error: 'unsupported' };
  }
  const our = nativeHwndId(win);
  const info = zorder.windowInfo(targetId);
  if (!our || !info) return { ...pinSnapshot(win), error: 'missing-window' };
  clearPinWatch(prev);
  win.setAlwaysOnTop(false);
  const attached = zorder.attach(our, info.id);
  const state = {
    mode: 'above',
    targetId: info.id,
    targetTitle: info.title,
    attached,
    timer: null,
  };
  state.timer = setInterval(() => {
    if (win.isDestroyed()) {
      clearPinWatch(state);
      return;
    }
    if (!zorder.isWindow(info.id)) {
      unpinWindow(win);
      return;
    }
    if (!state.attached) zorder.restack(our, info.id);
  }, 200);
  pinByWindow.set(win, state);
  sendPinState(win);
  toastPin(win, `Pinned on top of ${info.title}`);
  return pinSnapshot(win);
}

function listPinWindows(win) {
  if (process.platform !== 'win32') return [];
  const skip = [...windows]
    .filter(candidate => candidate && !candidate.isDestroyed())
    .map(nativeHwndId)
    .filter(Boolean);
  const ours = win && !win.isDestroyed() ? nativeHwndId(win) : '';
  if (ours) skip.push(ours);
  return zorder.listWindows(skip);
}

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

const WHATS_NEW_SECTION_KEYS = ['new', 'improved', 'fixed'];

function normalizeWhatsNewItem(item) {
  if (typeof item === 'string') {
    const title = item.trim();
    return title ? { title, description: '' } : null;
  }
  if (!item || typeof item !== 'object') return null;
  const title = String(item.title || '').trim();
  const description = String(item.description || '').trim();
  if (!title && !description) return null;
  return { title: title || description, description: title ? description : '' };
}

function normalizeChangelogRelease(version, entry) {
  const fallbackHeadline = `RefBoard ${version}`;
  if (Array.isArray(entry)) {
    let activeSection = 'improved';
    const sections = { new: [], improved: [], fixed: [] };
    for (const raw of entry) {
      const text = String(raw || '').trim();
      if (!text) continue;
      if (/^(new|new features?)\s*:?$/i.test(text)) { activeSection = 'new'; continue; }
      if (/^(improved|improvements?)\s*:?$/i.test(text)) { activeSection = 'improved'; continue; }
      if (/^(fixed|fixes|bug fixes?)\s*:?$/i.test(text)) { activeSection = 'fixed'; continue; }
      const item = normalizeWhatsNewItem(text);
      if (item) sections[activeSection].push(item);
    }
    return { version, headline: fallbackHeadline, summary: '', sections };
  }

  const sourceSections = entry?.sections && typeof entry.sections === 'object' ? entry.sections : {};
  const sections = { new: [], improved: [], fixed: [] };
  for (const key of WHATS_NEW_SECTION_KEYS) {
    const source = Array.isArray(sourceSections[key]) ? sourceSections[key] : [];
    sections[key] = source.map(normalizeWhatsNewItem).filter(Boolean);
  }
  return {
    version,
    headline: String(entry?.headline || fallbackHeadline).trim(),
    summary: String(entry?.summary || '').trim(),
    sections,
  };
}

function hasWhatsNewContent(entry) {
  if (Array.isArray(entry)) return entry.some(value => String(value || '').trim());
  const sections = entry?.sections;
  return !!sections && WHATS_NEW_SECTION_KEYS.some(key => Array.isArray(sections[key]) && sections[key].length);
}

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

async function buildWhatsNewPayload({ current, lastSeen = null, currentOnly = false }) {
  const changelog = await loadChangelog();
  const versions = Object.keys(changelog)
    .filter(v => hasWhatsNewContent(changelog[v]))
    .filter(v => currentOnly
      ? v === current
      : (v === current) || (semverGt(current, v) && (lastSeen === null ? false : semverGt(v, lastSeen))))
    .sort((a, b) => (semverGt(a, b) ? -1 : semverGt(b, a) ? 1 : 0));

  const releases = versions.map(v => normalizeChangelogRelease(v, changelog[v]));
  const sections = { new: [], improved: [], fixed: [] };
  const seen = new Set();
  for (const release of releases) {
    for (const key of WHATS_NEW_SECTION_KEYS) {
      for (const item of release.sections[key]) {
        const identity = `${key}\n${item.title}\n${item.description}`;
        if (seen.has(identity)) continue;
        seen.add(identity);
        sections[key].push({ ...item, version: release.version });
      }
    }
  }
  const totalChanges = WHATS_NEW_SECTION_KEYS.reduce((total, key) => total + sections[key].length, 0);
  if (!totalChanges) {
    return { show: false };
  }

  const latest = releases[0];
  const multipleReleases = releases.length > 1;
  return {
    show: true,
    version: current,
    headline: multipleReleases ? `Everything new since ${lastSeen}` : latest.headline,
    summary: multipleReleases
      ? `${releases.length} RefBoard updates, collected in one place.`
      : latest.summary,
    sections,
    releaseCount: releases.length,
    totalChanges,
  };
}

async function evaluateWhatsNew() {
  const current = app.getVersion();
  const store = await loadWhatsNewStore();
  const lastSeen = store.lastSeenVersion ?? null;

  if (lastSeen !== null && !semverGt(current, lastSeen)) {
    return { show: false };
  }

  return buildWhatsNewPayload({ current, lastSeen });
}

async function getCurrentWhatsNew() {
  const payload = await buildWhatsNewPayload({
    current: app.getVersion(),
    currentOnly: true,
  });
  return payload.show ? payload : null;
}

function notifyRenderer(msg) {
  const safe = JSON.stringify(msg);
  for (const candidate of windows) {
    if (!candidate || candidate.isDestroyed()) continue;
    candidate.webContents.executeJavaScript(`window.__pinToast && window.__pinToast(${safe})`).catch(() => {});
  }
}

let manualUpdateCheck = false;

function setupAutoUpdate() {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-available', () => {
    appDownloadStatus = { phase: 'downloading', percent: 0 };
    notifyRenderer({ type: 'update', phase: 'downloading', appDownload: { ...appDownloadStatus } });
  });
  let __updLastPct = -1;
  autoUpdater.on('download-progress', p => {
    const pct = Math.round(p.percent || 0);
    if (pct !== __updLastPct) {
      __updLastPct = pct;
      appDownloadStatus = { phase: 'progress', percent: pct, downloadedBytes: p.transferred || 0, totalBytes: p.total || 0 };
      notifyRenderer({ type: 'update', phase: 'progress', percent: pct,
        appDownload: { ...appDownloadStatus } });
    }
  });
  autoUpdater.on('update-downloaded', () => {
    appDownloadStatus = { phase: 'ready', percent: 100 };
    notifyRenderer({ type: 'update', phase: 'ready', appDownload: { ...appDownloadStatus } });
  });
  autoUpdater.on('update-not-available', () => {
    appDownloadStatus = { phase: 'idle', percent: 0 };
    notifyRenderer({ type: 'update', phase: 'uptodate' });
  });
  autoUpdater.on('error', (err) => {
    appDownloadStatus = { phase: 'error', percent: 0, error: String(err?.message || err) };
    if (manualUpdateCheck) notifyRenderer({ type: 'update', phase: 'error', message: String(err?.message || err) });
  });
}

function setupIpc() {
  const boardSaveSessions = new Map();
  const boardOpenSessions = new Map();

  async function closeBoardOpenSession(session) {
    if (!session) return;
    clearTimeout(session.timer);
    session.timer = null;
    try { await session.handle?.close(); } catch { /* already closed */ }
    session.handle = null;
  }

  /* A save that fails or is abandoned must not leave its temp file beside the
     board or keep its file handle open (which locks the file on Windows).
     Removed by mistake in ff90c34; every failure branch then threw
     ReferenceError and hid the real error. */
  async function discardBoardSaveSession(session) {
    if (!session) return;
    try { await session.handle?.close(); } catch { /* already closed */ }
    session.handle = null;
    if (session.tempPath) await fs.unlink(session.tempPath).catch(() => {});
  }

  async function appendBoardSaveImageParts(session, image, data) {
    const parts = boardImageParts(image, data);
    await session.handle.write((session.firstImage ? '' : ',') + parts.prefix);
    await session.handle.write(parts.base64);
    await session.handle.write(parts.suffix);
    session.firstImage = false;
  }

  ipcMain.handle('choose-folder', async event => {
    const r = await dialog.showOpenDialog(windowForEvent(event), {
      title: 'Choose export folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (r.canceled || !r.filePaths.length) return null;
    return r.filePaths[0];
  });

  ipcMain.handle('get-default-export-dir', async () => {
    return path.join(app.getPath('documents'), 'RefBoard Exports');
  });

  ipcMain.handle('get-process-memory-info', async () => {
    return app.getAppMetrics().map(metric => ({
      pid: metric.pid,
      type: metric.type,
      memory: metric.memory,
    }));
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

  /* ---------- drag out ---------- */

  /* The receiving application reads the dropped path after the drop finishes,
     so the bytes cannot be handed over from memory — they are staged on disk.
     One directory per renderer, rebuilt on every drag, keeps a long session
     from accumulating every image the user has ever dragged out. */
  const dragOutDirs = new Map();

  async function dragOutDirFor(contentsId) {
    let dir = dragOutDirs.get(contentsId);
    if (!dir) {
      dir = path.join(dragOutStagingRoot(), `${process.pid}-${contentsId}`);
      dragOutDirs.set(contentsId, dir);
    }
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  ipcMain.handle('stage-drag-out', async (event, { files } = {}) => {
    const list = Array.isArray(files) ? files.slice(0, DRAG_OUT_MAX_FILES) : [];
    if (!list.length) return { paths: [] };
    const root = path.resolve(await dragOutDirFor(event.sender.id));
    const paths = [];
    for (const f of list) {
      const name = path.basename(String(f?.name || ''));
      if (!name || name === '.' || name === '..') continue;
      const target = path.resolve(root, name);
      // A crafted name must not write outside the staging directory.
      if (!target.startsWith(root + path.sep)) continue;
      await fs.writeFile(target, Buffer.from(String(f?.data || ''), 'base64'));
      paths.push(target);
    }
    return { paths };
  });

  ipcMain.handle('start-drag-out', async (event, { paths, icon } = {}) => {
    const dir = dragOutDirs.get(event.sender.id);
    if (!dir) return { started: false };
    const root = path.resolve(dir);
    // Only paths this renderer just staged may be dragged, and only if the
    // write actually landed — startDrag on a missing file drops nothing.
    const files = (Array.isArray(paths) ? paths : [])
      .map(entry => path.resolve(String(entry || '')))
      .filter(entry => entry.startsWith(root + path.sep) && fsSync.existsSync(entry));
    if (!files.length) return { started: false };

    // Windows refuses startDrag without a real icon, so a thumbnail that failed
    // to decode has to fall back to the app icon rather than abort the drag.
    let image = null;
    if (typeof icon === 'string' && icon.startsWith('data:image/')) {
      try { image = nativeImage.createFromDataURL(icon); } catch { image = null; }
    }
    if (!image || image.isEmpty()) image = nativeImage.createFromPath(appIconPath());
    if (image.isEmpty()) return { started: false };

    event.sender.startDrag({ file: files[0], files, icon: image });
    return { started: true, count: files.length };
  });

  ipcMain.handle('save-board-file', async (event, { defaultName, data, filePath, forceDialog = false }) => {
    let target = forceDialog ? null : filePath;
    if (!target) {
      const r = await dialog.showSaveDialog(windowForEvent(event), {
        title: 'Save RefBoard board',
        defaultPath: filePath || path.join(app.getPath('documents'), defaultName),
        filters: [{ name: 'RefBoard board', extensions: ['refboard'] }],
      });
      if (r.canceled || !r.filePath) return { saved: false };
      target = r.filePath;
    }
    await fs.writeFile(target, data, 'utf8');
    refreshShellIcons(target);
    return { saved: true, filePath: target };
  });

  ipcMain.handle('begin-board-save', async (event, { defaultName, filePath, forceDialog = false, core, preview }) => {
    let target = forceDialog ? null : filePath;
    if (!target) {
      const r = await dialog.showSaveDialog(windowForEvent(event), {
        title: 'Save RefBoard board',
        defaultPath: filePath || path.join(app.getPath('documents'), defaultName),
        filters: [{ name: 'RefBoard board', extensions: ['refboard'] }],
      });
      if (r.canceled || !r.filePath) return { started: false };
      target = r.filePath;
    }

    const token = crypto.randomUUID();
    const tempPath = `${target}.saving-${process.pid}-${token}`;
    const session = {
      token, target, tempPath, ownerId: event.sender.id, handle: null, firstImage: true,
    };
    try {
      session.handle = await fs.open(tempPath, 'wx');
      await session.handle.write(boardHeaderPrefix(core, preview));
      boardSaveSessions.set(token, session);
      return { started: true, token, filePath: target };
    } catch (err) {
      await discardBoardSaveSession(session);
      throw err;
    }
  });

  ipcMain.handle('append-board-save-image', async (event, { token, image, data }) => {
    const session = boardSaveSessions.get(token);
    if (!session || session.ownerId !== event.sender.id) throw new Error('Unknown board save session');
    await appendBoardSaveImageParts(session, image, data);
    return { appended: true };
  });

  ipcMain.handle('append-board-save-images', async (event, { token, images }) => {
    const session = boardSaveSessions.get(token);
    if (!session || session.ownerId !== event.sender.id) throw new Error('Unknown board save session');
    const list = Array.isArray(images) ? images : [];
    for (const entry of list) {
      await appendBoardSaveImageParts(session, entry?.image, entry?.data);
    }
    return { appended: true, count: list.length };
  });

  ipcMain.handle('finish-board-save', async (event, token) => {
    const session = boardSaveSessions.get(token);
    if (!session || session.ownerId !== event.sender.id) throw new Error('Unknown board save session');
    boardSaveSessions.delete(token);
    try {
      await session.handle.write(']}');
      await session.handle.sync();
      await session.handle.close();
      session.handle = null;

      await replaceBoardFile(session.target, session.tempPath);
      refreshShellIcons(session.target);
      return { saved: true, filePath: session.target };
    } catch (err) {
      await discardBoardSaveSession(session);
      throw err;
    }
  });

  ipcMain.handle('abort-board-save', async (event, token) => {
    const session = boardSaveSessions.get(token);
    if (!session || session.ownerId !== event.sender.id) return { aborted: false };
    boardSaveSessions.delete(token);
    await discardBoardSaveSession(session);
    return { aborted: true };
  });

  ipcMain.handle('open-board-dialog', async event => {
    const r = await dialog.showOpenDialog(windowForEvent(event), {
      title: 'Open RefBoard board',
      filters: [{ name: 'RefBoard board', extensions: ['refboard'] }],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths.length) return null;
    const filePath = r.filePaths[0];
    return { filePath };
  });

  ipcMain.handle('read-board-file', async (_, filePath) => {
    const resolved = path.resolve(String(filePath || ''));
    await recoverBoardFileIfMissing(resolved);
    const data = await fs.readFile(resolved, 'utf8');
    return { filePath: resolved, data };
  });

  ipcMain.handle('recover-board-file', async (_, filePath) => {
    return recoverBoardFileIfMissing(filePath);
  });

  ipcMain.handle('begin-board-open', async (event, filePath) => {
    const resolved = path.resolve(String(filePath || ''));
    await recoverBoardFileIfMissing(resolved);
    const handle = await fs.open(resolved, 'r');
    try {
      const stat = await handle.stat();
      const scanned = await scanBoardHandle(handle, stat.size);
      const token = crypto.randomUUID();
      const session = {
        token, ownerId: event.sender.id, filePath: resolved, images: scanned.images, handle, timer: null,
      };
      session.timer = setTimeout(() => {
        boardOpenSessions.delete(token);
        void closeBoardOpenSession(session);
      }, 5 * 60 * 1000);
      boardOpenSessions.set(token, session);
      return { token, core: scanned.core, images: scanned.images.map(({ dataStart, dataLength, ...meta }) => meta) };
    } catch (err) {
      await handle.close().catch(() => {});
      throw err;
    }
  });

  ipcMain.handle('read-board-open-image', async (event, { token, index }) => {
    const session = boardOpenSessions.get(token);
    if (!session || session.ownerId !== event.sender.id) throw new Error('Unknown board open session');
    const image = session.images[index];
    if (!image) throw new Error('Unknown board image');
    if (session.handle) return await readBoardImageBytesFromHandle(session.handle, image);
    return await readBoardImageBytes(session.filePath, image);
  });

  ipcMain.handle('read-board-open-images', async (event, { token, indexes }) => {
    const session = boardOpenSessions.get(token);
    if (!session || session.ownerId !== event.sender.id) throw new Error('Unknown board open session');
    const list = Array.isArray(indexes) ? indexes : [];
    return await Promise.all(list.map(async (index) => {
      const image = session.images[index];
      if (!image) throw new Error('Unknown board image');
      if (session.handle) return readBoardImageBytesFromHandle(session.handle, image);
      return readBoardImageBytes(session.filePath, image);
    }));
  });

  ipcMain.handle('finish-board-open', async (event, token) => {
    const session = boardOpenSessions.get(token);
    if (!session || session.ownerId !== event.sender.id) return { finished: false };
    boardOpenSessions.delete(token);
    await closeBoardOpenSession(session);
    return { finished: true };
  });

  ipcMain.handle('get-recent-works', async () => {
    const list = await loadRecentWorks();
    for (const work of list) {
      if (work?.path) await recoverBoardFileIfMissing(work.path).catch(() => {});
    }
    // Sorted on the way out rather than on disk: the file stays a plain history,
    // and every reader gets pins first without having to know to ask.
    return sortRecentWorks(list);
  });

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
      // Carried over deliberately: the entry is rebuilt from scratch on every
      // open, so anything not restored here is lost by simply using the board.
      pinned: entry.pinned != null ? !!entry.pinned : !!existing?.pinned,
    });
    const capped = capRecentWorks(list);
    // A thumbnail is shared by id, so only unlink one nothing kept still points at.
    const keptThumbs = new Set(capped.kept.map(w => w.thumbnail).filter(Boolean));
    for (const w of capped.dropped) {
      if (w.thumbnail && !keptThumbs.has(w.thumbnail)) {
        await fs.unlink(path.join(thumbnailsDir(), w.thumbnail)).catch(() => {});
      }
    }
    list = capped.kept;
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

  ipcMain.handle('set-recent-work-pinned', async (_, { filePath, pinned } = {}) => {
    if (!filePath) return loadRecentWorks();
    const resolved = path.resolve(String(filePath));
    const id = recentIdForPath(resolved);
    const list = await loadRecentWorks();
    const index = list.findIndex(w => w.id === id || path.resolve(w.path) === resolved);
    if (index === -1) return list;
    const want = !!pinned;
    // A backstop, not the message: the landing checks the limit first so it can
    // say why. Refusing here keeps two windows from pinning past it at once.
    if (want && !list[index].pinned && pinsRemaining(list) === 0) return list;
    list[index] = { ...list[index], pinned: want };
    const capped = capRecentWorks(list);
    await saveRecentWorks(capped.kept);
    return capped.kept;
  });

  ipcMain.handle('rename-recent-work', async (_, { filePath, name } = {}) => {
    if (!filePath) return { ok: false, reason: 'invalid-path', message: boardRenameFailureText('invalid-path') };
    const from = path.resolve(String(filePath));
    // Moving a file out from under an in-flight save or streamed open would
    // leave the session writing to (or reading from) a path that no longer
    // names this board.
    for (const session of boardSaveSessions.values()) {
      if (path.resolve(session.target) === from) return { ok: false, reason: 'busy', message: boardRenameFailureText('busy') };
    }
    for (const session of boardOpenSessions.values()) {
      if (path.resolve(session.filePath) === from) return { ok: false, reason: 'busy', message: boardRenameFailureText('busy') };
    }

    const result = await renameBoardFile(from, name);
    if (!result.ok) {
      return { ...result, message: boardRenameFailureText(result.reason), list: await loadRecentWorks() };
    }

    const oldId = recentIdForPath(result.from);
    const newId = recentIdForPath(result.to);
    let list = await loadRecentWorks();
    const idx = list.findIndex(w => w.id === oldId || path.resolve(w.path) === result.from);
    if (idx !== -1) {
      const entry = list[idx];
      let thumbnail = entry.thumbnail || null;
      if (thumbnail && oldId !== newId) {
        const next = `${newId}${path.extname(thumbnail) || '.jpg'}`;
        try {
          await ensureThumbDir();
          await fs.rename(path.join(thumbnailsDir(), thumbnail), path.join(thumbnailsDir(), next));
          thumbnail = next;
        } catch {
          // A missing cached thumbnail is not worth failing a completed rename
          // over; the card falls back to the preview inside the board file.
          thumbnail = null;
        }
      }
      const updated = { ...entry, id: newId, path: result.to, title: result.name, thumbnail };
      // A stale entry may already point at the new path (a board that used to
      // live there). Drop it so the same file cannot appear twice.
      list = list
        .filter((_w, i) => i !== idx)
        .filter(w => w.id !== newId && path.resolve(w.path) !== result.to);
      list.splice(Math.min(idx, list.length), 0, updated);
      await saveRecentWorks(list);
    }

    if (!result.unchanged) {
      refreshShellIcons(result.from);
      refreshShellIcons(result.to);
    }
    return { ok: true, unchanged: !!result.unchanged, from: result.from, path: result.to, title: result.name, list };
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
    list = capRecentWorks(list).kept;
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

  ipcMain.handle('get-board-preview', async (_, filePath) => {
    if (!filePath) return null;
    try {
      return await readBoardPreview(path.resolve(String(filePath)));
    } catch {
      return null;
    }
  });

  ipcMain.handle('write-board-preview', async (_, { filePath, preview } = {}) => {
    if (!filePath || typeof preview !== 'string' || !preview.length) return { written: false };
    const target = path.resolve(String(filePath));
    for (const session of boardSaveSessions.values()) {
      if (path.resolve(session.target) === target) {
        throw new Error('Board save in progress');
      }
    }
    const result = await rewriteBoardFilePreview(target, preview);
    refreshShellIcons(target);
    return result;
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

  ipcMain.handle('open-board-window', async (_, payload = {}) => {
    const filePath = /\.refboard$/i.test(String(payload?.filePath || ''))
      ? path.resolve(String(payload.filePath))
      : null;
    if (windows.size >= MAX_BOARD_WINDOWS) {
      const owner = focusedWindow();
      if (owner && !owner.isDestroyed()) {
        if (owner.isMinimized()) owner.restore();
        owner.focus();
      }
      return { opened: false, reason: 'window-limit', limit: MAX_BOARD_WINDOWS };
    }
    const boardWindow = await createWindow(filePath);
    return { opened: !!boardWindow, limit: MAX_BOARD_WINDOWS };
  });

  ipcMain.handle('get-board-window-count', () =>
    [...windows].filter(candidate => candidate && !candidate.isDestroyed()).length);

  ipcMain.on('close-confirmed', event => {
    closing = true;
    const target = windowForEvent(event);
    if (target && !target.isDestroyed()) target.close();
  });

  ipcMain.on('window-minimize', event => {
    const target = windowForEvent(event);
    if (target && !target.isDestroyed()) target.minimize();
  });

  ipcMain.on('window-maximize', event => {
    const target = windowForEvent(event);
    if (!target || target.isDestroyed()) return;
    if (target.isMaximized()) target.unmaximize();
    else target.maximize();
  });

  ipcMain.on('window-close', event => {
    const target = windowForEvent(event);
    if (target && !target.isDestroyed()) target.webContents.send('close-request');
  });

  ipcMain.handle('window-is-maximized', event => {
    const target = windowForEvent(event);
    return !!(target && !target.isDestroyed() && target.isMaximized());
  });

  ipcMain.handle('pin-get-state', event => pinSnapshot(windowForEvent(event)));
  ipcMain.handle('pin-set-always', event => pinAlways(windowForEvent(event)));
  ipcMain.handle('pin-set-above', (event, payload = {}) => pinAbove(windowForEvent(event), payload.id));
  ipcMain.handle('pin-clear', event => unpinWindow(windowForEvent(event)));
  ipcMain.handle('pin-list-windows', event => listPinWindows(windowForEvent(event)));

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
  ipcMain.handle('whats-new-current', () => getCurrentWhatsNew());

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

const DRAG_OUT_MAX_FILES = 200;

/* Staged drag-out files must outlive the drop, so they cannot be deleted when
   the drag ends — a slow copy would read a file that is already gone. They are
   swept at startup instead, which bounds them to a single session's leftovers
   without ever racing a drop in progress. */
function dragOutStagingRoot() {
  return path.join(app.getPath('temp'), 'RefBoard-DragOut');
}

function sweepDragOutStaging() {
  try {
    fsSync.rmSync(dragOutStagingRoot(), { recursive: true, force: true });
  } catch (err) {
    console.warn('RefBoard could not clear drag-out staging:', err?.message || err);
  }
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

/* Registration is a one-time install step, but it used to spawn PowerShell on
   every launch. Remember what was registered and re-run only when the handler,
   the executable, the icon or the app version actually changes. */
function thumbnailRegistrationStampPath() {
  return path.join(app.getPath('userData'), 'thumb-handler-registration.json');
}

function thumbnailRegistrationStamp(dll, exePath, iconArg) {
  let dllStat = null;
  try { dllStat = fsSync.statSync(dll); } catch { /* checked by the caller */ }
  return JSON.stringify({
    version: app.getVersion(),
    dll,
    dllSize: dllStat?.size ?? 0,
    dllMtimeMs: Math.round(dllStat?.mtimeMs ?? 0),
    exePath,
    iconArg,
  });
}

function registerFileTypeIntegration() {
  if (!isInstalledWindowsBuild({
    platform: process.platform,
    isPackaged: app.isPackaged,
    exePath: process.execPath,
    productName: 'RefBoard',
  })) return;
  const { dll, script } = thumbnailHandlerPaths();
  if (!fsSync.existsSync(dll) || !fsSync.existsSync(script)) return;
  const exePath = process.execPath;
  const iconArg = fsSync.existsSync(appIconIcoPath()) ? appIconIcoPath() : appIconPath();

  const stampPath = thumbnailRegistrationStampPath();
  const stamp = thumbnailRegistrationStamp(dll, exePath, iconArg);
  try {
    if (fsSync.readFileSync(stampPath, 'utf8') === stamp) return;
  } catch { /* never registered, or the stamp is unreadable: register now */ }

  execFile('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-DllPath', dll,
    '-Action', 'install',
    '-AppExePath', exePath,
    '-DefaultIconPath', iconArg,
  ], { windowsHide: true }, (err) => {
    if (err) {
      console.warn('RefBoard file icon registration skipped:', err.message);
      return;
    }
    // Only record success, so a failed run is retried on the next launch.
    try { fsSync.writeFileSync(stampPath, stamp, 'utf8'); }
    catch (writeErr) { console.warn('RefBoard could not record icon registration:', writeErr.message); }
    refreshShellIcons();
  });
}

async function createWindow(startupFilePath = null) {
  // Keep the first window on the legacy "main" session slot so existing
  // autosave/restore state continues to load after the multi-window change.
  const windowId = [...windows].some(w => w && !w.isDestroyed()) ? crypto.randomUUID() : 'main';
  const win = new BrowserWindow({
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
      additionalArguments: [`--refboard-window-id=${windowId}`],
    },
  });
  windows.add(win);

  Menu.setApplicationMenu(null);
  await win.loadFile('index.html', { query: { wid: windowId } }).catch(err => {
    console.warn('RefBoard window initial load failed:', err?.message || err);
  });

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
    if (input.type !== 'keydown') return;
    const key = String(input.key || '').toLowerCase();
    if (input.control && !input.alt && !input.shift && key === 't') {
      e.preventDefault();
      pinAlways(win);
      return;
    }
    if (input.control && input.alt && input.shift && key === 'a') {
      e.preventDefault();
      win.webContents.send('pin-open-above');
    }
  });

  win.on('closed', () => {
    unpinWindow(win, { silent: true });
    windows.delete(win);
  });

  const sendMaximizeState = () => {
    if (!win.isDestroyed()) {
      win.webContents.send('window-maximize-changed', win.isMaximized());
    }
  };
  win.on('maximize', sendMaximizeState);
  win.on('unmaximize', sendMaximizeState);
  win.webContents.on('did-finish-load', () => {
    sendMaximizeState();
    if (startupFilePath && !win.isDestroyed()) {
      win.webContents.send('open-board-path', startupFilePath);
    }
  });

  let rendererCrashReloads = 0;
  win.webContents.on('render-process-gone', (_event, details) => {
    const reason = details?.reason || 'unknown';
    console.error('[window] renderer gone:', reason, details?.exitCode);
    if (closing || win.isDestroyed()) return;
    if (rendererCrashReloads >= 2) return;
    rendererCrashReloads++;
    win.loadFile('index.html', { query: { wid: windowId, recovered: '1' } }).catch(err => {
      console.warn('RefBoard window reload after renderer crash failed:', err?.message || err);
    });
  });

  win.on('close', (e) => {
    if (closing) return;
    if (win.webContents.isDestroyed() || win.webContents.isCrashed()) return;
    e.preventDefault();
    win.webContents.send('close-request');
  });

  return win;
}

app.on('second-instance', (_e, argv) => {
  const filePath = extractArgvBoardPath(argv);
  const win = focusedWindow();
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
    const win = focusedWindow();
    if (win && !win.isDestroyed()) win.webContents.send('open-board-path', filePath);
    else pendingOpenPath = filePath;
  }
});

app.whenReady().then(async () => {
  const argvPath = extractArgvBoardPath(process.argv);
  if (argvPath) pendingOpenPath = argvPath;
  sweepDragOutStaging();
  setupIpc();
  await createWindow();
  registerFileTypeIntegration();
  setupAutoUpdate();
});
app.on('window-all-closed', () => app.quit());
