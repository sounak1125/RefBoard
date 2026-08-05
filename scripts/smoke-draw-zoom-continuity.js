'use strict';

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'refboard-draw-zoom-continuity-smoke-'));
app.setPath('userData', path.join(tempRoot, 'user-data'));
app.commandLine.appendSwitch('disable-gpu');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(win, expression, label, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await win.webContents.executeJavaScript(`Boolean(${expression})`);
      if (value) return;
    } catch { /* renderer may still be loading */ }
    await delay(60);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function dispatchPointer(win, type, point, buttons) {
  return win.webContents.executeJavaScript(`(() => {
    const board = document.querySelector('#board');
    return board.dispatchEvent(new PointerEvent(${JSON.stringify(type)}, {
      clientX: ${point.x},
      clientY: ${point.y},
      button: 0,
      buttons: ${buttons},
      pointerId: 91,
      pointerType: 'mouse',
      isPrimary: true,
      bubbles: true,
      cancelable: true,
    }));
  })()`);
}

function dispatchZeroWheel(win, point) {
  return win.webContents.executeJavaScript(`(() => {
    const board = document.querySelector('#board');
    return board.dispatchEvent(new WheelEvent('wheel', {
      clientX: ${point.x},
      clientY: ${point.y},
      deltaY: 0,
      bubbles: true,
      cancelable: true,
    }));
  })()`);
}

async function run() {
  const rendererErrors = [];
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
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
    if (/Uncaught|SyntaxError|ReferenceError|TypeError|\[(?:draw|image|board|lod)\].*failed/i.test(message)) {
      rendererErrors.push(message);
    }
  });

  await win.loadFile(path.join(__dirname, '..', 'index.html'));
  await waitFor(win, 'window.RefBoard && document.querySelector("#rwNewBoard")', 'renderer API');
  await delay(750);
  await win.webContents.executeJavaScript('document.querySelector("#rwNewBoard").click()');
  await waitFor(win, 'document.body.classList.contains("board-active")', 'empty board');

  const fixture = await win.webContents.executeJavaScript(`(async () => {
    const waitFrame = () => new Promise(resolve =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const source = document.createElement('canvas');
    source.width = 1600;
    source.height = 1200;
    const sourceCtx = source.getContext('2d');
    sourceCtx.fillStyle = '#ffffff';
    sourceCtx.fillRect(0, 0, source.width, source.height);
    const blob = await new Promise(resolve => source.toBlob(resolve, 'image/png'));
    source.width = source.height = 0;
    if (!blob) throw new Error('Could not create draw/zoom smoke source');

    await RefBoard.addImages([
      new File([blob], 'draw-zoom-source.png', { type: 'image/png' }),
    ]);
    const item = RefBoard.state.items[0];
    if (!item) throw new Error('Draw/zoom source image was not added');
    item.x = 0;
    item.y = 0;
    item.w = 800;
    item.h = 600;
    item.crop = { l: 0, t: 0, r: 1, b: 1 };
    RefBoard.state.sel.clear();
    RefBoard.state.anchorId = null;

    const board = document.querySelector('#board');
    const rect = board.getBoundingClientRect();
    RefBoard.state.view.s = 0.5;
    RefBoard.state.view.tx = board.clientWidth / 2 - (item.x + item.w / 2) * RefBoard.state.view.s;
    RefBoard.state.view.ty = board.clientHeight / 2 - (item.y + item.h / 2) * RefBoard.state.view.s;

    // Synthetic PointerEvents need a small capture shim to exercise the same
    // asynchronous drawing preparation path as native input.
    const capturedPointers = new Set();
    board.setPointerCapture = pointerId => capturedPointers.add(pointerId);
    board.hasPointerCapture = pointerId => capturedPointers.has(pointerId);
    board.releasePointerCapture = pointerId => capturedPointers.delete(pointerId);

    const nativeCreateImageBitmap = window.createImageBitmap.bind(window);
    window.__drawZoomContinuitySmoke = {
      itemId: item.id,
      imgId: item.imgId,
      delayNextProxyMs: 0,
      proxyDelayStarted: false,
      proxyDelayFinished: false,
      sampleBoard() {
        const boardCanvas = document.querySelector('#board');
        const current = RefBoard.state.items.find(entry => entry.id === this.itemId);
        if (!boardCanvas || !current) return null;
        const view = RefBoard.state.view;
        const dpr = devicePixelRatio || 1;
        const centerX = Math.round(((current.x + current.w / 2) * view.s + view.tx) * dpr);
        const centerY = Math.round(((current.y + current.h / 2) * view.s + view.ty) * dpr);
        const radius = Math.max(6, Math.round(8 * dpr));
        const x = Math.max(0, centerX - radius);
        const y = Math.max(0, centerY - radius);
        const w = Math.min(radius * 2 + 1, boardCanvas.width - x);
        const h = Math.min(radius * 2 + 1, boardCanvas.height - y);
        if (w <= 0 || h <= 0) return null;
        const pixels = boardCanvas.getContext('2d').getImageData(x, y, w, h).data;
        let darkest = 255;
        for (let index = 0; index < pixels.length; index += 4) {
          darkest = Math.min(darkest,
            Math.max(pixels[index], pixels[index + 1], pixels[index + 2]));
        }
        return { darkest };
      },
      sampleLod() {
        const current = RefBoard.state.items.find(entry => entry.id === this.itemId);
        const image = current && RefBoard.images.get(current.imgId);
        const target = RefBoard.imageRenderState(this.itemId)?.displayTarget;
        const entry = image?.lod?.entries?.get(target);
        if (!entry?.bitmap) return null;
        const sample = document.createElement('canvas');
        sample.width = entry.w;
        sample.height = entry.h;
        const sampleCtx = sample.getContext('2d', { willReadFrequently: true });
        sampleCtx.drawImage(entry.bitmap, 0, 0);
        const radius = 4;
        const x = Math.max(0, Math.floor(entry.w / 2) - radius);
        const y = Math.max(0, Math.floor(entry.h / 2) - radius);
        const pixels = sampleCtx.getImageData(
          x,
          y,
          Math.min(radius * 2 + 1, entry.w - x),
          Math.min(radius * 2 + 1, entry.h - y),
        ).data;
        let darkest = 255;
        for (let index = 0; index < pixels.length; index += 4) {
          darkest = Math.min(darkest,
            Math.max(pixels[index], pixels[index + 1], pixels[index + 2]));
        }
        sample.width = sample.height = 0;
        return { darkest, target, width: entry.w, version: Number(image.version) || 0 };
      },
    };

    window.createImageBitmap = async function(sourceValue, ...args) {
      const options = args.length === 1 && args[0] && typeof args[0] === 'object'
        ? args[0]
        : null;
      const smoke = window.__drawZoomContinuitySmoke;
      const delayMs = Number(smoke?.delayNextProxyMs) || 0;
      if (delayMs > 0
          && sourceValue instanceof Blob
          && Number(options?.resizeWidth) === 256) {
        smoke.delayNextProxyMs = 0;
        smoke.proxyDelayStarted = true;
        await new Promise(resolve => setTimeout(resolve, delayMs));
        smoke.proxyDelayFinished = true;
      }
      return nativeCreateImageBitmap(sourceValue, ...args);
    };

    await waitFrame();
    const clientPoint = {
      x: Math.round(rect.left + board.clientWidth / 2),
      y: Math.round(rect.top + board.clientHeight / 2),
    };
    return {
      itemId: item.id,
      imgId: item.imgId,
      point: clientPoint,
      dpr: devicePixelRatio || 1,
    };
  })()`);

  await dispatchZeroWheel(win, fixture.point);
  await delay(320);
  await dispatchZeroWheel(win, fixture.point);
  await waitFor(
    win,
    `(() => {
      const target = RefBoard.imageRenderState(${JSON.stringify(fixture.itemId)})?.displayTarget;
      return typeof target === 'number' && target > 256;
    })()`,
    'dynamic image-detail target',
  );
  await waitFor(
    win,
    `(() => {
      const smoke = window.__drawZoomContinuitySmoke;
      const item = RefBoard.state.items.find(entry => entry.id === smoke.itemId);
      const image = item && RefBoard.images.get(item.imgId);
      const target = RefBoard.imageRenderState(smoke.itemId)?.displayTarget;
      return image?.lod?.entries?.has(target);
    })()`,
    'initial unpainted LOD',
  );

  await win.webContents.executeJavaScript('document.querySelector("#drawModeBtn").click()');
  const beforeVersion = await win.webContents.executeJavaScript(
    `Number(RefBoard.images.get(${JSON.stringify(fixture.imgId)})?.version) || 0`,
  );
  await dispatchPointer(win, 'pointerdown', fixture.point, 1);

  let strokeVisible = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    await delay(70);
    await dispatchPointer(win, 'pointermove', {
      x: fixture.point.x + 12 + Math.min(attempt, 8) * 3,
      y: fixture.point.y + 2,
    }, 1);
    const sample = await win.webContents.executeJavaScript(
      'window.__drawZoomContinuitySmoke.sampleBoard()',
    );
    if (sample?.darkest < 180) {
      strokeVisible = true;
      break;
    }
  }
  if (!strokeVisible) throw new Error('The live drawing stroke never became visible');

  await win.webContents.executeJavaScript(`(() => {
    const smoke = window.__drawZoomContinuitySmoke;
    smoke.delayNextProxyMs = 650;
    smoke.proxyDelayStarted = false;
    smoke.proxyDelayFinished = false;
  })()`);
  await dispatchPointer(win, 'pointerup', {
    x: fixture.point.x + 36,
    y: fixture.point.y + 2,
  }, 0);

  await waitFor(
    win,
    `Number(RefBoard.images.get(${JSON.stringify(fixture.imgId)})?.version) > ${beforeVersion}`,
    'painted image version',
  );
  await waitFor(
    win,
    'window.__drawZoomContinuitySmoke.proxyDelayStarted',
    'delayed painted proxy publication',
  );

  const continuitySamples = [];
  for (let step = 0; step < 28; step++) {
    await dispatchZeroWheel(win, fixture.point);
    await delay(45);
    const state = await win.webContents.executeJavaScript(`(() => {
      const smoke = window.__drawZoomContinuitySmoke;
      const item = RefBoard.state.items.find(entry => entry.id === smoke.itemId);
      const image = item && RefBoard.images.get(item.imgId);
      return {
        board: smoke.sampleBoard(),
        target: RefBoard.imageRenderState(smoke.itemId)?.displayTarget,
        publishing: !!image?.pixelUpdateInProgress,
        lodCount: image?.lod?.entries?.size || 0,
        proxyDelayFinished: smoke.proxyDelayFinished,
      };
    })()`);
    continuitySamples.push(state);
  }

  await waitFor(
    win,
    `(() => {
      const smoke = window.__drawZoomContinuitySmoke;
      const item = RefBoard.state.items.find(entry => entry.id === smoke.itemId);
      const image = item && RefBoard.images.get(item.imgId);
      return smoke.proxyDelayFinished && !image?.pixelUpdateInProgress;
    })()`,
    'paint publication completion',
  );
  await dispatchZeroWheel(win, fixture.point);
  await waitFor(
    win,
    'window.__drawZoomContinuitySmoke.sampleLod()?.darkest < 180',
    'painted LOD after zoom',
  );
  await delay(260);

  const settled = await win.webContents.executeJavaScript(`(async () => {
    const smoke = window.__drawZoomContinuitySmoke;
    return {
      board: smoke.sampleBoard(),
      lod: smoke.sampleLod(),
      renderState: RefBoard.imageRenderState(smoke.itemId),
      diagnostics: await RefBoard.memoryStats(),
    };
  })()`);
  const invisibleSamples = continuitySamples.filter(
    sample => !sample.board || sample.board.darkest >= 180,
  );

  if (invisibleSamples.length
      || !settled.board
      || settled.board.darkest >= 180
      || !settled.lod
      || settled.lod.darkest >= 180
      || settled.diagnostics.lastBoardRenderError
      || rendererErrors.length) {
    throw new Error(`Drawing continuity failed across zoom tiers: ${JSON.stringify({
      fixture,
      invisibleSamples,
      continuitySamples,
      settled,
      rendererErrors,
    })}`);
  }

  return {
    fixture,
    sampleCount: continuitySamples.length,
    darkestRange: {
      min: Math.min(...continuitySamples.map(sample => sample.board.darkest)),
      max: Math.max(...continuitySamples.map(sample => sample.board.darkest)),
    },
    publicationSamples: continuitySamples.filter(sample => sample.publishing).length,
    settled,
  };
}

app.whenReady().then(async () => {
  try {
    const result = await run();
    process.stdout.write(`draw/zoom continuity Electron smoke passed ${JSON.stringify(result)}\n`);
    app.exit(0);
  } catch (error) {
    process.stderr.write(`${error.stack || error}\n`);
    app.exit(1);
  }
});

app.on('will-quit', () => {
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});
