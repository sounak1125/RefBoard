/**
 * Pen and Eraser turn drawing on, driven through the real Draw panel with real
 * mouse input.
 *
 * The Draw panel used to have a separate on/off button, and Pen or Eraser only
 * picked the tool. A user who opened the panel, picked Pen and dragged across
 * an image moved the image instead of painting it. This opens the panel the
 * way a user does, picks Pen, drags across an image, and checks that the image
 * stayed put and its committed pixels changed. Then it picks Eraser, drags over
 * the same line, and checks that drawing stayed on and the original pixels came
 * back.
 *
 * Input goes through CDP Input.dispatchMouseEvent rather than synthetic DOM
 * events, so the toolbar buttons are hit-tested and the board's pointer
 * handlers run exactly as they do for a user.
 *
 * Set REFBOARD_SMOKE_SHOT to a .png path to keep a screenshot of the open Draw
 * panel with Pen picked.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeProfileDir } from './smoke-profile-cleanup.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = process.env.REFBOARD_SMOKE_EXECUTABLE || path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const profile = await mkdtemp(path.join(os.tmpdir(), 'refboard-draw-pen-arms-'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const child = spawn(electron, [...(process.env.REFBOARD_SMOKE_EXECUTABLE ? [] : ['.']), '--remote-debugging-port=0', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-features=CalculateNativeWinOcclusion', `--user-data-dir=${profile}`], {
  cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
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

async function attach(port) {
  let target = null;
  for (let attempt = 0; attempt < 100 && !target; attempt++) {
    try {
      const list = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json());
      target = list.find(t => t.type === 'page' && /index\.html/i.test(t.url || '') && !/pane=secondary/i.test(t.url || ''));
    } catch { /* retry */ }
    if (!target) await delay(100);
  }
  if (!target) throw new Error('no RefBoard page target');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let nextId = 0;
  const pending = new Map();
  socket.onmessage = event => {
    const msg = JSON.parse(event.data);
    if (!msg.id || !pending.has(msg.id)) return;
    const h = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) h.reject(new Error(msg.error.message)); else h.resolve(msg.result);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const run = async expression => {
    const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
    return res.result.value;
  };
  return { send, run, close: () => socket.close() };
}

// The image is placed at board (0, 0) at its natural size, so a board point is
// also the image pixel under it. The stroke runs across the middle row.
const IMG_W = 400;
const IMG_H = 300;
const STROKE_Y = 150;
const SAMPLE_XS = [100, 140, 180, 220, 260, 300];

/* Board point -> client CSS px, computed inside the page from the live view. */
const toClient = (bx, by) => `(()=>{const r=document.getElementById('board').getBoundingClientRect();const v=window.RefBoard.state.view;return [r.left+${bx}*v.s+v.tx, r.top+${by}*v.s+v.ty];})()`;

// Reads the committed image bytes (not the screen) along the stroke row. Each
// sample column reports the RGB of every pixel in a small band around the row,
// so a thin anti-aliased pen line is caught wherever it lands.
const readStrokeBand = `(async()=>{
  const RB=window.RefBoard;
  const item=RB.state.items.find(i=>i.id===window.__penArms.itemId);
  const blob=await RB.getImageBlobForTest(RB.images.get(item.imgId));
  const bmp=await createImageBitmap(blob);
  const c=document.createElement('canvas');c.width=bmp.width;c.height=bmp.height;
  const g=c.getContext('2d');g.drawImage(bmp,0,0);
  const out=[];
  for(const x of ${JSON.stringify(SAMPLE_XS)}){
    const d=g.getImageData(x,${STROKE_Y}-4,1,9).data;
    const px=[];for(let i=0;i<d.length;i+=4)px.push([d[i],d[i+1],d[i+2]]);
    out.push(px);
  }
  return {width:bmp.width,height:bmp.height,band:out};
})()`;

const itemState = `(()=>{
  const RB=window.RefBoard;
  const item=RB.state.items.find(i=>i.id===window.__penArms.itemId);
  const im=RB.images.get(item.imgId);
  return {x:item.x,y:item.y,w:item.w,h:item.h,imgId:item.imgId,version:Number(im?.version)||0,busy:!!im?.pixelUpdateInProgress,
    penOn:document.querySelector('#drawPen').classList.contains('on'),
    eraserOn:document.querySelector('#drawEraser').classList.contains('on'),
    panelOpen:document.querySelector('#drawPanelWrap').classList.contains('open'),
    toast:document.querySelector('#toast').textContent};
})()`;

const luminance = ([r, g, b]) => 0.299 * r + 0.587 * g + 0.114 * b;

try {
  const port = await debuggerPort();
  const cdp = await attach(port);
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});

  await cdp.run(`(async()=>{
    const wait=ms=>new Promise(r=>setTimeout(r,ms));
    for(let i=0;i<300&&!(window.RefBoard&&window.RefBoard.startupComplete);i++)await wait(50);
    if(!window.RefBoard?.startupComplete)throw new Error('startup did not complete');
    document.querySelectorAll('.modal.show').forEach(el=>el.classList.remove('show'));
    document.querySelector('#rwNewBoard').click();
    for(let i=0;i<100&&!document.body.classList.contains('board-active');i++)await wait(50);
    if(!document.body.classList.contains('board-active'))throw new Error('New board did not open');
    await wait(300);
    document.querySelectorAll('.modal.show').forEach(el=>el.classList.remove('show'));
    window.__penArmsErrors=[];
    window.addEventListener('error',e=>window.__penArmsErrors.push(e.message));
    const RB=window.RefBoard;
    // A light gradient, so a black pen line shows and the eraser has distinct
    // original pixels to bring back along the row.
    const c=document.createElement('canvas');c.width=${IMG_W};c.height=${IMG_H};
    const g=c.getContext('2d');
    const grad=g.createLinearGradient(0,0,${IMG_W},0);grad.addColorStop(0,'#e9e4da');grad.addColorStop(1,'#a9bcd4');
    g.fillStyle=grad;g.fillRect(0,0,${IMG_W},${IMG_H});
    const blob=await new Promise(r=>c.toBlob(r,'image/png'));
    const [it]=await RB.addImages([new File([blob],'paint-me.png',{type:'image/png'})]);
    await wait(400);
    if(!it)throw new Error('the image was not added');
    it.x=0;it.y=0;it.w=${IMG_W};it.h=${IMG_H};it.rot=0;
    const board=document.getElementById('board');
    RB.state.view.s=1;
    RB.state.view.tx=Math.round((board.clientWidth-${IMG_W})/2);
    RB.state.view.ty=Math.round((board.clientHeight-${IMG_H})/2);
    RB.state.sel.clear();RB.updateSelBarForTest();
    RB.invalidateLayout();RB.invalidate();
    window.__penArms={itemId:it.id};
    await wait(200);
    return true;
  })()`);

  const mouse = (type, x, y, buttons = 0, clickCount = 1) => cdp.send('Input.dispatchMouseEvent', {
    type, x, y, button: type === 'mouseMoved' ? (buttons ? 'left' : 'none') : 'left', buttons, clickCount,
  });
  async function clickElement(selector) {
    const at = await cdp.run(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)return null;const r=el.getBoundingClientRect();if(!r.width||!r.height)return null;const x=r.left+r.width/2,y=r.top+r.height/2;const top=document.elementFromPoint(x,y);return {x,y,hit:!!top&&(top===el||el.contains(top)),top:top&&(top.id||top.className)};})()`);
    assert.ok(at, `${selector} should be on screen`);
    assert.equal(at.hit, true, `${selector} should be the element under the pointer, found ${at.top}`);
    await mouse('mouseMoved', at.x, at.y);
    await mouse('mousePressed', at.x, at.y, 1);
    await mouse('mouseReleased', at.x, at.y, 0);
    await delay(120);
  }
  // A drag across the image row. The pointer rests a moment after the press,
  // because the first stroke on an image prepares its private copy and its
  // pristine eraser base asynchronously before paint lands.
  async function dragAcrossImage(x0, x1, { steps = 40, stepMs = 10 } = {}) {
    const start = await cdp.run(toClient(x0, STROKE_Y));
    const end = await cdp.run(toClient(x1, STROKE_Y));
    const under = await cdp.run(`(()=>{const el=document.elementFromPoint(${start[0]},${start[1]});return el&&el.id;})()`);
    assert.equal(under, 'board', 'the drag must start on the board, not on a panel over it');
    await mouse('mouseMoved', start[0], start[1]);
    await mouse('mousePressed', start[0], start[1], 1);
    await delay(250);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      await mouse('mouseMoved', start[0] + (end[0] - start[0]) * t, start[1] + (end[1] - start[1]) * t, 1);
      await delay(stepMs);
    }
    await mouse('mouseReleased', end[0], end[1], 0);
    await delay(120);
  }
  // The toolbar floats by default and slides in from its edge handle; then the
  // toolbar's Draw button opens the Draw panel.
  async function openDrawPanel() {
    if (await cdp.run(`document.body.classList.contains('toolbar-floating')`)) {
      await clickElement('#toolbarEdgeHandle');
      await delay(400);
    }
    await clickElement('#btnDraw');
    await delay(300);
  }
  async function waitForBake(afterVersion, label) {
    let state = null;
    for (let attempt = 0; attempt < 100; attempt++) {
      state = await cdp.run(itemState);
      if (state.version > afterVersion && !state.busy) return state;
      await delay(100);
    }
    throw new Error(`${label}: the stroke never baked into the image ${JSON.stringify(state)}`);
  }

  const original = await cdp.run(readStrokeBand);
  assert.equal(original.width, IMG_W);
  assert.equal(original.height, IMG_H);
  const start = await cdp.run(itemState);
  assert.equal(start.penOn, false, 'drawing starts off');

  /* ---- Pen turns drawing on and paints ---- */
  await openDrawPanel();
  await clickElement('#drawPen');
  await delay(300);
  const armed = await cdp.run(itemState);
  const modeButtonLeft = await cdp.run(`!!document.querySelector('#drawModeBtn')`);

  if (process.env.REFBOARD_SMOKE_SHOT) {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(process.env.REFBOARD_SMOKE_SHOT, Buffer.from(shot.data, 'base64'));
  }

  // Drag first and check the image before the button state: the image moving
  // is what a user saw when Pen only picked the tool.
  await dragAcrossImage(40, 360);
  const afterPenDrag = await cdp.run(itemState);
  assert.deepEqual(
    { x: afterPenDrag.x, y: afterPenDrag.y },
    { x: start.x, y: start.y },
    `a drag with Pen picked must paint the image, not move it (Pen state after the click: ${JSON.stringify(armed)})`,
  );
  assert.equal(armed.panelOpen, true, 'the Draw panel is open');
  assert.equal(armed.penOn, true, `picking Pen should turn drawing on with the pen ${JSON.stringify(armed)}`);
  assert.equal(armed.toast, 'Draw on · Esc to stop', 'turning drawing on says how to stop');
  assert.equal(modeButtonLeft, false, 'the separate Draw button is gone');
  await waitForBake(start.version, 'pen');
  const painted = await cdp.run(readStrokeBand);
  for (const [i, x] of SAMPLE_XS.entries()) {
    const before = Math.min(...original.band[i].map(luminance));
    const after = Math.min(...painted.band[i].map(luminance));
    assert.ok(after < before - 80, `the pen should darken the image at x=${x}: luminance ${before.toFixed(0)} -> ${after.toFixed(0)}`);
  }

  /* ---- Eraser keeps drawing on and restores the original ---- */
  // Pressing on the board closes the Draw panel but leaves drawing on, so the
  // user reopens the panel to pick Eraser.
  const beforeErase = await cdp.run(itemState);
  assert.equal(beforeErase.panelOpen, false, 'the stroke closed the Draw panel');
  assert.equal(beforeErase.penOn, true, 'closing the Draw panel leaves drawing on');
  await openDrawPanel();
  await clickElement('#drawEraser');
  const eraserArmed = await cdp.run(itemState);
  assert.equal(eraserArmed.eraserOn, true, `picking Eraser should keep drawing on with the eraser ${JSON.stringify(eraserArmed)}`);
  assert.equal(eraserArmed.penOn, false);
  await dragAcrossImage(20, 380);
  const afterEraseDrag = await cdp.run(itemState);
  assert.deepEqual(
    { x: afterEraseDrag.x, y: afterEraseDrag.y },
    { x: start.x, y: start.y },
    'a drag with Eraser picked must erase, not move the image',
  );
  assert.equal(afterEraseDrag.eraserOn, true, 'drawing stays on after erasing');
  await waitForBake(beforeErase.version, 'eraser');
  const erased = await cdp.run(readStrokeBand);
  for (const [i, x] of SAMPLE_XS.entries()) {
    for (const [row, px] of erased.band[i].entries()) {
      const want = original.band[i][row];
      const diff = Math.max(...px.map((v, c) => Math.abs(v - want[c])));
      assert.ok(diff <= 6, `the eraser should restore the original pixel at (${x}, ${STROKE_Y - 4 + row}): got ${px}, want ${want}`);
    }
  }

  const errors = await cdp.run('window.__penArmsErrors');
  assert.deepEqual(errors, [], 'no runtime errors');
  cdp.close();
  console.log(`draw pen arms Electron smoke passed — Pen turned drawing on from the Draw panel, a drag painted the image without moving it, Eraser kept drawing on and restored ${SAMPLE_XS.length * 9} sampled pixels`);
} catch (err) {
  if (stderr.trim()) console.error(`--- electron stderr ---\n${stderr.trim()}`);
  throw err;
} finally {
  if (child.exitCode === null) child.kill();
  await Promise.race([once(child, 'exit'), delay(3000)]).catch(() => {});
  await removeProfileDir(profile);
}
