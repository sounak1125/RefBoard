'use strict';

/**
 * Large-board steady-state sharpness measurement.
 *
 * The complaint this exists for: on a board of a few hundred images, some images
 * render visibly soft while their neighbours are sharp, and which ones shift as
 * you move around. That is not a drawing bug -- it is budget starvation. Every
 * visible image asks for a surface sized to its on-screen pixels, only the
 * closest ones that fit the decoded-image budget are granted it, and a refused
 * image falls back to whatever coarser surface it already has.
 *
 * So this measures the fallback directly. It fills a board, parks the view at a
 * realistic working zoom with a screenful of images, waits for steady state, and
 * reads the ACTUAL source surface each item was last drawn from by hooking
 * ctx.drawImage. Sharpness is that surface's long edge over the smaller of the
 * item's on-screen requirement and its own original size -- a ratio of 1 means
 * the image is as sharp as it can be, and anything under 0.85 is a surface being
 * stretched past the point where the softness shows.
 *
 * Then it pans, because the starved set is ranked by distance to the viewport
 * centre and therefore moves. The worst frame during the pan is the "glitch".
 *
 * Attribution is exact: items sit on a fixed lattice, and the board transform at
 * drawImage time inverts through the live view back to the item's lattice cell.
 *
 * Run: npm run test:sharpness-smoke
 */

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'refboard-sharpness-'));
app.setPath('userData', path.join(tempRoot, 'user-data'));
app.commandLine.appendSwitch('disable-gpu');
// Texture demand scales with DPR, and every display this ships on has one above
// 1. At 1 a screenful of images fits the old budget and the bug hides.
app.commandLine.appendSwitch('force-device-scale-factor',
  String(Number(process.env.SHARPNESS_DPR) || 2));

const IMAGE_COUNT = Number(process.env.SHARPNESS_IMAGE_COUNT) || 240;
/* A screenful of images at a size where detail matters. Zoom is chosen so each
   item is about this many CSS px on its long edge, which on the window below
   leaves roughly 40 images competing -- an ordinary way to look at a reference
   board, not a contrived one. */
const TARGET_ITEM_CSS_PX = Number(process.env.SHARPNESS_ITEM_PX) || 300;
const WINDOW_W = Number(process.env.SHARPNESS_WINDOW_W) || 2560;
const WINDOW_H = Number(process.env.SHARPNESS_WINDOW_H) || 1440;
const SOFT_RATIO = 0.85;
const PAN_STEPS = Number(process.env.SHARPNESS_PAN_STEPS) || 12;
/* Deliberately starve the budget to exercise the floor tier: with the pool this
   small almost nothing can be admitted at its target, so every drawn surface is
   the fallback. The point of the floor is that the fallback is still 512px. */
const MEMORY_MB = Number(process.env.SHARPNESS_MEMORY_MB) || 0;

const ITEM_SIZE = 210;
const LATTICE = 234;
const COLS = 20;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(win, expression, label, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      if (await win.webContents.executeJavaScript(`Boolean(${expression})`)) return;
    } catch { /* renderer may still be loading */ }
    await delay(80);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

const buildFixture = () => `(async () => {
  const waitFrame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

  /* Ordinary reference-board sizes. The two below 1024 are the important ones:
     an image whose original is smaller than the tier it needs decodes at full
     resolution instead of building a pointless oversized copy, so those land in
     the full-bitmap pool while the larger two land in the LOD pool. A real board
     is mostly the small kind. */
  const SIZES = [900, 760, 1400, 2048];
  const sources = new Map();
  for (const size of SIZES) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');
    g.fillStyle = '#315c9b';
    g.fillRect(0, 0, size, size);
    g.fillStyle = '#f4c66d';
    const cell = Math.max(4, Math.round(size / 16));
    for (let y = 0; y < size; y += cell * 2) {
      for (let x = 0; x < size; x += cell * 2) g.fillRect(x, y, cell, cell);
    }
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    c.width = c.height = 0;
    if (!blob) throw new Error('could not build source at ' + size);
    sources.set(size, blob);
  }

  const items = [];
  const centres = new Map();
  const sourceById = new Map();
  for (let i = 0; i < ${IMAGE_COUNT}; i++) {
    const size = SIZES[i % SIZES.length];
    const imgId = 'sharp-image-' + i;
    const item = {
      id: 'sharp-item-' + i, kind: 'image', imgId,
      x: (i % ${COLS}) * ${LATTICE}, y: Math.floor(i / ${COLS}) * ${LATTICE},
      w: ${ITEM_SIZE}, h: ${ITEM_SIZE}, rot: 0, flipX: false, flipY: false, gray: false,
      crop: { l: 0, t: 0, r: 1, b: 1 }, groupId: null,
    };
    items.push(item);
    centres.set((i % ${COLS}) + ':' + Math.floor(i / ${COLS}), item.id);
    sourceById.set(item.id, size);
    RefBoard.images.set(imgId, {
      id: imgId, w: size, h: size, blob: sources.get(size), blobSize: sources.get(size).size,
      type: 'image/png', name: imgId + '.png', version: 0, bitmap: null,
      proxy: null, proxyW: 0, proxyH: 0,
      decodeFailed: false, decodeWasSkipped: false, fullLastUsed: 0, fullPinCount: 0,
      lod: { entries: new Map(), pending: new Map() },
    });
  }
  ${MEMORY_MB ? `RefBoard.appSettings.imageMemoryMB = ${MEMORY_MB};` : ''}
  RefBoard.state.items = items;
  RefBoard.state.sel.clear();
  RefBoard.state.anchorId = null;
  await RefBoard.fitAll();
  await waitFrame();

  const board = document.querySelector('#board');
  const ctx = board.getContext('2d');
  const originalDrawImage = ctx.drawImage;
  const probe = window.__sharp = {
    centres,
    sourceById,
    drawn: new Map(),      // itemId -> long edge of the surface it last drew
    sampling: false,
  };

  ctx.drawImage = function(source, ...args) {
    if (probe.sampling && args.length === 8) {
      const v = RefBoard.state.view;
      const dpr = devicePixelRatio || 1;
      const t = this.getTransform();
      const bx = (t.e / dpr - v.tx) / v.s;
      const by = (t.f / dpr - v.ty) / v.s;
      const col = Math.round((bx - ${ITEM_SIZE / 2}) / ${LATTICE});
      const row = Math.round((by - ${ITEM_SIZE / 2}) / ${LATTICE});
      const itemId = probe.centres.get(col + ':' + row);
      if (itemId) {
        probe.drawn.set(itemId, Math.max(Number(source?.width) || 0, Number(source?.height) || 0));
      }
    }
    return originalDrawImage.call(this, source, ...args);
  };

  /* Park at a working zoom, centred on the middle of the lattice so the viewport
     is full of images rather than sitting past the edge of the board. */
  const zoom = ${TARGET_ITEM_CSS_PX} / ${ITEM_SIZE};
  const rows = Math.ceil(${IMAGE_COUNT} / ${COLS});
  const cx = (${COLS} - 1) * ${LATTICE} / 2 + ${ITEM_SIZE / 2};
  const cy = (rows - 1) * ${LATTICE} / 2 + ${ITEM_SIZE / 2};
  RefBoard.state.view.s = zoom;
  RefBoard.state.view.tx = board.clientWidth / 2 - cx * zoom;
  RefBoard.state.view.ty = board.clientHeight / 2 - cy * zoom;
  RefBoard.invalidate();
  await waitFrame();

  return {
    itemCount: items.length,
    zoom,
    dpr: devicePixelRatio || 1,
    deviceMemoryGiB: navigator.deviceMemory ?? null,
    viewport: { w: board.clientWidth, h: board.clientHeight },
  };
})()`;

/* One reading of the current frame: for every item drawn, how sharp the surface
   it drew actually was. */
const readSharpness = `(async () => {
  const probe = window.__sharp;
  const v = RefBoard.state.view;
  const dpr = Math.max(1, Math.min(2, devicePixelRatio || 1));
  const rows = [];
  for (const [itemId, drawnEdge] of probe.drawn) {
    const source = probe.sourceById.get(itemId) || 1;
    // Mirrors imageRequiredTexturePixels(): on-screen long edge in device px.
    const required = Math.max(1, Math.ceil(${ITEM_SIZE} * v.s * dpr));
    const ideal = Math.min(source, required);
    rows.push({ itemId, drawnEdge, source, required, ideal, ratio: drawnEdge / ideal });
  }
  rows.sort((a, b) => a.ratio - b.ratio);
  const byDrawnEdge = {};
  for (const r of rows) byDrawnEdge[r.drawnEdge] = (byDrawnEdge[r.drawnEdge] || 0) + 1;
  const ratios = rows.map(r => r.ratio);
  const proxied = rows.filter(r => r.drawnEdge <= 256 && r.ideal > 256);
  const soft = rows.filter(r => r.ratio < ${SOFT_RATIO});
  return {
    measured: rows.length,
    required: rows[0]?.required ?? 0,
    byDrawnEdge,
    proxied: proxied.length,
    soft: soft.length,
    sharp: rows.length - soft.length,
    minRatio: ratios.length ? Number(ratios[0].toFixed(3)) : null,
    medianRatio: ratios.length ? Number(ratios[Math.floor(ratios.length / 2)].toFixed(3)) : null,
    worst: rows.slice(0, 6).map(r => ({
      source: r.source, required: r.required, drawn: r.drawnEdge, ratio: Number(r.ratio.toFixed(3)),
    })),
    memory: (await RefBoard.memoryStats()).images,
  };
})()`;

async function sample(win, holdMs) {
  await win.webContents.executeJavaScript('window.__sharp.drawn.clear(); window.__sharp.sampling = true; RefBoard.invalidate();');
  await delay(holdMs);
  return win.webContents.executeJavaScript(readSharpness);
}

async function run() {
  const rendererErrors = [];
  const win = new BrowserWindow({
    x: -32000, y: -32000, width: WINDOW_W, height: WINDOW_H,
    show: false, opacity: 0, skipTaskbar: true, backgroundColor: '#101116',
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.webContents.on('console-message', details => {
    const message = details?.message || '';
    if (/Uncaught|SyntaxError|ReferenceError|TypeError|\[(?:image|board|lod)\].*failed/i.test(message)) {
      rendererErrors.push(message);
    }
  });

  win.showInactive();
  await win.loadFile(path.join(__dirname, '..', 'index.html'));
  await waitFor(win, 'window.RefBoard && document.querySelector("#rwNewBoard")', 'renderer API');
  await delay(750);
  await win.webContents.executeJavaScript('document.querySelector("#rwNewBoard").click()');
  await waitFor(win, 'document.body.classList.contains("board-active")', 'empty board');

  const fixture = await win.webContents.executeJavaScript(buildFixture());

  // Everything the renderer wants to decode for this view, it has had time to.
  await delay(6000);
  const settled = await sample(win, 900);

  /* Pan a screen's width. The starved set is ranked by distance to the viewport
     centre, so it slides as the view moves -- this is where a user watches
     images go soft and come back. */
  let worstDuringPan = settled;
  const panTrace = [];
  for (let step = 0; step < PAN_STEPS; step++) {
    await win.webContents.executeJavaScript(`(() => {
      RefBoard.state.view.tx -= ${Math.round(WINDOW_W / PAN_STEPS)};
      RefBoard.invalidate();
    })()`);
    const reading = await sample(win, 260);
    panTrace.push({ soft: reading.soft, proxied: reading.proxied, minRatio: reading.minRatio });
    if (reading.soft > worstDuringPan.soft) worstDuringPan = reading;
  }
  await delay(2500);
  const afterPan = await sample(win, 900);

  return { fixture, settled, worstDuringPan, afterPan, panTrace, rendererErrors };
}

app.whenReady().then(async () => {
  try {
    const result = await run();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    const bad = [];
    if (result.settled.soft > 0) bad.push(`${result.settled.soft} soft image(s) at rest`);
    if (result.afterPan.soft > 0) bad.push(`${result.afterPan.soft} soft image(s) after panning`);
    if (result.settled.proxied > 0) bad.push(`${result.settled.proxied} image(s) drawn from the 256px proxy`);
    if (result.rendererErrors.length) bad.push(`renderer errors: ${result.rendererErrors.length}`);
    if (bad.length) {
      process.stderr.write(`FAIL: ${bad.join('; ')}\n`);
      app.exit(1);
      return;
    }
    process.stdout.write('large-board sharpness smoke passed\n');
    app.exit(0);
  } catch (error) {
    process.stderr.write(`${error.stack || error}\n`);
    app.exit(1);
  }
});

app.on('will-quit', () => {
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});
