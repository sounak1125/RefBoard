/**
 * Align left / center / right, driven through the real selection bar and the
 * right-click Alignment menu.
 *
 * Two rows like a storyboard: a scene group and a loose image in each, the
 * second row starting further left than the first. Aligning must line the rows
 * up at their start, middle or end while each row keeps its own spacing,
 * groups carry their children, nothing moves up or down, and one undo puts it
 * all back. test-export-order.mjs pins the row arithmetic; this pins that the
 * buttons, the menu and the board agree with it.
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
const profile = await mkdtemp(path.join(os.tmpdir(), 'refboard-align-rows-'));
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
    ['#c8543c','#3c7ac8','#4cc86a','#c8b43c','#8c3cc8','#3cc8c0'].map(async(fill,i)=>
      new File([await png(fill)],'shot'+i+'.png',{type:'image/png'}))));
  await wait(500);
  if(added.length!==6)throw new Error('expected six images, got '+added.length);

  // Two ragged rows, sizes fixed so the arithmetic is known.
  const [a,b,c,d,e,f]=added;
  const place=(it,x,y,w,h)=>{ it.x=x; it.y=y; it.w=w; it.h=h; it.rot=0; };
  place(a,  60,   0, 200, 150);
  place(b, 280,   0, 160, 150);
  place(c, 470,   0, 180, 150);
  place(d,   0, 300, 220, 160);
  place(e, 240, 300, 150, 160);
  place(f, 420, 300, 260, 160);
  RB.invalidateLayout();

  // Scenes are groups, made the way a user makes them.
  const group=async ids=>{
    RB.state.sel=new Set(ids); RB.updateSelBarForTest();
    document.querySelector('#board').dispatchEvent(new KeyboardEvent('keydown',{key:'g',ctrlKey:true,bubbles:true}));
    await wait(150);
    return RB.state.items.find(it=>it.kind==='group'&&RB.state.sel.has(it.id));
  };
  const g1=await group([a.id,b.id]);
  const g2=await group([d.id,e.id]);
  if(!g1||!g2)throw new Error('the scene groups did not form');
  RB.syncGroupFramesForTest();

  const roots=[g1.id,c.id,g2.id,f.id];
  const rows=[[g1.id,c.id],[g2.id,f.id]];
  const selectAll=()=>{ RB.state.sel=new Set(roots); RB.updateSelBarForTest(); };
  const positions=()=>Object.fromEntries(RB.state.items.map(it=>[it.id,{x:it.x,y:it.y}]));
  const same=(p,q)=>Object.keys(p).length===Object.keys(q).length
    &&Object.keys(q).every(id=>p[id]&&Math.abs(p[id].x-q[id].x)<1e-6&&Math.abs(p[id].y-q[id].y)<1e-6);
  // Undo rebuilds items from its snapshot, so hold ids, never item objects.
  const live=id=>RB.state.items.find(it=>it.id===id);
  // A row's edges are the selection frame around just that row.
  const rowEdges=()=>{
    const out=rows.map(ids=>{
      RB.state.sel=new Set(ids);
      const r=RB.selectionBBoxRectForTest();
      return r ? {left:r.x,right:r.x+r.w,center:r.x+r.w/2} : {left:NaN,right:NaN,center:NaN};
    });
    selectAll();
    return out;
  };
  const press=el=>{
    el.dispatchEvent(new PointerEvent('pointerdown',{button:0,bubbles:true}));
    el.dispatchEvent(new MouseEvent('click',{button:0,bubbles:true}));
  };
  const toastText=()=>document.querySelector('#toast').textContent;
  const clearToast=()=>{ document.querySelector('#toast').textContent=''; };

  const buttons={};
  const viaButton=async align=>{
    const btn=document.querySelector('#sAlign'+align[0].toUpperCase()+align.slice(1));
    buttons[align]=!!btn&&getComputedStyle(btn).display!=='none';
    if(btn)press(btn);
    await wait(150);
  };

  // Empty canvas to right-click on: a hit on an unselected item would
  // replace the selection before the menu opens.
  const board=document.getElementById('board');
  RB.state.view.s=0.5; RB.state.view.tx=60; RB.state.view.ty=120;
  RB.invalidate();
  await wait(200);
  const rect=board.getBoundingClientRect();
  const menuPoint={x:rect.left+rect.width*0.85,y:rect.top+rect.height*0.8};
  const menuPointEmpty=!RB.itemAt(menuPoint.x-rect.left,menuPoint.y-rect.top);
  const menuEntries={};
  const viaMenu=async align=>{
    board.dispatchEvent(new MouseEvent('contextmenu',{clientX:menuPoint.x,clientY:menuPoint.y,bubbles:true,cancelable:true}));
    await wait(220);
    const row=[...document.querySelectorAll('#ctxmenu .mi')].find(r=>r.textContent.startsWith('Alignment'));
    if(row){ press(row); await wait(250); }
    const label='Align '+align;
    const entry=[...document.querySelectorAll('#ctxSub .mi')].find(r=>r.textContent.trim()===label);
    menuEntries[align]=!!entry;
    if(entry)press(entry);
    await wait(150);
  };

  selectAll();
  const before=positions();
  const beforeEdges=rowEdges();
  const results={};
  for(const [align,how] of [['left',viaButton],['right',viaButton],['center',viaMenu]]){
    selectAll();
    await how(align);
    const after=positions();
    results[align]={edges:rowEdges(),positions:after,moved:!same(after,before)};
    // Undo only what this step did: with nothing to take back it would undo
    // the grouping instead.
    if(results[align].moved){ await RB.undoForTest(); await wait(200); }
    results[align].undone=same(positions(),before);
  }

  // One row on its own has nothing to line up with.
  RB.state.sel=new Set(rows[0]); RB.updateSelBarForTest();
  clearToast();
  await viaButton('left');
  const singleRow={toast:toastText(),unchanged:same(positions(),before)};

  // A locked scene refuses, the way dragging it does.
  live(g2.id).locked=true;
  selectAll();
  clearToast();
  await viaButton('left');
  const locked={toast:toastText(),unchanged:same(positions(),before)};
  live(g2.id).locked=false;

  return {runtimeErrors,buttons,menuEntries,menuPointEmpty,before,beforeEdges,results,singleRow,locked,
    ids:{g1:g1.id,g2:g2.id,a:a.id,b:b.id,c:c.id,d:d.id,e:e.id,f:f.id}};
})()`;

try {
  const r = await evaluate(await debuggerPort(), smokeExpression);
  const near = (actual, expected, message) =>
    assert.ok(Math.abs(actual - expected) < 0.01, `${message}: expected ${expected}, got ${actual}`);

  assert.deepEqual(r.runtimeErrors, [], 'aligning must not throw renderer errors');
  assert.equal(r.menuPointEmpty, true, 'the smoke must right-click empty canvas so the selection survives');

  /* Where the rows end up first: that is what a user sees, and what an older
     build gets wrong before anything else. */
  const [row1, row2] = r.beforeEdges;
  const target = {
    left: Math.min(row1.left, row2.left),
    right: Math.max(row1.right, row2.right),
    center: (Math.min(row1.left, row2.left) + Math.max(row1.right, row2.right)) / 2,
  };
  const ragged = `\nrows before: ${JSON.stringify(r.beforeEdges)}`;
  for (const align of ['left', 'right', 'center']) {
    const edges = r.results[align].edges;
    for (const [i, row] of edges.entries()) {
      near(row[align], target[align], `Align ${align}: row ${i + 1} should ${align === 'center' ? 'centre on' : `meet the ${align} edge at`} ${target[align]}${ragged}\nrows after: ${JSON.stringify(edges)}`);
    }
  }

  for (const align of ['left', 'right', 'center']) {
    const { positions } = r.results[align];
    const moved = id => positions[id].x - r.before[id].x;
    // Each row moved as one block: every item in it by the same amount.
    near(moved(r.ids.a), moved(r.ids.c), `Align ${align}: row 1 must keep its spacing`);
    near(moved(r.ids.b), moved(r.ids.c), `Align ${align}: a group's children move with the row`);
    near(moved(r.ids.d), moved(r.ids.f), `Align ${align}: row 2 must keep its spacing`);
    near(moved(r.ids.e), moved(r.ids.f), `Align ${align}: a group's children move with the row`);
    for (const id of Object.keys(positions)) {
      near(positions[id].y, r.before[id].y, `Align ${align} must not move anything up or down`);
    }
    assert.equal(r.results[align].undone, true, `one undo must put Align ${align} back`);
  }

  assert.deepEqual(r.buttons, { left: true, right: true }, 'the selection bar offers Align left and Align right');
  assert.equal(r.menuEntries.center, true, 'the Alignment menu offers Align center');
  assert.equal(r.singleRow.toast, 'Select two or more rows to align');
  assert.equal(r.singleRow.unchanged, true, 'a single row has nothing to line up with');
  assert.equal(r.locked.toast, 'Group is locked');
  assert.equal(r.locked.unchanged, true, 'nothing moves while a locked scene is selected');

  console.log(
    `align rows Electron smoke passed — two ragged rows `
    + `(starts ${row1.left} and ${row2.left}) lined up left, right and center, `
    + `spacing kept, groups carried, one undo each`,
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
