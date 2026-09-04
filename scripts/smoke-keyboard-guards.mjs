/**
 * Proves two keyboard paths no longer misbehave.
 *
 * Enter with nothing selected, or with two items selected, used to throw an
 * uncaught TypeError from the item-kind predicates. And Ctrl+Z during a live
 * drag replaced every item object under the gesture: the dragged item snapped
 * back to its pre-drag position while the pointer was still down, and the
 * rest of the move wrote into objects the board no longer held.
 *
 * Runs the real app, counts page errors around the keypresses, and drives a
 * drag with pointer events, pressing Ctrl+Z in the middle of it.
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
const profile = await mkdtemp(path.join(os.tmpdir(), 'refboard-keyboard-guards-'));
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
  const RB=window.RefBoard, state=RB.state;
  document.querySelectorAll('.modal.show').forEach(el=>el.classList.remove('show'));
  document.querySelector('#rwNewBoard')?.click();
  for(let attempt=0;attempt<100&&!document.body.classList.contains('board-active');attempt++)await wait(50);
  if(!document.body.classList.contains('board-active'))throw new Error('New board did not open');
  await wait(200);
  document.querySelectorAll('.modal.show').forEach(el=>el.classList.remove('show'));

  const files=[];
  for(let i=0;i<2;i++){
    const c=document.createElement('canvas');c.width=120;c.height=90;
    const g=c.getContext('2d');g.fillStyle=i?'#c96':'#69c';g.fillRect(0,0,120,90);
    const blob=await new Promise(r=>c.toBlob(r,'image/png'));
    files.push(new File([blob],'guard-'+i+'.png',{type:'image/png'}));
  }
  await RB.addImages(files);
  await wait(250);
  const imgs=state.items.filter(it=>(it.kind||'image')==='image');
  if(imgs.length<2)throw new Error('two images expected');

  const errors=[];
  window.addEventListener('error',e=>errors.push(String(e.message||e.error||e)));
  window.addEventListener('unhandledrejection',e=>errors.push('rejection: '+String(e.reason&&e.reason.message||e.reason)));
  document.activeElement?.blur?.();
  const key=(k,extra={})=>{
    const opts={key:k,code:k,bubbles:true,cancelable:true,...extra};
    document.body.dispatchEvent(new KeyboardEvent('keydown',opts));
  };

  // 1. Enter with nothing selected, then with two items selected.
  state.sel.clear();RB.invalidate();await wait(50);
  key('Enter');await wait(80);
  const enterEmptyErrors=errors.length;
  state.sel.clear();state.sel.add(imgs[0].id);state.sel.add(imgs[1].id);RB.invalidate();await wait(50);
  key('Enter');await wait(80);
  const enterMultiErrors=errors.length;
  state.sel.clear();

  // 2. Ctrl+Z in the middle of a drag.
  const board=document.querySelector('#board');
  const v=state.view;v.s=1;v.tx=0;v.ty=0;
  const A=imgs[0];A.x=200;A.y=200;A.w=120;A.h=90;A.rot=0;
  const B=imgs[1];B.x=600;B.y=200;B.w=120;B.h=90;B.rot=0;
  RB.invalidate();await wait(100);
  const rect=board.getBoundingClientRect();
  const fire=(type,sx,sy,extra={})=>{
    const opts={bubbles:true,cancelable:true,view:window,pointerId:91,pointerType:'mouse',isPrimary:true,
      button:extra.button??(type==='pointermove'?(extra.drag?0:-1):0),
      buttons:extra.buttons??((extra.drag||type==='pointerdown')?1:0),
      clientX:rect.left+sx,clientY:rect.top+sy};
    board.dispatchEvent(new PointerEvent(type,opts));
    if(type!=='pointerdown')window.dispatchEvent(new PointerEvent(type,opts));
  };
  const startX=A.x+A.w/2, startY=A.y+A.h/2;
  fire('pointerdown',startX,startY);
  fire('pointermove',startX+6,startY+6,{drag:true});
  fire('pointermove',startX+40,startY+30,{drag:true});
  await wait(50);
  // Null-safe: on the old code the item was not findable after a mid-drag undo.
  const live=()=>state.items.find(it=>it.id===A.id)||{x:null,y:null};
  const itemCount=()=>state.items.length;
  const midDragX=live().x, midDragY=live().y; const countMidDrag=itemCount();
  const modeBefore=RB.mode?.type||null;
  key('z',{ctrlKey:true});
  await wait(300);
  const afterUndoX=live().x, afterUndoY=live().y; const countAfterUndo=itemCount();
  const modeAfter=RB.mode?.type||null;
  fire('pointermove',startX+50,startY+40,{drag:true});
  fire('pointerup',startX+50,startY+40,{drag:true,button:0,buttons:0});
  await wait(100);
  const droppedX=live().x, droppedY=live().y;
  // Now, with no gesture live, Ctrl+Z must work as usual.
  key('z',{ctrlKey:true});
  await wait(400);
  const undoneX=live().x, undoneY=live().y;
  return {enterEmptyErrors,enterMultiErrors,errors,countMidDrag,countAfterUndo,midDrag:[midDragX,midDragY],afterUndo:[afterUndoX,afterUndoY],modeBefore,modeAfter,dropped:[droppedX,droppedY],undone:[undoneX,undoneY]};
})()`;

try {
  const port = await debuggerPort();
  const r = await evaluate(port, smokeExpression, { attempts: 1 });
  console.log('keyboard guards probe', JSON.stringify(r));
  assert.equal(r.enterEmptyErrors, 0, `Enter with nothing selected must not throw: ${r.errors.join(' | ')}`);
  assert.equal(r.enterMultiErrors, 0, `Enter with two items selected must not throw: ${r.errors.join(' | ')}`);
  assert.deepEqual(r.midDrag, [240, 230], `the drag moved the item (${r.midDrag})`);
  assert.equal(r.modeBefore, 'move', 'a move gesture was live when Ctrl+Z was pressed');
  assert.equal(r.countAfterUndo, r.countMidDrag, `Ctrl+Z during a drag must not change the board (${r.countMidDrag} -> ${r.countAfterUndo} items)`);
  assert.deepEqual(r.afterUndo, r.midDrag, `Ctrl+Z during a drag must not move the item (${r.afterUndo} vs ${r.midDrag})`);
  assert.equal(r.modeAfter, 'move', 'the gesture is still live after the refused undo');
  assert.deepEqual(r.dropped, [250, 240], `the drag completed where the pointer was released (${r.dropped})`);
  assert.deepEqual(r.undone, [200, 200], `Ctrl+Z after the drag restores the pre-drag position (${r.undone})`);
  assert.deepEqual(r.errors, [], `no page errors during the run: ${r.errors.join(' | ')}`);
  console.log('keyboard guards Electron smoke passed');
} finally {
  if (child.exitCode === null) child.kill();
  await Promise.race([once(child, 'exit'), delay(3000)]).catch(() => {});
  await removeProfileDir(profile);
}
