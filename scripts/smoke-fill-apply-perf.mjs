/**
 * Proves an edited photo does not slow the board down after the edit.
 *
 * Drawing a 24 MP source into a tile a few hundred pixels wide costs the GPU
 * about 20 ms a frame, a resample of every source pixel. Two edit paths left
 * one such draw on the board at every zoom:
 *
 * - While Remove object was open, the item drew the tool's full-resolution
 *   working canvas.
 * - After Apply (and after a Draw stroke), the edit left the new full bitmap
 *   resident. At proxy size nothing replaced it, and being drawn kept it
 *   protected from eviction, so the board stayed slow until it was reopened.
 *   Zooming into a photo and back out left the same loop behind.
 *
 * On an RTX 4070 at 160 Hz the board panned at 160 fps before a fill and at
 * about 65 fps both during the session and for as long as it stayed open
 * after Apply.
 *
 * Runs the real app maximized with nine 6000x4000 photos at proxy size, fills
 * and applies on one, draws a stroke on another, and zooms one in and back
 * out. After each step it checks which surface the edited item drew (a test
 * hook, because the cost is GPU time a screenshot cannot show), and it
 * measures rAF intervals over a 3 s programmatic pan. Frame rates are only
 * asserted on a hardware renderer: Windows CI has no GPU.
 *
 * Needs WebGPU and the fill model at inpaint-lab/models/lama-carve/, like
 * smoke-inpaint-fill.mjs. Run it locally with `npm run test:fill-perf-smoke`.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeProfileDir } from './smoke-profile-cleanup.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const model = path.join(root, 'inpaint-lab', 'models', 'lama-carve', 'lama_fp32.onnx');
if (!process.env.REFBOARD_SMOKE_EXECUTABLE) {
  try {
    await access(model);
  } catch {
    console.error(`smoke-fill-apply-perf needs the model at ${model} (see scripts/inpaint-bakeoff/README.md)`);
    process.exit(1);
  }
}

const electron = process.env.REFBOARD_SMOKE_EXECUTABLE || path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const profile = await mkdtemp(path.join(os.tmpdir(), 'refboard-fill-perf-'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const SOURCE_W = 6000;
const SOURCE_H = 4000;
/* The old code panned at about 40% of the baseline frame rate on a 160 Hz
   display, and at about 80% on a 60 Hz one, where vsync caps the baseline. */
const MIN_FPS_RATIO = 0.8;
/* A surface more than twice the item's target extent is the oversized draw. */
const MAX_SURFACE_RATIO = 2;

const child = spawn(electron, [...(process.env.REFBOARD_SMOKE_EXECUTABLE ? [] : ['.']), '--remote-debugging-port=0', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-features=CalculateNativeWinOcclusion', `--user-data-dir=${profile}`], {
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

/* One persistent connection: the Draw stroke has to arrive as real input (CDP
   Input), interleaved with page reads. */
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

/* A 3 s pan, wobbling a few pixels per frame: rAF intervals only. */
const PAN = `(async()=>{
  const RB=window.RefBoard,v=RB.state.view;
  const frames=[];let prev=performance.now();const end=prev+3000;let dir=1,k=0;
  await new Promise(done=>{const step=t=>{frames.push(t-prev);prev=t;if(++k%60===0)dir=-dir;v.tx+=4*dir;v.ty+=2*dir;RB.invalidate();
    if(t<end)requestAnimationFrame(step);else done();};requestAnimationFrame(step);});
  frames.shift();frames.sort((a,b)=>a-b);
  const mean=frames.reduce((a,b)=>a+b,0)/frames.length;
  return {fps:Math.round(1000/mean),p95:Math.round(frames[Math.floor(frames.length*.95)]*10)/10,frames:frames.length};
})()`;

/* What the item drew last frame, and what it needed. Null on a build without
   the hook, so the frame rates are still reported. */
const surfaceOf = id => `(async()=>{
  const RB=window.RefBoard;RB.invalidate();
  await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
  if(typeof RB.imageSurfaceForTest!=='function')return null;
  const s=RB.imageSurfaceForTest(${JSON.stringify(id)});
  const st=RB.imageRenderStateForTest(${JSON.stringify(id)});
  const source=Math.max(st.w,st.h);
  const targetExtent=st.displayTarget==='full'?source:Math.min(source,st.displayTarget);
  return {kind:s?.kind||null,extent:s?Math.max(s.w,s.h):0,target:st.displayTarget,targetExtent,fullResident:st.fullResident,fullProtected:st.fullProtected};
})()`;

/* Put an item's centre on screen at `screenPx` physical pixels wide, then let
   the demand plan and decodes settle. */
const viewItem = (id, screenPx, settleMs) => `(async()=>{
  const RB=window.RefBoard,v=RB.state.view;
  const it=RB.state.items.find(i=>i.id===${JSON.stringify(id)});
  const rect=document.getElementById('board').getBoundingClientRect();
  const dpr=Math.max(1,Math.min(2,devicePixelRatio||1));
  v.s=${screenPx}/dpr/it.w;v.tx=rect.width/2-(it.x+it.w/2)*v.s;v.ty=rect.height/2-(it.y+it.h/2)*v.s;
  RB.invalidate();
  await new Promise(r=>setTimeout(r,${settleMs}));
  return true;
})()`;

const report = {};
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
    window.__perfErrors=[];
    window.addEventListener('error',e=>__perfErrors.push(e.message));
    window.addEventListener('unhandledrejection',e=>__perfErrors.push(String(e.reason?.message||e.reason)));
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
    added.forEach((it,i)=>{it.w=600;it.h=400;it.x=(i%3)*640;it.y=Math.floor(i/3)*440;it.rot=0;});
    RefBoard.invalidateLayout();
    RefBoard.traceImageSurfacesForTest?.(true);
    let renderer='unknown';
    try{const gl=document.createElement('canvas').getContext('webgl');renderer=String(gl.getParameter(gl.getExtension('WEBGL_debug_renderer_info').UNMASKED_RENDERER_WEBGL));}catch{}
    return {renderer,ids:added.map(it=>it.id),imgIds:added.map(it=>it.imgId),dpr:devicePixelRatio};
  })()`);
  const fillId = setup.ids[4];
  const drawId = setup.ids[0];
  const drawImgId = setup.imgIds[0];
  // The middle photo at proxy size (230 physical px), the grid around it in view.
  const fitView = async () => {
    await cdp.evaluate(viewItem(fillId, 230, 300));
    await cdp.evaluate(`(async()=>{for(let i=0;i<400;i++){if([...RefBoard.images.values()].every(im=>im.proxy))break;await new Promise(r=>setTimeout(r,50));}
      await new Promise(r=>setTimeout(r,1500));return true;})()`);
  };
  await fitView();
  report.baseline = await cdp.evaluate(PAN);

  // 1. Remove object on the middle photo: one fill, then pan with the tool open.
  report.fill = await cdp.evaluate(`(async()=>{
    const wait=ms=>new Promise(r=>setTimeout(r,ms));const RB=window.RefBoard;
    const until=async(test,ms,what)=>{const end=performance.now()+ms;while(performance.now()<end){if(test())return true;await wait(50);}
      throw new Error('timed out waiting for '+what+' - fill state: '+JSON.stringify(RB.fillStateForTest())+' toast: "'+document.querySelector('#toast').textContent+'"');};
    const it=RB.state.items.find(i=>i.id===${JSON.stringify(fillId)});
    RB.state.sel=new Set([it.id]);RB.updateSelBarForTest();
    document.querySelector('#sFill').click();
    for(let i=0;i<40&&!RB.fillStateForTest();i++){
      if(document.querySelector('#confirmModal').classList.contains('show')){document.querySelector('#confirmOk').click();break;}
      await wait(50);
    }
    await until(()=>RB.fillStateForTest()?.status==='Draw around what to remove',600000,'the model to load');
    const cv=document.getElementById('board'),v=RB.state.view,r=cv.getBoundingClientRect();
    const toC=(px,py)=>[r.left+(it.x+px/${SOURCE_W}*it.w)*v.s+v.tx,r.top+(it.y+py/${SOURCE_H}*it.h)*v.s+v.ty];
    const P=(t,[x,y],tg=cv)=>tg.dispatchEvent(new PointerEvent(t,{clientX:x,clientY:y,button:0,buttons:t==='pointerup'?0:1,pointerId:1,pointerType:'mouse',isPrimary:true,bubbles:true}));
    const pts=[];for(let k=0;k<=40;k++){const a=k/40*Math.PI*2;pts.push(toC(3000+700*Math.cos(a),2000+700*Math.sin(a)));}
    P('pointerdown',pts[0]);for(const p of pts.slice(1)){P('pointermove',p,window);await wait(4);}P('pointerup',pts.at(-1),window);
    await until(()=>RB.fillStateForTest()?.fills===1&&!RB.fillStateForTest().busy,120000,'the fill');
    await wait(500);
    return RB.fillStateForTest();
  })()`);
  report.sessionSurface = await cdp.evaluate(surfaceOf(fillId));
  report.duringSession = await cdp.evaluate(PAN);
  // Shown near full size, the tool still draws its full working canvas.
  await cdp.evaluate(viewItem(fillId, 3000, 2500));
  report.sessionZoomedSurface = await cdp.evaluate(surfaceOf(fillId));
  await fitView();

  // 2. Apply, then pan.
  await cdp.evaluate(`(async()=>{
    document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
    for(let i=0;i<600&&RefBoard.fillStateForTest();i++)await new Promise(r=>setTimeout(r,50));
    if(RefBoard.fillStateForTest())throw new Error('Apply did not finish');
    await new Promise(r=>setTimeout(r,2000));
    return true;
  })()`);
  report.appliedSurface = await cdp.evaluate(surfaceOf(fillId));
  report.afterApply = await cdp.evaluate(PAN);

  // 3. A Draw stroke on the top-left photo, committed on release.
  const board = await cdp.evaluate(`(()=>{const RB=window.RefBoard,v=RB.state.view;const it=RB.state.items.find(i=>i.id===${JSON.stringify(drawId)});
    const r=document.getElementById('board').getBoundingClientRect();
    return {x0:r.left+(it.x+it.w*.25)*v.s+v.tx,x1:r.left+(it.x+it.w*.75)*v.s+v.tx,y:r.top+(it.y+it.h/2)*v.s+v.ty,
      gen:RB.images.get(${JSON.stringify(drawImgId)})?.pixelGen||0};})()`);
  const key = async (k, code, vk) => {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, text: k });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk });
  };
  await key('d', 'KeyD', 68);
  await delay(200);
  const mouse = (type, x, y, buttons = 0) => cdp.send('Input.dispatchMouseEvent', {
    type, x, y, button: type === 'mouseMoved' ? (buttons ? 'left' : 'none') : 'left', buttons, clickCount: 1,
  });
  await mouse('mouseMoved', board.x0, board.y);
  await mouse('mousePressed', board.x0, board.y, 1);
  await delay(400);
  for (let i = 1; i <= 30; i++) await mouse('mouseMoved', board.x0 + (board.x1 - board.x0) * i / 30, board.y, 1);
  await mouse('mouseReleased', board.x1, board.y);
  await cdp.evaluate(`(async()=>{
    const wait=ms=>new Promise(r=>setTimeout(r,ms));
    const im=()=>RefBoard.images.get(${JSON.stringify(drawImgId)});
    for(let i=0;i<200&&((im()?.pixelGen||0)===${board.gen}||im()?.pixelUpdateInProgress);i++)await wait(50);
    if((im()?.pixelGen||0)===${board.gen})throw new Error('the stroke was not committed');
    return true;
  })()`);
  await key('d', 'KeyD', 68);
  await delay(2000);
  report.drawnSurface = await cdp.evaluate(surfaceOf(drawId));
  report.afterDraw = await cdp.evaluate(PAN);

  // 4. Zoom the edited photo to full size and back out: it is sharp up close,
  // and the full bitmap it decoded stops being drawn once it is small again.
  await cdp.evaluate(viewItem(fillId, 3000, 4000));
  report.zoomedSurface = await cdp.evaluate(surfaceOf(fillId));
  await fitView();
  await delay(1000);
  report.zoomedOutSurface = await cdp.evaluate(surfaceOf(fillId));
  report.afterZoomOut = await cdp.evaluate(PAN);
  report.errors = await cdp.evaluate('window.__perfErrors');
  cdp.close();

  const hardware = !/SwiftShader|Basic Render|WARP|llvmpipe/i.test(setup.renderer);
  console.log(`fill-apply-perf smoke on ${setup.renderer} at ${setup.dpr}x: pan fps baseline ${report.baseline.fps}, `
    + `fill tool open ${report.duringSession.fps}, after Apply ${report.afterApply.fps}, after a Draw stroke ${report.afterDraw.fps}, `
    + `after zooming in and out ${report.afterZoomOut.fps}`);
  console.log(JSON.stringify({
    session: report.sessionSurface, sessionZoomed: report.sessionZoomedSurface, applied: report.appliedSurface,
    drawn: report.drawnSurface, zoomed: report.zoomedSurface, zoomedOut: report.zoomedOutSurface,
  }));

  assert.deepEqual(report.errors, [], 'no runtime errors');
  if (hardware) {
    for (const step of ['duringSession', 'afterApply', 'afterDraw', 'afterZoomOut']) {
      assert.ok(report[step].fps >= report.baseline.fps * MIN_FPS_RATIO,
        `${step}: the board pans at ${report[step].fps} fps, below ${MIN_FPS_RATIO * 100}% of the ${report.baseline.fps} fps baseline`);
    }
  } else {
    console.log(`fill-apply-perf smoke: frame rates not asserted on a software renderer (${setup.renderer})`);
  }
  assert.ok(report.sessionSurface, 'the page exposes imageSurfaceForTest');
  const small = (s, what) => {
    assert.ok(s.extent <= s.targetExtent * MAX_SURFACE_RATIO,
      `${what}: drew a ${s.kind} surface ${s.extent} px long for a ${s.targetExtent} px target (${JSON.stringify(s)})`);
  };
  assert.equal(report.sessionSurface.kind, 'fill-preview', 'at proxy size the fill tool draws its preview, not the working canvas');
  small(report.sessionSurface, 'fill tool open');
  assert.equal(report.sessionZoomedSurface.kind, 'fill', 'near full size the fill tool draws its full working canvas');
  assert.notEqual(report.appliedSurface.kind, 'full', 'after Apply the photo no longer draws its full bitmap at proxy size');
  small(report.appliedSurface, 'after Apply');
  assert.notEqual(report.drawnSurface.kind, 'full', 'after a Draw stroke the photo no longer draws its full bitmap at proxy size');
  small(report.drawnSurface, 'after a Draw stroke');
  assert.ok(report.zoomedSurface.extent >= Math.min(2048, report.zoomedSurface.targetExtent),
    `zoomed in, the photo is drawn sharp (${JSON.stringify(report.zoomedSurface)})`);
  small(report.zoomedOutSurface, 'zoomed back out');
  console.log('fill-apply-perf Electron smoke passed');
} finally {
  if (child.exitCode === null) child.kill();
  await Promise.race([once(child, 'exit'), delay(3000)]).catch(() => {});
  await removeProfileDir(profile);
}
