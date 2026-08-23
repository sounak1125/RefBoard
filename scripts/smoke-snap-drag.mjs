import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeProfileDir } from './smoke-profile-cleanup.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const profile = await mkdtemp(path.join(os.tmpdir(), 'refboard-snap-smoke-'));
const child = spawn(electron, ['.', '--remote-debugging-port=0', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-features=CalculateNativeWinOcclusion', `--user-data-dir=${profile}`], {
  cwd: root,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stderr = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', chunk => { stderr += chunk; });

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

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

async function evaluate(port, expression) {
  let targets = [];
  for (let attempt = 0; attempt < 50; attempt++) {
    try { targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json()); } catch { /* retry */ }
    if (targets.some(entry => entry.type === 'page')) break;
    await delay(100);
  }
  const target = targets.find(entry => entry.type === 'page' && /RefBoard|index\.html/i.test(`${entry.title} ${entry.url}`))
    || targets.find(entry => entry.type === 'page');
  if (!target) throw new Error('RefBoard page target was not available');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let nextId = 0;
  const pending = new Map();
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const handlers = pending.get(message.id); pending.delete(message.id);
    if (message.error) handlers.reject(new Error(message.error.message)); else handlers.resolve(message.result);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
  });
  await send('Runtime.enable');
  const response = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  socket.close();
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  return response.result.value;
}

const smokeExpression = String.raw`(async()=>{
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  Element.prototype.setPointerCapture=()=>{};
  Element.prototype.releasePointerCapture=()=>{};
  for(let attempt=0;attempt<100&&!window.RefBoard;attempt++)await wait(50);
  if(!window.RefBoard)throw new Error('RefBoard API unavailable');
  for(let attempt=0;attempt<300&&!window.RefBoard.startupComplete;attempt++)await wait(50);
  if(!window.RefBoard.startupComplete)throw new Error('RefBoard startup did not complete');
  document.querySelectorAll('.modal.show').forEach(el=>el.classList.remove('show'));
  document.querySelector('#rwNewBoard')?.click();
  for(let attempt=0;attempt<100&&!document.body.classList.contains('board-active');attempt++)await wait(50);
  if(!document.body.classList.contains('board-active'))throw new Error('New board did not open');
  await wait(200);
  document.querySelectorAll('.modal.show').forEach(el=>el.classList.remove('show'));

  const RB=window.RefBoard;
  const state=RB.state;
  const board=document.getElementById('board');
  if(!board)throw new Error('Board canvas missing');

  const makeImage=async(name,fill)=>{
    const c=document.createElement('canvas');c.width=200;c.height=200;
    const g=c.getContext('2d');g.fillStyle=fill;g.fillRect(0,0,200,200);
    const blob=await new Promise(r=>c.toBlob(r,'image/png'));
    return new File([blob],name,{type:'image/png'});
  };
  await RB.addImages([await makeImage('snap-a.png','#e44747'),await makeImage('snap-b.png','#357bd8')]);
  await wait(250);

  const view=()=>state.view;
  const toScreen=(x,y)=>{const v=view();return [x*v.s+v.tx,y*v.s+v.ty];};
  const rect=()=>board.getBoundingClientRect();
  const toClient=(sx,sy)=>{const r=rect();return {clientX:r.left+sx,clientY:r.top+sy};};
  const fire=(type,pt,extra={})=>{
    const opts={bubbles:true,cancelable:true,view:window,pointerId:73,pointerType:'mouse',isPrimary:true,
      button:extra.button??(type==='pointermove'?(extra.drag?0:-1):0),
      buttons:extra.buttons??((extra.drag||type==='pointerdown')?1:0),
      clientX:pt.clientX,clientY:pt.clientY,
      shiftKey:!!extra.shiftKey,ctrlKey:!!extra.ctrlKey};
    board.dispatchEvent(new PointerEvent(type,opts));
    if(type!=='pointerdown')window.dispatchEvent(new PointerEvent(type,opts));
  };
  const imgs=()=>state.items.filter(it=>(it.kind||'image')==='image');
  // Never index into state.items: bringItemsToFront reorders it on every drag,
  // so positional lookups silently point at the wrong image.
  const live=id=>state.items.find(it=>it.id===id);

  // Zoom 1:1 and place the pair by hand so screen px == board px and every
  // assertion below can be an exact number.
  view().s=1;view().tx=0;view().ty=0;
  RB.appSettings.snapEnabled=true;
  const place=(it,x,y,w,h)=>{it.x=x;it.y=y;it.w=w;it.h=h;it.rot=0;};
  const [A,B]=imgs();
  if(!A||!B)throw new Error('Both smoke images were not added');

  // Grab a point inside an item and drag it by an exact screen delta. The 3px
  // dead zone is crossed first, then the real delta is applied, so the total
  // pointer travel from pointerdown is exactly (dx,dy).
  const dragBy=(it,dx,dy,extra={})=>{
    state.sel=new Set([it.id]);
    const [sx,sy]=toScreen(it.x+it.w/2,it.y+it.h/2);
    const start=toClient(sx,sy);
    fire('pointerdown',start);
    fire('pointermove',toClient(sx+(dx>=0?4:-4),sy+(dy>=0?4:-4)),{drag:true,...extra});
    fire('pointermove',toClient(sx+dx,sy+dy),{drag:true,...extra});
    const mid=RB.snapStateForTest();
    fire('pointerup',toClient(sx+dx,sy+dy),{drag:true,button:0,buttons:0,...extra});
    return mid;
  };

  /* 1 + 2: flush tiling and its guide. B's left edge starts 7px right of A's
     right edge; dragging B 0px should pull it flush. */
  place(A,100,100,200,200);
  place(B,307,100,200,200);
  const flushMid=dragBy(B,0,0);
  await wait(30);
  const flush={bx:live(B.id).x,expected:live(A.id).x+live(A.id).w,guides:flushMid.guides,sticky:flushMid.sticky};

  /* 3: with B flush, a pure-vertical drag must not disturb x. */
  const xBeforeVertical=live(B.id).x;
  dragBy(live(B.id),0,37);
  await wait(30);
  const verticalKeptX=live(B.id).x===xBeforeVertical;

  /* 4: the dot grid must no longer quantise motion. A lone image dragged 3px
     has to move exactly 3px — the old 10px lattice snapped it to 0 or 10. */
  state.gridAppearance='dots';
  place(A,100,100,200,200);
  place(B,4000,4000,200,200);
  const ax0=live(A.id).x;
  dragBy(live(A.id),3,0);
  await wait(30);
  const gridFree=live(A.id).x-ax0;

  /* 5: Ctrl suppresses the magnet. */
  place(A,100,100,200,200);
  place(B,307,100,200,200);
  const bx0=live(B.id).x;
  dragBy(live(B.id),0,0,{ctrlKey:true});
  await wait(30);
  const ctrlBypassed=live(B.id).x===bx0;

  /* 6: a dragged group lands its children flush, not a padding-width short. */
  place(A,100,100,200,200);
  place(B,700,100,200,200);
  const child2={...RB.makeNoteForTest({x:100,y:400,w:200,h:120,text:'g'}),groupId:null};
  state.items.push(child2);
  const groupId='snap-smoke-group';
  const group={id:groupId,kind:'group',x:90,y:90,w:420,h:440,rot:0,padding:40,color:'#5aa2ff',locked:false,name:'G'};
  state.items.push(group);
  A.groupId=groupId;child2.groupId=groupId;
  // Shift the group so its children's right edge sits 6px short of B's left
  // edge — inside the flush pull, so the drag should close the gap exactly.
  const kids=[A,child2];
  const kidsRight=Math.max(...kids.map(k=>k.x+k.w));
  const shift=(B.x-6)-kidsRight;
  for(const k of kids)k.x+=shift;
  group.x+=shift;
  state.sel=new Set([groupId]);
  const [gsx,gsy]=toScreen(group.x+group.w/2,group.y+group.h/2);
  const gStart=toClient(gsx,gsy);
  fire('pointerdown',gStart);
  fire('pointermove',toClient(gsx+4,gsy),{drag:true});
  fire('pointermove',toClient(gsx,gsy),{drag:true});
  const groupMid=RB.snapStateForTest();
  fire('pointerup',toClient(gsx,gsy),{drag:true,button:0,buttons:0});
  await wait(30);
  const groupFlush={childRight:live(A.id).x+live(A.id).w,targetLeft:live(B.id).x,guides:groupMid.guides};

  /* 7: resize snapping. Drag A's right-edge pill toward B's left edge. */
  for(const it of state.items.filter(i=>i.kind==='group'||i.kind==='note'))state.items.splice(state.items.indexOf(it),1);
  for(const it of imgs())it.groupId=null;
  place(live(A.id),100,100,200,200);
  place(live(B.id),700,100,200,200);
  const R=live(A.id);
  state.sel=new Set([R.id]);
  const aspect0=R.w/R.h;
  const [rsx,rsy]=toScreen(R.x+R.w,R.y+R.h/2);
  const pill=toClient(rsx,rsy);
  // Target 694: 6px short of B's left edge at 700.
  const [tsx]=toScreen(694,0);
  fire('pointerdown',pill);
  fire('pointermove',toClient(rsx+4,rsy),{drag:true});
  fire('pointermove',toClient(tsx,rsy),{drag:true});
  const resizeMid=RB.snapStateForTest();
  fire('pointerup',toClient(tsx,rsy),{drag:true,button:0,buttons:0});
  await wait(30);
  const liveR=live(R.id);
  const resize={right:liveR.x+liveR.w,targetLeft:live(B.id).x,aspect:liveR.w/liveR.h,aspect0,guides:resizeMid.guides};

  /* 8: a rotated image still snaps, by its centre. Rotation is about the
     centre, so A's centre y is A.y+A.h/2 at any angle; park it 5px off B's
     centre y and the drag should close that exactly. */
  place(live(A.id),100,105,200,200);
  place(live(B.id),700,100,200,200);
  live(A.id).rot=30;
  const rotBefore=live(A.id).y;
  const rotMid=dragBy(live(A.id),0,0);
  await wait(30);
  const rotated={y:live(A.id).y,before:rotBefore,expected:100,guides:rotMid.guides};
  live(A.id).rot=0;

  return {flush,verticalKeptX,gridFree,ctrlBypassed,groupFlush,resize,rotated};
})()`;

try {
  const port = await debuggerPort();
  const result = await evaluate(port, smokeExpression);

  assert.equal(result.flush.bx, result.flush.expected,
    `dragging an image beside its neighbour should land it exactly flush (got ${result.flush.bx}, wanted ${result.flush.expected})`);
  assert.ok(result.flush.guides.length >= 1, 'a snapped drag should show a guide');
  assert.ok(result.flush.guides.some(g => g.cls === 'flush' && g.axis === 'x'),
    `the guide should mark the flush contact (got ${JSON.stringify(result.flush.guides)})`);
  assert.ok(result.flush.sticky && result.flush.sticky.x, 'the x axis should read as engaged mid-drag');

  assert.ok(result.verticalKeptX, 'a pure-vertical drag must not disturb an existing flush alignment');

  assert.equal(result.gridFree, 3,
    `with the dot grid on, a 3px drag must move exactly 3px (got ${result.gridFree}) — the grid is visual only now`);

  assert.ok(result.ctrlBypassed, 'Ctrl during a drag should suppress snapping');

  assert.equal(result.groupFlush.childRight, result.groupFlush.targetLeft,
    `a dragged group should land its visible child flush (child right ${result.groupFlush.childRight}, target left ${result.groupFlush.targetLeft})`);

  assert.equal(result.resize.right, result.resize.targetLeft,
    `an edge resize should snap flush to the neighbour (got ${result.resize.right}, wanted ${result.resize.targetLeft})`);
  assert.ok(Math.abs(result.resize.aspect - result.resize.aspect0) < 1e-6,
    'edge resize is aspect-locked, so snapping must not distort the item');
  assert.equal(result.resize.guides.length, 1,
    `a resize applies one axis, so it must advertise exactly one guide (got ${JSON.stringify(result.resize.guides)})`);
  assert.equal(result.resize.guides[0].axis, 'x', 'and it should be the axis that was actually applied');

  assert.equal(result.rotated.y, result.rotated.expected,
    `a rotated image should centre-snap (started ${result.rotated.before}, landed ${result.rotated.y}, wanted ${result.rotated.expected})`);
  assert.ok(result.rotated.guides.some(g => g.cls === 'center' && g.axis === 'y'),
    `a rotated snap should be reported as a centre alignment (got ${JSON.stringify(result.rotated.guides)})`);
  assert.ok(result.rotated.guides.every(g => g.cls === 'center'),
    'a rotated item has no real edge, so it must never claim a flush or edge snap');

  console.log('snap drag Electron smoke passed');
} finally {
  if (child.exitCode === null) child.kill();
  await Promise.race([once(child, 'exit'), delay(3000)]).catch(() => {});
  await removeProfileDir(profile);
}
