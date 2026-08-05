'use strict';

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'refboard-image-edit-isolation-smoke-'));
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
      pointerId: 71,
      pointerType: 'mouse',
      isPrimary: true,
      bubbles: true,
      cancelable: true,
    }));
  })()`);
}

async function drawStroke(win, itemId, {
  expectDetach,
  waitForCommit = true,
  commitDelayMs = 0,
  endType = 'pointerup',
}) {
  const before = await itemPoint(win, itemId);
  if (!before) throw new Error(`Missing draw target ${itemId}`);

  await win.webContents.executeJavaScript(`(() => {
    const board = document.querySelector('#board');
    window.__imageEditIsolationSmoke.lastPointer = {
      targetItemId: ${JSON.stringify(itemId)},
      point: ${JSON.stringify(before)},
      elementAtPoint: document.elementFromPoint(${before.x}, ${before.y})?.id || null,
      events: [],
    };
    board.addEventListener('pointerdown', event => {
      const log = window.__imageEditIsolationSmoke.lastPointer;
      log.events.push({
        type: event.type,
        button: event.button,
        pointerId: event.pointerId,
        hasCaptureNow: board.hasPointerCapture(event.pointerId),
      });
      setTimeout(() => log.events.push({
        type: 'pointerdown-settled',
        pointerId: event.pointerId,
        hasCaptureNow: board.hasPointerCapture(event.pointerId),
      }), 0);
    }, { once: true, capture: true });
  })()`);

  await dispatchPointer(win, 'pointerdown', before, 1);

  if (expectDetach) {
    try {
      await waitFor(
        win,
        `RefBoard.state.items.find(entry => entry.id === ${JSON.stringify(itemId)})?.imgId !== ${JSON.stringify(before.imgId)}`,
        `${itemId} private image ownership`,
      );
    } catch (error) {
      const debug = await win.webContents.executeJavaScript(`(() => ({
        pointer: window.__imageEditIsolationSmoke.lastPointer,
        report: window.__imageEditIsolationSmoke.report(),
        drawActive: document.querySelector('#drawModeBtn').classList.contains('on'),
        visibility: document.visibilityState,
        boardClass: document.querySelector('#board').className,
        boardPointerEvents: getComputedStyle(document.querySelector('#board')).pointerEvents,
      }))()`);
      throw new Error(`${error.message}: ${JSON.stringify(debug)}`);
    }
  } else {
    // Even uniquely owned images may need to decode their pristine eraser base.
    await delay(220);
  }

  const active = await itemPoint(win, itemId);
  if (!active) throw new Error(`Draw target disappeared: ${itemId}`);
  await dispatchPointer(win, 'pointermove', { x: active.x + 18, y: active.y + 2 }, 1);
  await dispatchPointer(win, 'pointermove', { x: active.x + 28, y: active.y + 2 }, 1);
  if (commitDelayMs > 0) {
    await win.webContents.executeJavaScript(
      `window.__imageEditIsolationSmoke.delayNextCommitMs = ${Number(commitDelayMs) || 0}`,
    );
  }
  if (endType === 'blur') {
    await win.webContents.executeJavaScript("window.dispatchEvent(new Event('blur'))");
  } else {
    await dispatchPointer(win, endType, { x: active.x + 28, y: active.y + 2 }, 0);
  }

  if (waitForCommit) {
    await waitFor(
      win,
      `Number(RefBoard.images.get(RefBoard.state.items.find(entry => entry.id === ${JSON.stringify(itemId)})?.imgId)?.version) > ${active.version}`,
      `${itemId} draw commit`,
    );
    await win.webContents.executeJavaScript(
      'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
    );
  }
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

function dispatchToolShortcut(win, key) {
  return win.webContents.executeJavaScript(`document.body.dispatchEvent(new KeyboardEvent('keydown', {
    key: ${JSON.stringify(key)},
    code: ${JSON.stringify(`Key${String(key).toUpperCase()}`)},
    bubbles: true,
    cancelable: true,
  }))`);
}

function isWhite(sample) {
  return sample && sample.darkest > 235 && sample.alpha > 240;
}

function isPainted(sample) {
  return sample && sample.darkest < 100 && sample.alpha > 240;
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
    if (/Uncaught|SyntaxError|ReferenceError|TypeError|\[draw\].*failed/i.test(message)) {
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
    const blob = await new Promise(resolve => source.toBlob(resolve, 'image/png'));
    source.width = source.height = 0;
    if (!blob) throw new Error('Could not create image-edit smoke source');

    const nativeToBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function(callback, type, quality) {
      const delayMs = Number(window.__imageEditIsolationSmoke?.delayNextCommitMs) || 0;
      if (delayMs > 0 && this.width === 1600 && this.height === 1200) {
        window.__imageEditIsolationSmoke.delayNextCommitMs = 0;
        setTimeout(() => nativeToBlob.call(this, callback, type, quality), delayMs);
        return;
      }
      return nativeToBlob.call(this, callback, type, quality);
    };

    await RefBoard.addImages([new File([blob], 'isolation-source.png', { type: 'image/png' })]);
    const original = RefBoard.state.items[0];
    if (!original) throw new Error('Source image was not added');
    RefBoard.state.sel = new Set([original.id]);
    document.querySelector('#sDup').click();
    const duplicate = RefBoard.state.items.find(item => item.id !== original.id);
    if (!duplicate) throw new Error('Duplicate image was not created');
    duplicate.x = original.x + original.w + 70;
    duplicate.y = original.y;

    // Same-window clipboard placement creates this exact ownership shape:
    // a fresh board item id that still points at the source imgId.
    const pasted = {
      ...original,
      id: 'isolation-pasted-item',
      x: original.x + (original.w + 70) * 2,
      y: original.y,
    };
    RefBoard.state.items.push(pasted);
    RefBoard.state.sel.clear();
    RefBoard.state.anchorId = null;
    RefBoard.fitAll();
    await waitFrame();

    // Synthetic PointerEvents cannot acquire native pointer capture. This
    // smoke-only shim preserves the same capture lifetime expected by the
    // application while exercising its real pointer handlers.
    const capturedPointers = new Set();
    const board = document.querySelector('#board');
    board.setPointerCapture = pointerId => capturedPointers.add(pointerId);
    board.hasPointerCapture = pointerId => capturedPointers.has(pointerId);
    board.releasePointerCapture = pointerId => capturedPointers.delete(pointerId);

    window.__imageEditIsolationSmoke = {
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
        for (let index = 0; index < pixels.length; index += 4) {
          darkest = Math.min(darkest, Math.max(pixels[index], pixels[index + 1], pixels[index + 2]));
          alpha = Math.min(alpha, pixels[index + 3]);
        }
        sampleCanvas.width = sampleCanvas.height = 0;
        return { darkest, alpha };
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

    document.querySelector('#drawModeBtn').click();
    return {
      ids: window.__imageEditIsolationSmoke.ids,
      sourceImgId: original.imgId,
      initialImgIds: RefBoard.state.items.map(item => item.imgId),
      drawActive: document.querySelector('#drawModeBtn').classList.contains('on'),
    };
  })()`);

  if (!fixture.drawActive || new Set(fixture.initialImgIds).size !== 1) {
    throw new Error(`Invalid shared-image fixture: ${JSON.stringify(fixture)}`);
  }

  await drawStroke(win, fixture.ids.duplicate, {
    expectDetach: true,
    waitForCommit: false,
    commitDelayMs: 180,
  });
  await dispatchHistoryShortcut(win);
  await waitFor(
    win,
    `(() => {
      const smoke = window.__imageEditIsolationSmoke;
      const item = RefBoard.state.items.find(entry => entry.id === ${JSON.stringify(fixture.ids.duplicate)});
      return Number(RefBoard.images.get(item?.imgId)?.version) >= 2
        && smoke.sample(${JSON.stringify(fixture.ids.duplicate)})?.darkest > 235
        && smoke.sampleBoard(${JSON.stringify(fixture.ids.duplicate)})?.darkest > 235;
    })()`,
    'immediate draw undo',
  );
  const afterImmediateUndo = await win.webContents.executeJavaScript(
    'window.__imageEditIsolationSmoke.report()',
  );
  if (afterImmediateUndo.imgIds.original !== fixture.sourceImgId
      || afterImmediateUndo.imgIds.duplicate === fixture.sourceImgId
      || afterImmediateUndo.imgIds.pasted !== fixture.sourceImgId
      || !isWhite(afterImmediateUndo.pixels.original)
      || !isWhite(afterImmediateUndo.pixels.duplicate)
      || !isWhite(afterImmediateUndo.pixels.pasted)
      || !isWhite(afterImmediateUndo.boardPixels.duplicate)) {
    throw new Error(`Immediate draw undo failed: ${JSON.stringify(afterImmediateUndo)}`);
  }

  await dispatchHistoryShortcut(win, { redo: true });
  await waitFor(
    win,
    `(() => {
      const smoke = window.__imageEditIsolationSmoke;
      const item = RefBoard.state.items.find(entry => entry.id === ${JSON.stringify(fixture.ids.duplicate)});
      return Number(RefBoard.images.get(item?.imgId)?.version) >= 3
        && smoke.sample(${JSON.stringify(fixture.ids.duplicate)})?.darkest < 100
        && smoke.sampleBoard(${JSON.stringify(fixture.ids.duplicate)})?.darkest < 100;
    })()`,
    'draw redo after immediate undo',
  );
  const afterImmediateRedo = await win.webContents.executeJavaScript(
    'window.__imageEditIsolationSmoke.report()',
  );
  if (!isWhite(afterImmediateRedo.pixels.original)
      || !isPainted(afterImmediateRedo.pixels.duplicate)
      || !isWhite(afterImmediateRedo.pixels.pasted)
      || !isPainted(afterImmediateRedo.boardPixels.duplicate)) {
    throw new Error(`Immediate draw redo failed: ${JSON.stringify(afterImmediateRedo)}`);
  }

  await drawStroke(win, fixture.ids.pasted, { expectDetach: true });
  const afterPastePaint = await win.webContents.executeJavaScript(
    'window.__imageEditIsolationSmoke.report()',
  );
  if (new Set(Object.values(afterPastePaint.imgIds)).size !== 3
      || !isWhite(afterPastePaint.pixels.original)
      || !isPainted(afterPastePaint.pixels.duplicate)
      || !isPainted(afterPastePaint.pixels.pasted)
      || !isPainted(afterPastePaint.boardPixels.pasted)) {
    throw new Error(`Paste-style paint isolation failed: ${JSON.stringify(afterPastePaint)}`);
  }

  await win.webContents.executeJavaScript('document.querySelector("#drawEraser").click()');
  await drawStroke(win, fixture.ids.duplicate, { expectDetach: false });
  const afterDuplicateErase = await win.webContents.executeJavaScript(
    'window.__imageEditIsolationSmoke.report()',
  );
  if (new Set(Object.values(afterDuplicateErase.imgIds)).size !== 3
      || afterDuplicateErase.versions.original !== 0
      || afterDuplicateErase.versions.duplicate < 2
      || afterDuplicateErase.versions.pasted < 1
      || !isWhite(afterDuplicateErase.pixels.original)
      || !isWhite(afterDuplicateErase.pixels.duplicate)
      || !isPainted(afterDuplicateErase.pixels.pasted)
      || !isWhite(afterDuplicateErase.boardPixels.duplicate)
      || !isPainted(afterDuplicateErase.boardPixels.pasted)
      || afterDuplicateErase.imageRecords !== 3
      || rendererErrors.length) {
    throw new Error(`Duplicate erase isolation failed: ${JSON.stringify({
      state: afterDuplicateErase,
      rendererErrors,
    })}`);
  }

  await win.webContents.executeJavaScript('document.querySelector("#drawModeBtn").click()');
  await dispatchToolShortcut(win, 'e');
  const afterInactiveE = await win.webContents.executeJavaScript(`({
    drawActive: document.querySelector('#drawModeBtn').classList.contains('on'),
    penActive: document.querySelector('#drawPen').classList.contains('on'),
    eraserActive: document.querySelector('#drawEraser').classList.contains('on'),
  })`);
  if (!afterInactiveE.drawActive || afterInactiveE.penActive || !afterInactiveE.eraserActive) {
    throw new Error(`E did not activate the eraser from inactive drawing: ${JSON.stringify(afterInactiveE)}`);
  }

  await dispatchToolShortcut(win, 'd');
  await dispatchToolShortcut(win, 'd');
  const afterRepeatedD = await win.webContents.executeJavaScript(`({
    drawActive: document.querySelector('#drawModeBtn').classList.contains('on'),
    penActive: document.querySelector('#drawPen').classList.contains('on'),
    eraserActive: document.querySelector('#drawEraser').classList.contains('on'),
  })`);
  if (!afterRepeatedD.drawActive || !afterRepeatedD.penActive || afterRepeatedD.eraserActive) {
    throw new Error(`D did not keep the draw pen active: ${JSON.stringify(afterRepeatedD)}`);
  }

  await drawStroke(win, fixture.ids.original, {
    expectDetach: false,
    endType: 'pointercancel',
  });
  const afterPointerCancel = await win.webContents.executeJavaScript(
    'window.__imageEditIsolationSmoke.report()',
  );
  if (afterPointerCancel.versions.original < 1
      || !isPainted(afterPointerCancel.pixels.original)
      || !isPainted(afterPointerCancel.boardPixels.original)) {
    throw new Error(`Pointer cancellation did not finalize drawing: ${JSON.stringify(afterPointerCancel)}`);
  }

  await drawStroke(win, fixture.ids.original, {
    expectDetach: false,
    endType: 'blur',
  });
  const afterBlurCommit = await win.webContents.executeJavaScript(
    'window.__imageEditIsolationSmoke.report()',
  );
  if (afterBlurCommit.versions.original <= afterPointerCancel.versions.original
      || !isPainted(afterBlurCommit.boardPixels.original)) {
    throw new Error(`Window blur did not finalize drawing: ${JSON.stringify(afterBlurCommit)}`);
  }

  // A normal stroke after pointer cancellation and blur proves neither path
  // leaves a stale drawSession that blocks subsequent drawing.
  await drawStroke(win, fixture.ids.original, { expectDetach: false });
  const afterRecoveryStroke = await win.webContents.executeJavaScript(
    'window.__imageEditIsolationSmoke.report()',
  );
  if (afterRecoveryStroke.versions.original <= afterBlurCommit.versions.original) {
    throw new Error(`Drawing did not recover after cancellation/blur: ${JSON.stringify(afterRecoveryStroke)}`);
  }

  await dispatchToolShortcut(win, 'e');
  const arrowResult = await win.webContents.executeJavaScript(`(() => {
    document.querySelector('#arrowSolidBtn').click();
    const board = document.querySelector('#board');
    const fire = (type, x, y, buttons) => board.dispatchEvent(new PointerEvent(type, {
      clientX: x,
      clientY: y,
      button: 0,
      buttons,
      pointerId: 72,
      pointerType: 'mouse',
      isPrimary: true,
      bubbles: true,
      cancelable: true,
    }));
    fire('pointerdown', 90, 110, 1);
    fire('pointermove', 230, 165, 1);
    fire('pointerup', 230, 165, 0);
    const arrow = RefBoard.state.items.filter(item => item.kind === 'arrow').at(-1);
    return {
      arrow: arrow ? {
        arrowStyle: arrow.arrowStyle,
        strokeWidth: arrow.strokeWidth,
      } : null,
      widthLabel: document.querySelector('#drawWidthVal').textContent,
      arrowActive: document.querySelector('#arrowSolidBtn').classList.contains('on'),
      drawActive: document.querySelector('#drawModeBtn').classList.contains('on'),
    };
  })()`);
  if (!arrowResult.arrow
      || arrowResult.arrow.arrowStyle !== 'solid'
      || arrowResult.arrow.strokeWidth !== 2
      || arrowResult.widthLabel !== '2'
      || !arrowResult.arrowActive
      || arrowResult.drawActive) {
    throw new Error(`Arrow inherited eraser width or failed creation: ${JSON.stringify(arrowResult)}`);
  }

  return {
    fixture,
    afterImmediateUndo,
    afterImmediateRedo,
    afterPastePaint,
    afterDuplicateErase,
    shortcuts: { afterInactiveE, afterRepeatedD },
    lifecycle: { afterPointerCancel, afterBlurCommit, afterRecoveryStroke },
    arrowResult,
  };
}

app.whenReady().then(async () => {
  try {
    const result = await run();
    process.stdout.write(`image edit isolation Electron smoke passed ${JSON.stringify(result)}\n`);
    app.exit(0);
  } catch (error) {
    process.stderr.write(`${error.stack || error}\n`);
    app.exit(1);
  }
});

app.on('will-quit', () => {
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});
