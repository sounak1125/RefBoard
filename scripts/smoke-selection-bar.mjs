/**
 * The multi-select part of the selection bar, driven with real mouse clicks.
 *
 * With several images selected the bar reads as three labelled jobs, each
 * behind a separator: Arrange (row, column, grid), Line up rows (left, center,
 * right) and Match size, one button with a small menu. This pins that:
 *   (a) Arrange in a grid packs only the selection into a compact block where
 *       the selection was, leaves everything else alone, and undoes in one go;
 *   (b) Match size -> Same height brings every selected image to the shortest
 *       height, and the menu closes on Esc, on an outside click and after a pick;
 *   (c) the Line up buttons are dimmed for one row and on for two;
 *   (d) the groups and separators sit in that order, the bar is no wider than
 *       before, and a single image still gets its old bar.
 * It also times updateSelBar for small, large and very large selections.
 *
 * Set REFBOARD_SMOKE_SHOT_DIR to save two crops of the bar: one with five
 * images selected (selbar-after.png) and one with the Match size menu open
 * (selbar-after-menu.png).
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeProfileDir } from './smoke-profile-cleanup.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = process.env.REFBOARD_SMOKE_EXECUTABLE || path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const profile = await mkdtemp(path.join(os.tmpdir(), 'refboard-selection-bar-'));
const shotDir = process.env.REFBOARD_SMOKE_SHOT_DIR || '';
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

async function attach(port) {
  let target = null;
  for (let attempt = 0; attempt < 100 && !target; attempt++) {
    try {
      const list = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json());
      target = list.find(t => t.type === 'page' && /index\.html/i.test(t.url || '') && !/pane=secondary/i.test(t.url || ''));
    } catch { /* retry */ }
    if (!target) await delay(100);
  }
  if (!target) throw new Error('no RefBoard page target');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let nextId = 0;
  const pending = new Map();
  socket.onmessage = event => {
    const msg = JSON.parse(event.data);
    if (!msg.id || !pending.has(msg.id)) return;
    const h = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) h.reject(new Error(msg.error.message)); else h.resolve(msg.result);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const run = async expression => {
    const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
    return res.result.value;
  };
  return { send, run, close: () => socket.close() };
}

try {
  const port = await debuggerPort();
  const cdp = await attach(port);
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});

  // Five images to select, of known and different sizes, scattered so two
  // pairs overlap; two more far off that must never move.
  const ids = await cdp.run(`(async()=>{
    const wait=ms=>new Promise(r=>setTimeout(r,ms));
    for(let i=0;i<300&&!(window.RefBoard&&window.RefBoard.startupComplete);i++)await wait(50);
    if(!window.RefBoard?.startupComplete)throw new Error('startup did not complete');
    document.querySelectorAll('.modal.show').forEach(el=>el.classList.remove('show'));
    document.querySelector('#rwNewBoard').click();
    for(let i=0;i<100&&!document.body.classList.contains('board-active');i++)await wait(50);
    if(!document.body.classList.contains('board-active'))throw new Error('New board did not open');
    await wait(300);
    document.querySelectorAll('.modal.show').forEach(el=>el.classList.remove('show'));
    window.__selbarErrors=[];
    window.addEventListener('error',e=>window.__selbarErrors.push(e.message));
    const RB=window.RefBoard;
    const sizes=[[200,150],[160,220],[240,120],[180,180],[120,200],[100,100],[100,100]];
    const colors=['#c8543c','#3c7ac8','#4cc86a','#c8b43c','#8c3cc8','#777','#999'];
    const files=await Promise.all(sizes.map(async([w,h],i)=>{
      const c=document.createElement('canvas');c.width=w;c.height=h;
      const g=c.getContext('2d');g.fillStyle=colors[i];g.fillRect(0,0,w,h);
      return new File([await new Promise(r=>c.toBlob(r,'image/png'))],'img'+i+'.png',{type:'image/png'});
    }));
    const added=await RB.addImages(files);
    await wait(500);
    if(added.length!==7)throw new Error('expected seven images, got '+added.length);
    const spots=[[0,0],[150,80],[600,500],[560,450],[100,900],[1400,0],[1400,600]];
    added.forEach((it,i)=>{ it.x=spots[i][0]; it.y=spots[i][1]; it.w=sizes[i][0]; it.h=sizes[i][1]; it.rot=0; });
    const board=document.getElementById('board');
    RB.state.view.s=0.4; RB.state.view.tx=80; RB.state.view.ty=150;
    RB.state.sel=new Set(added.slice(0,5).map(it=>it.id));
    RB.updateSelBarForTest();
    RB.invalidateLayout(); RB.invalidate();
    await wait(300);
    return added.map(it=>it.id);
  })()`);
  const picked = ids.slice(0, 5);
  const others = ids.slice(5);

  const mouse = (type, x, y) => cdp.send('Input.dispatchMouseEvent', {
    type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1,
  });
  // A real click at the centre of whatever the selector finds; false when it
  // is missing or hidden, so an older build reports instead of throwing.
  async function click(selector) {
    const at = await cdp.run(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});
      if(!el||getComputedStyle(el).display==='none')return null;
      const r=el.getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2];})()`);
    if (!at) return false;
    await mouse('mouseMoved', at[0], at[1]);
    await mouse('mousePressed', at[0], at[1]);
    await mouse('mouseReleased', at[0], at[1]);
    await delay(200);
    return true;
  }
  // Rest the pointer on empty board, away from the toolbar's reveal edge, so no
  // tooltip shows in a screenshot.
  const parkMouse = async () => {
    const [x, y] = await cdp.run(`[innerWidth-60, innerHeight-80]`);
    await mouse('mouseMoved', x, y);
    await delay(450);
  };
  const select = list => cdp.run(`(()=>{const RB=window.RefBoard;RB.state.sel=new Set(${JSON.stringify(list)});RB.updateSelBarForTest();RB.invalidate();return true;})()`);
  const rects = () => cdp.run(`Object.fromEntries(window.RefBoard.state.items.map(it=>[it.id,{x:it.x,y:it.y,w:it.w,h:it.h}]))`);
  const toast = () => cdp.run(`document.querySelector('#toast').textContent`);
  const clearToast = () => cdp.run(`(()=>{document.querySelector('#toast').textContent='';return true;})()`);
  async function shoot(name, selectors) {
    if (!shotDir) return;
    const box = await cdp.run(`(()=>{const rs=${JSON.stringify(selectors)}.map(s=>document.querySelector(s))
      .filter(el=>el&&getComputedStyle(el).display!=='none').map(el=>el.getBoundingClientRect());
      const x=Math.min(...rs.map(r=>r.left))-16,y=Math.min(...rs.map(r=>r.top))-16;
      return {x,y,width:Math.max(...rs.map(r=>r.right))+16-x,height:Math.max(...rs.map(r=>r.bottom))+16-y};})()`);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { ...box, scale: 2 } });
    await writeFile(path.join(shotDir, name), Buffer.from(shot.data, 'base64'));
  }

  /* (d) The bar: visible controls in order, and its width. */
  const barState = () => cdp.run(`(()=>{const bar=document.querySelector('#selbar');
    const seq=[...bar.children].filter(el=>getComputedStyle(el).display!=='none')
      .map(el=>el.classList.contains('sep')?'sep':el.id);
    return {seq,width:Math.round(bar.getBoundingClientRect().width)};})()`);
  await select(picked);
  await parkMouse();
  const multiBar = await barState();
  await shoot('selbar-after.png', ['#selbar']);
  await select([picked[0]]);
  const singleBar = await barState();

  /* (c) Line up rows: one row dims the buttons, two rows turn them on. */
  const lineUp = () => cdp.run(`['sAlignLeft','sAlignCenter','sAlignRight'].map(id=>{
    const el=document.querySelector('#'+id);return {disabled:el?.getAttribute('aria-disabled')??null,tip:el?.dataset.tip??null};})`);
  await select([picked[0], picked[1]]);
  const oneRow = await lineUp();
  await clearToast();
  const oneRowClicked = await click('#sAlignLeft');
  const oneRowToast = await toast();
  await select([picked[0], picked[4]]);
  const twoRows = await lineUp();

  /* (a) Arrange in a grid. */
  await select(picked);
  const beforeGrid = await rects();
  const gridClicked = await click('#sArrangeGrid');
  const afterGrid = await rects();
  await cdp.run(`(async()=>{await window.RefBoard.undoForTest();return true;})()`);
  await delay(250);
  const afterGridUndo = await rects();

  /* (b) Match size: the menu opens and closes the expected ways, then Same
     height matches every selected image to the shortest. */
  await select(picked);
  const popOpen = () => cdp.run(`!!document.querySelector('#matchSizePop')?.classList.contains('open')`);
  const menu = {};
  menu.buttonClicked = await click('#sMatchSize');
  menu.opened = await popOpen();
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await delay(150);
  menu.afterEsc = await popOpen();
  menu.selectionAfterEsc = await cdp.run(`window.RefBoard.state.sel.size`);
  await click('#sMatchSize');
  menu.reopened = await popOpen();
  await click('#selcount');
  menu.afterOutside = await popOpen();
  await click('#sMatchSize');
  await parkMouse();
  menu.entries = await cdp.run(`[...document.querySelectorAll('#matchSizePop .mi')].map(el=>[...el.querySelectorAll('span')].map(span=>span.textContent).join(' — '))`);
  await shoot('selbar-after-menu.png', ['#selbar', '#matchSizePop']);
  await clearToast();
  menu.entryClicked = await click('#matchSizePop [data-match="height"]');
  menu.afterPick = await popOpen();
  menu.toast = await toast();
  const afterMatch = await rects();

  /* Timing: updateSelBar for 5, 300 and 2000 selected items. The big ones are
     copies of one image, laid out as a grid of rows. */
  const timing = await cdp.run(`(async()=>{
    const RB=window.RefBoard;
    const base=RB.state.items.find(it=>it.id===${JSON.stringify(picked[0])});
    const clones=[];
    for(let i=0;i<2000;i++){
      clones.push({...base,id:'bench'+i,x:5000+(i%50)*60,y:(Math.floor(i/50))*60,w:50,h:50,tags:[]});
    }
    RB.state.items.push(...clones);
    RB.invalidateLayout();
    const time=list=>{
      RB.state.sel=new Set(list);
      RB.updateSelBarForTest();
      const runs=[];
      for(let i=0;i<15;i++){const t=performance.now();RB.updateSelBarForTest();runs.push(performance.now()-t);}
      runs.sort((a,b)=>a-b);
      return Math.round(runs[7]*1000)/1000;
    };
    const out={
      five:time(${JSON.stringify(picked)}),
      three00:time(clones.slice(0,300).map(c=>c.id)),
      two000:time(clones.map(c=>c.id)),
    };
    RB.state.items=RB.state.items.filter(it=>!String(it.id).startsWith('bench'));
    RB.state.sel=new Set(); RB.updateSelBarForTest(); RB.invalidateLayout();
    return out;
  })()`);
  const errors = await cdp.run(`window.__selbarErrors`);

  /* ---- assertions ---- */
  assert.deepEqual(errors, [], 'the selection bar must not throw renderer errors');

  assert.deepEqual(multiBar.seq, [
    'selcount', 'sCopy', 'sDup', 'sOrig', 'sDragOut', 'sTags',
    'sep', 'sAlignH', 'sAlignV', 'sArrangeGrid',
    'sep', 'sAlignLeft', 'sAlignCenter', 'sAlignRight',
    'sep', 'sMatchSize',
    'sep', 'sDel',
  ], 'five images: Arrange, Line up rows and Match size, each behind a separator');
  assert.ok(multiBar.width <= 600, `the bar must be no wider than before (about 595 px), got ${multiBar.width}`);
  assert.deepEqual(singleBar.seq, ['selcount', 'sCopy', 'sDup', 'sOrig', 'sDragOut', 'sTags', 'sFill', 'sep', 'sDel'],
    'a single image keeps its old bar');

  assert.deepEqual(oneRow.map(b => b.disabled), ['true', 'true', 'true'], 'one row dims the Line up buttons');
  assert.ok(oneRow.every(b => b.tip === 'Line up rows: select two or more rows'), `a dimmed button says why, got ${JSON.stringify(oneRow)}`);
  assert.equal(oneRowClicked, true, 'the dimmed button stays on the bar');
  assert.equal(oneRowToast, '', 'a click on a dimmed Line up button does nothing');
  assert.deepEqual(twoRows.map(b => b.disabled), ['false', 'false', 'false'], 'two rows turn the Line up buttons on');
  assert.deepEqual(twoRows.map(b => b.tip), ['Line up rows: left', 'Line up rows: center', 'Line up rows: right']);

  assert.equal(gridClicked, true, 'the bar offers Arrange in a grid');
  for (const id of others) assert.deepEqual(afterGrid[id], beforeGrid[id], 'unselected items stay where they were');
  const boxes = picked.map(id => afterGrid[id]);
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const [a, b] = [boxes[i], boxes[j]];
      assert.ok(!(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h), `selected items ${i} and ${j} must not overlap after Arrange in a grid`);
    }
  }
  const bbox = list => {
    const x = Math.min(...list.map(r => r.x)), y = Math.min(...list.map(r => r.y));
    return { x, y, w: Math.max(...list.map(r => r.x + r.w)) - x, h: Math.max(...list.map(r => r.y + r.h)) - y };
  };
  const startBox = bbox(picked.map(id => beforeGrid[id]));
  const block = bbox(boxes);
  const itemArea = boxes.reduce((sum, r) => sum + r.w * r.h, 0);
  assert.ok(Math.abs(block.x - startBox.x) < 1e-6 && Math.abs(block.y - startBox.y) < 1e-6,
    `the block keeps the selection's top-left corner: ${JSON.stringify(startBox)} -> ${JSON.stringify(block)}`);
  assert.ok(block.w * block.h <= itemArea * 2.5, `the block is compact: ${Math.round(block.w)}×${Math.round(block.h)} for ${itemArea} px² of images`);
  assert.deepEqual(afterGridUndo, beforeGrid, 'one undo puts Arrange in a grid back');

  assert.equal(menu.buttonClicked, true, 'the bar offers Match size');
  assert.equal(menu.opened, true, 'Match size opens its menu');
  assert.equal(menu.afterEsc, false, 'Esc closes the Match size menu');
  assert.equal(menu.selectionAfterEsc, 5, 'Esc closes the menu without clearing the selection');
  assert.equal(menu.reopened, true);
  assert.equal(menu.afterOutside, false, 'an outside click closes the Match size menu');
  assert.deepEqual(menu.entries, ['Same height — shrinks to the shortest', 'Same width — shrinks to the narrowest', 'Same size — longest sides match']);
  assert.equal(menu.entryClicked, true);
  assert.equal(menu.afterPick, false, 'picking an entry closes the menu');
  assert.equal(menu.toast, 'Same height · 5 images');
  const shortest = Math.min(...picked.map(id => beforeGrid[id].h));
  for (const id of picked) {
    assert.ok(Math.abs(afterMatch[id].h - shortest) < 1e-6, `Same height: every selected image is ${shortest} tall, got ${afterMatch[id].h}`);
  }
  for (const id of others) assert.deepEqual(afterMatch[id], beforeGrid[id], 'Same height leaves unselected images alone');

  console.log(
    `selection bar Electron smoke passed — ${multiBar.width} px bar in three groups; `
    + `grid packed 5 images into ${Math.round(block.w)}×${Math.round(block.h)} at the same corner, one undo; `
    + `Same height -> ${shortest}; Line up dimmed for one row, on for two; `
    + `updateSelBar median ${timing.five} ms (5), ${timing.three00} ms (300), ${timing.two000} ms (2000, check skipped)`,
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
