'use strict';

/**
 * Large-board zoom flicker measurement.
 *
 * Builds a 500-image board of mixed source sizes, zooms in through the full
 * tier range, and counts how often an image redraws from a LOWER resolution
 * than it was already showing. Zoom only ever increases here, so every such
 * downgrade is a visible pop from sharp back to blurry -- the flicker.
 *
 * Draws are attributed to items exactly: the board transform at drawImage time
 * is inverted through the live view to recover the item's board-space centre,
 * which is constant per item, so no cross-frame guessing is involved.
 */

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'refboard-zoom-flicker-'));
app.setPath('userData', path.join(tempRoot, 'user-data'));
app.commandLine.appendSwitch('disable-gpu');
// Texture demand scales with the square of DPR. At 1 the whole visible board
// fits the budget comfortably, which is not the display any of this ships on.
app.commandLine.appendSwitch('force-device-scale-factor',
  String(Number(process.env.FLICKER_DPR) || 2));

const IMAGE_COUNT = Number(process.env.FLICKER_IMAGE_COUNT) || 500;
// Gentle steps at a realistic scroll cadence. A coarse sweep saturates the 100x
// zoom cap within a few frames and spends the run with two images on screen,
// which is exactly the case that never contends for budget.
const ZOOM_STEPS = Number(process.env.FLICKER_ZOOM_STEPS) || 60;
const ZOOM_DELTA = Number(process.env.FLICKER_ZOOM_DELTA) || -40;
const STEP_DELAY_MS = Number(process.env.FLICKER_STEP_DELAY_MS) || 50;
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

const buildFixture = count => `(async () => {
  const waitFrame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

  // Mixed source sizes. Anything at or below 2048 asks for the full tier as soon
  // as it exceeds the proxy on screen, so this mix exercises the shared budget
  // the way a real reference board does.
  const SIZES = [2048, 1200, 800, 512];
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

    const p = document.createElement('canvas');
    p.width = p.height = 256;
    const pg = p.getContext('2d');
    pg.fillStyle = '#315c9b';
    pg.fillRect(0, 0, 256, 256);
    pg.fillStyle = '#f4c66d';
    for (let y = 0; y < 256; y += 32) for (let x = 0; x < 256; x += 32) pg.fillRect(x, y, 16, 16);
    sources.set(size, { blob, proxy: p });
  }

  const COLS = 25;
  const items = [];
  const centres = new Map();
  for (let i = 0; i < ${count}; i++) {
    const size = SIZES[i % SIZES.length];
    const src = sources.get(size);
    const imgId = 'flicker-image-' + i;
    const item = {
      id: 'flicker-item-' + i, kind: 'image', imgId,
      x: (i % COLS) * 234, y: Math.floor(i / COLS) * 234,
      w: 210, h: 210, rot: 0, flipX: false, flipY: false, gray: false,
      crop: { l: 0, t: 0, r: 1, b: 1 }, groupId: null,
    };
    items.push(item);
    // Items sit on a fixed 234px lattice. Keying by lattice cell rather than raw
    // board coordinates keeps attribution exact at fit zoom, where one screen
    // pixel of float drift is worth several board units.
    centres.set((i % COLS) + ':' + Math.floor(i / COLS), item.id);
    RefBoard.images.set(imgId, {
      id: imgId, w: size, h: size, blob: src.blob, blobSize: src.blob.size,
      type: 'image/png', name: imgId + '.png', version: 0, bitmap: null,
      proxy: src.proxy, proxyW: 256, proxyH: 256,
      decodeFailed: false, decodeWasSkipped: false, fullLastUsed: 0, fullPinCount: 0,
      lod: { entries: new Map(), pending: new Map() },
    });
  }
  RefBoard.state.items = items;
  RefBoard.state.sel.clear();
  RefBoard.state.anchorId = null;
  await RefBoard.fitAll();
  await waitFrame();

  const board = document.querySelector('#board');
  const ctx = board.getContext('2d');
  const originalDrawImage = ctx.drawImage;
  const probe = window.__flicker = {
    centres,
    lastWidth: new Map(),
    downgrades: [],
    upgrades: 0,
    drawCalls: 0,
    matched: 0,
    unmatched: 0,
    sampling: false,
    zoomAtSample: 0,
  };

  ctx.drawImage = function(source, ...args) {
    if (probe.sampling && args.length === 8) {
      const v = RefBoard.state.view;
      const dpr = devicePixelRatio || 1;
      const t = this.getTransform();
      // The board item draw translates to the item centre before drawing, so the
      // transform inverts back to the item's lattice cell.
      const bx = (t.e / dpr - v.tx) / v.s;
      const by = (t.f / dpr - v.ty) / v.s;
      const col = Math.round((bx - 105) / 234);
      const row = Math.round((by - 105) / 234);
      const itemId = probe.centres.get(col + ':' + row);
      probe.drawCalls++;
      if (!itemId) probe.unmatched++;
      if (itemId) {
        probe.matched++;
        const width = Number(source?.width) || 0;
        const previous = probe.lastWidth.get(itemId);
        if (previous && width < previous) {
          probe.downgrades.push({ itemId, from: previous, to: width, zoom: probe.zoomAtSample });
          if (probe.downgrades.length > 4000) probe.downgrades.shift();
        } else if (previous && width > previous) {
          probe.upgrades++;
        }
        probe.lastWidth.set(itemId, width);
      }
    }
    return originalDrawImage.call(this, source, ...args);
  };

  const rect = board.getBoundingClientRect();
  return {
    itemCount: items.length,
    fitZoom: RefBoard.state.view.s,
    // Anchor the zoom well off-centre, as a cursor-anchored wheel does. Demand
    // is ranked by distance to the viewport centre, so an off-centre anchor
    // sweeps images across that ranking instead of holding it still.
    clientX: Math.round(rect.left + board.clientWidth * 0.80),
    clientY: Math.round(rect.top + board.clientHeight * 0.26),
  };
})()`;

async function run() {
  const rendererErrors = [];
  const win = new BrowserWindow({
    x: -32000, y: -32000, width: 1440, height: 900,
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

  const fixture = await win.webContents.executeJavaScript(buildFixture(IMAGE_COUNT));

  // Let proxies warm so the sweep measures tier churn, not first-paint.
  await delay(2500);
  await win.webContents.executeJavaScript('window.__flicker.sampling = true');

  const timeline = [];
  for (let step = 0; step < ZOOM_STEPS; step++) {
    await dispatchWheel(win, fixture.clientX, fixture.clientY, ZOOM_DELTA);
    await delay(STEP_DELAY_MS);
    timeline.push(await win.webContents.executeJavaScript(`(() => {
      const probe = window.__flicker;
      probe.zoomAtSample = RefBoard.state.view.s;
      return { zoom: RefBoard.state.view.s, downgrades: probe.downgrades.length, upgrades: probe.upgrades };
    })()`));
  }

  // Hold still: the view is fixed, so nothing may change resolution at all.
  await delay(1500);
  const beforeHold = await win.webContents.executeJavaScript('window.__flicker.downgrades.length');
  await delay(3500);

  const result = await win.webContents.executeJavaScript(`(async () => {
    const probe = window.__flicker;
    const byItem = new Map();
    for (const d of probe.downgrades) byItem.set(d.itemId, (byItem.get(d.itemId) || 0) + 1);
    const worst = [...probe.downgrades]
      .sort((a, b) => (b.from - b.to) - (a.from - a.to)).slice(0, 6);
    return {
      drawCalls: probe.drawCalls,
      matched: probe.matched,
      unmatched: probe.unmatched,
      itemsSeen: probe.lastWidth.size,
      upgrades: probe.upgrades,
      downgrades: probe.downgrades.length,
      itemsAffected: byItem.size,
      toProxy: probe.downgrades.filter(d => d.to === 256).length,
      worst,
      zoom: RefBoard.state.view.s,
      diagnostics: await RefBoard.memoryStats(),
    };
  })()`);
  result.downgradesWhileHolding = result.downgrades - beforeHold;
  result.fixture = fixture;
  result.timeline = timeline.filter((_, i) => i % 5 === 0 || i === timeline.length - 1);
  result.rendererErrors = rendererErrors;
  return result;
}

app.whenReady().then(async () => {
  try {
    const result = await run();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    app.exit(0);
  } catch (error) {
    process.stderr.write(`${error.stack || error}\n`);
    app.exit(1);
  }
});

app.on('will-quit', () => {
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});
