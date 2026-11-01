'use strict';
/**
 * Board export to a Viewer (.html) or a PDF, main-process side.
 *
 * The renderer encodes the images and builds the payload
 * (scripts/board-viewer-payload.mjs); this file owns the file system:
 *
 *   board-export-begin   save dialog (or a given path), then a temp file
 *                        holding the page head
 *   board-export-images  appends embedded images as base64 blocks
 *   board-export-finish  appends the payload and the runtime, then
 *                        viewer: renames the temp file over the target
 *                        pdf:    loads the page in a hidden, sandboxed window
 *                                in print mode, printToPDF, writes the PDF
 *   board-export-abort   drops the temp files
 *
 * The page is assembled here, not in the renderer, so the one place that
 * turns user text into HTML is escapeJsonForScript below.
 */
const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');
const os = require('os');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

/* PDF pages max out at 200 in (14,400 pt) a side; 96 CSS px per inch. */
const PDF_MAX_CSS_PX = 19200;
const PX_TO_PT = 0.75;
const PDF_READY_TIMEOUT_MS = 180_000;

const VIEWER_IMAGE_MIMES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif', 'image/bmp', 'image/svg+xml',
]);

function escapeHtmlText(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

/** JSON that is safe inside <script type="application/json">: no `<` survives. */
function escapeJsonForScript(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * The PDF page for a board of w x h board units: one page, scaled down (never
 * up) so neither side passes 200 in.
 */
function pdfPageLayout(w, h) {
  const W = Math.max(1, Number(w) || 1);
  const H = Math.max(1, Number(h) || 1);
  const scale = Math.min(1, PDF_MAX_CSS_PX / W, PDF_MAX_CSS_PX / H);
  const wPx = Math.min(PDF_MAX_CSS_PX, Math.max(1, Math.round(W * scale)));
  const hPx = Math.min(PDF_MAX_CSS_PX, Math.max(1, Math.round(H * scale)));
  return { scale, wPx, hPx, wPt: wPx * PX_TO_PT, hPt: hPx * PX_TO_PT, wIn: wPx / 96, hIn: hPx / 96 };
}

const MARK_TITLE = '<!--RB:TITLE-->';
const MARK_BODY = '<!--RB:BODY-->';

function viewerHead(template, title) {
  const at = template.indexOf(MARK_BODY);
  if (at < 0 || !template.includes(MARK_TITLE)) throw new Error('viewer template is missing its markers');
  return template.slice(0, at).replace(MARK_TITLE, escapeHtmlText(title));
}

function viewerImageBlock(index, mime, base64) {
  if (!Number.isInteger(index) || index < 0) throw new Error('bad image index');
  if (!VIEWER_IMAGE_MIMES.has(mime)) throw new Error(`unsupported image type ${mime}`);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new Error('image data is not base64');
  return `<script type="text/plain" data-rb-img="${index}" data-mime="${mime}">${base64}</script>\n`;
}

function viewerTail(template, payload, runtime) {
  const at = template.indexOf(MARK_BODY);
  if (at < 0) throw new Error('viewer template is missing its markers');
  if (/<\/script|<script|<!--/i.test(runtime)) throw new Error('viewer runtime must not contain script tags or <!--');
  return `<script type="application/json" id="rb-payload">${escapeJsonForScript(payload)}</script>\n`
    + `<script>${runtime}</script>\n`
    + template.slice(at + MARK_BODY.length);
}

/** The whole page in one string (tests; the exporter streams the same parts). */
function assembleViewerHtml({ template, runtime, title, payload, images = [] }) {
  return viewerHead(template, title)
    + images.map((im, i) => viewerImageBlock(i, im.mime, im.base64)).join('')
    + viewerTail(template, payload, runtime);
}

const CSS_COLOR_RE = /^#[0-9a-f]{3,8}$/i;

/** Checks the renderer's payload is the shape the runtime expects. */
function validatePayload(payload, imageCount) {
  if (!payload || typeof payload !== 'object' || payload.v !== 1) throw new Error('bad export payload');
  if (!Array.isArray(payload.items) || !Array.isArray(payload.images)) throw new Error('bad export payload');
  if (payload.images.length !== imageCount) throw new Error(`payload lists ${payload.images.length} images, received ${imageCount}`);
  const b = payload.bounds;
  if (!b || ![b.x, b.y, b.w, b.h].every(Number.isFinite) || b.w <= 0 || b.h <= 0) throw new Error('bad board bounds');
  if (!CSS_COLOR_RE.test(String(payload.bg || ''))) throw new Error('bad board colour');
}

async function replaceFile(target, temp) {
  for (let attempt = 0; ; attempt++) {
    try { await fs.rename(temp, target); return; } catch (err) {
      if (attempt >= 8 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
      await new Promise(r => setTimeout(r, 60 * (attempt + 1)));
    }
  }
}

async function writeFileAtomic(target, data) {
  const temp = `${target}.exporting-${process.pid}-${crypto.randomUUID()}`;
  let handle = null;
  try {
    handle = await fs.open(temp, 'wx');
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = null;
    await replaceFile(target, temp);
  } catch (err) {
    await handle?.close().catch(() => {});
    await fs.unlink(temp).catch(() => {});
    throw err;
  }
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms); }),
  ]);
}

/**
 * Prints `htmlPath` to PDF bytes in a hidden window that can reach nothing
 * but that file and its own data:/blob: URLs.
 */
async function renderPdf({ BrowserWindow, session }, htmlPath, layout, hooks = {}) {
  const ses = pdfSessionFor(session);
  const partition = PDF_PARTITION;
  const pageUrl = pathToFileURL(htmlPath).href;
  const blocked = [];
  pdfAllowedPages.add(pageUrl);
  const win = new BrowserWindow({
    show: false,
    width: Math.min(1600, Math.max(400, Math.round(layout.wPx))),
    height: Math.min(1200, Math.max(300, Math.round(layout.hPx))),
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      partition,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  const wcId = win.webContents.id;
  pdfBlockedBy.set(wcId, blocked);
  hooks.onWindow?.(win);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  try {
    await win.loadURL(pageUrl);
    const ready = await withTimeout(
      win.webContents.executeJavaScript('window.__refboardViewerReady', true),
      PDF_READY_TIMEOUT_MS, 'PDF page');
    if (!ready || !ready.ok) throw new Error(`PDF page not ready: ${ready?.error || 'unknown'}`);
    const data = await win.webContents.printToPDF({
      printBackground: true,
      preferCSSPageSize: true,
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
    });
    return { data, blocked, images: ready.images };
  } finally {
    if (!win.isDestroyed()) win.destroy();
    pdfBlockedBy.delete(wcId);
    pdfAllowedPages.delete(pageUrl);
    if (!pdfAllowedPages.size) await ses.clearStorageData().catch(() => {});
  }
}

/* Every PDF export shares one in-memory partition. Electron never frees a
   partition, so a fresh one per export would stay in memory until quit. The
   request filter is installed once and lets through only the pages of the
   exports running now, plus their own data:/blob: URLs. */
const PDF_PARTITION = 'refboard-pdf';
const pdfAllowedPages = new Set();
const pdfBlockedBy = new Map();   // webContents id -> blocked URLs, for the caller
let pdfSession = null;

function pdfSessionFor(session) {
  if (pdfSession) return pdfSession;
  pdfSession = session.fromPartition(PDF_PARTITION, { cache: false });
  pdfSession.webRequest.onBeforeRequest((details, callback) => {
    const url = details.url || '';
    if (pdfAllowedPages.has(url) || url.startsWith('data:') || url.startsWith('blob:')) callback({});
    else {
      pdfBlockedBy.get(details.webContentsId)?.push(url);
      callback({ cancel: true });
    }
  });
  pdfSession.setPermissionRequestHandler((_wc, _perm, callback) => callback(false));
  return pdfSession;
}

function registerBoardExportIpc({ ipcMain, dialog, app, BrowserWindow, session, windowForEvent, runtimePath, templatePath }) {
  const sessions = new Map();
  let lastPdfWindowId = null;

  async function cleanup(s) {
    sessions.delete(s.token);
    await s.handle?.close().catch(() => {});
    s.handle = null;
    if (s.tempPath) await fs.unlink(s.tempPath).catch(() => {});
    if (s.tempDir) await fs.rm(s.tempDir, { recursive: true, force: true }).catch(() => {});
  }

  function sessionFor(event, token) {
    const s = sessions.get(token);
    if (!s || s.ownerId !== event.sender.id) throw new Error('No such board export');
    return s;
  }

  ipcMain.handle('board-export-begin', async (event, { kind, defaultName, title, filePath } = {}) => {
    if (kind !== 'viewer' && kind !== 'pdf') throw new Error('Unknown export format');
    const ext = kind === 'pdf' ? 'pdf' : 'html';
    let target = typeof filePath === 'string' && filePath ? filePath : null;
    if (!target) {
      const safeName = String(defaultName || 'board').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'board';
      const r = await dialog.showSaveDialog(windowForEvent(event), {
        title: kind === 'pdf' ? 'Export board as PDF' : 'Export board as Viewer',
        defaultPath: path.join(app.getPath('documents'), `${safeName}.${ext}`),
        filters: kind === 'pdf'
          ? [{ name: 'PDF document', extensions: ['pdf'] }]
          : [{ name: 'Web page (Viewer)', extensions: ['html'] }],
      });
      if (r.canceled || !r.filePath) return { started: false };
      target = r.filePath;
    }
    target = path.resolve(target);
    const [template, runtime] = await Promise.all([
      fs.readFile(templatePath, 'utf8'),
      fs.readFile(runtimePath, 'utf8'),
    ]);
    const token = crypto.randomUUID();
    const s = { token, kind, target, ownerId: event.sender.id, template, runtime, handle: null, tempPath: null, tempDir: null, images: 0, chain: Promise.resolve(), bytes: 0 };
    if (kind === 'pdf') {
      s.tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'refboard-pdf-'));
      s.tempPath = path.join(s.tempDir, 'board.html');
    } else {
      s.tempPath = `${target}.exporting-${process.pid}-${token}`;
    }
    sessions.set(token, s);
    try {
      s.handle = await fs.open(s.tempPath, 'wx');
      const head = viewerHead(template, String(title || defaultName || 'Board'));
      await s.handle.write(head);
      s.bytes += Buffer.byteLength(head);
    } catch (err) {
      await cleanup(s);
      throw err;
    }
    return { started: true, token, filePath: target };
  });

  ipcMain.handle('board-export-images', async (event, { token, images } = {}) => {
    const s = sessionFor(event, token);
    const list = Array.isArray(images) ? images : [];
    const run = s.chain.then(async () => {
      for (const im of list) {
        const index = Number(im?.index);
        if (index !== s.images) throw new Error(`image ${index} arrived out of order (expected ${s.images})`);
        const bytes = im.data instanceof Uint8Array ? Buffer.from(im.data.buffer, im.data.byteOffset, im.data.byteLength) : null;
        if (!bytes) throw new Error('image data missing');
        const block = viewerImageBlock(index, String(im.mime || ''), bytes.toString('base64'));
        await s.handle.write(block);
        s.bytes += block.length;
        s.images++;
      }
      return { written: s.images };
    });
    s.chain = run.catch(() => {});
    try { return await run; } catch (err) { await cleanup(s); throw err; }
  });

  ipcMain.handle('board-export-finish', async (event, { token, payload } = {}) => {
    const s = sessionFor(event, token);
    try {
      await s.chain;
      validatePayload(payload, s.images);
      let layout = null;
      if (s.kind === 'pdf') {
        layout = pdfPageLayout(payload.bounds.w, payload.bounds.h);
        const bg = payload.print?.bg === 'white' ? '#ffffff' : payload.bg;
        payload = { ...payload, allowSave: 0, print: { scale: layout.scale, wPx: layout.wPx, hPx: layout.hPx, bg } };
      } else if (payload.print) {
        payload = { ...payload, print: undefined };
      }
      const tail = viewerTail(s.template, payload, s.runtime);
      await s.handle.write(tail);
      s.bytes += Buffer.byteLength(tail);
      await s.handle.sync();
      await s.handle.close();
      s.handle = null;
      if (s.aborted) throw new Error('Export cancelled');
      if (s.kind === 'viewer') {
        await replaceFile(s.target, s.tempPath);
        s.tempPath = null;
        await cleanup(s);
        return { saved: true, filePath: s.target, bytes: s.bytes, images: s.images };
      }
      const tempHtml = s.tempPath;
      const out = await renderPdf({ BrowserWindow, session }, tempHtml, layout, {
        onWindow: win => { lastPdfWindowId = win.id; },
      });
      // Cancelled while the PDF was printing: keep the old file, write nothing.
      if (s.aborted) throw new Error('Export cancelled');
      await writeFileAtomic(s.target, out.data);
      await cleanup(s);
      return {
        saved: true, filePath: s.target, bytes: out.data.length, images: s.images,
        page: { wPt: layout.wPt, hPt: layout.hPt, scale: layout.scale },
        blockedRequests: out.blocked.length,
        tempHtml, windowId: lastPdfWindowId,
      };
    } catch (err) {
      await cleanup(s);
      throw err;
    }
  });

  ipcMain.handle('board-export-abort', async (event, token) => {
    const s = sessions.get(token);
    if (!s || s.ownerId !== event.sender.id) return { aborted: false };
    s.aborted = true;
    await s.chain.catch(() => {});
    await cleanup(s);
    return { aborted: true };
  });

  return {
    activeSessions: () => sessions.size,
    pendingTempFiles: () => [...sessions.values()].map(s => s.tempPath).filter(p => p && fsSync.existsSync(p)),
  };
}

module.exports = {
  PDF_MAX_CSS_PX,
  pdfPageLayout,
  escapeHtmlText,
  escapeJsonForScript,
  viewerHead,
  viewerImageBlock,
  viewerTail,
  assembleViewerHtml,
  validatePayload,
  registerBoardExportIpc,
};
