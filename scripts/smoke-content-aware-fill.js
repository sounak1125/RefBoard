'use strict';

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'refboard-content-aware-fill-smoke-'));
app.setPath('userData', path.join(tempRoot, 'user-data'));
app.commandLine.appendSwitch('disable-gpu');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(win, expression, label, timeoutMs = 30000) {
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

async function itemPoint(win, itemId) {
  return win.webContents.executeJavaScript(`(() => {
    const item = RefBoard.state.items.find(entry => entry.id === ${JSON.stringify(itemId)});
    const board = document.querySelector('#board');
    if (!item || !board) return null;
    const rect = board.getBoundingClientRect();
    const view = RefBoard.state.view;
    return {
      x: Math.round(rect.left + (item.x + item.w / 2) * view.s + view.tx),
      y: Math.round(rect.top + (item.y + item.h / 2) * view.s + view.ty),
      imgId: item.imgId,
      version: Number(RefBoard.images.get(item.imgId)?.version) || 0,
      viewport: { width: innerWidth, height: innerHeight },
      boardRect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
    };
  })()`);
}

function dispatchPointer(win, type, point, buttons) {
  return win.webContents.executeJavaScript(`(() => {
    const board = document.querySelector('#board');
    return board.dispatchEvent(new PointerEvent(${JSON.stringify(type)}, {
      clientX: ${point.x},
      clientY: ${point.y},
      button: 0,
      buttons: ${buttons},
      pointerId: 73,
      pointerType: 'mouse',
      isPrimary: true,
      bubbles: true,
      cancelable: true,
    }));
  })()`);
}

async function lassoFill(win, itemId, { expectDetach }) {
  const before = await itemPoint(win, itemId);
  if (!before) throw new Error(`Missing fill target ${itemId}`);

  await dispatchPointer(win, 'pointerdown', before, 1);

  await delay(300);
  const afterDown = await win.webContents.executeJavaScript(`(() => ({
    fillPending: RefBoard.fillPendingPts?.length,
    fillSessionPts: RefBoard.fillSession?.pts?.length,
    mode: RefBoard.mode?.type,
  }))()`);
  console.log('after pointerdown:', afterDown);

  if (expectDetach) {
    try {
      await waitFor(
        win,
        `RefBoard.state.items.find(entry => entry.id === ${JSON.stringify(itemId)})?.imgId !== ${JSON.stringify(before.imgId)}`,
        `${itemId} private image ownership`,
      );
    } catch (error) {
      const debug = await win.webContents.executeJavaScript(`(() => ({
        report: window.__contentAwareFillSmoke.report(),
        fillActive: document.querySelector('#btnFill').classList.contains('on'),
        visibility: document.visibilityState,
        boardClass: document.querySelector('#board').className,
      }))()`);
      throw new Error(`${error.message}: ${JSON.stringify(debug)}`);
    }
  } else {
    await delay(250);
  }

  const active = await itemPoint(win, itemId);
  if (!active) throw new Error(`Fill target disappeared: ${itemId}`);

  // Compute the bitmap-to-screen ratio so the lasso covers the red square.
  const itemInfo = await win.webContents.executeJavaScript(`(() => {
    const item = RefBoard.state.items.find(entry => entry.id === ${JSON.stringify(itemId)});
    const view = RefBoard.state.view;
    const bitmapW = RefBoard.images.get(item.imgId)?.w || 1;
    return {
      screenW: item.w * view.s,
      bitmapW,
      scale: view.s,
    };
  })()`);
  const bitmapPerScreen = itemInfo.bitmapW / itemInfo.screenW;
  // Cover the 200x200 red square with margin, but clamp to stay within the item.
  const halfScreenW = itemInfo.screenW / 2;
  const halfScreenH = (itemInfo.bitmapW * 1200 / 1600) / bitmapPerScreen / 2; // item is 1600x1200
  const pad = Math.min(Math.max(60, Math.round(140 * bitmapPerScreen)), Math.floor(Math.min(halfScreenW, halfScreenH) * 0.8));
  console.log('lasso pad:', pad, 'bitmapPerScreen:', bitmapPerScreen, 'halfScreenW:', halfScreenW, 'halfScreenH:', halfScreenH);

  // Draw a lasso that fully encloses the red square, starting from top-left corner.
  // First, cancel the current session and restart from the corner.
  await dispatchPointer(win, 'pointerup', { x: active.x, y: active.y }, 0);
  await delay(100);

  // Restart: pointerdown at top-left corner of lasso.
  await dispatchPointer(win, 'pointerdown', { x: active.x - pad, y: active.y - pad }, 1);
  await delay(100);

  if (expectDetach) {
    try {
      await waitFor(
        win,
        `RefBoard.state.items.find(entry => entry.id === ${JSON.stringify(itemId)})?.imgId !== ${JSON.stringify(before.imgId)}`,
        `${itemId} private image ownership`,
      );
    } catch (error) {
      const debug = await win.webContents.executeJavaScript(`(() => ({
        report: window.__contentAwareFillSmoke.report(),
        fillActive: document.querySelector('#btnFill').classList.contains('on'),
        visibility: document.visibilityState,
        boardClass: document.querySelector('#board').className,
      }))()`);
      throw new Error(`${error.message}: ${JSON.stringify(debug)}`);
    }
  } else {
    await delay(250);
  }

  await dispatchPointer(win, 'pointermove', { x: active.x + pad, y: active.y - pad }, 1);
  await dispatchPointer(win, 'pointermove', { x: active.x + pad, y: active.y + pad }, 1);
  await dispatchPointer(win, 'pointermove', { x: active.x - pad, y: active.y + pad }, 1);

  await delay(100);
  const afterMoves = await win.webContents.executeJavaScript(`(() => ({
    fillSessionPts: RefBoard.fillSession?.pts?.length,
    mode: RefBoard.mode?.type,
  }))()`);
  console.log('after moves:', afterMoves);

  await dispatchPointer(win, 'pointerup', { x: active.x - 20, y: active.y + 0 }, 0);

  await delay(200);
  const fillState = await win.webContents.executeJavaScript(`(() => ({
    fillActive: RefBoard.fillActive,
    fillSessionPts: RefBoard.fillSession?.pts?.length,
    fillPendingPts: RefBoard.fillPendingPts?.length,
    mode: RefBoard.mode,
    canvasPointerEvents: getComputedStyle(document.querySelector('#board')).pointerEvents,
  }))()`);
  console.log('fillState after pointerup:', fillState);

  await waitFor(
    win,
    `Number(RefBoard.images.get(RefBoard.state.items.find(entry => entry.id === ${JSON.stringify(itemId)})?.imgId)?.version) > ${active.version}`,
    `${itemId} fill commit`,
  );
  await win.webContents.executeJavaScript(
    'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
  );
  return active;
}

function dispatchHistoryShortcut(win, { redo = false } = {}) {
  return win.webContents.executeJavaScript(`document.body.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'z',
    code: 'KeyZ',
    ctrlKey: true,
    shiftKey: ${redo ? 'true' : 'false'},
    bubbles: true,
    cancelable: true,
  }))`);
}

function isFilled(sample) {
  // The red square should be replaced by surrounding white pixels.
  return sample && sample.red > 200 && sample.green > 200 && sample.blue > 200 && sample.alpha > 240;
}

function isRedSquare(sample) {
  // Pure red: high R, low G/B.
  return sample && sample.red > 200 && sample.green < 80 && sample.blue < 80 && sample.alpha > 240;
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
    console.log('[renderer]', message);
    if (/Uncaught|SyntaxError|ReferenceError|TypeError|\[fill\].*failed/i.test(message)) {
      rendererErrors.push(message);
    }
  });

  await win.loadFile(path.join(__dirname, '..', 'index.html'));
  await waitFor(win, 'window.RefBoard && document.querySelector("#rwNewBoard")', 'renderer API');
  await delay(750);
  await win.webContents.executeJavaScript('document.querySelector("#rwNewBoard").click()');
  await waitFor(win, 'document.body.classList.contains("board-active")', 'empty board');

  const fixture = await win.webContents.executeJavaScript(`(async () => {
    const waitFrame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const source = document.createElement('canvas');
    source.width = 1600;
    source.height = 1200;
    const ctx = source.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, source.width, source.height);
    // Paint a large red square in the center for the fill to remove.
    ctx.fillStyle = '#ff0000';
    ctx.fillRect(700, 500, 200, 200);
    const blob = await new Promise(resolve => source.toBlob(resolve, 'image/png'));
    source.width = source.height = 0;
    if (!blob) throw new Error('Could not create content-aware fill smoke source');

    await RefBoard.addImages([new File([blob], 'fill-source.png', { type: 'image/png' })]);
    const original = RefBoard.state.items[0];
    if (!original) throw new Error('Source image was not added');
    RefBoard.state.sel = new Set([original.id]);
    document.querySelector('#sDup').click();
    const duplicate = RefBoard.state.items.find(item => item.id !== original.id);
    if (!duplicate) throw new Error('Duplicate image was not created');
    duplicate.x = original.x + original.w + 70;
    duplicate.y = original.y;

    const pasted = {
      ...original,
      id: 'fill-pasted-item',
      x: original.x + (original.w + 70) * 2,
      y: original.y,
    };
    RefBoard.state.items.push(pasted);
    RefBoard.state.sel.clear();
    RefBoard.state.anchorId = null;
    RefBoard.fitAll();
    await waitFrame();

    const capturedPointers = new Set();
    const board = document.querySelector('#board');
    board.setPointerCapture = pointerId => capturedPointers.add(pointerId);
    board.hasPointerCapture = pointerId => capturedPointers.has(pointerId);
    board.releasePointerCapture = pointerId => capturedPointers.delete(pointerId);

    window.__contentAwareFillSmoke = {
      ids: {
        original: original.id,
        duplicate: duplicate.id,
        pasted: pasted.id,
      },
      sourceImgId: original.imgId,
      sample(itemId) {
        const item = RefBoard.state.items.find(entry => entry.id === itemId);
        const bitmap = item && RefBoard.images.get(item.imgId)?.bitmap;
        if (!item || !bitmap) return null;
        const sampleCanvas = document.createElement('canvas');
        sampleCanvas.width = bitmap.width;
        sampleCanvas.height = bitmap.height;
        const sampleCtx = sampleCanvas.getContext('2d', { willReadFrequently: true });
        sampleCtx.drawImage(bitmap, 0, 0);
        const x = Math.max(0, Math.floor(bitmap.width / 2) - 4);
        const y = Math.max(0, Math.floor(bitmap.height / 2) - 4);
        const w = Math.min(9, bitmap.width - x);
        const h = Math.min(9, bitmap.height - y);
        const pixels = sampleCtx.getImageData(x, y, w, h).data;
        let darkest = 255;
        let alpha = 255;
        let red = 0;
        let green = 0;
        let blue = 0;
        for (let index = 0; index < pixels.length; index += 4) {
          darkest = Math.min(darkest, Math.max(pixels[index], pixels[index + 1], pixels[index + 2]));
          alpha = Math.min(alpha, pixels[index + 3]);
          red = Math.max(red, pixels[index]);
          green = Math.max(green, pixels[index + 1]);
          blue = Math.max(blue, pixels[index + 2]);
        }
        sampleCanvas.width = sampleCanvas.height = 0;
        return { darkest, alpha, red, green, blue };
      },
      sampleBoard(itemId) {
        const item = RefBoard.state.items.find(entry => entry.id === itemId);
        const boardCanvas = document.querySelector('#board');
        if (!item || !boardCanvas) return null;
        const view = RefBoard.state.view;
        const dpr = devicePixelRatio || 1;
        const centerX = Math.round(((item.x + item.w / 2) * view.s + view.tx) * dpr);
        const centerY = Math.round(((item.y + item.h / 2) * view.s + view.ty) * dpr);
        const radius = Math.max(4, Math.round(5 * dpr));
        const x = Math.max(0, centerX - radius);
        const y = Math.max(0, centerY - radius);
        const w = Math.min(radius * 2 + 1, boardCanvas.width - x);
        const h = Math.min(radius * 2 + 1, boardCanvas.height - y);
        if (w <= 0 || h <= 0) return null;
        const pixels = boardCanvas.getContext('2d').getImageData(x, y, w, h).data;
        let darkest = 255;
        let alpha = 255;
        for (let index = 0; index < pixels.length; index += 4) {
          darkest = Math.min(darkest, Math.max(pixels[index], pixels[index + 1], pixels[index + 2]));
          alpha = Math.min(alpha, pixels[index + 3]);
        }
        return { darkest, alpha };
      },
      report() {
        const ids = this.ids;
        const item = id => RefBoard.state.items.find(entry => entry.id === id);
        const record = id => RefBoard.images.get(item(id)?.imgId);
        return {
          imgIds: {
            original: item(ids.original)?.imgId,
            duplicate: item(ids.duplicate)?.imgId,
            pasted: item(ids.pasted)?.imgId,
          },
          versions: {
            original: Number(record(ids.original)?.version) || 0,
            duplicate: Number(record(ids.duplicate)?.version) || 0,
            pasted: Number(record(ids.pasted)?.version) || 0,
          },
          pixels: {
            original: this.sample(ids.original),
            duplicate: this.sample(ids.duplicate),
            pasted: this.sample(ids.pasted),
          },
          boardPixels: {
            original: this.sampleBoard(ids.original),
            duplicate: this.sampleBoard(ids.duplicate),
            pasted: this.sampleBoard(ids.pasted),
          },
          imageRecords: RefBoard.images.size,
        };
      },
    };

    return {
      ids: window.__contentAwareFillSmoke.ids,
      sourceImgId: original.imgId,
      initialImgIds: RefBoard.state.items.map(item => item.imgId),
    };
  })()`);

  if (new Set(fixture.initialImgIds).size !== 1) {
    throw new Error(`Invalid shared-image fixture: ${JSON.stringify(fixture)}`);
  }

  // Activate the fill tool and lasso the duplicate (which shares the source imgId).
  await win.webContents.executeJavaScript('document.querySelector("#btnFill").click()');
  await lassoFill(win, fixture.ids.duplicate, { expectDetach: true });

  const afterFill = await win.webContents.executeJavaScript(
    'window.__contentAwareFillSmoke.report()',
  );
  if (afterFill.imgIds.original !== fixture.sourceImgId
      || afterFill.imgIds.pasted !== fixture.sourceImgId
      || afterFill.imgIds.duplicate === fixture.sourceImgId) {
    throw new Error(`Fill isolation failed: ${JSON.stringify(afterFill.imgIds)}`);
  }
  if (!isFilled(afterFill.pixels.duplicate)) {
    throw new Error(`Duplicate center was not filled: ${JSON.stringify(afterFill.pixels.duplicate)}`);
  }
  if (!isRedSquare(afterFill.pixels.original)) {
    throw new Error(`Original must keep its red square: ${JSON.stringify(afterFill.pixels.original)}`);
  }
  if (!isRedSquare(afterFill.pixels.pasted)) {
    throw new Error(`Pasted copy must keep its red square: ${JSON.stringify(afterFill.pixels.pasted)}`);
  }

  // Undo restores the red square on the duplicate.
  await dispatchHistoryShortcut(win);
  await waitFor(
    win,
    `(() => {
      const smoke = window.__contentAwareFillSmoke;
      const item = RefBoard.state.items.find(entry => entry.id === ${JSON.stringify(fixture.ids.duplicate)});
      const sample = smoke.sample(${JSON.stringify(fixture.ids.duplicate)});
      return Number(RefBoard.images.get(item?.imgId)?.version) >= 2
        && sample && sample.red > 200 && sample.green < 80 && sample.blue < 80;
    })()`,
    'fill undo',
  );

  // Redo re-applies the fill.
  await dispatchHistoryShortcut(win, { redo: true });
  await waitFor(
    win,
    `(() => {
      const smoke = window.__contentAwareFillSmoke;
      const item = RefBoard.state.items.find(entry => entry.id === ${JSON.stringify(fixture.ids.duplicate)});
      const sample = smoke.sample(${JSON.stringify(fixture.ids.duplicate)});
      return Number(RefBoard.images.get(item?.imgId)?.version) >= 3
        && sample && sample.red > 200 && sample.green > 200 && sample.blue > 200;
    })()`,
    'fill redo',
  );

  if (rendererErrors.length) {
    throw new Error(`Renderer errors: ${rendererErrors.join('; ')}`);
  }

  console.log('content-aware fill smoke passed');
  await win.close();
  app.exit(0);
}

app.whenReady().then(async () => {
  try {
    await run();
  } catch (error) {
    process.stderr.write(`${error.stack || error}\n`);
    app.exit(1);
  }
});

app.on('will-quit', () => {
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});
