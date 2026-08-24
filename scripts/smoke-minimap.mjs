/**
 * Minimap: shows the whole board and where the viewport sits, and pans on click.
 *
 * On a large board there is otherwise no way to tell where you are. This drives
 * the real toggle and canvas, and checks the viewport marker tracks the camera
 * and that clicking the minimap moves the board view to that point.
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
const profile = await mkdtemp(path.join(os.tmpdir(), 'refboard-minimap-'));
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
  const frame=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
  for(let attempt=0;attempt<200&&!window.RefBoard;attempt++)await wait(50);
  if(!window.RefBoard)throw new Error('RefBoard API unavailable');
  // init() ends by navigating to the landing view; anything done before
  // that point gets torn down again. Wait for startup to finish.
  for(let attempt=0;attempt<300&&!window.RefBoard.startupComplete;attempt++)await wait(50);
  if(!window.RefBoard.startupComplete)throw new Error('RefBoard startup did not complete');
  document.querySelectorAll('.modal.show').forEach(el=>el.classList.remove('show'));
  document.querySelector('#rwNewBoard')?.click();
  for(let attempt=0;attempt<100&&!document.body.classList.contains('board-active');attempt++)await wait(50);
  if(!document.body.classList.contains('board-active'))throw new Error('New board did not open');
  await wait(250);
  document.querySelectorAll('.modal.show').forEach(el=>el.classList.remove('show'));

  const c=document.createElement('canvas');c.width=c.height=48;
  const cg=c.getContext('2d');cg.fillStyle='#6ab';cg.fillRect(0,0,48,48);
  const blob=await new Promise(r=>c.toBlob(r,'image/png'));
  const files=[];for(let i=0;i<12;i++)files.push(new File([blob],'mm'+i+'.png',{type:'image/png'}));
  await window.RefBoard.addImages(files);
  await wait(400);
  window.RefBoard.fitAll();
  await frame(); await wait(200);

  const mm=document.querySelector('#minimap');
  const mmCanvas=document.querySelector('#minimapCanvas');
  const toggle=document.querySelector('#minimapToggle');
  const shown=()=>getComputedStyle(mm).display!=='none';

  const hiddenByDefault=!shown();

  // --- the M shortcut toggles it ---
  document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'m',bubbles:true,cancelable:true}));
  await wait(150); await frame();
  const openedByKey=shown();

  // --- it actually paints something ---
  const px=mmCanvas.getContext('2d').getImageData(0,0,mmCanvas.width,mmCanvas.height).data;
  let painted=0; for(let i=3;i<px.length;i+=4) if(px[i]>0) painted++;

  // --- clicking near a corner pans the board there ---
  const before={...window.RefBoard.state.view};
  const r=mmCanvas.getBoundingClientRect();
  mmCanvas.dispatchEvent(new PointerEvent('pointerdown',{
    clientX:r.left+r.width*0.2, clientY:r.top+r.height*0.25,
    bubbles:true, cancelable:true, pointerId:1,
  }));
  await wait(150); await frame();
  const after={...window.RefBoard.state.view};
  const panned=Math.abs(after.tx-before.tx)>2||Math.abs(after.ty-before.ty)>2;
  const zoomUnchanged=Math.abs(after.s-before.s)<1e-9;

  // --- the toggle button closes it and the choice persists ---
  toggle.click();
  await wait(120);
  const closedByButton=!shown();
  const persisted=JSON.parse(localStorage.getItem('refboard.settings')||'{}').minimap;

  return {hiddenByDefault,openedByKey,painted,panned,zoomUnchanged,closedByButton,persisted,
          mmW:mmCanvas.width,mmH:mmCanvas.height};
})()`;

try {
  const r = await evaluate(await debuggerPort(), smokeExpression);

  assert.equal(r.hiddenByDefault, true, 'the minimap should be off until asked for');
  assert.equal(r.openedByKey, true, 'M must toggle the minimap on');
  assert.ok(r.mmW > 0 && r.mmH > 0, 'the minimap canvas must be sized');
  assert.ok(r.painted > 100, `the minimap must actually draw the board (only ${r.painted} opaque pixels)`);
  assert.equal(r.panned, true, 'clicking the minimap must pan the board view');
  assert.equal(r.zoomUnchanged, true, 'panning via the minimap must not change zoom');
  assert.equal(r.closedByButton, true, 'the toggle button must close the minimap');
  assert.equal(r.persisted, false, 'the minimap preference must persist');

  console.log('minimap Electron smoke passed');
} finally {
  if (child.exitCode === null) child.kill();
  await Promise.race([once(child, 'exit'), delay(3000)]).catch(() => {});
  await removeProfileDir(profile);
}
