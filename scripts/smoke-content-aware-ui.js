'use strict';
/* Electron smoke for the content-aware fill user interface.
 *
 * Covers the three controls the engine tests cannot see: the quality presets
 * (§26), sampling-area painting (§17) and content-aware canvas extension (§24),
 * plus undo of an expansion. Captures a screenshot of each step so the result
 * can be looked at, not only asserted about.
 *
 *   npx electron scripts/smoke-content-aware-ui.js
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const OUT = path.join(__dirname, '..', 'content-aware-out');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

app.on('window-all-closed', () => app.quit());

async function waitFor(win, expression, label, timeout = 90000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const ok = await win.webContents.executeJavaScript(`(() => { try { return !!(${expression}); } catch (e) { return false; } })()`);
    if (ok) return;
    if (Date.now() > deadline) {
      const state = await win.webContents.executeJavaScript(`(() => ({
        phase: RefBoard.fillSession?.phase,
        stage: document.querySelector('#fillPreviewStage')?.textContent,
        detail: document.querySelector('#fillPreviewDetail')?.textContent,
      }))()`).catch(() => null);
      throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(state)}`);
    }
    await delay(150);
  }
}

async function shot(win, name) {
  try {
    fs.mkdirSync(OUT, { recursive: true });
    const image = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, `ui-${name}.png`), image.toPNG());
  } catch (err) {
    console.warn(`  (screenshot ${name} failed: ${err.message})`);
  }
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, width: 1280, height: 860,
    webPreferences: { contextIsolation: false, nodeIntegration: true },
  });
  const errors = [];
  win.webContents.on('console-message', (...args) => {
    const message = typeof args[1] === 'number' ? args[2] : (args[0] && args[0].message);
    if (typeof message === 'string' && /error|failed/i.test(message) && !/willReadFrequently/i.test(message)) {
      errors.push(message);
    }
  });

  const check = (ok, label) => {
    if (ok) console.log(`  ok: ${label}`);
    else { console.error(`FAIL: ${label}`); process.exitCode = 1; }
  };

  try {
    await win.loadFile(path.join(__dirname, '..', 'index.html'));
    await waitFor(win, 'window.RefBoard && document.querySelector("#rwNewBoard")', 'renderer');
    await delay(750);
    await win.webContents.executeJavaScript('document.querySelector("#rwNewBoard").click()');
    await waitFor(win, 'document.body.classList.contains("board-active")', 'board');

    // A textured plate with an obvious object to remove.
    const fixture = await win.webContents.executeJavaScript(`(async () => {
      const c = document.createElement('canvas');
      c.width = 520; c.height = 400;
      const g = c.getContext('2d');
      const img = g.createImageData(c.width, c.height);
      for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
        let n = (x * 374761393 + y * 668265263) | 0;
        n = Math.imul(n ^ n >>> 16, 2246822507);
        n = Math.imul(n ^ n >>> 13, 3266489909);
        const grain = ((n >>> 0) % 19) - 9;
        const band = 26 * Math.sin(y / 34) + 14 * Math.cos(x / 51);
        const p = (y * c.width + x) * 4;
        img.data[p] = 148 + band + grain;
        img.data[p + 1] = 140 + band * 0.7 + grain;
        img.data[p + 2] = 132 + band * 0.4 + grain;
        img.data[p + 3] = 255;
      }
      g.putImageData(img, 0, 0);
      g.fillStyle = '#d81b60';
      g.beginPath(); g.ellipse(260, 200, 40, 30, 0, 0, Math.PI * 2); g.fill();
      const blob = await new Promise(r => c.toBlob(r, 'image/png'));
      await RefBoard.addImages([new File([blob], 'ui-fixture.png', { type: 'image/png' })]);
      const item = RefBoard.state.items[RefBoard.state.items.length - 1];
      RefBoard.state.sel = new Set([item.id]);
      RefBoard.fitAll();
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      return { id: item.id, imgId: item.imgId, w: item.w, h: item.h };
    })()`);
    await shot(win, '1-fixture');

    /* --- a fill over the object ------------------------------------------ */
    await win.webContents.executeJavaScript(`document.querySelector('#btnFill').click()`);
    await delay(150);

    // Drawn as real pointer events, the same path a user takes.
    await win.webContents.executeJavaScript(`(async () => {
      const it = RefBoard.state.items.find(e => e.id === ${JSON.stringify(fixture.id)});
      const rect = document.querySelector('#board').getBoundingClientRect();
      const toScreenPt = (bx, by) => {
        const v = RefBoard.state.view;
        return [bx * v.s + v.tx, by * v.s + v.ty];
      };
      const im = RefBoard.images.get(it.imgId);
      const sx = it.x + (260 / im.w) * it.w;
      const sy = it.y + (200 / im.h) * it.h;
      const [cx, cy] = toScreenPt(sx, sy);
      const canvas = document.querySelector('#board');
      const send = (type, x, y, buttons) => canvas.dispatchEvent(new PointerEvent(type, {
        clientX: x + rect.left, clientY: y + rect.top, buttons, bubbles: true, pointerId: 1, isPrimary: true,
      }));
      const rx = (52 / im.w) * it.w * RefBoard.state.view.s;
      const ry = (42 / im.h) * it.h * RefBoard.state.view.s;
      send('pointerdown', cx - rx, cy - ry, 1);
      send('pointermove', cx + rx, cy - ry, 1);
      send('pointermove', cx + rx, cy + ry, 1);
      send('pointermove', cx - rx, cy + ry, 1);
      window.dispatchEvent(new PointerEvent('pointerup', {
        clientX: cx - rx + rect.left, clientY: cy + rect.top, buttons: 0, bubbles: true, pointerId: 1, isPrimary: true,
      }));
    })()`);

    await waitFor(win, `RefBoard.fillSession?.phase === 'preview'`, 'fill preview');
    await shot(win, '2-preview');
    const preview = await win.webContents.executeJavaScript(`(() => ({
      quality: RefBoard.fillSession.quality,
      candidates: RefBoard.fillSession.candidates.length,
      algorithm: RefBoard.fillSession.candidates[0]?.algorithmUsed,
      applyEnabled: !document.querySelector('#fillApply').disabled,
      samplingEnabled: !document.querySelector('#fillSampling').disabled,
      qualityOn: document.querySelector('#fillQuality .fp-q.on')?.dataset.quality,
      detail: document.querySelector('#fillPreviewDetail').textContent,
    }))()`);
    console.log('  preview:', JSON.stringify(preview));
    check(preview.candidates > 0, 'a candidate is produced');
    check(preview.applyEnabled, 'Apply is enabled');
    check(preview.qualityOn === 'balanced', 'Balanced is the default preset');
    check(preview.samplingEnabled, 'the sampling-area control unlocks once a crop exists');
    check(/patchmatch/.test(preview.algorithm || ''), `the exemplar engine ran (${preview.algorithm})`);

    /* --- quality presets (§26) ------------------------------------------- */
    await win.webContents.executeJavaScript(
      `document.querySelector('#fillQuality .fp-q[data-quality="preview"]').click()`);
    await waitFor(win, `RefBoard.fillSession?.phase === 'preview' && RefBoard.fillSession.quality === 'preview'`,
      'preview-quality re-run');
    const afterPreset = await win.webContents.executeJavaScript(`(() => ({
      quality: RefBoard.fillSession.quality,
      on: document.querySelector('#fillQuality .fp-q.on')?.dataset.quality,
      candidates: RefBoard.fillSession.candidates.length,
    }))()`);
    check(afterPreset.quality === 'preview' && afterPreset.on === 'preview',
      'changing the preset re-runs the fill and updates the control');
    check(afterPreset.candidates > 0, 'and produces a fresh candidate');
    await shot(win, '3-preset-preview');

    /* --- sampling area (§17) --------------------------------------------- */
    await win.webContents.executeJavaScript(`document.querySelector('#fillSampling').click()`);
    const samplingOn = await win.webContents.executeJavaScript(`(() => ({
      mode: RefBoard.fillSamplingMode,
      buttonOn: document.querySelector('#fillSampling').classList.contains('on'),
      maskLen: RefBoard.fillSession?.samplingMask?.length,
      cropPx: RefBoard.fillSession.bounds.cropW * RefBoard.fillSession.bounds.cropH,
    }))()`);
    check(samplingOn.mode && samplingOn.buttonOn, 'sampling mode toggles on');
    check(samplingOn.maskLen === samplingOn.cropPx,
      `the sampling mask is allocated in crop space (${samplingOn.maskLen} of ${samplingOn.cropPx})`);
    await shot(win, '4-sampling-overlay');

    // Exclude a band, then confirm it reaches the engine on the next run.
    const painted = await win.webContents.executeJavaScript(`(() => {
      const s = RefBoard.fillSession;
      const { cropW, cropH } = s.bounds;
      let before = 0;
      for (let i = 0; i < s.samplingMask.length; i++) if (s.samplingMask[i] >= 128) before++;
      for (let y = 0; y < cropH; y++) for (let x = 0; x < cropW * 0.35; x++) s.samplingMask[y * cropW + x] = 0;
      s.samplingOverlay = null;
      s.samplingDirty = true;
      let after = 0;
      for (let i = 0; i < s.samplingMask.length; i++) if (s.samplingMask[i] >= 128) after++;
      RefBoard.invalidate?.();
      // Nudge the pointer so the overlay repaints for the screenshot.
      const rect = document.querySelector('#board').getBoundingClientRect();
      window.dispatchEvent(new PointerEvent('pointermove', {
        clientX: rect.left + rect.width * 0.42, clientY: rect.top + rect.height * 0.55,
        buttons: 0, bubbles: true, pointerId: 1, isPrimary: true,
      }));
      return { before, after };
    })()`);
    await delay(400);
    await shot(win, '4b-sampling-painted');
    check(painted.after < painted.before, `excluding a region shrinks the allowed area (${painted.before} -> ${painted.after})`);

    await win.webContents.executeJavaScript(`document.querySelector('#fillSampling').click()`);
    await waitFor(win, `RefBoard.fillSession?.phase === 'preview'`, 're-run after sampling change');
    check(await win.webContents.executeJavaScript(`RefBoard.fillSession.candidates.length > 0`),
      'turning sampling mode off re-runs the fill against the new area');
    await shot(win, '5-after-sampling');

    await win.webContents.executeJavaScript(`document.querySelector('#fillApply').click()`);
    await waitFor(win, `!RefBoard.fillSession`, 'apply');
    await shot(win, '6-applied');
    check(true, 'Apply commits and closes the session');

    /* --- canvas extension (§24) ------------------------------------------ */
    const before = await win.webContents.executeJavaScript(`(() => {
      const it = RefBoard.state.items.find(e => e.id === ${JSON.stringify(fixture.id)});
      const im = RefBoard.images.get(it.imgId);
      return { imW: im.w, imH: im.h, itW: it.w, itX: it.x, undo: RefBoard.undoDepth ? RefBoard.undoDepth() : null };
    })()`);

    await win.webContents.executeJavaScript(`(() => {
      const it = RefBoard.state.items.find(e => e.id === ${JSON.stringify(fixture.id)});
      return RefBoard.expandCanvas(it.id, { right: 90 });
    })()`);
    await waitFor(win, `RefBoard.fillSession?.phase === 'preview' && RefBoard.fillSession.expand`,
      'canvas extension preview');
    await shot(win, '7-expand-preview');

    const expanded = await win.webContents.executeJavaScript(`(() => {
      const it = RefBoard.state.items.find(e => e.id === ${JSON.stringify(fixture.id)});
      const im = RefBoard.images.get(it.imgId);
      return { imW: im.w, imH: im.h, itW: it.w, itX: it.x,
        candidates: RefBoard.fillSession.candidates.length,
        applyEnabled: !document.querySelector('#fillApply').disabled };
    })()`);
    check(expanded.imW === before.imW + 90, `the bitmap grew by the requested margin (${before.imW} -> ${expanded.imW})`);
    check(expanded.imH === before.imH, 'and only on the requested axis');
    check(expanded.itW > before.itW, 'the board item grew with it');
    check(Math.abs(expanded.itX - before.itX) < 0.5, 'anchored so existing content does not move');
    check(expanded.candidates > 0 && expanded.applyEnabled, 'the new canvas was synthesised and can be applied');

    await win.webContents.executeJavaScript(`document.querySelector('#fillApply').click()`);
    await waitFor(win, `!RefBoard.fillSession`, 'expansion apply');
    await shot(win, '8-expanded');

    const committed = await win.webContents.executeJavaScript(`(() => {
      const it = RefBoard.state.items.find(e => e.id === ${JSON.stringify(fixture.id)});
      const im = RefBoard.images.get(it.imgId);
      const c = document.createElement('canvas');
      c.width = im.w; c.height = im.h;
      c.getContext('2d').drawImage(im.bitmap, 0, 0);
      const px = c.getContext('2d').getImageData(im.w - 40, Math.floor(im.h / 2), 20, 20).data;
      let sum = 0, alphaMin = 255;
      for (let i = 0; i < px.length; i += 4) { sum += px[i + 1]; alphaMin = Math.min(alphaMin, px[i + 3]); }
      return { imW: im.w, mean: sum / (px.length / 4), alphaMin };
    })()`);
    check(committed.imW === before.imW + 90, 'the committed bitmap keeps the new size');
    check(committed.alphaMin === 255, 'the new canvas is opaque, not transparent');
    check(committed.mean > 40, `and carries real content (mean green ${committed.mean.toFixed(0)})`);

    /* --- undo restores the pre-expansion geometry ------------------------ */
    await win.webContents.executeJavaScript(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }))`);
    await delay(1800);
    const undone = await win.webContents.executeJavaScript(`(() => {
      const it = RefBoard.state.items.find(e => e.id === ${JSON.stringify(fixture.id)});
      if (!it) return null;
      const im = RefBoard.images.get(it.imgId);
      return { imW: im?.w, itW: it.w, itX: it.x };
    })()`);
    check(undone && undone.imW === before.imW,
      `undo restores the original bitmap size (${undone && undone.imW} vs ${before.imW})`);
    check(undone && Math.abs(undone.itW - before.itW) < 1,
      `and the original board geometry (${undone && undone.itW?.toFixed(1)} vs ${before.itW.toFixed(1)})`);
    await shot(win, '9-undone');

    if (errors.length) {
      for (const e of errors.slice(0, 5)) console.error(`FAIL: renderer error: ${e}`);
      process.exitCode = 1;
    }
  } catch (err) {
    console.error(`FAIL: ${err.stack || err}`);
    process.exitCode = 1;
    await shot(win, 'error');
  }

  console.log(process.exitCode ? 'content-aware fill UI smoke FAILED' : 'content-aware fill UI smoke passed');
  app.exit(process.exitCode || 0);
});
