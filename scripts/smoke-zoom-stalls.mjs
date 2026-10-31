/**
 * Proves zooming a board of large images does not freeze drawing while the
 * sharper copies are made.
 *
 * createImageBitmap(blob, { resizeWidth, resizeHeight }) resizes on the thread
 * that calls it. Every LOD tier and stable proxy used to be made on the page,
 * so a zoom on a board of big photos froze the board for 16-125 ms per copy:
 * at 160 Hz, up to twenty dropped frames at a time. They are now made in
 * workers (scripts/image-resize-pool.mjs).
 *
 * Runs the real app maximized, adds nine 6000x4000 photos in a grid, and zooms
 * in by mouse wheel from proxy size to just under the 2048 tier, pausing
 * between notches the way a person does, then back out. A MessageChannel ping
 * records every stretch the page thread could not answer. The sweep stays
 * below the full-resolution tier on purpose: the first draw of a full bitmap
 * is a GPU upload, a separate cost this smoke does not cover.
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
const profile = await mkdtemp(path.join(os.tmpdir(), 'refboard-zoom-stalls-'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/* On an RTX 4070 the old page resize froze this sweep for about 270 ms in all,
   the worst single stall around 55 ms; the worker path showed none over 12 ms.
   Either limit alone fails the old code. */
const MAX_STALL_MS = 40;
const MAX_TOTAL_STALL_MS = 100;
const SOURCE_W = 6000;
const SOURCE_H = 4000;
const software = process.argv.includes('--software');

const child = spawn(electron, [...(process.env.REFBOARD_SMOKE_EXECUTABLE ? [] : ['.']), ...(software ? ['--disable-gpu'] : []), '--remote-debugging-port=0', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-features=CalculateNativeWinOcclusion', `--user-data-dir=${profile}`], {
  cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
});
let stderr = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', chunk => { stderr += chunk; });

async function debuggerPort() {
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let attempt = 0; attempt < 150; attempt++) {
    if (child.exitCode !== null) throw new Error(`Electron exited before smoke setup (${child.exitCode})\n${stderr}`);
    try {
      const [port] = (await readFile(portFile, 'utf8')).trim().split(/\r?\n/);
      if (/^\d+$/.test(port)) return Number(port);
    } catch { /* wait for Chromium */ }
    await delay(100);
  }
  throw new Error(`Electron debugging port did not become ready\n${stderr}`);
}

/* One persistent connection: the wheel has to arrive as real input (CDP
   Input), interleaved with page reads, and a fresh socket per call would add
   its own pauses to the gesture being measured. */
async function connect(port) {
  let target = null;
  for (let attempt = 0; attempt < 100 && !target; attempt++) {
    try {
      const list = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json());
      target = list.find(t => t.type === 'page' && /index\.html/i.test(t.url || '') && !/[?&]pane=secondary(?:&|$)/i.test(t.url || ''));
    } catch { /* retry */ }
    if (!target) await delay(100);
  }
  if (!target) throw new Error('RefBoard page target was not available');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let nextId = 0;
  const pending = new Map();
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    const handlers = pending.get(message.id);
    if (!handlers) return;
    pending.delete(message.id);
    if (message.error) handlers.reject(new Error(message.error.message));
    else handlers.resolve(message.result);
  };
  socket.onclose = () => {
    for (const handlers of pending.values()) handlers.reject(new Error('CDP socket closed'));
    pending.clear();
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  return { send, evaluate, close: () => socket.close() };
}

try {
  const cdp = await connect(await debuggerPort());
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
  for (let attempt = 0; attempt < 300; attempt++) {
    try { if (await cdp.evaluate("/index\\.html/.test(location.pathname) && !!(window.RefBoard && window.RefBoard.startupComplete)")) break; } catch { /* context still loading */ }
    await delay(100);
  }

  const setup = await cdp.evaluate(`(async()=>{
    const wait=ms=>new Promise(r=>setTimeout(r,ms));
    window.RefBoardAPI.windowMaximize();
    await wait(800);
    document.querySelectorAll('.modal.show').forEach(el=>el.classList.remove('show'));
    document.querySelector('#rwNewBoard')?.click();
    for(let i=0;i<100&&!document.body.classList.contains('board-active');i++)await wait(50);
    if(!document.body.classList.contains('board-active'))throw new Error('New board did not open');
    document.querySelectorAll('.modal.show').forEach(el=>el.classList.remove('show'));

    // Nine large photos. Noise-free gradients and shapes still cost a full
    // decode and a real resize, which is all the smoke needs.
    const files=[];
    for(let i=0;i<9;i++){
      const c=document.createElement('canvas');c.width=${SOURCE_W};c.height=${SOURCE_H};
      const g=c.getContext('2d');
      const grad=g.createLinearGradient(0,0,c.width,c.height);
      grad.addColorStop(0,'hsl('+(i*40)+',70%,45%)');grad.addColorStop(1,'hsl('+(i*40+160)+',60%,30%)');
      g.fillStyle=grad;g.fillRect(0,0,c.width,c.height);
      for(let k=0;k<60;k++){g.fillStyle='hsla('+((i*40+k*23)%360)+',80%,60%,.5)';g.beginPath();g.arc((k*977)%c.width,(k*613)%c.height,80+(k*37)%400,0,Math.PI*2);g.fill();}
      const blob=await new Promise(r=>c.toBlob(r,'image/jpeg',0.92));
      c.width=0;c.height=0;
      files.push(new File([blob],'photo-'+i+'.jpg',{type:'image/jpeg'}));
    }
    const added=await RefBoard.addImages(files);
    if(added.length!==9)throw new Error('expected 9 images, got '+added.length);
    // A 3x3 grid in board units, 3:2 like the sources.
    added.forEach((it,i)=>{it.w=600;it.h=400;it.x=(i%3)*640;it.y=Math.floor(i/3)*440;});
    RefBoard.invalidateLayout();
    const dpr=Math.max(1,Math.min(2,devicePixelRatio||1));
    const rect=document.querySelector('#board').getBoundingClientRect();
    // Start with each photo at proxy size on screen.
    const v=RefBoard.state.view;v.s=230/dpr/600;
    v.tx=rect.width/2-(640+300)*v.s;v.ty=rect.height/2-(440+200)*v.s;
    RefBoard.invalidate();
    // Every stable proxy has to exist before the measured gesture starts.
    for(let i=0;i<400;i++){if([...RefBoard.images.values()].every(im=>im.proxy))break;await wait(50);}
    await wait(1500);
    window.__stalls={on:false,list:[]};
    let last=performance.now();
    const mc=new MessageChannel();
    mc.port1.onmessage=()=>{const now=performance.now();if(__stalls.on&&now-last>12)__stalls.list.push(Math.round(now-last));last=now;mc.port2.postMessage(0);};
    mc.port2.postMessage(0);
    let renderer='unknown';
    try{const gl=document.createElement('canvas').getContext('webgl');renderer=String(gl.getParameter(gl.getExtension('WEBGL_debug_renderer_info').UNMASKED_RENDERER_WEBGL));}catch{}
    return {renderer,x:rect.left+rect.width/2,y:rect.top+rect.height/2,dpr,w:rect.width,h:rect.height,
      proxies:[...RefBoard.images.values()].filter(im=>im.proxy).length,
      lodBefore:(await RefBoard.memoryStats()).images.lodCount};
  })()`);
  assert.equal(setup.proxies, 9, 'every photo has its stable proxy before the zoom');

  // From 230 to about 1900 physical px on screen: notches of x1.17 (deltaY 100).
  const notches = Math.floor(Math.log(1900 / 230) / 0.16);
  const wheel = deltaY => cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: setup.x, y: setup.y, deltaX: 0, deltaY });
  await cdp.evaluate('(__stalls.on=true,1)');
  for (const direction of [-100, 100]) {
    for (let n = 0; n < notches; n += 2) {
      await wheel(direction);
      await delay(16);
      if (n + 1 < notches) await wheel(direction);
      // Long enough for the wheel to settle and the new tiers to be made.
      await delay(450);
    }
  }
  await delay(2000);

  const result = await cdp.evaluate(`(async()=>{__stalls.on=false;return {
    stalls:__stalls.list.slice().sort((a,b)=>b-a),
    lodAfter:(await RefBoard.memoryStats()).images.lodCount,
    resize:typeof RefBoard.imageResizeStats==='function'?RefBoard.imageResizeStats():null,
    scale:RefBoard.state.view.s,
  }})()`);
  cdp.close();

  const worst = result.stalls[0] || 0;
  const total = result.stalls.reduce((a, b) => a + b, 0);
  console.log(`zoom-stalls smoke (${software ? 'software' : 'default'}): ${setup.w}x${setup.h} CSS px at ${setup.dpr}x, ${notches} notches each way; `
    + `LOD tiers ${setup.lodBefore} -> ${result.lodAfter}; page stalls over 12 ms: ${result.stalls.length} `
    + `(total ${total} ms, worst ${worst} ms: [${result.stalls.slice(0, 8).join(', ')}]); `
    + `resize pool ${JSON.stringify(result.resize)}`);

  assert.ok(result.lodAfter - setup.lodBefore >= 6, `the zoom made sharper tiers (${setup.lodBefore} -> ${result.lodAfter})`);
  // A software rasteriser spends ~40 ms of page time drawing each frame of a
  // maximized board whatever the resize path, so timing proves nothing there
  // (Windows CI has no GPU). The worker checks below still run.
  const hardware = !software && !/SwiftShader|Basic Render|WARP|llvmpipe/i.test(setup.renderer);
  if (hardware) {
    assert.ok(worst < MAX_STALL_MS, `no single page stall reaches ${MAX_STALL_MS} ms while zooming (worst ${worst} ms)`);
    assert.ok(total < MAX_TOTAL_STALL_MS, `page stalls total under ${MAX_TOTAL_STALL_MS} ms across the zoom (${total} ms)`);
  } else {
    console.log(`zoom-stalls smoke: stall limits not asserted on a software renderer (${setup.renderer})`);
  }
  assert.ok(result.resize, 'the page exposes resize pool stats');
  assert.equal(result.resize.fallbacks, 0, 'every resize ran in a worker, none fell back to the page');
  assert.ok(result.resize.completed >= 9 + 6, `the workers made the proxies and the tiers (${result.resize.completed})`);
  console.log('zoom-stalls Electron smoke passed');
} finally {
  if (child.exitCode === null) child.kill();
  await Promise.race([once(child, 'exit'), delay(3000)]).catch(() => {});
  await removeProfileDir(profile);
}
