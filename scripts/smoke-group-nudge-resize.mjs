// Two group regressions, both driven through real input so the assertions are
// about what the user ends up with:
//   1. nudge() moved the selection but not a selected group's children, so the
//      frame slid off its contents. It also never pushed undo.
//   2. multi-select groupResize scaled group frames without their children.
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
const profile = await mkdtemp(path.join(os.tmpdir(), 'refboard-group-fix-smoke-'));
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
  const live=id=>state.items.find(it=>it.id===id);

  const mk=async(name,fill)=>{
    const c=document.createElement('canvas');c.width=200;c.height=200;
    const g=c.getContext('2d');g.fillStyle=fill;g.fillRect(0,0,200,200);
    const b=await new Promise(r=>c.toBlob(r,'image/png'));
    return new File([b],name,{type:'image/png'});
  };
  await RB.addImages([await mk('g1.png','#c94a4a'),await mk('g2.png','#3f74c9'),await mk('solo.png','#4a9c6a')]);
  await wait(300);
  state.view.s=1;state.view.tx=0;state.view.ty=0;

  const imgs=state.items.filter(i=>(i.kind||'image')==='image');
  const [A,B,C]=imgs;
  const place=(it,x,y,w,h)=>{it.x=x;it.y=y;it.w=w;it.h=h;it.rot=0;};

  // A + B in a group; C loose alongside.
  place(A,100,100,200,200);
  place(B,340,100,200,200);
  place(C,700,100,200,200);
  const gid='grp-smoke-1';
  const group={id:gid,kind:'group',x:60,y:60,w:520,h:280,rot:0,padding:40,color:'#5aa2ff',locked:false,name:'G'};
  state.items.push(group);
  A.groupId=gid;B.groupId=gid;
  const frameOf=()=>live(gid);

  // Dispatch on body, not window: the handler calls e.target.matches(...), and
  // window has no matches(), so a window-targeted event throws before it ever
  // reaches the arrow branch. Body bubbles up to the window listener.
  const key=(k,extra={})=>document.body.dispatchEvent(new KeyboardEvent('keydown',{key:k,bubbles:true,cancelable:true,...extra}));

  /* --- 1a: nudging a selected GROUP must carry its children --- */
  state.sel=new Set([gid]);
  const before={ax:live(A.id).x,bx:live(B.id).x,fx:frameOf().x};
  const entriesBefore=RB.undoStats().entries;
  key('ArrowRight',{shiftKey:true});   // step = 20 at s=1
  await wait(60);
  const nudged={
    ax:live(A.id).x,bx:live(B.id).x,fx:frameOf().x,
    beforeAx:before.ax,beforeBx:before.bx,beforeFx:before.fx,
  };

  const entriesAdded=RB.undoStats().entries-entriesBefore;

  /* --- 1c: a held key (repeat) collapses into ONE history entry --- */
  state.sel=new Set([gid]);
  const entries0=RB.undoStats().entries;
  key('ArrowRight');                                  // initial press
  for(let i=0;i<6;i++)key('ArrowRight',{repeat:true}); // OS key repeat
  await wait(60);
  const burst={added:RB.undoStats().entries-entries0,moved:live(A.id).x-nudged.ax};

  /* --- 2: multi-select resize of [group, loose image] must scale the group's
         children, not just its frame --- */
  place(live(A.id),100,100,200,200);
  place(live(B.id),340,100,200,200);
  place(live(C.id),700,100,200,200);
  if(typeof RB.syncGroupFramesForTest==='function')RB.syncGroupFramesForTest();
  state.sel=new Set([gid,C.id]);
  await wait(60);

  const rect=board.getBoundingClientRect();
  const toClient=(x,y)=>({clientX:rect.left+x*state.view.s+state.view.tx,clientY:rect.top+y*state.view.s+state.view.ty});
  const fire=(t,pt,extra={})=>{
    const o={bubbles:true,cancelable:true,view:window,pointerId:77,pointerType:'mouse',isPrimary:true,
      button:extra.drag?0:(t==='pointermove'?-1:0),buttons:(extra.drag||t==='pointerdown')?1:0,
      clientX:pt.clientX,clientY:pt.clientY,ctrlKey:true};   // ctrl = no snapping, pure geometry
    board.dispatchEvent(new PointerEvent(t,o));
    if(t!=='pointerdown')window.dispatchEvent(new PointerEvent(t,o));
  };

  // Aim at the SE corner using the app's own selection rect, so the pointer
  // lands on the real handle.
  const bb=(()=>{
    const r=RB.selectionBBoxRectForTest();
    if(!r)throw new Error('no multi-select frame');
    if(r.rot)throw new Error('unexpected rotated selection frame');
    return {x2:r.x+r.w,y2:r.y+r.h};
  })();
  const preA={x:live(A.id).x,y:live(A.id).y,w:live(A.id).w,h:live(A.id).h};
  const preB={w:live(B.id).w};
  const preC={w:live(C.id).w};
  const preFrame={x:frameOf().x,w:frameOf().w};

  const se=toClient(bb.x2,bb.y2);
  fire('pointerdown',se);
  fire('pointermove',{clientX:se.clientX+6,clientY:se.clientY+6},{drag:true});
  fire('pointermove',{clientX:se.clientX+160,clientY:se.clientY+160},{drag:true});
  fire('pointerup',{clientX:se.clientX+160,clientY:se.clientY+160},{drag:true,button:0,buttons:0});
  await wait(80);

  const postA={x:live(A.id).x,y:live(A.id).y,w:live(A.id).w,h:live(A.id).h};
  const postFrame={x:frameOf().x,w:frameOf().w};
  const resize={
    aGrew:postA.w>preA.w+1,
    bGrew:live(B.id).w>preB.w+1,
    cGrew:live(C.id).w>preC.w+1,
    aScale:postA.w/preA.w,
    cScale:live(C.id).w/preC.w,
    // The frame must still wrap its children after the scale.
    frameWrapsChildren:(()=>{
      const f=frameOf();
      const kids=[live(A.id),live(B.id)];
      const kx1=Math.min(...kids.map(k=>k.x)),kx2=Math.max(...kids.map(k=>k.x+k.w));
      const ky1=Math.min(...kids.map(k=>k.y)),ky2=Math.max(...kids.map(k=>k.y+k.h));
      return f.x<=kx1+0.51 && f.y<=ky1+0.51 && f.x+f.w>=kx2-0.51 && f.y+f.h>=ky2-0.51;
    })(),
    preFrame,postFrame,
  };

  /* --- 1b LAST: undo must step back one nudge. Pre-fix, nudge pushed nothing,
         so undo reached straight past it and took the items with it — which is
         why this runs last and checks existence, rather than cascading a crash
         through the stages above. */
  place(live(A.id),100,100,200,200);
  place(live(B.id),340,100,200,200);
  RB.syncGroupFramesForTest();
  state.sel=new Set([gid]);
  await wait(40);
  const undoBefore={ax:live(A.id).x,bx:live(B.id).x};
  key('ArrowRight',{shiftKey:true});
  await wait(60);
  const undoNudged={ax:live(A.id).x,bx:live(B.id).x};
  RB.undoForTest();
  await wait(80);
  const ua=live(A.id),ub=live(B.id);
  const afterUndo={present:!!(ua&&ub),ax:ua?ua.x:null,bx:ub?ub.x:null,
                   wantAx:undoBefore.ax,wantBx:undoBefore.bx,movedTo:undoNudged.ax};

  return {nudged,entriesAdded,afterUndo,burst,resize};
})()`;

try {
  const port = await debuggerPort();
  const r = await evaluate(port, smokeExpression);

  // --- 1a ---
  assert.equal(r.nudged.ax, r.nudged.beforeAx + 20, `nudge should move the group's first child (got ${r.nudged.ax}, wanted ${r.nudged.beforeAx + 20})`);
  assert.equal(r.nudged.bx, r.nudged.beforeBx + 20, `nudge should move the group's second child (got ${r.nudged.bx})`);
  assert.equal(r.nudged.fx, r.nudged.beforeFx + 20, 'and the frame should travel with them, not slide off');

  // --- 1b ---
  assert.equal(r.entriesAdded, 1, `a nudge should add exactly one history entry (got ${r.entriesAdded})`);
  assert.ok(r.afterUndo.present, 'undo after a nudge should step back one nudge, not past the items themselves');
  assert.equal(r.afterUndo.ax, r.afterUndo.wantAx, `undo should put the first child back (moved to ${r.afterUndo.movedTo}, landed ${r.afterUndo.ax}, wanted ${r.afterUndo.wantAx})`);
  assert.equal(r.afterUndo.bx, r.afterUndo.wantBx, 'undo should put the second child back');

  // --- 1c ---
  assert.ok(r.burst.moved !== 0, 'the held-key burst should still move the selection');
  assert.equal(r.burst.added, 1, `a held arrow key should collapse into one history entry (got ${r.burst.added})`);

  // --- 2 ---
  assert.ok(r.resize.cGrew, 'the loose image in the multi-selection should scale');
  assert.ok(r.resize.aGrew, 'a grouped child should scale too — this is the bug: the frame used to scale alone');
  assert.ok(r.resize.bGrew, 'both grouped children should scale');
  assert.ok(Math.abs(r.resize.aScale - r.resize.cScale) < 0.02,
    `grouped and loose items should scale by the same factor (group ${r.resize.aScale.toFixed(3)} vs loose ${r.resize.cScale.toFixed(3)})`);
  assert.ok(r.resize.frameWrapsChildren,
    `the group frame should still wrap its children after the resize (frame ${JSON.stringify(r.resize.postFrame)})`);

  console.log('group nudge + resize Electron smoke passed');
} finally {
  if (child.exitCode === null) child.kill();
  await Promise.race([once(child, 'exit'), delay(3000)]).catch(() => {});
  await removeProfileDir(profile);
}
