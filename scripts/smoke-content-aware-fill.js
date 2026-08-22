'use strict';

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'refboard-content-aware-fill-smoke-'));
app.setPath('userData', path.join(tempRoot, 'user-data'));
app.commandLine.appendSwitch('disable-gpu');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(win, expression, label, timeoutMs = 45000) {
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

async function lassoFill(win, itemId, { expectDetach, coverBitmap = 140 } = {}) {
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
    const rec = RefBoard.images.get(item.imgId);
    return {
      screenW: item.w * view.s,
      screenH: item.h * view.s,
      bitmapW: rec?.w || 1,
      bitmapH: rec?.h || 1,
      scale: view.s,
    };
  })()`);
  const bitmapPerScreen = itemInfo.bitmapW / itemInfo.screenW;
  const halfScreenW = itemInfo.screenW / 2;
  const halfScreenH = itemInfo.screenH / 2;
  const coverScreen = Math.round(coverBitmap * (itemInfo.screenW / itemInfo.bitmapW));
  const pad = Math.min(Math.max(40, coverScreen), Math.floor(Math.min(halfScreenW, halfScreenH) * 0.8));
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

  try {
    await waitFor(
      win,
      `RefBoard.fillSession?.phase === 'preview' && !document.querySelector('#fillApply').disabled`,
      `${itemId} non-destructive fill preview`,
      90000,
    );
  } catch (error) {
    const debug = await win.webContents.executeJavaScript(`(() => ({
      phase: RefBoard.fillSession?.phase,
      candidateCount: RefBoard.fillSession?.candidates?.length,
      stage: document.querySelector('#fillPreviewStage')?.textContent,
      detail: document.querySelector('#fillPreviewDetail')?.textContent,
      barShown: document.querySelector('#fillPreviewBar')?.classList.contains('show'),
      applyDisabled: document.querySelector('#fillApply')?.disabled,
    }))()`);
    throw new Error(`${error.message}: ${JSON.stringify(debug)}`);
  }
  await win.webContents.executeJavaScript(`document.querySelector('#fillApply').click()`);

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
    source.width = 800;
    source.height = 600;
    const ctx = source.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, source.width, source.height);
    // Paint a large red square in the center for the fill to remove.
    ctx.fillStyle = '#ff0000';
    ctx.fillRect(350, 250, 100, 100);
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

  const grain = await win.webContents.executeJavaScript(`(async () => {
    const source = document.createElement('canvas');
    source.width = 640;
    source.height = 640;
    const ctx = source.getContext('2d');
    const image = ctx.createImageData(640, 640);
    for (let y = 0; y < 640; y++) {
      for (let x = 0; x < 640; x++) {
        let n = (x * 374761393 + y * 668265263) | 0;
        n = Math.imul(n ^ n >>> 16, 2246822507);
        n = Math.imul(n ^ n >>> 13, 3266489909);
        const grain = ((n >>> 0) % 61) - 30;
        const p = (y * 640 + x) * 4;
        image.data[p] = Math.max(0, Math.min(255, 168 + grain));
        image.data[p + 1] = Math.max(0, Math.min(255, 142 + grain));
        image.data[p + 2] = Math.max(0, Math.min(255, 98 + grain));
        image.data[p + 3] = 255;
      }
    }
    ctx.putImageData(image, 0, 0);
    ctx.fillStyle = '#14c85a';
    ctx.beginPath();
    ctx.arc(320, 320, 48, 0, Math.PI * 2);
    ctx.fill();
    const blob = await new Promise(resolve => source.toBlob(resolve, 'image/png'));
    source.width = source.height = 0;
    await RefBoard.addImages([new File([blob], 'fill-grain.png', { type: 'image/png' })]);
    const item = RefBoard.state.items[RefBoard.state.items.length - 1];
    item.x = 80;
    item.y = 80;
    RefBoard.state.sel = new Set([item.id]);
    RefBoard.fitAll();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    window.__contentAwareFillSmoke.ids.grain = item.id;
    window.__contentAwareFillSmoke.sampleGrain = function(itemId) {
      const it = RefBoard.state.items.find(entry => entry.id === itemId);
      const bitmap = it && RefBoard.images.get(it.imgId)?.bitmap;
      if (!it || !bitmap) return null;
      const c = document.createElement('canvas');
      c.width = bitmap.width;
      c.height = bitmap.height;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(bitmap, 0, 0);
      const x = Math.max(0, Math.floor(bitmap.width / 2) - 8);
      const y = Math.max(0, Math.round(bitmap.height / 2) - 8);
      const pixels = g.getImageData(x, y, 16, 16).data;
      let sum = 0, sumSq = 0, n = 0, maxG = 0, minR = 255;
      for (let i = 0; i < pixels.length; i += 4) {
        const L = 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
        sum += L;
        sumSq += L * L;
        n++;
        maxG = Math.max(maxG, pixels[i + 1]);
        minR = Math.min(minR, pixels[i]);
      }
      c.width = c.height = 0;
      const mean = sum / n;
      return { variance: Math.max(0, sumSq / n - mean * mean), maxG, minR, mean };
    };
    return { id: item.id, before: window.__contentAwareFillSmoke.sampleGrain(item.id) };
  })()`);

  if (!grain.before || grain.before.maxG < 180) {
    throw new Error(`Grain fixture blob was not green: ${JSON.stringify(grain.before)}`);
  }

  await lassoFill(win, grain.id, { expectDetach: false, coverBitmap: 70 });
  const grainAfter = await win.webContents.executeJavaScript(
    `window.__contentAwareFillSmoke.sampleGrain(${JSON.stringify(grain.id)})`,
  );
  if (!grainAfter || (grainAfter.minR < 80 && grainAfter.maxG > 180)) {
    throw new Error(`Grain blob was not removed: ${JSON.stringify(grainAfter)}`);
  }
  if (!grainAfter || grainAfter.variance < 25) {
    throw new Error(`Grain fill stayed smeared: ${JSON.stringify(grainAfter)}`);
  }

  // Regression for the reported "fill colors do not match" rejections on real
  // photos: a fill over fine grain must keep Apply available and land near the
  // surrounding tone rather than drifting away from it.
  const shifted = await win.webContents.executeJavaScript(`(async () => {
    const source = document.createElement('canvas');
    source.width = 512;
    source.height = 384;
    const ctx = source.getContext('2d');
    const image = ctx.createImageData(source.width, source.height);
    for (let y = 0; y < source.height; y++) for (let x = 0; x < source.width; x++) {
      let n = (x * 374761393 + y * 668265263) | 0;
      n = Math.imul(n ^ n >>> 16, 2246822507);
      n = Math.imul(n ^ n >>> 13, 3266489909);
      const grain = ((n >>> 0) % 17) - 8;
      const p = (y * source.width + x) * 4;
      image.data[p] = Math.max(0, Math.min(255, 186 + grain));
      image.data[p + 1] = Math.max(0, Math.min(255, 178 + grain));
      image.data[p + 2] = Math.max(0, Math.min(255, 164 + grain));
      image.data[p + 3] = 255;
    }
    ctx.putImageData(image, 0, 0);
    ctx.fillStyle = '#20242a';
    ctx.beginPath();
    ctx.ellipse(256, 192, 46, 34, 0, 0, Math.PI * 2);
    ctx.fill();
    const blob = await new Promise(resolve => source.toBlob(resolve, 'image/png'));
    source.width = source.height = 0;
    await RefBoard.addImages([new File([blob], 'fill-shifted.png', { type: 'image/png' })]);
    const item = RefBoard.state.items[RefBoard.state.items.length - 1];
    item.x = 60;
    item.y = 60;
    RefBoard.state.sel = new Set([item.id]);
    RefBoard.fitAll();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    window.__contentAwareFillSmoke.ids.shifted = item.id;
    return { id: item.id };
  })()`);

  await lassoFill(win, shifted.id, { expectDetach: false, coverBitmap: 70 });
  const shiftedAfter = await win.webContents.executeJavaScript(`(() => {
    const it = RefBoard.state.items.find(entry => entry.id === ${JSON.stringify(shifted.id)});
    const bitmap = it && RefBoard.images.get(it.imgId)?.bitmap;
    if (!it || !bitmap) return null;
    const c = document.createElement('canvas');
    c.width = bitmap.width;
    c.height = bitmap.height;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(bitmap, 0, 0);
    const sampleMean = (x, y, w, h) => {
      const px = g.getImageData(x, y, w, h).data;
      let sum = 0, count = 0;
      for (let i = 0; i < px.length; i += 4) { sum += px[i] * .299 + px[i + 1] * .587 + px[i + 2] * .114; count++; }
      return sum / count;
    };
    return {
      center: sampleMean(Math.floor(bitmap.width / 2) - 10, Math.floor(bitmap.height / 2) - 10, 20, 20),
      ring: sampleMean(24, 24, 40, 40),
    };
  })()`);
  if (!shiftedAfter || Math.abs(shiftedAfter.center - shiftedAfter.ring) > 45) {
    throw new Error(`Shifted fill was not harmonized toward the surroundings: ${JSON.stringify(shiftedAfter)}`);
  }

  // Full renderer regression for the reported rock-removal failure: the engine
  // mock returns a flat mean fill and bright foam sits near the lasso. The
  // detail pass must restore ripple texture from compatible water sources only,
  // so the clean plate keeps the water tone without foam speckle.
  const water = await win.webContents.executeJavaScript(`(async () => {
    const source = document.createElement('canvas');
    source.width = 640;
    source.height = 480;
    const ctx = source.getContext('2d');
    const image = ctx.createImageData(source.width, source.height);
    for (let y = 0; y < source.height; y++) for (let x = 0; x < source.width; x++) {
      const ripple = ((x * 23 + y * 41) % 29) - 14;
      const wave = Math.round(Math.sin((x + y * 1.7) / 17) * 7);
      const p = (y * source.width + x) * 4;
      image.data[p] = Math.max(0, Math.min(255, 88 + ripple + wave));
      image.data[p + 1] = Math.max(0, Math.min(255, 137 + ripple + wave));
      image.data[p + 2] = Math.max(0, Math.min(255, 151 + ripple + wave));
      image.data[p + 3] = 255;
    }
    ctx.putImageData(image, 0, 0);
    ctx.fillStyle = '#514632';
    ctx.beginPath();
    ctx.ellipse(320, 240, 45, 38, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fbfaf2';
    ctx.beginPath();
    ctx.ellipse(455, 235, 42, 31, -.12, 0, Math.PI * 2);
    ctx.fill();
    const blob = await new Promise(resolve => source.toBlob(resolve, 'image/png'));
    source.width = source.height = 0;
    await RefBoard.addImages([new File([blob], 'fill-water-white-decoy.png', { type: 'image/png' })]);
    const item = RefBoard.state.items[RefBoard.state.items.length - 1];
    item.x = 80;
    item.y = 80;
    RefBoard.state.sel = new Set([item.id]);
    RefBoard.fitAll();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    window.__contentAwareFillSmoke.ids.water = item.id;
    window.__contentAwareFillSmoke.sampleWater = function(itemId) {
      const it = RefBoard.state.items.find(entry => entry.id === itemId);
      const bitmap = it && RefBoard.images.get(it.imgId)?.bitmap;
      if (!it || !bitmap) return null;
      const c = document.createElement('canvas');
      c.width = bitmap.width;
      c.height = bitmap.height;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(bitmap, 0, 0);
      const pixels = g.getImageData(Math.floor(bitmap.width / 2) - 12, Math.floor(bitmap.height / 2) - 12, 24, 24).data;
      let sum = 0, sumSq = 0, count = 0, bright = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        const luma = pixels[index] * .299 + pixels[index + 1] * .587 + pixels[index + 2] * .114;
        sum += luma; sumSq += luma * luma; count++;
        if (pixels[index] > 225 && pixels[index + 1] > 225 && pixels[index + 2] > 225) bright++;
      }
      c.width = c.height = 0;
      const mean = sum / count;
      return { mean, variance: Math.max(0, sumSq / count - mean * mean), brightRatio: bright / count };
    };
    return { id: item.id, before: window.__contentAwareFillSmoke.sampleWater(item.id) };
  })()`);

  await lassoFill(win, water.id, { expectDetach: false, coverBitmap: 60 });
  const waterAfter = await win.webContents.executeJavaScript(
    `window.__contentAwareFillSmoke.sampleWater(${JSON.stringify(water.id)})`,
  );
  if (!waterAfter || waterAfter.mean > 190 || waterAfter.brightRatio > .01) {
    throw new Error(`White guide/foam contaminated the water clean plate: ${JSON.stringify({ before: water.before, after: waterAfter })}`);
  }
  if (waterAfter.variance < 10) {
    throw new Error(`Water detail was flattened by the clean plate: ${JSON.stringify(waterAfter)}`);
  }

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
