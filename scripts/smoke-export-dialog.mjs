/**
 * The Export dialog (Ctrl+E), end to end in the real app, driven with real
 * mouse and key events:
 *   1. Ctrl+E with two images selected opens Export on Images, counting 2;
 *   2. Ctrl+E with nothing selected opens Board;
 *   3. Ctrl+E with only a note selected opens Board, and Images then lists
 *      every image on the board;
 *   4. the selection bar's Export images button always opens Images;
 *   5. the toolbar's Export button follows the Ctrl+E rule;
 *   6. Ctrl+Shift+I does nothing;
 *   7. Esc closes the dialog;
 *   8. an empty board toasts "Board is empty" and opens nothing;
 *   9. the card keeps its width (and its left and top) on both tabs;
 *  10. an Images export writes the expected files into the folder the app
 *      remembers (refboard.exportDir);
 *  11. a Board export writes a PNG of the right pixel size at 1x and 2x
 *      (2x through Enter, which only the Board tab takes);
 * and also: a board with a note but no images says so on the Images tab and
 * disables its Export; the context menu's entries open the right tab.
 *
 * Set REFBOARD_SMOKE_SHOT_DIR to save a screenshot of each tab.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeProfileDir } from './smoke-profile-cleanup.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = process.env.REFBOARD_SMOKE_EXECUTABLE || path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const profile = await mkdtemp(path.join(os.tmpdir(), 'refboard-export-'));
const outDir = await mkdtemp(path.join(os.tmpdir(), 'refboard-export-out-'));
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

const KEYS = {
  e: { key: 'e', code: 'KeyE', vk: 69 },
  i: { key: 'i', code: 'KeyI', vk: 73 },
  I: { key: 'I', code: 'KeyI', vk: 73 },
  Escape: { key: 'Escape', code: 'Escape', vk: 27 },
  Enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
};

/** Width and height from a PNG's IHDR chunk. */
function pngSize(buf) {
  assert.ok(buf.length > 24 && buf.toString('latin1', 1, 4) === 'PNG', 'the file is a PNG');
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

try {
  const port = await debuggerPort();
  const cdp = await attach(port);
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
  if (shotDir) await mkdir(shotDir, { recursive: true });

  const mouse = (type, x, y) => cdp.send('Input.dispatchMouseEvent', {
    type, x, y, button: type === 'mouseMoved' ? 'none' : 'left',
    buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1,
  });
  async function click(selector) {
    const at = await cdp.run(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});
      if(!el||el.closest('[hidden]')||getComputedStyle(el).display==='none')return null;
      const r=el.getBoundingClientRect();if(!r.width||!r.height)return null;return [r.left+r.width/2,r.top+r.height/2];})()`);
    if (!at) return false;
    await mouse('mouseMoved', at[0], at[1]);
    await mouse('mousePressed', at[0], at[1]);
    await mouse('mouseReleased', at[0], at[1]);
    await delay(150);
    return true;
  }
  async function key(name, { ctrl = false, shift = false } = {}) {
    const k = KEYS[name];
    const modifiers = (ctrl ? 2 : 0) | (shift ? 8 : 0);
    const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, modifiers };
    await cdp.send('Input.dispatchKeyEvent', { type: k.text && !ctrl ? 'keyDown' : 'rawKeyDown', ...base, ...(k.text && !ctrl ? { text: k.text } : {}) });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    await delay(80);
  }
  const settle = () => cdp.run(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))`);
  async function waitFor(expression, label, tries = 100) {
    for (let i = 0; i < tries; i++) {
      if (await cdp.run(expression)) return;
      await delay(50);
    }
    throw new Error(`timed out waiting for ${label}`);
  }
  const select = ids => cdp.run(`(()=>{const RB=window.RefBoard;RB.state.sel=new Set(${JSON.stringify(ids)});RB.updateSelBarForTest();RB.invalidate();
    document.activeElement?.blur?.();return true;})()`);
  // Every open modal, so a stray old dialog would show up here too.
  const openModals = () => cdp.run(`[...document.querySelectorAll('.modal.show')].map(m=>m.id)`);
  const dialog = () => cdp.run(`(()=>{const m=document.querySelector('#exportModal');const card=m?.querySelector('.card');
    const r=card?card.getBoundingClientRect():null;
    const tabOn=[...document.querySelectorAll('#expTabs button.on')].map(b=>b.dataset.tab);
    const visiblePane=[...document.querySelectorAll('#exportModal .export-pane')].filter(p=>!p.hidden&&getComputedStyle(p).display!=='none').map(p=>p.dataset.pane);
    return {open:!!m?.classList.contains('show'),title:card?.querySelector('h3')?.textContent||'',tabOn,visiblePane,
      count:document.querySelector('#expImgCount')?.textContent||'',
      imgGoDisabled:!!document.querySelector('#expImgGo')?.disabled,
      fieldsHidden:!!document.querySelector('#expImgFields')?.hidden,
      rect:r&&{left:Math.round(r.left),top:Math.round(r.top),width:Math.round(r.width)}};})()`);
  async function openWithCtrlE() {
    await key('e', { ctrl: true });
    await waitFor(`document.querySelector('#exportModal')?.classList.contains('show')`, 'Ctrl+E to open Export');
    await settle();
    return dialog();
  }
  async function closeWithEsc() {
    await key('Escape');
    await waitFor(`!document.querySelector('.modal.show')`, 'Esc to close Export');
  }
  async function shoot(name) {
    if (!shotDir) return;
    await settle();
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(path.join(shotDir, name), Buffer.from(shot.data, 'base64'));
  }
  const toastText = () => cdp.run(`document.querySelector('#toast')?.textContent||''`);
  const clearToast = () => cdp.run(`(()=>{const t=document.querySelector('#toast');if(t)t.textContent='';return true;})()`);

  await cdp.run(`(async()=>{
    const wait=ms=>new Promise(r=>setTimeout(r,ms));
    for(let i=0;i<300&&!(window.RefBoard&&window.RefBoard.startupComplete);i++)await wait(50);
    if(!window.RefBoard?.startupComplete)throw new Error('startup did not complete');
    document.querySelectorAll('.modal.show').forEach(el=>el.classList.remove('show'));
    document.querySelector('#rwNewBoard').click();
    for(let i=0;i<100&&!document.body.classList.contains('board-active');i++)await wait(50);
    if(!document.body.classList.contains('board-active'))throw new Error('New board did not open');
    await wait(300);
    document.querySelectorAll('.modal.show').forEach(el=>el.classList.remove('show'));
    window.__expErrors=[];
    window.addEventListener('error',e=>window.__expErrors.push(e.message));
    return true;
  })()`);

  /* 8. An empty board: Ctrl+E toasts and opens nothing. */
  assert.equal(await cdp.run(`window.RefBoard.state.items.length`), 0, 'the new board starts empty');
  await clearToast();
  await key('e', { ctrl: true });
  await delay(250);
  assert.deepEqual(await openModals(), [], 'Ctrl+E on an empty board opens nothing');
  assert.equal(await toastText(), 'Board is empty', 'Ctrl+E on an empty board says so');

  /* A note and no images: Board opens; the Images tab says so and cannot export. */
  const noteId = await cdp.run(`(()=>{const RB=window.RefBoard;const note=RB.makeNoteForTest({x:900,y:520});
    RB.state.items.push(note);RB.invalidateLayout();RB.fitAll();RB.invalidate();return note.id;})()`);
  await select([]);
  let d = await openWithCtrlE();
  assert.deepEqual(d.tabOn, ['board'], 'no images: Ctrl+E opens Board');
  assert.equal(await click('#expTabImages'), true, 'the Images tab is clickable');
  d = await dialog();
  assert.deepEqual(d.visiblePane, ['images'], 'switching to Images shows the Images pane');
  assert.match(d.count, /no images/i, 'the Images tab says the board has no images');
  assert.equal(d.imgGoDisabled, true, 'its Export is disabled');
  assert.equal(d.fieldsHidden, true, 'its options are hidden');
  await shoot('export-no-images.png');
  assert.equal(await click('#expTabBoard'), true, 'switching back still works');
  assert.deepEqual((await dialog()).visiblePane, ['board']);
  await closeWithEsc();

  /* The board: red and blue (400x300), green (200x100), and the note. */
  const ids = await cdp.run(`(async()=>{
    const RB=window.RefBoard;
    const make=async(w,h,rgb,name)=>{const c=document.createElement('canvas');c.width=w;c.height=h;
      const g=c.getContext('2d');g.fillStyle='rgb('+rgb+')';g.fillRect(0,0,w,h);
      return new File([await new Promise(r=>c.toBlob(r,'image/png'))],name,{type:'image/png'});};
    const added=await RB.addImages([await make(400,300,'200,40,40','red.png'),await make(400,300,'40,80,220','blue.png'),await make(200,100,'40,200,90','green.png')]);
    await new Promise(r=>setTimeout(r,500));
    if(added.length!==3)throw new Error('expected three images, got '+added.length);
    const spots=[[0,0],[500,0],[0,400]];
    added.forEach((it,i)=>{it.x=spots[i][0];it.y=spots[i][1];it.rot=0;});
    RB.invalidateLayout();RB.fitAll();RB.invalidate();
    await new Promise(r=>setTimeout(r,300));
    return {red:added[0].id,blue:added[1].id,green:added[2].id};
  })()`);

  /* 1. Two images selected: Images, counting 2. */
  await select([ids.red, ids.blue]);
  d = await openWithCtrlE();
  assert.equal(d.title, 'Export', 'one dialog, titled Export');
  assert.deepEqual(d.tabOn, ['images'], 'two images selected: Ctrl+E opens Images');
  assert.deepEqual(d.visiblePane, ['images']);
  assert.equal(d.count, '2 images will be exported', 'the count says 2');
  assert.equal(d.imgGoDisabled, false);
  await shoot('export-images-tab.png');

  /* 9. The card does not move sideways (or up) between tabs. */
  const imagesRect = d.rect;
  assert.equal(await click('#expTabBoard'), true);
  d = await dialog();
  assert.deepEqual(d.visiblePane, ['board']);
  await shoot('export-board-tab.png');
  assert.equal(d.rect.width, imagesRect.width, 'the card keeps its width on both tabs');
  assert.equal(d.rect.left, imagesRect.left, 'the card keeps its left edge on both tabs');
  assert.equal(d.rect.top, imagesRect.top, 'the card keeps its top (and so its tab bar) on both tabs');
  assert.equal(await click('#expTabImages'), true);
  assert.deepEqual((await dialog()).rect, imagesRect, 'back on Images, the card is where it was');

  /* Enter on the Images tab does nothing (it never did), even off the fields. */
  await cdp.run(`(document.activeElement?.blur?.(),true)`);
  await key('Enter');
  assert.equal((await dialog()).open, true, 'Enter on the Images tab leaves the dialog open');
  assert.deepEqual(await readdir(outDir), [], 'Enter on the Images tab writes nothing');

  /* 7. Esc closes it. */
  await closeWithEsc();
  assert.deepEqual(await openModals(), [], 'Esc closes the dialog');

  /* 2. Nothing selected: Board. */
  await select([]);
  d = await openWithCtrlE();
  assert.deepEqual(d.tabOn, ['board'], 'nothing selected: Ctrl+E opens Board');
  assert.equal(await click('#expTabImages'), true);
  assert.equal((await dialog()).count, '3 images will be exported', 'nothing selected: Images lists every image');
  await closeWithEsc();

  /* 3. Only a note selected: Board; Images lists every image. */
  await select([noteId]);
  d = await openWithCtrlE();
  assert.deepEqual(d.tabOn, ['board'], 'a note selected: Ctrl+E opens Board');
  assert.equal(await click('#expTabImages'), true);
  d = await dialog();
  assert.equal(d.count, '3 images will be exported', 'a note selected: Images lists every image on the board');
  assert.equal(d.imgGoDisabled, false);
  await closeWithEsc();

  /* 4. The selection bar's button always opens Images. */
  for (const [label, sel, count] of [['a note', [noteId], 3], ['one image', [ids.green], 1], ['two images', [ids.red, ids.blue], 2]]) {
    await select(sel);
    assert.equal(await click('#sOrig'), true, `the selection bar offers Export images for ${label}`);
    await waitFor(`document.querySelector('#exportModal')?.classList.contains('show')`, `#sOrig for ${label}`);
    d = await dialog();
    assert.deepEqual(d.tabOn, ['images'], `#sOrig with ${label} opens Images`);
    assert.equal(d.count, `${count} image${count === 1 ? '' : 's'} will be exported`, `#sOrig with ${label} counts ${count}`);
    await closeWithEsc();
  }
  assert.equal(await cdp.run(`document.querySelector('#sOrig').dataset.tip`), 'Export images…  (Ctrl+E)');

  /* 5. The toolbar's Export button follows the Ctrl+E rule. */
  async function clickToolbarExport() {
    await mouse('mouseMoved', 2, 450);
    await waitFor(`document.body.classList.contains('toolbar-revealed')`, 'toolbar reveal');
    await delay(260);
    assert.equal(await click('#btnExport'), true, 'the toolbar shows Export');
    await waitFor(`document.querySelector('#exportModal')?.classList.contains('show')`, 'toolbar Export');
    return dialog();
  }
  for (const [label, sel, tab] of [['two images', [ids.red, ids.blue], 'images'], ['nothing', [], 'board'], ['a note', [noteId], 'board']]) {
    await select(sel);
    d = await clickToolbarExport();
    assert.deepEqual(d.tabOn, [tab], `toolbar Export with ${label} selected opens ${tab}`);
    await closeWithEsc();
  }

  /* The context menu: the selection entry opens Images, the board entry Board. */
  async function menuEntry(startsWith) {
    // Dispatched on the canvas: the handler calls e.target.closest().
    return cdp.run(`(async()=>{
      document.getElementById('board').dispatchEvent(new MouseEvent('contextmenu',{clientX:6,clientY:window.innerHeight-6,bubbles:true,cancelable:true}));
      await new Promise(r=>setTimeout(r,200));
      const rows=[...document.querySelectorAll('#ctxmenu .mi')];
      const row=rows.find(r=>r.textContent.startsWith(${JSON.stringify(startsWith)}));
      if(!row)return {missing:rows.map(r=>r.textContent.trim())};
      const key=row.querySelector('.k')?.textContent||'';
      row.click();
      return {key};
    })()`);
  }
  for (const [label, sel, entry, tab] of [
    ['two images', [ids.red, ids.blue], 'Export images', 'images'],
    ['a note', [noteId], 'Export image', 'images'],
    ['two images', [ids.red, ids.blue], 'Export board…', 'board'],
    ['nothing', [], 'Export board…', 'board'],
  ]) {
    await select(sel);
    const hit = await menuEntry(entry);
    assert.ok(!hit.missing, `the context menu has "${entry}" with ${label} selected: ${JSON.stringify(hit.missing)}`);
    assert.equal(hit.key, 'Ctrl+E', `"${entry}" shows Ctrl+E`);
    await waitFor(`document.querySelector('#exportModal')?.classList.contains('show')`, `context menu "${entry}"`);
    assert.deepEqual((await dialog()).tabOn, [tab], `"${entry}" with ${label} selected opens ${tab}`);
    await closeWithEsc();
  }

  /* 6. Ctrl+Shift+I does nothing, with or without a selection. */
  for (const sel of [[ids.red, ids.blue], []]) {
    await select(sel);
    await key('I', { ctrl: true, shift: true });
    await delay(250);
    assert.deepEqual(await openModals(), [], 'Ctrl+Shift+I opens no dialog');
  }

  /* 10. An Images export into the remembered folder. */
  await cdp.run(`(localStorage.setItem('refboard.exportDir', ${JSON.stringify(outDir)}), true)`);
  await select([ids.red, ids.blue]);
  d = await openWithCtrlE();
  assert.deepEqual(d.tabOn, ['images']);
  const ui = await cdp.run(`({dir:document.querySelector('#expImgDir').value,preview:document.querySelector('#expImgPreview').textContent})`);
  assert.equal(ui.dir, outDir, 'the dialog shows the remembered folder');
  const expectedNames = ui.preview.split(' … ').map(s => s.trim());
  assert.equal(expectedNames.length, 2, `the preview names a first and a last file (${ui.preview})`);
  assert.equal(await click('#expImgGo'), true);
  await waitFor(`!document.querySelector('#exportModal').classList.contains('show')`, 'the Images export to finish', 200);
  const written = (await readdir(outDir)).sort();
  assert.deepEqual(written, [...expectedNames].sort(), 'the folder holds exactly the two named files');
  for (const name of written) {
    const size = pngSize(await readFile(path.join(outDir, name)));
    assert.deepEqual(size, { w: 400, h: 300 }, `${name} is the 400x300 original`);
  }
  assert.match(await toastText(), /Exported 2 images/, 'the export reports two images');

  /* 11. Board PNG at 1x (button) and 2x (Enter). */
  await cdp.run(`(()=>{window.__boardExports=[];window.RefBoard.boardExportSinkForTest=async(blob,name)=>{
    const b64=await new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(String(r.result).split(',')[1]);r.onerror=rej;r.readAsDataURL(blob);});
    window.__boardExports.push({name,b64});};return true;})()`);
  // The board export pads the items' box by 48 board px a side, then scales.
  const box = await cdp.run(`(()=>{let x1=Infinity,y1=Infinity,x2=-Infinity,y2=-Infinity;
    for(const it of window.RefBoard.state.items){x1=Math.min(x1,it.x);y1=Math.min(y1,it.y);x2=Math.max(x2,it.x+it.w);y2=Math.max(y2,it.y+it.h);}
    return {w:x2-x1+96,h:y2-y1+96};})()`);
  async function boardExport(scale, how) {
    await select([]);
    d = await openWithCtrlE();
    assert.deepEqual(d.tabOn, ['board'], 'nothing selected opens Board for the PNG export');
    assert.equal(await click('#expBoardFormat button[data-format="png"]'), true, 'the format row offers PNG');
    assert.equal(await click(`#expScale button[data-v="${scale}"]`), true);
    assert.equal(await click('#expBg button[data-v="#ffffff"]'), true);
    const before = await cdp.run(`window.__boardExports.length`);
    if (how === 'enter') {
      await cdp.run(`(document.activeElement?.blur?.(),true)`);
      await key('Enter');
    } else {
      assert.equal(await click('#expGo'), true);
    }
    await waitFor(`window.__boardExports.length>${before}`, `the ${scale}x board export`, 200);
    assert.deepEqual(await openModals(), [], 'the board export closes the dialog');
    const { name, b64 } = await cdp.run(`window.__boardExports[window.__boardExports.length-1]`);
    assert.match(name, /^refboard-\d{8}-\d{4}\.png$/, 'the board PNG keeps its file name');
    const file = path.join(outDir, `board-${scale}x.png`);
    await writeFile(file, Buffer.from(b64, 'base64'));
    const size = pngSize(await readFile(file));
    assert.deepEqual(size, { w: Math.round(box.w * scale), h: Math.round(box.h * scale) }, `the ${scale}x PNG is ${scale}x the padded board`);
    assert.equal(await toastText(), `Exported ${size.w}×${size.h} PNG`);
    return size;
  }
  const one = await boardExport(1, 'click');
  const two = await boardExport(2, 'enter');
  assert.deepEqual(two, { w: one.w * 2, h: one.h * 2 }, '2x is twice 1x');
  // The PNG choices stay as they were left (in the session, as before).
  await select([]);
  await openWithCtrlE();
  assert.deepEqual(await cdp.run(`[document.querySelector('#expScale .on')?.dataset.v,document.querySelector('#expBg .on')?.dataset.v]`), ['2', '#ffffff'],
    'the Board tab keeps the last resolution and background');
  assert.deepEqual(await cdp.run(`[...document.querySelectorAll('#expBoardFormat button.on')].map(b=>b.dataset.format)`), ['png'],
    'the Board tab keeps the last format for the session');
  await closeWithEsc();

  /* The help panel lists Ctrl+E as Export, and no Ctrl+Shift+I. */
  const lists = await cdp.run(`(()=>{
    const help=document.querySelector('#helpModal')?.textContent||'';
    return {help,shiftI:/Ctrl\\s*Shift\\s*I/.test(help.replace(/\\s+/g,' '))};
  })()`);
  assert.equal(lists.shiftI, false, 'the help panel no longer lists Ctrl+Shift+I');
  assert.match(lists.help, /Export — images if selected, otherwise the board/, 'the help panel lists Export on Ctrl+E');

  const errors = await cdp.run(`window.__expErrors`);
  assert.deepEqual(errors, [], 'the Export dialog must not throw renderer errors');
  console.log('export dialog Electron smoke passed — Ctrl+E picks Images or Board, #sOrig opens Images, toolbar follows Ctrl+E, '
    + 'Ctrl+Shift+I does nothing, Esc closes, empty board toasts, no-images state, fixed card, Images files written, Board PNG 1x/2x');
} catch (err) {
  if (stderr.trim()) console.error(`--- electron stderr ---\n${stderr.trim()}`);
  console.error('child exitCode=' + child.exitCode);
  throw err;
} finally {
  if (child.exitCode === null) child.kill();
  await Promise.race([once(child, 'exit'), delay(3000)]).catch(() => {});
  await removeProfileDir(profile);
  await rm(outDir, { recursive: true, force: true }).catch(() => {});
}
