/**
 * Proves a wheel zoom in the middle of a drag-pan keeps the board under the
 * cursor.
 *
 * The pan used to rebuild the view from a pointerdown snapshot on every move:
 * tx = tx0 + dx. A wheel zoom mid-drag moves tx to keep the cursor anchored,
 * and the next move put tx0 back under the new scale, throwing the board by
 * (board x under cursor) * (scale change) - a few hundred px at 100%, tens of
 * thousands when zoomed in.
 *
 * Runs the real app at 2000% with the cursor far from the board origin, holds
 * the middle button, moves, zooms out and in with the wheel, and after every
 * move checks that the board point grabbed at the last zoom sits under the
 * cursor.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeProfileDir } from './smoke-profile-cleanup.mjs';
import { evaluate } from './smoke-cdp.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const profile = await mkdtemp(path.join(os.tmpdir(), 'refboard-pan-zoom-'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const child = spawn(electron, ['.', '--remote-debugging-port=0', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-features=CalculateNativeWinOcclusion', `--user-data-dir=${profile}`], {
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

const smokeExpression = `(async()=>{
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  for(let attempt=0;attempt<300&&!(window.RefBoard&&window.RefBoard.startupComplete);attempt++)await wait(50);
  if(!(window.RefBoard&&window.RefBoard.startupComplete))throw new Error('RefBoard startup did not complete');
  document.querySelectorAll('.modal.show').forEach(el=>el.classList.remove('show'));
  document.querySelector('#rwNewBoard')?.click();
  for(let attempt=0;attempt<100&&!document.body.classList.contains('board-active');attempt++)await wait(50);
  if(!document.body.classList.contains('board-active'))throw new Error('New board did not open');
  await wait(200);
  document.querySelectorAll('.modal.show').forEach(el=>el.classList.remove('show'));

  const RB=window.RefBoard, view=RB.state.view;
  const board=document.querySelector('#board');
  const rect=board.getBoundingClientRect();
  const cx=rect.width/2, cy=rect.height/2;
  // 2000%, with board point (3000, 2000) under the canvas centre.
  view.s=20; view.tx=cx-3000*20; view.ty=cy-2000*20;
  RB.invalidate();
  await wait(50);

  const toBoard=(sx,sy)=>[(sx-view.tx)/view.s,(sy-view.ty)/view.s];
  const toScreen=(bx,by)=>[bx*view.s+view.tx,by*view.s+view.ty];
  const pointer=(type,sx,sy)=>{
    const opts={bubbles:true,cancelable:true,view:window,pointerId:61,pointerType:'mouse',isPrimary:true,
      button:type==='pointermove'?-1:1,buttons:type==='pointerup'?0:4,
      clientX:rect.left+sx,clientY:rect.top+sy};
    (type==='pointerdown'?board:window).dispatchEvent(new PointerEvent(type,opts));
  };
  const wheel=(sx,sy,deltaY)=>board.dispatchEvent(new WheelEvent('wheel',
    {clientX:rect.left+sx,clientY:rect.top+sy,deltaY,bubbles:true,cancelable:true}));

  // After each move, the point grabbed at the last zoom must be under the cursor.
  const checks=[];
  let grabbed=null, cur=[cx,cy];
  const grab=()=>{grabbed=toBoard(...cur);};
  const moveTo=(label,sx,sy)=>{
    pointer('pointermove',sx,sy); cur=[sx,sy];
    const [gx,gy]=toScreen(...grabbed);
    checks.push({label,scale:view.s,errX:gx-sx,errY:gy-sy});
  };

  pointer('pointerdown',cx,cy);
  const modeType=RB.mode?.type||null;
  grab();
  moveTo('plain drag',cx+10,cy+6);
  wheel(...cur,120); grab();
  moveTo('after zoom out',cx+11,cy+7);
  wheel(...cur,-120); wheel(...cur,-120); grab();
  moveTo('after zoom in',cx+30,cy-12);
  pointer('pointerup',...cur);
  return {modeType,modeAfter:RB.mode?.type||null,checks};
})()`;

try {
  const port = await debuggerPort();
  const r = await evaluate(port, smokeExpression, { attempts: 1 });
  assert.equal(r.modeType, 'pan', 'a middle-button press starts a pan');
  assert.equal(r.modeAfter, null, 'pointerup ends the pan');
  for (const c of r.checks) {
    const err = Math.hypot(c.errX, c.errY);
    console.log(`pan-zoom smoke: ${c.label} at ${(c.scale * 100).toFixed(0)}% -> board ${err.toFixed(3)} px off the cursor`);
    assert.ok(err < 0.01, `${c.label}: the grabbed board point must stay under the cursor (off by ${c.errX.toFixed(1)}, ${c.errY.toFixed(1)} px)`);
  }
  assert.ok(r.checks[1].scale < r.checks[0].scale && r.checks[2].scale > r.checks[1].scale, 'the wheel zoomed out, then in, mid-drag');
  console.log('pan-zoom Electron smoke passed');
} finally {
  if (child.exitCode === null) child.kill();
  await Promise.race([once(child, 'exit'), delay(3000)]).catch(() => {});
  await removeProfileDir(profile);
}
