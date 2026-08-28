/**
 * Tagging from the right-click menu.
 *
 * Kept apart from smoke-tags.mjs deliberately. That one is a long session —
 * filtering, undo, a save and a reopen — and the context menu is sensitive to
 * exactly what the selection and the board are at the moment it opens. Sharing
 * a board with all of that made the failures about the harness rather than the
 * feature. This starts clean and does one thing.
 *
 * Covers all three capabilities the submenu is meant to carry: adding a tag,
 * toggling one the selection partly has, and setting that tag's glow colour.
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
const profile = await mkdtemp(path.join(os.tmpdir(), 'refboard-tagmenu-'));
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
  for(let i=0;i<200&&!window.RefBoard;i++)await wait(50);
  if(!window.RefBoard)throw new Error('RefBoard API unavailable');
  for(let i=0;i<300&&!window.RefBoard.startupComplete;i++)await wait(50);
  if(!window.RefBoard.startupComplete)throw new Error('RefBoard startup did not complete');
  document.querySelectorAll('.modal.show').forEach(el=>el.classList.remove('show'));
  document.querySelector('#rwNewBoard').click();
  for(let i=0;i<100&&!document.body.classList.contains('board-active');i++)await wait(50);
  if(!document.body.classList.contains('board-active'))throw new Error('New board did not open');
  await wait(400);
  document.querySelectorAll('.modal.show').forEach(el=>el.classList.remove('show'));

  const RB=window.RefBoard;
  const mk=async fill=>{
    const c=document.createElement('canvas');c.width=200;c.height=150;
    const g=c.getContext('2d');g.fillStyle=fill;g.fillRect(0,0,200,150);
    return await new Promise(r=>c.toBlob(r,'image/png'));
  };
  const added=await RB.addImages([
    new File([await mk('#c8543c')],'a.png',{type:'image/png'}),
    new File([await mk('#3c7ac8')],'b.png',{type:'image/png'}),
  ]);
  await wait(600);
  if(added.length!==2)throw new Error('expected two images');

  // One image carries the tag and the other does not, so every board tag is
  // partial across the selection — the state the submenu has to represent.
  added[0].tags=['mood'];
  RB.state.sel=new Set(added.map(i=>i.id));
  RB.updateSelBarForTest();
  await wait(150);

  const press=el=>{
    if(!el)throw new Error('press() got nothing to press');
    el.dispatchEvent(new PointerEvent('pointerdown',{button:0,bubbles:true}));
    el.dispatchEvent(new MouseEvent('click',{button:0,bubbles:true}));
  };
  /* Dispatched on the canvas, not the window: the handler calls
     e.target.closest(), which a window-targeted event does not have. */
  const openCtx=async()=>{
    document.getElementById('board').dispatchEvent(
      new MouseEvent('contextmenu',{clientX:500,clientY:400,bubbles:true,cancelable:true}));
    await wait(220);
    return document.querySelector('#ctxmenu').classList.contains('show');
  };
  const openTagsSub=async()=>{
    if(!await openCtx())throw new Error('the context menu did not open');
    const row=[...document.querySelectorAll('#ctxmenu .mi')].find(r=>r.textContent.startsWith('Tags'));
    if(!row)throw new Error('no Tags entry — sel='+RB.state.sel.size
      +' rows=['+[...document.querySelectorAll('#ctxmenu .mi')].map(r=>r.textContent.trim()).join(' | ')+']');
    press(row);
    await wait(250);
    return document.querySelector('#ctxSub').classList.contains('show');
  };

  const subShown=await openTagsSub();
  const rows=[...document.querySelectorAll('#ctxSub .mi')].map(r=>r.textContent.trim());
  const moodRow=[...document.querySelectorAll('#ctxSub .mi-tag')]
    .find(r=>r.textContent.toLowerCase().includes('mood'));
  if(!moodRow)throw new Error('the submenu does not list the board tags');
  const partialMark=moodRow.querySelector('.k').textContent.trim();

  press(moodRow);
  await wait(250);
  const afterToggle=added.map(it=>(it.tags||[]).some(t=>t.toLowerCase()==='mood'));

  // Toggling again, now that all of them carry it, must take it off all of them.
  await openTagsSub();
  press([...document.querySelectorAll('#ctxSub .mi-tag')]
    .find(r=>r.textContent.toLowerCase().includes('mood')));
  await wait(250);
  const afterSecondToggle=added.map(it=>(it.tags||[]).some(t=>t.toLowerCase()==='mood'));

  // Put it back, then set its colour from the well inside the submenu.
  added[0].tags=['mood']; added[1].tags=['mood'];
  RB.invalidate();
  await wait(120);
  await openTagsSub();
  const dot=document.querySelector('#ctxSub .mi-tag .tag-dot');
  press(dot);
  await wait(320);
  const colorPopOpen=document.querySelector('#tagColorPop').classList.contains('open');
  const swatch=document.querySelectorAll('#tagColorGrid .tag-color-sw')[3];
  if(swatch)press(swatch);
  await wait(280);
  const colors={...RB.state.tagColors};

  // 'Add tag…' opens the same panel the selection bar uses.
  await openTagsSub();
  press([...document.querySelectorAll('#ctxSub .mi')].find(r=>r.textContent.includes('Add tag')));
  await wait(300);
  const addOpensPop=document.querySelector('#tagPanel').classList.contains('open');

  return {subShown,rows,partialMark,afterToggle,afterSecondToggle,colorPopOpen,colors,addOpensPop};
})()`;

try {
  const r = await evaluate(await debuggerPort(), smokeExpression);

  assert.equal(r.subShown, true, 'right-click on a selection must offer a Tags submenu');
  assert.ok(r.rows.some(t => t.includes('Add tag')), `no "Add tag…" row: ${r.rows.join(' | ')}`);
  assert.ok(r.rows.some(t => t.toLowerCase().includes('mood')), 'the board tags must be listed');
  assert.ok(r.rows.some(t => t.includes('Tag panel')), 'the submenu must reach the tag panel');

  // Some-but-not-all has to look different from none, or one click looks inert.
  assert.equal(r.partialMark, '–', `a partly-applied tag must be marked, got "${r.partialMark}"`);

  assert.deepEqual(r.afterToggle, [true, true],
    'toggling a partly-applied tag must bring the whole selection up to it, not strip it');
  assert.deepEqual(r.afterSecondToggle, [false, false],
    'toggling again, once every item carries it, must remove it from all of them');

  assert.equal(r.colorPopOpen, true, 'the colour well in the submenu must open the palette');
  assert.equal(Object.keys(r.colors).length, 1, `picking a swatch must assign a colour, got ${JSON.stringify(r.colors)}`);
  assert.match(Object.values(r.colors)[0], /^#[0-9a-f]{6}$/, 'the colour must be stored as hex');

  assert.equal(r.addOpensPop, true, '"Add tag…" must open the same panel the selection bar uses');

  console.log('tag context menu Electron smoke passed — add, toggle from partial, and colour, all from right-click');
} finally {
  if (child.exitCode === null) child.kill();
  await Promise.race([once(child, 'exit'), delay(3000)]).catch(() => {});
  await removeProfileDir(profile);
}
