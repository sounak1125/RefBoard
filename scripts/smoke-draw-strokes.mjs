/**
 * Raster Draw strokes, driven with real mouse input through CDP.
 *
 * Two artifacts the Draw tool used to leave in the committed pixels:
 *
 * - Beading. Every pointer move was stroked on its own at the brush's alpha,
 *   so a Marker line darkened wherever two segments' round caps overlapped
 *   and came out as a chain of dots. A straight Marker line must now be one
 *   even tone along its centre.
 * - The re-entry chord. Points off the image were dropped while the stroke
 *   remembered the last point inside, so a stroke that left the image and came
 *   back joined its exit and re-entry points with a straight line across the
 *   picture. The image's centre, which that line crossed, must stay white.
 *
 * Draw mode is turned on with the D key, the way a user does, and the brush
 * and width come from the Draw panel's own buttons.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeProfileDir } from './smoke-profile-cleanup.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = process.env.REFBOARD_SMOKE_EXECUTABLE || path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const profile = await mkdtemp(path.join(os.tmpdir(), 'refboard-draw-strokes-'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const child = spawn(electron, [...(process.env.REFBOARD_SMOKE_EXECUTABLE ? [] : ['.']), '--remote-debugging-port=0', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-features=CalculateNativeWinOcclusion', `--user-data-dir=${profile}`], {
  cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
});
let stderr = '';
const consoleErrors = [];
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
    // Renderer console errors explain a stroke that never commits.
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push(msg.params.args.map(a => a.value ?? a.description ?? '').join(' '));
    }
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

/* The image: 1600x900 white pixels shown at 800x450 board units, so one board
   unit is two bitmap pixels. */
const IMAGE = { w: 1600, h: 900, boardW: 800, boardH: 450 };
const toBitmap = v => v * (IMAGE.w / IMAGE.boardW);

try {
  const cdp = await attach(await debuggerPort());
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});

  const view = await cdp.run(`(async()=>{
    const wait=ms=>new Promise(r=>setTimeout(r,ms));
    for(let i=0;i<300&&!(window.RefBoard&&window.RefBoard.startupComplete);i++)await wait(50);
    if(!window.RefBoard?.startupComplete)throw new Error('startup did not complete');
    document.querySelectorAll('.modal.show').forEach(el=>el.classList.remove('show'));
    document.querySelector('#rwNewBoard').click();
    for(let i=0;i<100&&!document.body.classList.contains('board-active');i++)await wait(50);
    if(!document.body.classList.contains('board-active'))throw new Error('New board did not open');
    await wait(300);
    document.querySelectorAll('.modal.show').forEach(el=>el.classList.remove('show'));
    window.__drawStrokeErrors=[];
    window.addEventListener('error',e=>window.__drawStrokeErrors.push(e.message));
    const RB=window.RefBoard;
    const c=document.createElement('canvas');c.width=${IMAGE.w};c.height=${IMAGE.h};
    const g=c.getContext('2d');g.fillStyle='#ffffff';g.fillRect(0,0,c.width,c.height);
    const blob=await new Promise(r=>c.toBlob(r,'image/png'));
    await RB.addImages([new File([blob],'white.png',{type:'image/png'})]);
    await wait(400);
    const it=RB.state.items[0];
    if(!it)throw new Error('the white image was not added');
    it.x=0;it.y=0;it.w=${IMAGE.boardW};it.h=${IMAGE.boardH};it.rot=0;
    it.crop={l:0,t:0,r:1,b:1};
    const board=document.getElementById('board');
    // Room for the loop that leaves the image on every side but the top.
    RB.state.view.s=0.8;
    RB.state.view.tx=Math.round(board.clientWidth/2-400*0.8);
    RB.state.view.ty=Math.round(board.clientHeight/2-260*0.8);
    RB.state.sel.clear();
    RB.invalidateLayout();RB.invalidate();
    await wait(200);
    return {imgId:it.imgId,board:board.getBoundingClientRect().toJSON(),s:RB.state.view.s,tx:RB.state.view.tx,ty:RB.state.view.ty,
      width:board.clientWidth,height:board.clientHeight};
  })()`);

  const toClient = (bx, by) => [view.board.left + bx * view.s + view.tx, view.board.top + by * view.s + view.ty];
  for (const [bx, by] of [[-60, 0], [860, 530]]) {
    const [x, y] = toClient(bx, by);
    assert.ok(x > view.board.left && y > view.board.top && x < view.board.right && y < view.board.bottom,
      `the stroke path must be on screen (board ${bx},${by} -> client ${x},${y} in ${JSON.stringify(view.board)})`);
  }

  const mouse = (type, bx, by, buttons = 0) => {
    const [x, y] = toClient(bx, by);
    return cdp.send('Input.dispatchMouseEvent', {
      type, x, y, button: type === 'mouseMoved' ? (buttons ? 'left' : 'none') : 'left', buttons, clickCount: 1,
    });
  };
  /* Press, move through every waypoint in `step`-unit hops, release, and wait
     for the stroke to bake into a new blob. */
  async function stroke(points, step) {
    // The blob itself may already be on disk; the pixel generation always moves.
    const genBefore = await cdp.run(`RefBoard.images.get(${JSON.stringify(view.imgId)})?.pixelGen||0`);
    const [first, ...rest] = points;
    await mouse('mouseMoved', ...first);
    await mouse('mousePressed', ...first, 1);
    // The press prepares the image asynchronously before the first segment.
    await delay(250);
    let [cx, cy] = first;
    for (const [tx, ty] of rest) {
      const n = Math.max(1, Math.ceil(Math.hypot(tx - cx, ty - cy) / step));
      for (let i = 1; i <= n; i++) {
        await mouse('mouseMoved', cx + ((tx - cx) * i) / n, cy + ((ty - cy) * i) / n, 1);
      }
      [cx, cy] = [tx, ty];
    }
    await mouse('mouseReleased', cx, cy);
    await cdp.run(`(async()=>{
      const wait=ms=>new Promise(r=>setTimeout(r,ms));
      const im=()=>RefBoard.images.get(${JSON.stringify(view.imgId)});
      for(let i=0;i<200&&((im()?.pixelGen||0)===${genBefore}||im()?.pixelUpdateInProgress);i++)await wait(50);
      if((im()?.pixelGen||0)===${genBefore})throw new Error('the stroke was not committed');
      return true;
    })()`);
  }
  /* Read one row of the committed bitmap as darkness (255 - red). */
  const committedRow = (y, x0, x1) => cdp.run(`(async()=>{
    const im=RefBoard.images.get(${JSON.stringify(view.imgId)});
    const blob=await RefBoard.getImageBlobForTest(im);
    const bmp=await createImageBitmap(blob);
    const c=document.createElement('canvas');c.width=bmp.width;c.height=bmp.height;
    const g=c.getContext('2d');g.drawImage(bmp,0,0);bmp.close();
    const d=g.getImageData(${x0},${y},${x1 - x0},1).data;
    const out=[];for(let i=0;i<d.length;i+=4)out.push(255-d[i]);
    return out;
  })()`);

  // D turns drawing on with the pen; the panel picks the Marker and widens it.
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'd', code: 'KeyD', windowsVirtualKeyCode: 68, text: 'd' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'd', code: 'KeyD', windowsVirtualKeyCode: 68 });
  await delay(150);
  const marker = await cdp.run(`(async()=>{
    document.querySelector('[data-brush="marker"]').click();
    for(let i=0;i<18;i++)document.querySelector('#drawWidthUp').click();
    await new Promise(r=>setTimeout(r,100));
    return {on:document.querySelector('#drawBrushMarker').classList.contains('on')};
  })()`);
  assert.equal(marker.on, true, 'the Marker brush must be selected from the panel');

  /* Beading. Marker width 20 board units is 29 with its multiplier; hops of
     12 units leave joints three or four segments deep along the old line. */
  const rowY = 150;
  await stroke([[100, rowY], [700, rowY]], 12);
  const row = await committedRow(toBitmap(rowY), toBitmap(200), toBitmap(600));
  const lo = Math.min(...row), hi = Math.max(...row);
  const mean = row.reduce((a, b) => a + b, 0) / row.length;
  const beads = `darkness along the marker's centre ranged ${lo}..${hi} (mean ${mean.toFixed(1)})`;
  // Both artifacts are checked before either fails, so one run shows both.
  const problems = [];
  if (!(lo > 40)) problems.push(`the marker stroke must have been painted: ${beads}`);
  if (!(hi - lo <= 4)) problems.push(`a straight marker line must be one even tone, not beads: ${beads}`);
  // One pass of black at the Marker's 0.42 alpha over white.
  if (!(Math.abs(mean - 255 * 0.42) <= 4)) problems.push(`one marker stroke is laid down at the brush alpha once: ${beads}`);

  /* Re-entry. A pen stroke starts right of centre, leaves through the right
     edge, loops below the image and comes back in through the left edge. */
  await cdp.run(`document.querySelector('[data-brush="pen"]').click();true`);
  const midY = IMAGE.boardH / 2;
  await stroke([[600, midY], [860, midY], [860, 530], [-60, 530], [-60, midY], [100, midY]], 10);
  const mid = await committedRow(toBitmap(midY), 0, IMAGE.w);
  const at = bx => mid[Math.round(toBitmap(bx))];
  const chord = `darkness on the centre row: start side ${at(700)}, centre ${at(400)}, re-entry side ${at(50)}`;
  if (!(at(700) > 200)) problems.push(`the stroke must paint from its start to the right edge: ${chord}`);
  if (!(at(50) > 200)) problems.push(`the stroke must paint again where it comes back in: ${chord}`);
  if (!(at(400) <= 2 && at(250) <= 2 && at(550) <= 2)) {
    problems.push(`leaving the image and coming back must not draw a line across it: ${chord}`);
  }
  assert.deepEqual(problems, [], `draw stroke artifacts:\n  ${problems.join('\n  ')}`);

  const errors = await cdp.run('window.__drawStrokeErrors');
  assert.deepEqual(errors, [], 'drawing must not throw renderer errors');
  cdp.close();

  console.log(
    `draw strokes Electron smoke passed — marker centre darkness ${lo}..${hi} (mean ${mean.toFixed(1)}), `
    + `image centre untouched after leaving and re-entering (${chord})`,
  );
} catch (err) {
  if (stderr.trim()) console.error(`--- electron stderr ---\n${stderr.trim()}`);
  if (consoleErrors.length) console.error(`--- renderer console errors ---\n${consoleErrors.join('\n')}`);
  console.error('child exitCode=' + child.exitCode);
  throw err;
} finally {
  if (child.exitCode === null) child.kill();
  await Promise.race([once(child, 'exit'), delay(3000)]).catch(() => {});
  await removeProfileDir(profile);
}
