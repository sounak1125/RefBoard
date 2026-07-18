'use strict';
const { app, BrowserWindow, Menu, ipcMain, dialog, clipboard, shell, nativeImage } = require('electron');
const { autoUpdater } = require('electron-updater');
const { scanBoardFile, readBoardImageBytes, readBoardPreview } = require('./scripts/board-open-stream');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const os = require('os');
const ffmpegStaticPath = require('ffmpeg-static');
const { boardHeaderPrefix, boardImageParts } = require('./scripts/board-save-format');
const { isInstalledWindowsBuild } = require('./scripts/shell-integration');

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

async function evaluateWhatsNew() {
  const current = app.getVersion();
  const store = await loadWhatsNewStore();
  const lastSeen = store.lastSeenVersion ?? null;

  if (lastSeen !== null && !semverGt(current, lastSeen)) {
    return { show: false };
  }

  const changelog = await loadChangelog();
  const versions = Object.keys(changelog)
    .filter(v => hasWhatsNewContent(changelog[v]))
    .filter(v => (v === current) || (semverGt(current, v) && (lastSeen === null ? false : semverGt(v, lastSeen))))
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
  const boardSaveSessions = new Map();
  const boardOpenSessions = new Map();
  const animaticExportSessions = new Map();
  const premiereExportSessions = new Map();
  const afterEffectsExportSessions = new Map();

  function ffmpegPath() {
    return String(ffmpegStaticPath || '').replace('app.asar', 'app.asar.unpacked');
  }

  async function discardAnimaticExportSession(session) {
    if (!session) return;
    clearTimeout(session.timer);
    await fs.rm(session.dir, { recursive: true, force: true }).catch(() => {});
  }

  async function discardPremiereExportSession(session) {
    if (!session) return;
    clearTimeout(session.timer);
    if (!session.finished && session.mediaDir) await fs.rm(session.mediaDir, { recursive: true, force: true }).catch(() => {});
    if (session.tempPath) await fs.rm(session.tempPath, { force: true }).catch(() => {});
    if (session.finished && session.backupPath) await fs.rm(session.backupPath, { force: true }).catch(() => {});
  }

  async function discardAfterEffectsExportSession(session) {
    if (!session) return;
    clearTimeout(session.timer);
    if (!session.finished && session.mediaDir) await fs.rm(session.mediaDir, { recursive: true, force: true }).catch(() => {});
    if (session.tempPath) await fs.rm(session.tempPath, { force: true }).catch(() => {});
    if (session.finished && session.backupPath) await fs.rm(session.backupPath, { force: true }).catch(() => {});
  }

  async function createUniquePremiereMediaDir(output) {
    const parent = path.dirname(output);
    const stem = path.basename(output, path.extname(output));
    for (let index = 1; index < 1000; index++) {
      const suffix = index === 1 ? '_Media' : `_Media_${index}`;
      const candidate = path.join(parent, `${stem}${suffix}`);
      try {
        await fs.mkdir(candidate, { recursive: false });
        return candidate;
      } catch (err) {
        if (err?.code !== 'EEXIST') throw err;
      }
    }
    throw new Error('Could not create a unique Premiere media folder');
  }

  async function createUniqueAfterEffectsMediaDir(output) {
    return createUniquePremiereMediaDir(output);
  }

  async function appendCollectedExportAsset(session, asset, productName) {
    if (session.assetCount >= 2000) throw new Error(`${productName} export contains too many assets`);
    const requestedCategory = String(asset?.category || '').toLowerCase();
    const category = requestedCategory === 'image' ? 'image'
      : requestedCategory === 'video' ? 'video'
      : requestedCategory === 'audio' ? 'audio'
      : requestedCategory === 'drawing' || requestedCategory === 'stroke' ? 'drawing'
      : 'other';
    const folder = { image:'Images', video:'Videos', audio:'Audio', drawing:'Drawings', other:'Other' }[category];
    let name = path.basename(String(asset?.name || 'media.bin')).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '');
    if (!name || name === '.' || name === '..') name = 'media.bin';
    const ext = path.extname(name), stem = path.basename(name, ext);
    let final = name;
    for (let index = 2; session.usedNames.has(`${folder}/${final}`.toLowerCase()); index++) final = `${stem}_${index}${ext}`;
    session.usedNames.add(`${folder}/${final}`.toLowerCase());
    const root = path.resolve(session.mediaDir);
    const categoryDir = path.resolve(root, folder);
    if (!categoryDir.startsWith(root + path.sep)) throw new Error(`Unsafe ${productName} media folder`);
    await fs.mkdir(categoryDir, { recursive: true });
    const target = path.resolve(categoryDir, final);
    if (target === categoryDir || !target.startsWith(categoryDir + path.sep)) throw new Error(`Unsafe ${productName} media path`);
    await fs.writeFile(target, Buffer.from(asset?.data || []));
    session.assetCount++;
    return { appended: true, name: final, filePath: target, category, relativePath: `${folder}/${final}` };
  }

  function runFfmpeg(args, cwd) {
    return new Promise((resolve, reject) => {
      execFile(ffmpegPath(), args, { cwd, windowsHide: true }, (err, stdout, stderr) => {
        if (err) {
          err.message = `${err.message}\n${String(stderr || '').slice(-4000)}`;
          reject(err);
        } else resolve({ stdout, stderr });
      });
    });
  }

  function normalizedAnimaticAudioEnvelope(value, duration) {
    const end = Math.max(0, Number(duration) || 0);
    const points = (Array.isArray(value) ? value : []).slice(0, 256).map(point => ({
      time: Math.max(0, Math.min(end, Number(point?.time) || 0)),
      gain: Math.max(0, Math.min(1, Number(point?.gain) || 0)),
    })).filter(point => Number.isFinite(point.time) && Number.isFinite(point.gain)).sort((a, b) => a.time - b.time);
    const unique = [];
    for (const point of points) {
      if (unique.length && Math.abs(unique.at(-1).time - point.time) < 1e-8) unique[unique.length - 1] = point;
      else unique.push(point);
    }
    return unique;
  }

  function animaticAudioEnvelopeExpression(points) {
    if (!Array.isArray(points) || points.length < 2) return null;
    const number = value => Number(value).toFixed(8);
    let expression = number(points.at(-1).gain);
    for (let index = points.length - 2; index >= 0; index--) {
      const from = points[index], to = points[index + 1], span = Math.max(1e-8, to.time - from.time);
      const interpolation = `${number(from.gain)}+(${number(to.gain - from.gain)})*(t-${number(from.time)})/${number(span)}`;
      expression = `if(lt(t,${number(to.time)}),${interpolation},${expression})`;
    }
    return expression;
  }

  async function discardBoardSaveSession(session) {
    if (!session) return;
    try { await session.handle?.close(); } catch { /* already closed */ }
    await fs.unlink(session.tempPath).catch(() => {});
  }

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

  ipcMain.handle('get-process-memory-info', async () => {
    return app.getAppMetrics().map(metric => ({
      pid: metric.pid,
      type: metric.type,
      memory: metric.memory,
    }));
  });

  ipcMain.handle('begin-animatic-export', async (event, settings = {}) => {
    const fps = [24, 30, 60].includes(Number(settings.fps)) ? Number(settings.fps) : 30;
    const requestedWidth = Number(settings.width);
    const requestedHeight = Number(settings.height);
    const width = Math.max(2, Math.min(4096, Math.round((Number.isFinite(requestedWidth) ? requestedWidth : 1920) / 2) * 2));
    const height = Math.max(2, Math.min(4096, Math.round((Number.isFinite(requestedHeight) ? requestedHeight : 1080) / 2) * 2));
    const defaultName = path.basename(String(settings.defaultName || 'refboard-animatic.mp4')).replace(/[^\w. -]/g, '_');
    const picked = await dialog.showSaveDialog(win, {
      title: 'Export RefBoard animatic',
      defaultPath: path.join(app.getPath('videos'), defaultName),
      filters: [{ name: 'H.264 video', extensions: ['mp4'] }],
    });
    if (picked.canceled || !picked.filePath) return { started: false };
    const token = crypto.randomUUID();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'refboard-animatic-'));
    animaticExportSessions.set(token, {
      token, ownerId: event.sender.id, dir, output: picked.filePath, fps, width, height,
      frames: [], audio: [],
      timer: setTimeout(() => {
        const stale = animaticExportSessions.get(token);
        animaticExportSessions.delete(token);
        discardAnimaticExportSession(stale);
      }, 30 * 60 * 1000),
    });
    return { started: true, token };
  });

  ipcMain.handle('append-animatic-frame', async (event, { token, frame } = {}) => {
    const session = animaticExportSessions.get(token);
    if (!session || session.ownerId !== event.sender.id) throw new Error('Unknown animatic export session');
    const index = session.frames.length;
    const name = `frame-${String(index).padStart(5, '0')}.png`;
    const duration = Math.max(1 / session.fps, Math.min(3600, Number(frame?.duration) || 1 / session.fps));
    await fs.writeFile(path.join(session.dir, name), Buffer.from(frame?.data || []));
    session.frames.push({ name, duration });
    return { appended: true, index };
  });

  ipcMain.handle('append-animatic-audio', async (event, { token, audio } = {}) => {
    const session = animaticExportSessions.get(token);
    if (!session || session.ownerId !== event.sender.id) throw new Error('Unknown animatic export session');
    if (session.audio.length >= 5) return { appended: false };
    const suppliedExt = path.extname(String(audio?.name || '')).toLowerCase();
    const ext = /^\.(wav|mp3|m4a|aac|ogg|flac|opus)$/i.test(suppliedExt) ? suppliedExt : '.audio';
    const name = `audio-${session.audio.length}${ext}`;
    await fs.writeFile(path.join(session.dir, name), Buffer.from(audio?.data || []));
    session.audio.push({
      name,
      start: Math.max(0, Number(audio?.start) || 0),
      sourceIn: Math.max(0, Number(audio?.sourceIn) || 0),
      duration: Math.max(1 / session.fps, Math.min(3600, Number(audio?.duration) || 1 / session.fps)),
      volume: Number.isFinite(Number(audio?.volume)) ? Math.max(0, Math.min(3.981072, Number(audio.volume))) : 1,
      envelope: normalizedAnimaticAudioEnvelope(audio?.envelope, audio?.duration),
    });
    return { appended: true };
  });

  ipcMain.handle('finish-animatic-export', async (event, token) => {
    const session = animaticExportSessions.get(token);
    if (!session || session.ownerId !== event.sender.id) throw new Error('Unknown animatic export session');
    animaticExportSessions.delete(token);
    clearTimeout(session.timer);
    try {
      if (!session.frames.length) throw new Error('The animatic has no visible frames');
      const concatLines = [];
      let totalDuration = 0;
      for (const frame of session.frames) {
        concatLines.push(`file '${frame.name}'`, `duration ${frame.duration.toFixed(8)}`);
        totalDuration += frame.duration;
      }
      concatLines.push(`file '${session.frames.at(-1).name}'`);
      await fs.writeFile(path.join(session.dir, 'frames.txt'), concatLines.join('\n'), 'utf8');
      const args = ['-y', '-f', 'concat', '-safe', '0', '-i', 'frames.txt'];
      for (const audio of session.audio) args.push('-ss', audio.sourceIn.toFixed(6), '-t', audio.duration.toFixed(6), '-i', audio.name);
      if (session.audio.length) {
        const filters = session.audio.map((audio, index) => {
          const delay = Math.round(audio.start * 1000);
          const envelope = animaticAudioEnvelopeExpression(audio.envelope);
          const volumeFilters = [`volume=${audio.volume}`];
          if (envelope) volumeFilters.push(`volume='${envelope}':eval=frame`);
          return `[${index + 1}:a]${volumeFilters.join(',')},adelay=${delay}|${delay}[a${index}]`;
        });
        filters.push(`${session.audio.map((_, i) => `[a${i}]`).join('')}amix=inputs=${session.audio.length}:duration=longest:dropout_transition=0[aout]`);
        args.push('-filter_complex', filters.join(';'), '-map', '0:v:0', '-map', '[aout]');
      } else {
        args.push('-map', '0:v:0');
      }
      args.push(
        '-r', String(session.fps), '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
        '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-t', totalDuration.toFixed(6),
      );
      if (session.audio.length) args.push('-c:a', 'aac', '-b:a', '192k');
      args.push(session.output);
      await runFfmpeg(args, session.dir);
      return { saved: true, filePath: session.output };
    } finally {
      await discardAnimaticExportSession(session);
    }
  });

  ipcMain.handle('abort-animatic-export', async (event, token) => {
    const session = animaticExportSessions.get(token);
    if (!session || session.ownerId !== event.sender.id) return { aborted: false };
    animaticExportSessions.delete(token);
    await discardAnimaticExportSession(session);
    return { aborted: true };
  });

  ipcMain.handle('begin-premiere-export', async (event, settings = {}) => {
    const defaultName = path.basename(String(settings.defaultName || 'refboard-animatic.xml')).replace(/[^\w. -]/g, '_');
    const picked = await dialog.showSaveDialog(win, {
      title: 'Export Premiere Pro timeline',
      defaultPath: path.join(app.getPath('videos'), defaultName),
      filters: [{ name: 'Premiere Pro XML timeline', extensions: ['xml'] }],
    });
    if (picked.canceled || !picked.filePath) return { started: false };
    const output = /\.xml$/i.test(picked.filePath) ? picked.filePath : `${picked.filePath}.xml`;
    const mediaDir = await createUniquePremiereMediaDir(output);
    const token = crypto.randomUUID();
    const session = {
      token,
      ownerId: event.sender.id,
      output,
      mediaDir,
      usedNames: new Set(),
      assetCount: 0,
      finished: false,
      tempPath: `${output}.refboard-${token}.tmp`,
      backupPath: `${output}.refboard-${token}.backup`,
      timer: null,
    };
    session.timer = setTimeout(() => {
      const stale = premiereExportSessions.get(token);
      premiereExportSessions.delete(token);
      discardPremiereExportSession(stale);
    }, 30 * 60 * 1000);
    premiereExportSessions.set(token, session);
    return { started: true, token, filePath: output, mediaDir };
  });

  ipcMain.handle('append-premiere-export-asset', async (event, { token, asset } = {}) => {
    const session = premiereExportSessions.get(token);
    if (!session || session.ownerId !== event.sender.id) throw new Error('Unknown Premiere export session');
    return appendCollectedExportAsset(session, asset, 'Premiere');
  });

  ipcMain.handle('finish-premiere-export', async (event, { token, xml } = {}) => {
    const session = premiereExportSessions.get(token);
    if (!session || session.ownerId !== event.sender.id) throw new Error('Unknown Premiere export session');
    const document = String(xml || '');
    if (!document.startsWith('<?xml') || !document.includes('<xmeml')) throw new Error('Invalid Premiere XML document');
    if (Buffer.byteLength(document, 'utf8') > 20 * 1024 * 1024) throw new Error('Premiere XML document is too large');
    premiereExportSessions.delete(token);
    clearTimeout(session.timer);
    try {
      await fs.writeFile(session.tempPath, document, 'utf8');
      let backedUp = false;
      try {
        await fs.rename(session.output, session.backupPath);
        backedUp = true;
      } catch (err) {
        if (err?.code !== 'ENOENT') throw err;
      }
      try {
        await fs.rename(session.tempPath, session.output);
      } catch (err) {
        if (backedUp) await fs.rename(session.backupPath, session.output).catch(() => {});
        throw err;
      }
      if (backedUp) await fs.rm(session.backupPath, { force: true });
      session.finished = true;
      return { saved: true, filePath: session.output, mediaDir: session.mediaDir, assetCount: session.assetCount };
    } finally {
      await discardPremiereExportSession(session);
    }
  });

  ipcMain.handle('abort-premiere-export', async (event, token) => {
    const session = premiereExportSessions.get(token);
    if (!session || session.ownerId !== event.sender.id) return { aborted: false };
    premiereExportSessions.delete(token);
    await discardPremiereExportSession(session);
    return { aborted: true };
  });

  ipcMain.handle('begin-after-effects-export', async (event, settings = {}) => {
    const defaultName = path.basename(String(settings.defaultName || 'refboard-animatic-after-effects.jsx')).replace(/[^\w. -]/g, '_');
    const picked = await dialog.showSaveDialog(win, {
      title: 'Export After Effects project builder',
      defaultPath: path.join(app.getPath('videos'), defaultName),
      filters: [{ name: 'After Effects project builder', extensions: ['jsx'] }],
    });
    if (picked.canceled || !picked.filePath) return { started: false };
    const output = /\.jsx$/i.test(picked.filePath) ? picked.filePath : `${picked.filePath}.jsx`;
    const mediaDir = await createUniqueAfterEffectsMediaDir(output);
    const token = crypto.randomUUID();
    const session = {
      token,
      ownerId: event.sender.id,
      output,
      mediaDir,
      usedNames: new Set(),
      assetCount: 0,
      finished: false,
      tempPath: `${output}.refboard-${token}.tmp`,
      backupPath: `${output}.refboard-${token}.backup`,
      timer: null,
    };
    session.timer = setTimeout(() => {
      const stale = afterEffectsExportSessions.get(token);
      afterEffectsExportSessions.delete(token);
      discardAfterEffectsExportSession(stale);
    }, 30 * 60 * 1000);
    afterEffectsExportSessions.set(token, session);
    return {
      started: true,
      token,
      filePath: output,
      mediaDir,
      mediaFolderName: path.basename(mediaDir),
      projectFileName: `${path.basename(output, path.extname(output))}.aep`,
    };
  });

  ipcMain.handle('append-after-effects-export-asset', async (event, { token, asset } = {}) => {
    const session = afterEffectsExportSessions.get(token);
    if (!session || session.ownerId !== event.sender.id) throw new Error('Unknown After Effects export session');
    return appendCollectedExportAsset(session, asset, 'After Effects');
  });

  ipcMain.handle('finish-after-effects-export', async (event, { token, script } = {}) => {
    const session = afterEffectsExportSessions.get(token);
    if (!session || session.ownerId !== event.sender.id) throw new Error('Unknown After Effects export session');
    const document = String(script || '');
    if (!document.startsWith('#target aftereffects') || !document.includes('RefBoard After Effects Project Builder')) throw new Error('Invalid After Effects project builder');
    if (Buffer.byteLength(document, 'utf8') > 20 * 1024 * 1024) throw new Error('After Effects project builder is too large');
    afterEffectsExportSessions.delete(token);
    clearTimeout(session.timer);
    try {
      await fs.writeFile(session.tempPath, document, 'utf8');
      let backedUp = false;
      try {
        await fs.rename(session.output, session.backupPath);
        backedUp = true;
      } catch (err) {
        if (err?.code !== 'ENOENT') throw err;
      }
      try {
        await fs.rename(session.tempPath, session.output);
      } catch (err) {
        if (backedUp) await fs.rename(session.backupPath, session.output).catch(() => {});
        throw err;
      }
      if (backedUp) await fs.rm(session.backupPath, { force: true });
      session.finished = true;
      return { saved: true, filePath: session.output, mediaDir: session.mediaDir, assetCount: session.assetCount };
    } finally {
      await discardAfterEffectsExportSession(session);
    }
  });

  ipcMain.handle('abort-after-effects-export', async (event, token) => {
    const session = afterEffectsExportSessions.get(token);
    if (!session || session.ownerId !== event.sender.id) return { aborted: false };
    afterEffectsExportSessions.delete(token);
    await discardAfterEffectsExportSession(session);
    return { aborted: true };
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

  ipcMain.handle('save-board-file', async (_, { defaultName, data, filePath, forceDialog = false }) => {
    let target = forceDialog ? null : filePath;
    if (!target) {
      const r = await dialog.showSaveDialog(win, {
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
      const r = await dialog.showSaveDialog(win, {
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
    const parts = boardImageParts(image, data);
    await session.handle.write((session.firstImage ? '' : ',') + parts.prefix);
    await session.handle.write(parts.base64);
    await session.handle.write(parts.suffix);
    session.firstImage = false;
    return { appended: true };
  });

  ipcMain.handle('finish-board-save', async (event, token) => {
    const session = boardSaveSessions.get(token);
    if (!session || session.ownerId !== event.sender.id) throw new Error('Unknown board save session');
    boardSaveSessions.delete(token);
    let backupPath = null;
    try {
      await session.handle.write(']}');
      await session.handle.sync();
      await session.handle.close();
      session.handle = null;

      if (fsSync.existsSync(session.target)) {
        backupPath = `${session.target}.backup-${process.pid}-${session.token}`;
        await fs.rename(session.target, backupPath);
      }
      await fs.rename(session.tempPath, session.target);
      if (backupPath) await fs.unlink(backupPath).catch(() => {});
      refreshShellIcons(session.target);
      return { saved: true, filePath: session.target };
    } catch (err) {
      if (backupPath && !fsSync.existsSync(session.target)) {
        await fs.rename(backupPath, session.target).catch(() => {});
      }
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

  ipcMain.handle('open-board-dialog', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Open RefBoard board',
      filters: [{ name: 'RefBoard board', extensions: ['refboard'] }],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths.length) return null;
    const filePath = r.filePaths[0];
    return { filePath };
  });

  ipcMain.handle('read-board-file', async (_, filePath) => {
    const data = await fs.readFile(filePath, 'utf8');
    return { filePath, data };
  });

  ipcMain.handle('begin-board-open', async (event, filePath) => {
    const resolved = path.resolve(String(filePath || ''));
    const scanned = await scanBoardFile(resolved);
    const token = crypto.randomUUID();
    boardOpenSessions.set(token, {
      token, ownerId: event.sender.id, filePath: resolved, images: scanned.images,
      timer: setTimeout(() => boardOpenSessions.delete(token), 5 * 60 * 1000),
    });
    return { token, core: scanned.core, images: scanned.images.map(({ dataStart, dataLength, ...meta }) => meta) };
  });

  ipcMain.handle('read-board-open-image', async (event, { token, index }) => {
    const session = boardOpenSessions.get(token);
    if (!session || session.ownerId !== event.sender.id) throw new Error('Unknown board open session');
    const image = session.images[index];
    if (!image) throw new Error('Unknown board image');
    return await readBoardImageBytes(session.filePath, image);
  });

  ipcMain.handle('finish-board-open', async (event, token) => {
    const session = boardOpenSessions.get(token);
    if (!session || session.ownerId !== event.sender.id) return { finished: false };
    clearTimeout(session.timer);
    boardOpenSessions.delete(token);
    return { finished: true };
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

  ipcMain.handle('get-board-preview', async (_, filePath) => {
    if (!filePath) return null;
    try {
      return await readBoardPreview(path.resolve(String(filePath)));
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
