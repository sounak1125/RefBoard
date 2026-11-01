/**
 * Snip to board, end to end in the real app: freeze the screens, drive the
 * overlay with real pointer and key events, and check what lands on the board.
 *
 * A harness cannot press a global shortcut, so the snip starts through the
 * main-process test hook (REFBOARD_SNIP_TEST=1, reached over the Node
 * inspector); everything after that is the code the shortcut runs.
 *
 * Checked:
 * - From Home, a drag starts a new board and adds one image, named after the
 *   window in front, at the crop's real pixel size, with the same pixels as
 *   that region of the frozen capture. The overlay shows the capture itself.
 * - A second snip lines up to the right of the first, top-aligned.
 * - A click without a drag takes a whole display at its physical size.
 * - Esc closes every overlay and adds nothing.
 *
 * This puts a fullscreen overlay on the real screens for a moment per snip.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeProfileDir } from './smoke-profile-cleanup.mjs';
import { evaluate } from './smoke-cdp.mjs';

const require = createRequire(import.meta.url);
const geometry = require('./snip-geometry.js');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = process.env.REFBOARD_SMOKE_EXECUTABLE || path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const profile = await mkdtemp(path.join(os.tmpdir(), 'refboard-snip-smoke-'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const child = spawn(electron, [...(process.env.REFBOARD_SMOKE_EXECUTABLE ? [] : ['.']), '--inspect=0', '--remote-debugging-port=0', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-features=CalculateNativeWinOcclusion', `--user-data-dir=${profile}`], {
  cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, REFBOARD_SNIP_TEST: '1' },
});
let stderr = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', chunk => { stderr += chunk; });

async function debuggerPort() {
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`Electron exited before smoke setup (${child.exitCode})\n${stderr}`);
    try {
      const [port] = (await readFile(portFile, 'utf8')).trim().split(/\r?\n/);
      if (/^\d+$/.test(port)) return Number(port);
    } catch { /* wait for Chromium */ }
    await delay(100);
  }
  throw new Error(`Electron debugging port did not become ready\n${stderr}`);
}

async function inspectorUrl() {
  for (let attempt = 0; attempt < 100; attempt++) {
    const match = stderr.match(/Debugger listening on (ws:\/\/\S+)/);
    if (match) return match[1];
    await delay(100);
  }
  throw new Error(`main-process inspector did not start\n${stderr}`);
}

async function cdp(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let nextId = 0;
  const pending = new Map();
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const handlers = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) handlers.reject(new Error(message.error.message));
    else handlers.resolve(message.result);
  };
  socket.onclose = () => {
    for (const handlers of pending.values()) handlers.reject(new Error('CDP socket closed'));
    pending.clear();
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    if (socket.readyState !== 1) { reject(new Error('CDP socket closed')); return; }
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const run = async expression => {
    const response = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    return response.result.value;
  };
  return { send, run, close: () => { try { socket.close(); } catch { /* gone */ } } };
}

let main = null;
const hook = expression => main.run(`(async () => { const T = globalThis.__refboardSnipTest; if (!T) throw new Error('snip test hook missing'); ${expression} })()`);
const board = expression => evaluate(port, `(async()=>{const RB=window.RefBoard;const wait=ms=>new Promise(r=>setTimeout(r,ms));${expression}})()`);

async function overlayTarget(displayId) {
  for (let attempt = 0; attempt < 80; attempt++) {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json()).catch(() => []);
    const match = targets.find(t => t.type === 'page' && /snip-overlay\.html/.test(t.url) && new URL(t.url).searchParams.get('display') === String(displayId));
    if (match) return cdp(match.webSocketDebuggerUrl);
    await delay(50);
  }
  throw new Error(`no overlay page for display ${displayId}`);
}

async function waitFor(check, what, tries = 100, ms = 50) {
  for (let i = 0; i < tries; i++) {
    const value = await check();
    if (value) return value;
    await delay(ms);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function startSnip(title) {
  const shown = await hook(`return await T.start(${JSON.stringify({ title })});`);
  assert.equal(shown?.ok, true, `the snip overlay must show: ${JSON.stringify(shown)}`);
  const overlays = await hook('return T.overlays();');
  return { stats: shown.stats, overlays };
}

async function drag(overlay, from, to) {
  const mouse = (type, [x, y], extra = {}) => overlay.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra });
  await mouse('mouseMoved', from, { button: 'none', buttons: 0 });
  await mouse('mousePressed', from);
  for (let i = 1; i <= 6; i++) {
    await mouse('mouseMoved', [from[0] + (to[0] - from[0]) * i / 6, from[1] + (to[1] - from[1]) * i / 6]);
  }
}

async function release(overlay, at) {
  await overlay.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at[0], y: at[1], button: 'left', buttons: 0, clickCount: 1 });
}

async function lastSnip(previousId) {
  return waitFor(() => board(`const s=RB.lastSnipForTest;if(!s||s.itemId===${JSON.stringify(previousId)})return null;
    const it=RB.state.items.find(i=>i.id===s.itemId);const im=it&&RB.images.get(it.imgId);
    return it&&im?{...s,x:it.x,y:it.y,w:it.w,h:it.h,imgW:im.w,imgH:im.h,count:RB.state.items.length,onLanding:RB.onLanding}:null;`), 'the snip on the board');
}

// Pixels of the board item's stored image at bitmap points, as RGBA.
async function boardPixels(itemId, points) {
  return board(`const it=RB.state.items.find(i=>i.id===${JSON.stringify(itemId)});
    const blob=await RB.getImageBlobForTest(RB.images.get(it.imgId));
    const bmp=await createImageBitmap(blob,{colorSpaceConversion:'none',premultiplyAlpha:'none'});
    const c=new OffscreenCanvas(bmp.width,bmp.height);const g=c.getContext('2d',{willReadFrequently:true});g.drawImage(bmp,0,0);
    return ${JSON.stringify(points)}.map(([x,y])=>[...g.getImageData(x,y,1,1).data]);`);
}

function samplePoints(width, height) {
  const points = [[0, 0], [width - 1, height - 1], [width - 1, 0], [0, height - 1]];
  for (let i = 1; i <= 12; i++) points.push([Math.floor(width * ((i * 7) % 13) / 13), Math.floor(height * ((i * 5) % 11) / 11)]);
  return points;
}

const maxDiff = (a, b) => Math.max(...a.flatMap((px, i) => px.map((v, c) => Math.abs(v - b[i][c]))));

let port = 0;
let step = 'launch';
const report = {};
try {
  port = await debuggerPort();
  main = await cdp(await inspectorUrl());
  await main.send('Runtime.enable');

  const home = await board(`for(let i=0;i<300&&!(RB&&RB.startupComplete);i++)await wait(50);
    document.querySelectorAll('.modal.show').forEach(el=>el.classList.remove('show'));
    const help=[...document.querySelectorAll('#helpModal .ks')].map(el=>el.textContent.replace(/\\s+/g,''));
    return {onLanding:window.RefBoard.onLanding,items:window.RefBoard.state.items.length,helpHasSnip:help.includes('CtrlAltS')};`);
  assert.equal(home.onLanding, true, 'a fresh profile starts on Home');
  assert.equal(home.helpHasSnip, true, 'the ? panel lists Ctrl+Alt+S');
  report.shortcutRegistered = await hook('return T.registered;');

  /* ---- 1. From Home: drag a box. ---- */
  step = 'drag from Home';
  const first = await startSnip('waterfall.mp4 - VLC media player');
  report.first = first.stats;
  const displays = first.stats.displays;
  assert.equal(first.overlays.length, displays.filter(d => d.captured).length, 'one overlay per captured display');
  for (const o of first.overlays) {
    const d = displays.find(x => x.id === o.displayId);
    assert.equal(o.visible, true, `overlay on display ${o.displayId} is visible`);
    assert.deepEqual(o.bounds, d.bounds, `overlay on display ${o.displayId} covers the display exactly`);
  }
  const hinted = first.overlays.find(o => o.hint);
  assert.ok(hinted, 'one overlay carries the hint');
  const d1 = displays.find(d => d.id === hinted.displayId);
  const ov1 = await overlayTarget(d1.id);
  const view1 = await ov1.run(`(async()=>{for(let i=0;i<100&&!document.getElementById('hint').classList.contains('show');i++)await new Promise(r=>setTimeout(r,20));
    const c=document.getElementById('frame');return {w:c.width,h:c.height,hint:document.getElementById('hint').textContent,cursor:getComputedStyle(document.body).cursor,dpr:devicePixelRatio};})()`);
  assert.deepEqual([view1.w, view1.h], [d1.captured.width, d1.captured.height], 'the overlay canvas holds the full-resolution capture');
  assert.match(view1.hint, /Snip to RefBoard · drag a region, click for the whole screen · Esc to cancel/);
  assert.match(view1.hint, /→ New board$/, 'on Home the hint says a new board');
  assert.equal(view1.cursor, 'crosshair');
  // What the overlay shows is the capture itself (BGRA arrived as RGB).
  const shownPoints = samplePoints(d1.captured.width, d1.captured.height);
  const shown = await ov1.run(`(()=>{const g=document.getElementById('frame').getContext('2d');return ${JSON.stringify(shownPoints)}.map(([x,y])=>[...g.getImageData(x,y,1,1).data]);})()`);
  const frozen = await hook(`return T.sample(${JSON.stringify(String(d1.id))}, ${JSON.stringify(shownPoints)});`);
  report.overlayFrameMaxDiff = maxDiff(shown, frozen);
  assert.ok(report.overlayFrameMaxDiff <= 2, `the overlay must show the frozen capture (max channel diff ${report.overlayFrameMaxDiff})`);

  // Multiples of 4 DIP land on whole pixels at 100, 125, 150 and 175%; the
  // pointer events Chromium delivers are snapped to device pixels anyway.
  const from = [100, 80];
  const to = [420, 300];
  const expected = geometry.cropForDrag({ start: { x: from[0], y: from[1] }, end: { x: to[0], y: to[1] }, bounds: d1.bounds, imageSize: d1.captured });
  await drag(ov1, from, to);
  const live = await ov1.run(`(()=>{const s=document.getElementById('sel').getBoundingClientRect();return {size:document.getElementById('size').textContent,selecting:document.body.classList.contains('selecting'),outline:getComputedStyle(document.getElementById('sel')).outlineColor,sel:[s.x,s.y,s.width,s.height]};})()`);
  assert.equal(live.selecting, true, 'the drag shows a selection');
  assert.equal(live.size, `${expected.width} × ${expected.height}`, 'the size label is in real pixels');
  assert.equal(live.outline, 'rgb(110, 171, 255)');
  const tRelease = Date.now();
  await release(ov1, to);
  ov1.close();
  const snip1 = await lastSnip(null);
  report.releaseToBoardMs = snip1.addedAt - tRelease;
  await waitFor(async () => !(await hook('return T.active;')), 'the overlays to close');
  assert.equal(snip1.onLanding, false, 'a snip on Home starts a new board');
  assert.equal(snip1.count, 1, 'the new board holds just the snip');
  assert.deepEqual([snip1.imgW, snip1.imgH], [expected.width, expected.height], 'the image has the crop\'s real pixel size');
  assert.match(snip1.name, /^Snip – waterfall\.mp4 - VLC media player – \d\d\.\d\d\.png$/, 'named after the window in front');
  const stats1 = await hook('return T.stats();');
  assert.deepEqual([stats1.crop.x, stats1.crop.y, stats1.crop.width, stats1.crop.height], [expected.x, expected.y, expected.width, expected.height]);
  report.first.pngBytes = stats1.pngBytes;
  report.first.cropMs = stats1.cropMs;
  report.first.cropSize = `${stats1.crop.width}x${stats1.crop.height}`;
  report.releaseToDeliverMs = stats1.deliveredAt - stats1.endedAt;
  report.foregroundRestored = stats1.foregroundBefore ? stats1.foregroundAfter === stats1.foregroundBefore : 'n/a';
  const points1 = samplePoints(expected.width, expected.height);
  const onBoard = await boardPixels(snip1.itemId, points1);
  const fromCapture = await hook(`return T.sample(${JSON.stringify(String(d1.id))}, ${JSON.stringify(points1.map(([x, y]) => [x + expected.x, y + expected.y]))});`);
  report.cropMaxDiff = maxDiff(onBoard, fromCapture);
  assert.equal(report.cropMaxDiff, 0, 'the board image has exactly the pixels of that region of the frozen capture');

  /* ---- 2. Next snip lines up to the right, top-aligned. ---- */
  step = 'second snip in a row';
  const second = await startSnip('');
  report.second = second.stats;
  const ov2 = await overlayTarget(d1.id);
  await waitFor(() => ov2.run(`document.getElementById('frame').width>0`), 'the second overlay frame');
  await drag(ov2, [600, 200], [500, 120]);
  await release(ov2, [500, 120]);
  ov2.close();
  const snip2 = await lastSnip(snip1.itemId);
  assert.equal(snip2.count, 2);
  assert.match(snip2.name, /^Snip – \d\d\.\d\d\.png$/, 'no title: just the time');
  assert.ok(Math.abs(snip2.x - (snip1.x + snip1.w + 24)) < 1e-6, `the second snip sits right of the first (${snip2.x} vs ${snip1.x + snip1.w + 24})`);
  assert.ok(Math.abs(snip2.y - snip1.y) < 1e-6, 'top-aligned with the first');
  await waitFor(async () => !(await hook('return T.active;')), 'the overlays to close');

  /* ---- 3. A click with no drag takes the whole display. ---- */
  step = 'click for the whole display';
  const third = await startSnip('Clicked');
  const d3 = third.stats.displays.find(d => d.id !== d1.id && d.captured) || d1;
  report.third = { displayId: d3.id, bounds: d3.bounds, scaleFactor: d3.scaleFactor };
  const ov3 = await overlayTarget(d3.id);
  await waitFor(() => ov3.run(`document.getElementById('frame').width>0`), 'the third overlay frame');
  await drag(ov3, [300, 300], [302, 301]);
  await release(ov3, [302, 301]);
  ov3.close();
  const snip3 = await lastSnip(snip2.itemId);
  assert.deepEqual([snip3.imgW, snip3.imgH], [d3.captured.width, d3.captured.height], 'a click gives the whole display');
  const physical = [Math.round(d3.bounds.width * d3.scaleFactor), Math.round(d3.bounds.height * d3.scaleFactor)];
  assert.deepEqual([snip3.imgW, snip3.imgH], physical, 'at its physical resolution');
  await waitFor(async () => !(await hook('return T.active;')), 'the overlays to close');

  /* ---- 4. Esc cancels everything. ---- */
  step = 'Esc';
  await startSnip('Cancelled');
  const ov4 = await overlayTarget(d1.id);
  await waitFor(() => ov4.run(`document.getElementById('frame').width>0`), 'the fourth overlay frame');
  await drag(ov4, [50, 50], [250, 250]);
  await ov4.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  ov4.close();
  await waitFor(async () => !(await hook('return T.active;')), 'Esc to close the overlays');
  const overlaysLeft = await hook('return T.overlays().length;');
  assert.equal(overlaysLeft, 0, 'no overlay is left after Esc');
  const afterEsc = await (async () => { await delay(600); return board('return {count:RB.state.items.length,last:RB.lastSnipForTest.itemId};'); })();
  assert.deepEqual(afterEsc, { count: 3, last: snip3.itemId }, 'Esc adds nothing');
  assert.equal((await hook('return T.stats();')).outcome, 'cancelled');

  const ms = n => `${Math.round(n)} ms`;
  for (const d of report.first.displays) {
    console.log(`display ${d.id}: ${d.bounds.width}x${d.bounds.height} DIP at ${d.scaleFactor * 100}%, asked ${d.requested?.width}x${d.requested?.height}, captured ${d.captured?.width}x${d.captured?.height} in ${ms(d.ms)}`);
  }
  for (const [label, s] of [['first', report.first], ['second', report.second]]) {
    console.log(`${label} snip: captured in ${ms(s.captureMs)}, overlay visible after ${ms(s.visibleMs)}`);
  }
  console.log(`release to image on board: ${ms(report.releaseToBoardMs)} (crop + PNG ${ms(report.first.cropMs)}); PNG ${report.first.pngBytes} bytes for ${report.first.cropSize}`);
  console.log(`overlay frame vs capture max channel diff ${report.overlayFrameMaxDiff}; board image vs capture ${report.cropMaxDiff}; shortcut registered: ${report.shortcutRegistered}; foreground handed back: ${report.foregroundRestored}`);
  console.log('snip to board Electron smoke passed');
} catch (error) {
  const stats = await hook('return T.stats();').catch(() => null);
  console.error(`snip smoke failed at "${step}"; last snip ended by ${stats?.endReason || 'nothing'} (${stats?.outcome || 'open'})`);
  throw error;
} finally {
  main?.close();
  if (child.exitCode === null) child.kill();
  await Promise.race([once(child, 'exit'), delay(3000)]).catch(() => {});
  await removeProfileDir(profile);
}
