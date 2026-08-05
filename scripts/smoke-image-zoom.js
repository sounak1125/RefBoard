'use strict';

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'refboard-image-zoom-smoke-'));
app.setPath('userData', path.join(tempRoot, 'user-data'));
app.commandLine.appendSwitch('disable-gpu');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(win, expression, label, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await win.webContents.executeJavaScript(`Boolean(${expression})`);
      if (value) return;
    } catch { /* renderer may still be loading */ }
    await delay(80);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function dispatchWheel(win, fixture, deltaY) {
  return win.webContents.executeJavaScript(`(() => {
    const board = document.querySelector('#board');
    return board.dispatchEvent(new WheelEvent('wheel', {
      clientX: ${JSON.stringify(fixture.clientX)},
      clientY: ${JSON.stringify(fixture.clientY)},
      deltaY: ${JSON.stringify(deltaY)},
      bubbles: true,
      cancelable: true,
    }));
  })()`);
}

async function run() {
  const rendererErrors = [];
  const win = new BrowserWindow({
    x: -32000,
    y: -32000,
    width: 1440,
    height: 900,
    show: false,
    opacity: 0,
    skipTaskbar: true,
    backgroundColor: '#101116',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
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
  // RefBoard exposes its debug API just before async initialization finishes.
  // Let the pristine-profile landing transition complete before opening a board.
  await delay(750);
  await win.webContents.executeJavaScript('document.querySelector("#rwNewBoard").click()');
  await waitFor(win, 'document.body.classList.contains("board-active")', 'empty board');

  const fixture = await win.webContents.executeJavaScript(`(async () => {
    const waitFrame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const sourceSize = 2048;
    const sourceCanvas = document.createElement('canvas');
    sourceCanvas.width = sourceCanvas.height = sourceSize;
    const sourceCtx = sourceCanvas.getContext('2d');
    sourceCtx.fillStyle = '#315c9b';
    sourceCtx.fillRect(0, 0, sourceSize, sourceSize);
    sourceCtx.fillStyle = '#f4c66d';
    for (let y = 0; y < sourceSize; y += 128) {
      for (let x = (y / 128) % 2 ? 64 : 0; x < sourceSize; x += 128) {
        sourceCtx.fillRect(x, y, 64, 64);
      }
    }
    const blob = await new Promise(resolve => sourceCanvas.toBlob(resolve, 'image/png'));
    sourceCanvas.width = sourceCanvas.height = 0;
    if (!blob) throw new Error('Could not create zoom smoke source');

    const proxy = document.createElement('canvas');
    proxy.width = proxy.height = 256;
    const proxyCtx = proxy.getContext('2d');
    proxyCtx.fillStyle = '#315c9b';
    proxyCtx.fillRect(0, 0, 256, 256);
    proxyCtx.fillStyle = '#f4c66d';
    for (let y = 0; y < 256; y += 16) {
      for (let x = (y / 16) % 2 ? 8 : 0; x < 256; x += 16) proxyCtx.fillRect(x, y, 8, 8);
    }

    const items = [];
    for (let index = 0; index < 100; index++) {
      const row = Math.floor(index / 10);
      const col = index % 10;
      const imgId = 'zoom-smoke-image-' + index;
      const item = {
        id: 'zoom-smoke-item-' + index,
        kind: 'image',
        imgId,
        x: col * 234,
        y: row * 234,
        w: 210,
        h: 210,
        rot: 0,
        flipX: false,
        flipY: false,
        gray: false,
        crop: { l: 0, t: 0, r: 1, b: 1 },
        groupId: null,
      };
      items.push(item);
      RefBoard.images.set(imgId, {
        id: imgId,
        w: sourceSize,
        h: sourceSize,
        blob,
        blobSize: blob.size,
        type: 'image/png',
        name: imgId + '.png',
        version: 0,
        bitmap: null,
        proxy,
        proxyW: 256,
        proxyH: 256,
        decodeFailed: false,
        decodeWasSkipped: false,
        fullLastUsed: 0,
        fullPinCount: 0,
        lod: { entries: new Map(), pending: new Map() },
      });
    }
    RefBoard.state.items = items;
    RefBoard.state.sel.clear();
    RefBoard.state.anchorId = null;
    await RefBoard.fitAll();
    await waitFrame();

    const board = document.querySelector('#board');
    const rect = board.getBoundingClientRect();
    const view = RefBoard.state.view;
    const wantedX = board.clientWidth * 0.82;
    const wantedY = board.clientHeight * 0.52;
    const target = items
      .map(item => ({
        item,
        x: (item.x + item.w / 2) * view.s + view.tx,
        y: (item.y + item.h / 2) * view.s + view.ty,
      }))
      .filter(entry => entry.x > 0 && entry.x < board.clientWidth && entry.y > 0 && entry.y < board.clientHeight)
      .sort((a, b) => Math.hypot(a.x - wantedX, a.y - wantedY)
        - Math.hypot(b.x - wantedX, b.y - wantedY))[0];
    if (!target) throw new Error('No visible zoom smoke target');

    const ctx = board.getContext('2d');
    const originalDrawImage = ctx.drawImage;
    const smoke = window.__imageZoomSmoke = {
      itemId: target.item.id,
      imgId: target.item.imgId,
      x: target.x,
      y: target.y,
      startedAt: performance.now(),
      draws: [],
      sharpDraws: [],
    };
    ctx.drawImage = function(source, ...args) {
      const transform = this.getTransform();
      const dpr = devicePixelRatio || 1;
      const draw = {
        at: performance.now(),
        sourceWidth: Number(source?.width) || 0,
        smoothingEnabled: this.imageSmoothingEnabled,
        smoothingQuality: this.imageSmoothingQuality,
      };
      if (args.length === 8 && draw.sourceWidth > 256) {
        smoke.sharpDraws.push({ ...draw, x: transform.e / dpr, y: transform.f / dpr });
        if (smoke.sharpDraws.length > 200) smoke.sharpDraws.shift();
      }
      if (args.length === 8
          && Math.hypot(transform.e - smoke.x * dpr, transform.f - smoke.y * dpr) <= 4 * dpr) {
        smoke.draws.push(draw);
        if (smoke.draws.length > 200) smoke.draws.shift();
      }
      return originalDrawImage.call(this, source, ...args);
    };
    return {
      itemId: target.item.id,
      imgId: target.item.imgId,
      clientX: Math.round(rect.left + target.x),
      clientY: Math.round(rect.top + target.y),
      fitZoom: view.s,
      itemCount: items.length,
    };
  })()`);

  // Eight deterministic DOM wheel steps take the chosen 2048px source from a
  // fit-view proxy into full-tier demand.
  for (let step = 0; step < 8; step++) {
    await dispatchWheel(win, fixture, -250);
    await delay(35);
  }

  let navigationState = null;
  for (let attempt = 0; attempt < 40; attempt++) {
    // Near-zero wheel input keeps the navigation window open without materially
    // changing the zoom, proving that the ready tier appears before settle.
    await dispatchWheel(win, fixture, 0);
    await delay(70);
    navigationState = await win.webContents.executeJavaScript(`(() => {
      const smoke = window.__imageZoomSmoke;
      const image = RefBoard.images.get(smoke.imgId);
      const sharpDraw = smoke.sharpDraws.at(-1) || null;
      return {
        bitmapWidth: Number(image?.bitmap?.width) || 0,
        lodWidths: [...(image?.lod?.entries?.values?.() || [])].map(entry => entry.w),
        sharpDraw,
        latestDraw: smoke.draws.at(-1) || null,
        zoom: RefBoard.state.view.s,
        renderState: RefBoard.imageRenderState(smoke.itemId),
      };
    })()`);
    if (navigationState.sharpDraw) break;
  }

  if (!navigationState?.sharpDraw) {
    throw new Error(`Focused image did not sharpen during navigation: ${JSON.stringify({ fixture, navigationState })}`);
  }
  if (!navigationState.sharpDraw.smoothingEnabled
      || navigationState.sharpDraw.smoothingQuality !== 'high') {
    throw new Error(`Navigation changed configured smoothing: ${JSON.stringify(navigationState.sharpDraw)}`);
  }

  await delay(320);
  const settled = await win.webContents.executeJavaScript(`(async () => ({
    zoom: RefBoard.state.view.s,
    itemCount: RefBoard.state.items.length,
    targetBitmapWidth: Number(RefBoard.images.get(window.__imageZoomSmoke.imgId)?.bitmap?.width) || 0,
    latestDraw: window.__imageZoomSmoke.draws.at(-1) || null,
    diagnostics: await RefBoard.memoryStats(),
  }))()`);
  if (settled.itemCount !== 100 || !Number.isFinite(settled.zoom) || settled.zoom <= fixture.fitZoom) {
    throw new Error(`Zoom smoke board became invalid: ${JSON.stringify(settled)}`);
  }
  if (settled.diagnostics.lastBoardRenderError || rendererErrors.length) {
    throw new Error(`Renderer errors: ${JSON.stringify({
      diagnostic: settled.diagnostics.lastBoardRenderError,
      console: rendererErrors,
    })}`);
  }

  return { fixture, navigationState, settled };
}

app.whenReady().then(async () => {
  try {
    const result = await run();
    process.stdout.write(`image zoom Electron smoke passed ${JSON.stringify(result)}\n`);
    app.exit(0);
  } catch (error) {
    process.stderr.write(`${error.stack || error}\n`);
    app.exit(1);
  }
});

app.on('will-quit', () => {
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});
