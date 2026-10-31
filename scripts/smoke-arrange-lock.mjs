/**
 * Align in a row / Align in a column, driven through the real selection bar.
 *
 * A two-image group and a loose image that sits leftmost and topmost, so it is
 * the anchor and the group is what moves. Locked, the group must refuse both
 * buttons with "Group is locked" and nothing may move, the way Align left and
 * dragging already refuse. Unlocked, with one of its children selected as
 * well, the group must move once and carry its children: the selected child
 * used to be laid out a second time on its own, pulled out of its group.
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
const electron = process.env.REFBOARD_SMOKE_EXECUTABLE || path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const profile = await mkdtemp(path.join(os.tmpdir(), 'refboard-arrange-lock-'));
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

const smokeExpression = `(async()=>{
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  for(let i=0;i<200&&!window.RefBoard;i++)await wait(50);
  if(!window.RefBoard)throw new Error('RefBoard API unavailable');
  for(let i=0;i<300&&!window.RefBoard.startupComplete;i++)await wait(50);
  if(!window.RefBoard.startupComplete)throw new Error('RefBoard startup did not complete');
  document.querySelectorAll('.modal.show').forEach(el=>el.classList.remove('show'));
  document.querySelector('#rwNewBoard').click();
  for(let i=0;i<100&&!document.body.classList.contains('board-active');i++)await wait(50);
  if(!document.body.classList.contains('board-active'))throw new Error('New board did not open');
  await wait(300);
  document.querySelectorAll('.modal.show').forEach(el=>el.classList.remove('show'));

  const runtimeErrors=[];
  window.addEventListener('error',e=>runtimeErrors.push(e.message));
  const RB=window.RefBoard;
  const png=async fill=>{
    const c=document.createElement('canvas');c.width=120;c.height=90;
    const g=c.getContext('2d');g.fillStyle=fill;g.fillRect(0,0,120,90);
    return await new Promise(r=>c.toBlob(r,'image/png'));
  };
  const added=await RB.addImages(await Promise.all(
    ['#c8543c','#3c7ac8','#4cc86a'].map(async(fill,i)=>
      new File([await png(fill)],'shot'+i+'.png',{type:'image/png'}))));
  await wait(500);
  if(added.length!==3)throw new Error('expected three images, got '+added.length);

  // The loose image is leftmost and topmost, so it anchors both layouts and
  // the group is what moves.
  const [a,b,loose]=added;
  const place=(it,x,y,w,h)=>{ it.x=x; it.y=y; it.w=w; it.h=h; it.rot=0; };
  place(a,     400, 300, 200, 150);
  place(b,     620, 340, 160, 120);
  place(loose,   0,   0, 120,  90);
  RB.invalidateLayout();

  // The group is made the way a user makes it.
  RB.state.sel=new Set([a.id,b.id]); RB.updateSelBarForTest();
  document.querySelector('#board').dispatchEvent(new KeyboardEvent('keydown',{key:'g',ctrlKey:true,bubbles:true}));
  await wait(150);
  const g=RB.state.items.find(it=>it.kind==='group'&&RB.state.sel.has(it.id));
  if(!g)throw new Error('the group did not form');
  RB.syncGroupFramesForTest();

  // Undo rebuilds items from its snapshot, so hold ids, never item objects.
  const live=id=>RB.state.items.find(it=>it.id===id);
  const positions=()=>Object.fromEntries(RB.state.items.map(it=>[it.id,{x:it.x,y:it.y}]));
  const same=(p,q)=>Object.keys(p).length===Object.keys(q).length
    &&Object.keys(q).every(id=>p[id]&&Math.abs(p[id].x-q[id].x)<1e-6&&Math.abs(p[id].y-q[id].y)<1e-6);
  // No remembered anchor: the leftmost or topmost item anchors, as it does
  // for a marquee selection.
  const select=ids=>{ RB.state.sel=new Set(ids); RB.state.anchorId=null; RB.updateSelBarForTest(); };
  const press=el=>{
    el.dispatchEvent(new PointerEvent('pointerdown',{button:0,bubbles:true}));
    el.dispatchEvent(new MouseEvent('click',{button:0,bubbles:true}));
  };
  const toastText=()=>document.querySelector('#toast').textContent;
  const clearToast=()=>{ document.querySelector('#toast').textContent=''; };
  const buttons={};
  const viaButton=async id=>{
    const btn=document.querySelector('#'+id);
    buttons[id]=!!btn&&getComputedStyle(btn).display!=='none';
    if(btn)press(btn);
    await wait(150);
  };

  // A group's box on the board is its frame, which the selection frame shows
  // once a child inside it is selected too (one item alone draws no frame).
  const groupFrame=()=>{
    const keep=RB.state.sel;
    RB.state.sel=new Set([g.id,a.id]);
    const r=RB.selectionBBoxRectForTest();
    RB.state.sel=keep;
    return r&&{x:r.x,y:r.y,w:r.w,h:r.h};
  };
  const before=positions();
  const looseBox={x:loose.x,y:loose.y,w:loose.w,h:loose.h};
  const groupBox=groupFrame();

  // Locked: both buttons refuse and nothing moves.
  live(g.id).locked=true;
  const locked={};
  for(const id of ['sAlignH','sAlignV']){
    select([g.id,loose.id]);
    clearToast();
    await viaButton(id);
    const after=positions();
    locked[id]={toast:toastText(),unchanged:same(after,before),after};
    // Put back whatever an older build moved, so the next step starts clean.
    if(!locked[id].unchanged){ await RB.undoForTest(); await wait(200); }
  }
  live(g.id).locked=false;

  // Unlocked, with a child selected alongside its group: the group moves once
  // and the child stays where the group carries it.
  const carried={};
  for(const id of ['sAlignH','sAlignV']){
    select([g.id,a.id,loose.id]);
    clearToast();
    await viaButton(id);
    const after=positions();
    carried[id]={after,groupBox:groupFrame()};
    if(!same(after,before)){ await RB.undoForTest(); await wait(200); }
    carried[id].undone=same(positions(),before);
  }

  return {runtimeErrors,buttons,before,looseBox,groupBox,locked,carried,ids:{g:g.id,a:a.id,b:b.id,loose:loose.id}};
})()`;

try {
  const r = await evaluate(await debuggerPort(), smokeExpression);
  const near = (actual, expected, message) =>
    assert.ok(Math.abs(actual - expected) < 0.01, `${message}: expected ${expected}, got ${actual}`);
  const { ids, before, looseBox } = r;
  const labels = [['sAlignH', 'Align in a row'], ['sAlignV', 'Align in a column']];

  assert.deepEqual(r.runtimeErrors, [], 'aligning must not throw renderer errors');
  assert.deepEqual(r.buttons, { sAlignH: true, sAlignV: true }, 'the selection bar offers Align in a row and Align in a column');

  for (const [id, label] of labels) {
    const { toast, unchanged, after } = r.locked[id];
    const moved = Object.keys(before).filter(k => after[k].x !== before[k].x || after[k].y !== before[k].y);
    assert.equal(unchanged, true, `${label} must not move a locked group; moved ${moved.length} items`);
    assert.equal(toast, 'Group is locked', `${label} must say why it refused`);
  }

  for (const [id, label] of labels) {
    const { after, groupBox, undone } = r.carried[id];
    const delta = k => ({ x: after[k].x - before[k].x, y: after[k].y - before[k].y });
    const group = delta(ids.g);
    for (const kid of [ids.a, ids.b]) {
      const d = delta(kid);
      near(d.x, group.x, `${label}: a selected child must move with its group, not on its own (x)`);
      near(d.y, group.y, `${label}: a selected child must move with its group, not on its own (y)`);
    }
    // The group lands next to the anchor, 5px away, as before.
    if (id === 'sAlignH') {
      near(groupBox.x, looseBox.x + looseBox.w + 5, `${label}: the group lands 5px right of the anchor`);
      near(groupBox.y, looseBox.y, `${label}: the group lines up with the anchor's top`);
    } else {
      near(groupBox.x, looseBox.x, `${label}: the group lines up with the anchor's left`);
      near(groupBox.y, looseBox.y + looseBox.h + 5, `${label}: the group lands 5px below the anchor`);
    }
    near(groupBox.w, r.groupBox.w, `${label}: the group keeps its size`);
    near(after[ids.loose].x, before[ids.loose].x, `${label}: the anchor stays put`);
    near(after[ids.loose].y, before[ids.loose].y, `${label}: the anchor stays put`);
    assert.equal(undone, true, `one undo must put ${label} back`);
  }

  console.log(
    'arrange lock Electron smoke passed — a locked group refuses Align in a row and in a column, '
    + 'and a group selected with its child moves once, carrying both children',
  );
} catch (err) {
  if (stderr.trim()) console.error(`--- electron stderr ---\n${stderr.trim()}`);
  console.error('child exitCode=' + child.exitCode);
  throw err;
} finally {
  if (child.exitCode === null) child.kill();
  await Promise.race([once(child, 'exit'), delay(3000)]).catch(() => {});
  await removeProfileDir(profile);
}
