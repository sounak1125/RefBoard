'use strict';

/**
 * Steady-view blur flicker measurement.
 *
 * The complaint: on a board of a few hundred images, images pop between sharp
 * and soft without the zoom changing -- while holding still, while panning at a
 * fixed zoom, and in the second after a zoom settles. The zoom smoke never
 * caught it because it zooms to the 100x cap and spends the run with two images
 * on screen; the sharpness smoke reads one surface per item per sample and so
 * cannot see an alternation.
 *
 * This one parks a screenful of images at a working zoom, under a decoded-image
 * budget the visible set cannot fit, and counts every redraw of an item from a
 * LOWER-resolution surface than the frame before, in four phases: holding
 * still, panning at fixed zoom, holding again, and holding after a short zoom
 * in. In none of those does an item's on-screen requirement shrink, so every
 * such downgrade is a visible pop. An item that was not drawn in the previous
 * frame left the viewport and came back; its first redraw is a fresh baseline,
 * not a downgrade, because nobody saw the swap.
 *
 * The budget is deliberately the smallest the settings pane offers. The bug is
 * a budget-contention loop -- a full bitmap that is still on screen is evicted
 * to make room for another and then re-requested -- and at the default budget a
 * 1440p screenful fits, so nothing contends. A 500-image board on a laptop, or
 * a 2000-image board anywhere, does not fit, and that is what users report.
 *
 * Attribution is exact: items sit on a fixed lattice and the board transform at
 * drawImage time inverts through the live view to the item's cell. Frames are
 * counted by hooking the full-viewport clear at the top of draw().
 *
 * Run: npm run test:steady-flicker-smoke
 */

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'refboard-steady-flicker-'));
app.setPath('userData', path.join(tempRoot, 'user-data'));
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('force-device-scale-factor',
  String(Number(process.env.FLICKER_DPR) || 2));

const IMAGE_COUNT = Number(process.env.FLICKER_IMAGE_COUNT) || 500;
const TARGET_ITEM_CSS_PX = Number(process.env.FLICKER_ITEM_PX) || 300;
const WINDOW_W = Number(process.env.FLICKER_WINDOW_W) || 2560;
const WINDOW_H = Number(process.env.FLICKER_WINDOW_H) || 1440;
const MEMORY_MB = Number(process.env.FLICKER_MEMORY_MB) || 256;
const HOLD_MS = Number(process.env.FLICKER_HOLD_MS) || 5000;
const PAN_STEPS = Number(process.env.FLICKER_PAN_STEPS) || 8;
const ZOOM_STEPS = Number(process.env.FLICKER_ZOOM_STEPS) || 3;

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

function dispatchWheel(win, x, y, deltaY) {
  return win.webContents.executeJavaScript(`(() => document.querySelector('#board').dispatchEvent(
    new WheelEvent('wheel', {
      clientX: ${JSON.stringify(x)}, clientY: ${JSON.stringify(y)},
      deltaY: ${JSON.stringify(deltaY)}, bubbles: true, cancelable: true,
    })))()`);
}

const buildFixture = () => `(async () => {
  const waitFrame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

  /* Ordinary reference-board sizes. Sources smaller than the tier they need
     decode at full resolution rather than building an oversized copy, so the
     900 and 760 land in the full-bitmap pool -- the pool this measures. */
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
    const imgId = 'steady-image-' + i;
    const item = {
      id: 'steady-item-' + i, kind: 'image', imgId,
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
  RefBoard.appSettings.imageMemoryMB = ${MEMORY_MB};
  RefBoard.state.items = items;
  RefBoard.state.sel.clear();
  RefBoard.state.anchorId = null;
  await RefBoard.fitAll();
  await waitFrame();

  const board = document.querySelector('#board');
  const ctx = board.getContext('2d');
  const originalDrawImage = ctx.drawImage;
  const originalFillRect = ctx.fillRect;
  const probe = window.__steady = {
    centres,
    sourceById,
    frame: 0,
    last: new Map(),       // itemId -> { edge, frame } of its most recent draw
    downgrades: [],
    upgrades: 0,
    reentries: 0,
    matched: 0,
    unmatched: 0,
    sampling: false,
    phase: 'warm',
  };

  // draw() opens every frame by clearing the whole viewport. Nothing else fills
  // a rectangle that large from the origin, so this is the frame boundary.
  ctx.fillRect = function(x, y, w, h) {
    if (x === 0 && y === 0 && w >= board.clientWidth - 1 && h >= board.clientHeight - 1) probe.frame++;
    return originalFillRect.call(this, x, y, w, h);
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
      if (!itemId) { probe.unmatched++; }
      else {
        probe.matched++;
        const edge = Math.max(Number(source?.width) || 0, Number(source?.height) || 0);
        const previous = probe.last.get(itemId);
        if (previous && previous.frame < probe.frame - 1) {
          // Not drawn last frame: it was off screen. A fresh baseline, not a pop.
          probe.reentries++;
        } else if (previous && edge < previous.edge) {
          probe.downgrades.push({ itemId, from: previous.edge, to: edge, phase: probe.phase, frame: probe.frame });
          if (probe.downgrades.length > 4000) probe.downgrades.shift();
        } else if (previous && edge > previous.edge) {
          probe.upgrades++;
        }
        probe.last.set(itemId, { edge, frame: probe.frame });
      }
    }
    return originalDrawImage.call(this, source, ...args);
  };

  const zoom = ${TARGET_ITEM_CSS_PX} / ${ITEM_SIZE};
  const rows = Math.ceil(${IMAGE_COUNT} / ${COLS});
  const cx = (${COLS} - 1) * ${LATTICE} / 2 + ${ITEM_SIZE / 2};
  const cy = (rows - 1) * ${LATTICE} / 2 + ${ITEM_SIZE / 2};
  RefBoard.state.view.s = zoom;
  RefBoard.state.view.tx = board.clientWidth / 2 - cx * zoom;
  RefBoard.state.view.ty = board.clientHeight / 2 - cy * zoom;
  RefBoard.invalidate();
  await waitFrame();

  const rect = board.getBoundingClientRect();
  return {
    itemCount: items.length,
    zoom,
    memoryMB: ${MEMORY_MB},
    dpr: devicePixelRatio || 1,
    viewport: { w: board.clientWidth, h: board.clientHeight },
    // Off-centre, as a cursor-anchored wheel is: demand is ranked by distance to
    // the viewport centre, so an off-centre anchor reshuffles that ranking.
    clientX: Math.round(rect.left + board.clientWidth * 0.72),
    clientY: Math.round(rect.top + board.clientHeight * 0.30),
  };
})()`;

const readProbe = `(async () => {
  const probe = window.__steady;
  const byPhase = {};
  const byTransition = {};
  for (const d of probe.downgrades) {
    byPhase[d.phase] = (byPhase[d.phase] || 0) + 1;
    const key = d.phase + ' ' + d.from + '->' + d.to;
    byTransition[key] = (byTransition[key] || 0) + 1;
  }
  const byItem = new Map();
  for (const d of probe.downgrades) byItem.set(d.itemId, (byItem.get(d.itemId) || 0) + 1);
  return {
    frames: probe.frame,
    matched: probe.matched,
    unmatched: probe.unmatched,
    itemsSeen: probe.last.size,
    upgrades: probe.upgrades,
    reentries: probe.reentries,
    downgrades: probe.downgrades.length,
    itemsAffected: byItem.size,
    byPhase,
    byTransition,
    memory: (await RefBoard.memoryStats()).images,
  };
})()`;

const setPhase = (win, phase) =>
  win.webContents.executeJavaScript(`window.__steady.phase = ${JSON.stringify(phase)}; window.__steady.sampling = true; RefBoard.invalidate();`);

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

  // Let the first wave of proxies, floors and decodes land: this run measures
  // steady state, not first paint.
  await delay(5000);

  // 1. Hold still. Nothing may change resolution.
  await setPhase(win, 'hold');
  await delay(HOLD_MS);

  // 2. Pan a screen's width at fixed zoom. An item's requirement is unchanged
  //    while it stays on screen, so a downgrade of a continuously visible item
  //    is a pop; items that leave and return are excluded by the frame check.
  await setPhase(win, 'pan');
  for (let step = 0; step < PAN_STEPS; step++) {
    await win.webContents.executeJavaScript(`(() => {
      RefBoard.state.view.tx -= ${Math.round(WINDOW_W / PAN_STEPS / 2)};
      RefBoard.invalidate();
    })()`);
    await delay(200);
  }

  // 3. Hold again after the pan.
  await delay(1500);
  await setPhase(win, 'hold-after-pan');
  await delay(HOLD_MS);

  // 4. A short wheel zoom in, then hold. Requirements only grew, so once the
  //    wheel settles no item may redraw softer than it was.
  for (let step = 0; step < ZOOM_STEPS; step++) {
    await dispatchWheel(win, fixture.clientX, fixture.clientY, -60);
    await delay(60);
  }
  await delay(400);
  await setPhase(win, 'hold-after-zoom');
  await delay(HOLD_MS);

  const result = await win.webContents.executeJavaScript(readProbe);
  return { fixture, result, rendererErrors };
}

app.whenReady().then(async () => {
  try {
    const { fixture, result, rendererErrors } = await run();
    process.stdout.write(`${JSON.stringify({ fixture, result, rendererErrors }, null, 2)}\n`);
    const phases = result.byPhase || {};
    const bad = [];
    if (result.matched < 20) bad.push(`attribution matched only ${result.matched} draws`);
    for (const phase of ['hold', 'pan', 'hold-after-pan', 'hold-after-zoom']) {
      if (phases[phase] > 0) bad.push(`${phases[phase]} downgrade(s) of a visible image during ${phase}`);
    }
    if (rendererErrors.length) bad.push(`renderer errors: ${rendererErrors.length}`);
    if (bad.length) {
      process.stderr.write(`FAIL: ${bad.join('; ')}\n`);
      app.exit(1);
      return;
    }
    process.stdout.write('steady-view flicker smoke passed\n');
    app.exit(0);
  } catch (error) {
    process.stderr.write(`${error.stack || error}\n`);
    app.exit(1);
  }
});

app.on('will-quit', () => {
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});
