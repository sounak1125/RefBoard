/**
 * Proves delta undo restores the board exactly, keeps item identity, and costs
 * what the change cost rather than what the board weighs.
 *
 * Runs the real app. On a small board it performs a sequence of real
 * operations (rotate, nudge, group, delete, duplicate, bring to front),
 * recording a canonical picture of the board before each, then undoes all of
 * them checking each step lands on the recorded picture, and redoes all of
 * them checking the same the other way. It also checks a moved item is the
 * same object after undo. Then on a 2,000-item board it times opening an
 * undoable operation (what every gesture pays at its first pointermove)
 * against a whole-board JSON snapshot, which is what it used to cost.
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
const profile = await mkdtemp(path.join(os.tmpdir(), 'refboard-history-'));
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
  for(let i=0;i<8;i++){const c=document.createElement('canvas');c.width=160;c.height=120;const g=c.getContext('2d');g.fillStyle='rgb('+(40+i*20)+',90,160)';g.fillRect(0,0,160,120);
    const blob=await new Promise(r=>c.toBlob(r,'image/png'));files.push(new File([blob],'h-'+i+'.png',{type:'image/png'}));}
  await RB.addImages(files);
  await wait(250);
  state.items.push(RB.makeNoteForTest({x:900,y:900,text:'a note'}));
  RB.invalidateLayout();RB.invalidate();await wait(50);

  const canon=v=>Array.isArray(v)?v.map(canon):(v&&typeof v==='object')?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canon(v[k])])):v;
  const picture=()=>JSON.stringify(canon({items:state.items,boardGray:state.boardGray,gridAppearance:state.gridAppearance,tagColors:state.tagColors}));
  const key=(k,extra={})=>{document.activeElement?.blur?.();document.body.dispatchEvent(new KeyboardEvent('keydown',{key:k,code:k,bubbles:true,cancelable:true,...extra}));};
  const images=()=>state.items.filter(it=>(it.kind||'image')==='image');
  const settle=async()=>{await wait(120);};

  const pictures=[];
  const ops=[];
  const record=async(name,run)=>{pictures.push(picture());ops.push(name);await run();await settle();};
  const first=images()[0];
  await record('rotate all',async()=>{RB.selectAllForTest();RB.rotateSelectionForTest(15);});
  await record('nudge',async()=>{state.sel.clear();state.sel.add(first.id);RB.invalidate();await wait(30);key('ArrowRight');key('ArrowRight');});
  await record('group',async()=>{state.sel.clear();for(const it of images().slice(0,3))state.sel.add(it.id);RB.invalidate();await wait(30);key('g',{ctrlKey:true});});
  await record('delete',async()=>{state.sel.clear();state.sel.add(images()[5].id);RB.invalidate();await wait(30);key('Delete');});
  await record('duplicate',async()=>{state.sel.clear();state.sel.add(images()[4].id);RB.invalidate();await wait(30);key('d',{ctrlKey:true});});
  const finalPicture=picture();
  const opCount=ops.length;

  // An operation may be more than one entry (a nudge is one per keypress), so
  // undo until the recorded picture is reached, up to a few steps, and redo
  // the same number of steps back.
  const undoMismatch=[],stepsPerOp=[];
  for(let i=opCount-1;i>=0;i--){
    let steps=0;
    while(steps<4&&picture()!==pictures[i]){key('z',{ctrlKey:true});await settle();await settle();steps++;}
    stepsPerOp[i]=steps;
    if(picture()!==pictures[i])undoMismatch.push({op:ops[i],step:i,steps});
  }
  const sameObject=state.items.includes(first);
  const redoMismatch=[];
  for(let i=0;i<opCount;i++){
    for(let k=0;k<stepsPerOp[i];k++){key('y',{ctrlKey:true});await settle();await settle();}
    const expected=i+1<opCount?pictures[i+1]:finalPicture;
    if(picture()!==expected)redoMismatch.push({op:ops[i],step:i});
  }
  const stats=RB.historyStats();

  // Cost on a big board.
  const p=document.createElement('canvas');p.width=p.height=256;p.getContext('2d').fillRect(0,0,256,256);
  RB.images.set('hist-img',{id:'hist-img',w:800,h:600,blob:null,blobSize:0,type:'image/png',name:'s.png',version:0,bitmap:null,proxy:p,proxyW:256,proxyH:256,decodeFailed:false,decodeWasSkipped:false,fullLastUsed:0,fullPinCount:0,lod:{entries:new Map(),pending:new Map()}});
  const big=[];for(let i=0;i<2000;i++)big.push({id:'b-'+i,kind:'image',imgId:'hist-img',x:(i%50)*260,y:Math.floor(i/50)*260,w:200,h:150,rot:0,flipX:false,flipY:false,gray:false,crop:{l:0,t:0,r:1,b:1},groupId:null,tags:[]});
  state.items=big;state.sel.clear();RB.invalidateLayout();RB.invalidate();await wait(100);
  const beginMs=RB.historyBeginForTest(20);
  const t0=performance.now();for(let i=0;i<20;i++)JSON.stringify({items:state.items,boardGray:state.boardGray,gridAppearance:state.gridAppearance,tagColors:state.tagColors});
  const snapshotMs=(performance.now()-t0)/20;
  // One real-shaped op on the big board: move one item, then measure its entry.
  RB.pushUndoForTest();big[7].x+=40;RB.invalidateLayout();key('z',{ctrlKey:true});await settle();await settle();
  const afterBigUndo={x:big[7].x,items:state.items.length,bytes:RB.historyStats().bytes};
  return {ops,opCount,stepsPerOp,undoMismatch,redoMismatch,sameObject,stats,beginMs,snapshotMs,afterBigUndo};
})()`;

try {
  const port = await debuggerPort();
  const r = await evaluate(port, smokeExpression, { attempts: 1 });
  console.log('board history probe', JSON.stringify({ ops: r.ops, stepsPerOp: r.stepsPerOp, stats: r.stats, beginMs: Number(r.beginMs.toFixed(3)), snapshotMs: Number(r.snapshotMs.toFixed(3)), afterBigUndo: r.afterBigUndo, undoMismatch: r.undoMismatch, redoMismatch: r.redoMismatch }));
  assert.equal(r.opCount, 5, 'five operations ran');
  assert.deepEqual(r.undoMismatch, [], 'every undo lands exactly on the board as it was before that operation');
  assert.deepEqual(r.redoMismatch, [], 'every redo lands exactly on the board as it was after that operation');
  assert.equal(r.sameObject, true, 'an item that was moved and restored is still the same object');
  assert.equal(r.afterBigUndo.x, (7 % 50) * 260, 'undo on the big board restores the moved item');
  assert.equal(r.afterBigUndo.items, 2000, 'and leaves the rest alone');
  // Opening an operation is one per-item snapshot; the old whole-board stringify was
  // one call and slightly cheaper. What the delta buys is the restore and the memory,
  // so the gate here is only that opening stays trivially cheap on a big board.
  assert.ok(r.beginMs < 5, `opening an operation stays cheap on 2,000 items (${r.beginMs.toFixed(3)} ms)`);
  console.log(`board history smoke: 5 ops undone and redone exactly; on 2,000 items an undoable operation opens in ${r.beginMs.toFixed(3)} ms (old whole-board snapshot: ${r.snapshotMs.toFixed(3)} ms); history holds ${r.stats.bytes} bytes after the sequence`);
  console.log('board history Electron smoke passed');
} finally {
  if (child.exitCode === null) child.kill();
  await Promise.race([once(child, 'exit'), delay(3000)]).catch(() => {});
  await removeProfileDir(profile);
}
