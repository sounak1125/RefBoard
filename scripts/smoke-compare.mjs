/**
 * Compare, end to end in the real app, driven with real mouse and key events.
 *
 * The board gets generated images of known solid colours, so every check is a
 * pixel read back from the Compare canvas:
 *   1. the Compare button shows for exactly two images, and not for one, for
 *      three, or for an image and a note;
 *   2. clicking it opens Compare, with A the image further left;
 *   3. Wipe shows A left of the line and B right of it; Onion at 50% shows the
 *      mix; Difference shows |A - B|;
 *   4. dragging the wipe handle moves the boundary;
 *   5. Swap (X, and the button) exchanges the colours;
 *   6. arrow keys and a drag nudge B, and Reset puts it back;
 *   7. a B of another shape is letterboxed, and the uncovered band is dimmed
 *      and hatched, never shown as A, in Wipe and in Difference;
 *   8. Delete, Backspace, Ctrl+Z, Ctrl+A and Ctrl+V do nothing while it is open;
 *   9. Esc closes it, and the board saw no change at all (change version, undo
 *      stack and dirty flag as they were);
 *  10. both image records are unpinned after close;
 * and also: crop, flipX and grayscale show as on the board; an image removed
 * under Compare closes it.
 *
 * Set REFBOARD_SMOKE_SHOT_DIR to save a screenshot of each mode.
 * Run with --bench to time it on two generated 6000x4000 images instead.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeProfileDir } from './smoke-profile-cleanup.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = process.env.REFBOARD_SMOKE_EXECUTABLE || path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const profile = await mkdtemp(path.join(os.tmpdir(), 'refboard-compare-'));
const shotDir = process.env.REFBOARD_SMOKE_SHOT_DIR || '';
const bench = process.argv.includes('--bench');
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

/* Solid colours. A and B differ in every channel so |A - B| and the mix are
   unambiguous; GREEN is the other shape (2.67:1 against A's 4:3). */
const RED = [200, 40, 40];
const BLUE = [40, 80, 220];
const GREEN = [40, 200, 90];
const YELLOW = [240, 200, 40];

const KEYS = {
  x: { key: 'x', code: 'KeyX', vk: 88, text: 'x' },
  o: { key: 'o', code: 'KeyO', vk: 79, text: 'o' },
  d: { key: 'd', code: 'KeyD', vk: 68, text: 'd' },
  w: { key: 'w', code: 'KeyW', vk: 87, text: 'w' },
  a: { key: 'a', code: 'KeyA', vk: 65, text: 'a' },
  v: { key: 'v', code: 'KeyV', vk: 86, text: 'v' },
  z: { key: 'z', code: 'KeyZ', vk: 90, text: 'z' },
  Delete: { key: 'Delete', code: 'Delete', vk: 46 },
  Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  Escape: { key: 'Escape', code: 'Escape', vk: 27 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
};

try {
  const port = await debuggerPort();
  const cdp = await attach(port);
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
  if (shotDir) await mkdir(shotDir, { recursive: true });

  const mouse = (type, x, y, extra = {}) => cdp.send('Input.dispatchMouseEvent', {
    type, x, y, button: type === 'mouseMoved' && !extra.held ? 'none' : 'left',
    buttons: type === 'mousePressed' || extra.held ? 1 : 0, clickCount: 1,
  });
  async function click(selector) {
    const at = await cdp.run(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});
      if(!el||getComputedStyle(el).display==='none'||el.hidden)return null;
      const r=el.getBoundingClientRect();if(!r.width||!r.height)return null;return [r.left+r.width/2,r.top+r.height/2];})()`);
    if (!at) return false;
    await mouse('mouseMoved', at[0], at[1]);
    await mouse('mousePressed', at[0], at[1]);
    await mouse('mouseReleased', at[0], at[1]);
    await delay(150);
    return true;
  }
  async function drag(from, to, steps = 12) {
    await mouse('mouseMoved', from[0], from[1]);
    await mouse('mousePressed', from[0], from[1]);
    for (let i = 1; i <= steps; i++) {
      await mouse('mouseMoved', from[0] + (to[0] - from[0]) * i / steps, from[1] + (to[1] - from[1]) * i / steps, { held: true });
    }
    await mouse('mouseReleased', to[0], to[1]);
    await delay(120);
  }
  async function key(name, { ctrl = false, shift = false } = {}) {
    const k = KEYS[name];
    const modifiers = (ctrl ? 2 : 0) | (shift ? 8 : 0);
    const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, modifiers };
    await cdp.send('Input.dispatchKeyEvent', { type: k.text && !ctrl ? 'keyDown' : 'rawKeyDown', ...base, ...(k.text && !ctrl ? { text: k.text } : {}) });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    await delay(80);
  }
  // Two rAFs so the change has been drawn.
  const settle = () => cdp.run(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))`);
  const cmp = () => cdp.run(`window.RefBoard.compareStateForTest?.() ?? null`);
  const px = async (fx, fy) => { await settle(); return cdp.run(`window.RefBoard.comparePixelForTest(${fx},${fy})`); };
  const clientAt = (fx, fy) => cdp.run(`window.RefBoard.compareClientPointForTest(${fx},${fy})`);
  const select = ids => cdp.run(`(()=>{const RB=window.RefBoard;RB.state.sel=new Set(${JSON.stringify(ids)});RB.updateSelBarForTest();RB.invalidate();return true;})()`);
  const compareShown = () => cdp.run(`(()=>{const b=document.querySelector('#sCompare');const bar=document.querySelector('#selbar');
    return !!b&&bar.classList.contains('show')&&getComputedStyle(b).display!=='none';})()`);
  async function shoot(name) {
    if (!shotDir) return;
    await settle();
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(path.join(shotDir, name), Buffer.from(shot.data, 'base64'));
  }
  const near = (got, want, tol, msg) => {
    assert.ok(Array.isArray(got), `${msg}: no pixel (Compare not drawn?)`);
    const ok = want.every((v, i) => Math.abs(got[i] - v) <= tol);
    assert.ok(ok, `${msg}: expected ~${JSON.stringify(want)}, got ${JSON.stringify(got.slice(0, 3))}`);
  };
  const pinCounts = ids => cdp.run(`${JSON.stringify(ids)}.map(id=>{const RB=window.RefBoard;const it=RB.state.items.find(i=>i.id===id);
    const im=it&&RB.images.get(it.imgId);return im?im.fullPinCount||0:-1;})`);

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
    window.__cmpErrors=[];
    window.addEventListener('error',e=>window.__cmpErrors.push(e.message));
    return true;
  })()`);

  if (bench) {
    await runBench(cdp, { mouse, settle, cmp, click, select, clientAt, shoot });
  } else {
    await runSmoke();
  }

  async function runSmoke() {
    /* ---- the board: A red (left), B blue (right), C green (another shape),
       D two-tone (red left half, yellow right half), and a note ---- */
    const ids = await cdp.run(`(async()=>{
      const RB=window.RefBoard;
      const make=async(w,h,paint,name)=>{const c=document.createElement('canvas');c.width=w;c.height=h;
        const g=c.getContext('2d');paint(g,w,h);
        return new File([await new Promise(r=>c.toBlob(r,'image/png'))],name,{type:'image/png'});};
      const solid=rgb=>(g,w,h)=>{g.fillStyle='rgb('+rgb+')';g.fillRect(0,0,w,h);};
      const files=[
        await make(400,300,solid(${JSON.stringify(RED)}),'red.png'),
        await make(400,300,solid(${JSON.stringify(BLUE)}),'blue.png'),
        await make(400,150,solid(${JSON.stringify(GREEN)}),'green.png'),
        await make(400,300,(g,w,h)=>{g.fillStyle='rgb(${RED})';g.fillRect(0,0,w/2,h);g.fillStyle='rgb(${YELLOW})';g.fillRect(w/2,0,w/2,h);},'two-tone.png'),
      ];
      const added=await RB.addImages(files);
      await new Promise(r=>setTimeout(r,500));
      if(added.length!==4)throw new Error('expected four images, got '+added.length);
      const spots=[[0,0],[600,40],[1200,0],[0,600]];
      added.forEach((it,i)=>{it.x=spots[i][0];it.y=spots[i][1];it.rot=0;});
      const note=RB.makeNoteForTest({x:600,y:600});
      RB.state.items.push(note);
      RB.invalidateLayout();
      RB.fitAll();
      RB.invalidate();
      await new Promise(r=>setTimeout(r,300));
      return {red:added[0].id,blue:added[1].id,green:added[2].id,two:added[3].id,note:note.id};
    })()`);

    /* 1. The button: exactly two images. */
    const shown = {};
    await select([ids.blue, ids.red]); shown.two = await compareShown();
    await select([ids.red]); shown.one = await compareShown();
    await select([ids.red, ids.blue, ids.green]); shown.three = await compareShown();
    await select([ids.red, ids.note]); shown.imageAndNote = await compareShown();
    assert.equal(shown.two, true, 'two images show the Compare button');
    assert.equal(shown.one, false, 'one image hides it');
    assert.equal(shown.three, false, 'three images hide it');
    assert.equal(shown.imageAndNote, false, 'an image and a note hide it');
    const tip = await cdp.run(`document.querySelector('#sCompare')?.dataset.tip`);
    assert.equal(tip, 'Compare');

    /* 2. Open it with a real click. Selected right-first, A is still the left one. */
    await select([ids.blue, ids.red]);
    const before = await cdp.run(`(()=>{const RB=window.RefBoard;return {version:RB.boardChangeVersionForTest,dirty:RB.boardFileDirtyForTest,
      undo:RB.undoStats().entries,redo:RB.undoStats().redoEntries,items:RB.state.items.length,sel:[...RB.state.sel].sort()};})()`);
    assert.equal(await click('#sCompare'), true, 'the bar offers Compare');
    await settle();
    let st = await cmp();
    assert.ok(st, 'clicking Compare opens it');
    for (let i = 0; i < 50 && st.loading; i++) { await delay(50); st = await cmp(); }
    assert.equal(st.loading, false, 'the full bitmaps load');
    assert.equal(st.a, ids.red, 'A is the image further left');
    assert.equal(st.b, ids.blue);
    assert.equal(st.mode, 'wipe');
    assert.deepEqual(await pinCounts([ids.red, ids.blue]), [1, 1], 'both records are pinned while Compare is open');
    const ui = await cdp.run(`(()=>({
      names:[document.querySelector('#cmpFileA').textContent,document.querySelector('#cmpFileB').textContent],
      info:document.querySelector('#cmpInfoText').textContent,
      swapTip:document.querySelector('#cmpSwap').dataset.tip,
      seq:[...document.querySelector('#compareBar').children].filter(el=>getComputedStyle(el).display!=='none')
        .map(el=>el.id||el.className),
      selbarHidden:document.elementFromPoint(...(()=>{const r=document.querySelector('#selbar').getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2];})())?.closest('#compareView')!==null,
    }))()`);
    assert.deepEqual(ui.names, ['red.png', 'blue.png']);
    assert.equal(ui.info, 'Both 400 × 300 · drag B to nudge · Esc to close');
    assert.equal(ui.swapTip, 'Swap A and B  (X)');
    assert.deepEqual(ui.seq, ['cmp-name', 'cmpSwap', 'cmp-name', 'sep', 'cmpModes', 'sep', 'cmpDone'], 'bar order: A, swap, B, divider, modes, divider, Done');
    assert.equal(ui.selbarHidden, true, 'Compare covers the selection bar');
    const W = st.frame.w, H = st.frame.h;

    /* 3a. Wipe: A left of the line, B right. */
    near(await px(W * 0.25, H * 0.6), RED, 3, 'wipe: left of the line is A');
    near(await px(W * 0.75, H * 0.6), BLUE, 3, 'wipe: right of the line is B');
    await shoot('compare-wipe.png');

    /* 4. Drag the handle to 80% of the width. */
    const handle = await cdp.run(`(()=>{const s=window.RefBoard.compareStateForTest();const r=document.querySelector('#compareCanvas').getBoundingClientRect();
      return [r.left+s.handle.x,r.top+s.handle.y];})()`);
    const target = await clientAt(W * 0.8, H * 0.5);
    await drag(handle, [target[0], handle[1]]);
    st = await cmp();
    assert.ok(Math.abs(st.wipe - 0.8) < 0.01, `the wipe follows the drag, got ${st.wipe}`);
    assert.deepEqual(st.nudge, { x: 0, y: 0 }, 'dragging the handle does not nudge B');
    near(await px(W * 0.7, H * 0.6), RED, 3, 'after the drag, 70% across is A');
    near(await px(W * 0.9, H * 0.6), BLUE, 3, 'and 90% across is B');
    // And the line itself, grabbed away from the handle.
    const lineAt = await clientAt(W * 0.8, H * 0.15);
    const lineTo = await clientAt(W * 0.4, H * 0.15);
    await drag(lineAt, lineTo);
    st = await cmp();
    assert.ok(Math.abs(st.wipe - 0.4) < 0.01, `the line itself drags too, got ${st.wipe}`);

    /* 5. Swap with X: the colours exchange sides. Then back with the button. */
    await key('x');
    st = await cmp();
    assert.equal(st.a, ids.blue, 'X swaps A and B');
    near(await px(W * 0.2, H * 0.6), BLUE, 3, 'after swap, the left side is the old B');
    near(await px(W * 0.9, H * 0.6), RED, 3, 'after swap, the right side is the old A');
    assert.equal(await click('#cmpSwap'), true);
    st = await cmp();
    assert.equal(st.a, ids.red, 'the swap button swaps back');

    /* 3b. Onion at 50%: the mix. */
    await key('o');
    st = await cmp();
    assert.equal(st.mode, 'onion');
    assert.equal(await cdp.run(`getComputedStyle(document.querySelector('.cmp-opacity')).display!=='none'`), true, 'the opacity slider shows in Onion');
    assert.equal(st.opacity, 0.5, 'opacity starts at 50%');
    const mix = RED.map((v, i) => (v + BLUE[i]) / 2);
    near(await px(W * 0.2, H * 0.5), mix, 3, 'onion 50%: the mix of A and B');
    near(await px(W * 0.9, H * 0.5), mix, 3, 'onion is the same on both sides of where the wipe was');
    await shoot('compare-onion.png');

    /* 3c. Difference: |A - B|. */
    await key('d');
    st = await cmp();
    assert.equal(st.mode, 'difference');
    assert.equal(await cdp.run(`getComputedStyle(document.querySelector('.cmp-opacity')).display`), 'none', 'the slider hides outside Onion');
    const diff = RED.map((v, i) => Math.abs(v - BLUE[i]));
    near(await px(W * 0.5, H * 0.5), diff, 3, 'difference: |A - B|');
    near(await px(5, H * 0.5), diff, 3, 'difference reaches the left edge before any nudge');
    assert.match(await cdp.run(`document.querySelector('#cmpInfoText').textContent`), /black = identical/);
    await shoot('compare-difference.png');

    /* 6. Nudge: Right, then Shift+Right, moves B 11 px right; the left strip
       is then uncovered and must not read as A, B or a difference. */
    assert.equal(await cdp.run(`document.querySelector('#cmpReset').hidden`), true, 'no Reset before a nudge');
    await key('ArrowRight');
    await key('ArrowRight', { shift: true });
    st = await cmp();
    assert.deepEqual(st.nudge, { x: 11, y: 0 }, 'Right nudges 1 px, Shift+Right 10 px');
    const strip = await px(4, H * 0.5);
    assert.ok(strip.slice(0, 3).every(v => v < 110), `the uncovered strip is dim, got ${strip}`);
    assert.ok(!diff.every((v, i) => Math.abs(strip[i] - v) < 20), 'the uncovered strip is not |A - B|');
    near(await px(16, H * 0.5), diff, 3, 'past the strip it is |A - B| again');
    assert.equal(await cdp.run(`document.querySelector('#cmpReset').hidden`), false, 'Reset shows once B is off zero');
    // A drag on the stage nudges by the drag in A pixels.
    const from = await clientAt(W * 0.5, H * 0.5);
    await drag(from, [from[0] + 40, from[1] + 20]);
    st = await cmp();
    assert.deepEqual(st.nudge, { x: 11 + Math.round(40 / st.view.s), y: Math.round(20 / st.view.s) }, 'a drag nudges by its length in A pixels');
    assert.equal(await click('#cmpReset'), true);
    st = await cmp();
    assert.deepEqual(st.nudge, { x: 0, y: 0 }, 'Reset puts B back');
    assert.equal(await cdp.run(`document.querySelector('#cmpReset').hidden`), true);

    /* Zoom and fit: the wheel zooms about the cursor, F fits again. */
    const fitted = st.view;
    const centre = await clientAt(W * 0.25, H * 0.25);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: centre[0], y: centre[1], deltaX: 0, deltaY: -300 });
    await settle();
    st = await cmp();
    assert.ok(st.view.s > fitted.s * 1.2, 'the wheel zooms in');
    const back = await clientAt(W * 0.25, H * 0.25);
    assert.ok(Math.hypot(back[0] - centre[0], back[1] - centre[1]) < 1, 'about the cursor');
    await key('w');
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70, text: 'f' });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70 });
    await settle();
    st = await cmp();
    assert.equal(st.fitted, true, 'F fits again');
    assert.ok(Math.abs(st.view.s - fitted.s) < 1e-9);

    /* 8. Board keys do nothing while it is open. */
    await key('Delete');
    await key('Backspace');
    await key('z', { ctrl: true });
    await key('a', { ctrl: true });
    await key('v', { ctrl: true });
    await delay(200);
    st = await cmp();
    assert.ok(st, 'Compare is still open after the board keys');
    const during = await cdp.run(`(()=>{const RB=window.RefBoard;return {version:RB.boardChangeVersionForTest,
      undo:RB.undoStats().entries,redo:RB.undoStats().redoEntries,items:RB.state.items.length,sel:[...RB.state.sel].sort()};})()`);
    assert.equal(during.items, before.items, 'Delete and Backspace deleted nothing');
    assert.deepEqual(during.sel, before.sel, 'Ctrl+A did not select all');
    assert.equal(during.undo, before.undo, 'Ctrl+Z did not undo');
    assert.equal(during.redo, before.redo);
    assert.equal(during.version, before.version, 'nothing on the board changed');

    /* 9 and 10. Esc closes; the board is as it was; both records unpinned. */
    await key('Escape');
    await settle();
    st = await cmp();
    assert.equal(st, null, 'Esc closes Compare');
    const after = await cdp.run(`(()=>{const RB=window.RefBoard;return {version:RB.boardChangeVersionForTest,dirty:RB.boardFileDirtyForTest,
      undo:RB.undoStats().entries,redo:RB.undoStats().redoEntries,items:RB.state.items.length,sel:[...RB.state.sel].sort(),
      shown:getComputedStyle(document.querySelector('#compareView')).display};})()`);
    assert.equal(after.shown, 'none', 'the overlay is gone');
    assert.deepEqual({ ...after, shown: undefined }, { ...before, shown: undefined }, 'the board is exactly as before: no change, no undo, same dirty flag, same selection');
    assert.deepEqual(await pinCounts([ids.red, ids.blue]), [0, 0], 'both records are unpinned after close');
    // Esc after close is the board's again: it clears the selection.
    await key('Escape');
    assert.equal(await cdp.run(`window.RefBoard.state.sel.size`), 0, 'Esc reaches the board once Compare is closed');

    /* 7. Another shape: red (4:3) and green (8:3). Green is letterboxed. */
    await select([ids.red, ids.green]);
    assert.equal(await click('#sCompare'), true);
    st = await cmp();
    for (let i = 0; i < 50 && st.loading; i++) { await delay(50); st = await cmp(); }
    assert.equal(st.a, ids.red);
    assert.deepEqual([st.bRect.x, st.bRect.y, st.bRect.w, st.bRect.h], [0, 75, 400, 150], 'B is fitted by width and centred, not stretched');
    assert.match(await cdp.run(`document.querySelector('#cmpInfoText').textContent`), /^A 400 × 300 · B 400 × 150 · different shapes — B letterboxed/);
    const wipeTo = await clientAt(100, 150);
    const h2 = await cdp.run(`(()=>{const s=window.RefBoard.compareStateForTest();const r=document.querySelector('#compareCanvas').getBoundingClientRect();
      return [r.left+s.handle.x,r.top+s.handle.y];})()`);
    await drag(h2, [wipeTo[0], h2[1]]);
    near(await px(50, 30), RED, 3, 'left of the wipe, A shows in full, letterbox or not');
    near(await px(300, 150), GREEN, 3, 'right of the wipe, inside B: B');
    const band = await px(300, 30);
    assert.ok(band.slice(0, 3).every(v => v < 110), `right of the wipe, in the letterbox band: dimmed, got ${band}`);
    assert.ok(!RED.every((v, i) => Math.abs(band[i] - v) < 30), 'the letterbox band is not shown as A');
    await shoot('compare-letterbox-wipe.png');
    await key('d');
    const dband = await px(200, 30);
    const dgreen = RED.map((v, i) => Math.abs(v - GREEN[i]));
    assert.ok(dband.slice(0, 3).every(v => v > 15 && v < 110), `difference: the band is neither black nor bright, got ${dband}`);
    assert.ok(!dgreen.every((v, i) => Math.abs(dband[i] - v) < 20), 'difference: the band is not |A - B|');
    assert.ok(!RED.every((v, i) => Math.abs(dband[i] - v) < 30), 'difference: the band is not A');
    near(await px(200, 150), dgreen, 3, 'difference inside B');
    await shoot('compare-letterbox-difference.png');
    await key('o');
    const oband = await px(200, 30);
    assert.ok(oband.slice(0, 3).every(v => v < 110), `onion: the band is dimmed, got ${oband}`);
    await key('Escape');
    assert.equal(await cmp(), null);

    /* Crop, flip and grayscale show as on the board. D is red | yellow. */
    const openPair = async () => {
      await select([ids.two, ids.blue]);
      assert.equal(await click('#sCompare'), true);
      let s = await cmp();
      for (let i = 0; i < 50 && s.loading; i++) { await delay(50); s = await cmp(); }
      assert.equal(s.a, ids.two, 'the two-tone image is A (further left)');
      return s;
    };
    const setTwo = props => cdp.run(`(()=>{const it=window.RefBoard.state.items.find(i=>i.id===${JSON.stringify(ids.two)});
      Object.assign(it,${JSON.stringify(props)});window.RefBoard.invalidate();return true;})()`);
    await cdp.run(`(()=>{const it=window.RefBoard.state.items.find(i=>i.id===${JSON.stringify(ids.two)});it.x=-600;window.RefBoard.invalidateLayout();return true;})()`);
    let s2 = await openPair();
    near(await px(s2.frame.w * 0.1, s2.frame.h * 0.5), RED, 3, 'plain: the left of the two-tone is red');
    await key('Escape');
    await setTwo({ flipX: true });
    s2 = await openPair();
    near(await px(s2.frame.w * 0.1, s2.frame.h * 0.5), YELLOW, 3, 'flipX: the left shows the yellow half');
    await key('Escape');
    await setTwo({ flipX: false, crop: { l: 0.5, t: 0, r: 1, b: 1 } });
    s2 = await openPair();
    assert.deepEqual(s2.frame, { w: 200, h: 300 }, 'the crop defines the frame, in source pixels');
    near(await px(s2.frame.w * 0.1, s2.frame.h * 0.5), YELLOW, 3, 'cropped to the right half: yellow');
    await key('Escape');
    await setTwo({ gray: true });
    s2 = await openPair();
    const gray = await px(s2.frame.w * 0.1, s2.frame.h * 0.5);
    assert.ok(Math.abs(gray[0] - gray[1]) <= 2 && Math.abs(gray[1] - gray[2]) <= 2, `gray: the item's grayscale shows, got ${gray}`);
    await key('Escape');
    await setTwo({ gray: false, crop: { l: 0, t: 0, r: 1, b: 1 } });

    /* The board changes underneath: an image removed closes Compare and unpins. */
    await select([ids.red, ids.blue]);
    assert.equal(await click('#sCompare'), true);
    assert.ok(await cmp());
    await cdp.run(`(()=>{const RB=window.RefBoard;RB.state.items=RB.state.items.filter(i=>i.id!==${JSON.stringify(ids.blue)});RB.invalidate();return true;})()`);
    await settle();
    await settle();
    assert.equal(await cmp(), null, 'removing one of the images closes Compare');
    assert.equal(await cdp.run(`getComputedStyle(document.querySelector('#compareView')).display`), 'none');
    assert.deepEqual(await pinCounts([ids.red]), [0], 'and unpins');

    const errors = await cdp.run(`window.__cmpErrors`);
    assert.deepEqual(errors, [], 'Compare must not throw renderer errors');
    console.log('compare Electron smoke passed — button for exactly two images; wipe, drag, swap, onion 50%, difference, '
      + 'nudge (keys, drag, reset), zoom/fit, letterbox dimmed in all modes, crop/flip/gray, board keys blocked, '
      + 'Esc leaves the board unchanged, records unpinned, closes when an image is removed');
  }
} catch (err) {
  if (stderr.trim()) console.error(`--- electron stderr ---\n${stderr.trim()}`);
  console.error('child exitCode=' + child.exitCode);
  throw err;
} finally {
  if (child.exitCode === null) child.kill();
  await Promise.race([once(child, 'exit'), delay(3000)]).catch(() => {});
  await removeProfileDir(profile);
}

/* ---- --bench: two 6000x4000 images ----
   Real drags first, each read from rAF deltas and the draw time per frame.
   The GPU-synced numbers (a 1 px readback after each draw) come last: Chromium
   can move a canvas that is read back often to the CPU, which would slow
   every measurement after it. */
async function runBench(cdp, { mouse, settle, cmp, click, select, clientAt, shoot }) {
  const ids = await cdp.run(`(async()=>{
    const RB=window.RefBoard;
    const make=async(seed,name)=>{const w=6000,h=4000;const c=document.createElement('canvas');c.width=w;c.height=h;
      const g=c.getContext('2d');
      const grad=g.createLinearGradient(0,0,w,h);grad.addColorStop(0,seed?'#204070':'#703020');grad.addColorStop(1,seed?'#e0c060':'#60c0e0');
      g.fillStyle=grad;g.fillRect(0,0,w,h);
      for(let i=0;i<4000;i++){g.fillStyle='hsl('+((i*37+seed*90)%360)+',60%,'+(30+(i*13)%50)+'%)';
        g.fillRect((i*7919)%w,(i*104729+seed*500)%h,40+(i%90),20+(i%60));}
      const blob=await new Promise(r=>c.toBlob(r,'image/png'));c.width=0;c.height=0;
      return new File([blob],name,{type:'image/png'});};
    const files=[await make(0,'big-a.png'),await make(1,'big-b.png')];
    const added=await RB.addImages(files);
    await new Promise(r=>setTimeout(r,1500));
    added[0].x=0;added[0].y=0;added[1].x=added[0].w+200;added[1].y=0;
    RB.invalidateLayout();RB.fitAll();RB.invalidate();
    await new Promise(r=>setTimeout(r,1500));
    return added.map(it=>it.id);
  })()`);
  const residency = () => cdp.run(`${JSON.stringify(ids)}.map(id=>{const RB=window.RefBoard;const it=RB.state.items.find(i=>i.id===id);return !!RB.images.get(it.imgId).bitmap;})`);
  const dpr = await cdp.run('devicePixelRatio');
  const pressKey = async (key, code, vk, text) => {
    await cdp.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, ...(text ? { text } : {}) });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk });
    await settle();
  };
  async function open() {
    await select(ids);
    await settle();
    const resident = await residency();
    assert.equal(await click('#sCompare'), true);
    let st = await cmp();
    for (let i = 0; i < 600 && (!st || st.firstPaintMs == null); i++) { await delay(25); st = await cmp(); }
    return { residentBeforeClick: resident, firstFrameMs: round(st.firstFrameMs), firstPaintMs: round(st.firstPaintMs), firstDrawMs: round(st.stats.maxDrawMs) };
  }
  const round = v => Math.round(v * 100) / 100;
  async function measure(from, path) {
    await cdp.run(`(()=>{window.__rafTimes=[];const tick=t=>{window.__rafTimes.push(t);if(window.__rafOn)requestAnimationFrame(tick);};window.__rafOn=true;requestAnimationFrame(tick);
      window.__stats0={...window.RefBoard.compareStateForTest().stats};return true;})()`);
    await mouse('mouseMoved', from[0], from[1]);
    await mouse('mousePressed', from[0], from[1]);
    for (let i = 1; i <= 120; i++) {
      const [dx, dy] = path(i / 120);
      await mouse('mouseMoved', from[0] + dx, from[1] + dy, { held: true });
      await delay(6);
    }
    await mouse('mouseReleased', from[0], from[1]);
    return cdp.run(`(()=>{window.__rafOn=false;const t=window.__rafTimes;const d=[];for(let i=1;i<t.length;i++)d.push(t[i]-t[i-1]);d.sort((a,b)=>a-b);
      const s=window.RefBoard.compareStateForTest().stats,s0=window.__stats0;const n=Math.max(1,s.frames-s0.frames);
      const q=p=>Math.round(d[Math.min(d.length-1,Math.floor(d.length*p))]*10)/10;
      return {framesDrawn:s.frames-s0.frames,drawMsAvg:Math.round((s.drawMs-s0.drawMs)/n*100)/100,
        rafP50:q(.5),rafP95:q(.95),rafMax:Math.round(d[d.length-1]*10)/10};})()`);
  }
  const handlePoint = () => cdp.run(`(()=>{const s=window.RefBoard.compareStateForTest();const r=document.querySelector('#compareCanvas').getBoundingClientRect();
    return s.handle?[r.left+s.handle.x,r.top+s.handle.y]:null;})()`);
  const wipePath = t => [Math.sin(t * Math.PI * 2) * 250, 0];
  const nudgePath = t => [Math.sin(t * Math.PI * 2) * 60, Math.cos(t * Math.PI * 2) * 30 - 30];
  const set200 = frame => cdp.run(`(()=>{const s=window.RefBoard.compareStateForTest();const sc=2/s.dpr;const r=document.querySelector('#compareCanvas').getBoundingClientRect();
    window.RefBoard.setCompareViewForTest({s:sc,tx:r.width/2-${frame.w / 2}*sc,ty:r.height/2-${frame.h / 2}*sc});return true;})()`);

  const out = { dpr };
  out.open = await open();
  let st = await cmp();
  const frame = st.frame;
  await shoot('bench-wipe-fit.png');
  out.wipeFit = await measure(await handlePoint(), wipePath);
  await set200(frame);
  await settle();
  await shoot('bench-wipe-200.png');
  out.wipe200 = await measure(await handlePoint(), wipePath);
  await cdp.run(`window.RefBoard.setCompareViewForTest('fit')`);
  await pressKey('d', 'KeyD', 68, 'd');
  await shoot('bench-difference-fit.png');
  out.differenceFit = await measure(await clientAt(frame.w / 2, frame.h / 2), nudgePath);
  await set200(frame);
  await settle();
  out.difference200 = await measure(await clientAt(frame.w / 2, frame.h / 2), nudgePath);
  await cdp.run(`window.RefBoard.setCompareViewForTest('fit')`);
  await pressKey('o', 'KeyO', 79, 'o');
  out.onionFit = await measure(await clientAt(frame.w / 2, frame.h / 2), nudgePath);
  await pressKey('Escape', 'Escape', 27);
  // Cold: neither full bitmap resident at the click, so Compare waits on two
  // 6000x4000 decodes. The page must stay responsive meanwhile.
  await cdp.run(`(()=>{const RB=window.RefBoard;for(const id of ${JSON.stringify(ids)}){const it=RB.state.items.find(i=>i.id===id);
    const im=RB.images.get(it.imgId);try{im.bitmap?.close();}catch{}im.bitmap=null;}return true;})()`);
  await cdp.run(`(()=>{window.__longest=0;let last=performance.now();window.__busy=true;const tick=()=>{const now=performance.now();
    window.__longest=Math.max(window.__longest,now-last);last=now;if(window.__busy)requestAnimationFrame(tick);};requestAnimationFrame(tick);return true;})()`);
  out.openCold = await open();
  out.openCold.longestFrameGapWhileLoadingMs = round(await cdp.run(`(window.__busy=false,window.__longest)`));
  await pressKey('Escape', 'Escape', 27);
  // Grayscale on both sides (board grayscale), through ctx.filter.
  await cdp.run(`(()=>{const RB=window.RefBoard;RB.state.boardGray=true;RB.invalidate();return true;})()`);
  out.openGray = await open();
  await shoot('bench-gray-wipe-fit.png');
  out.grayWipeFit = await measure(await handlePoint(), wipePath);
  await pressKey('d', 'KeyD', 68, 'd');
  out.grayDifferenceFit = await measure(await clientAt(frame.w / 2, frame.h / 2), nudgePath);
  // Now the readback-synced draw times (last; see above). After a few
  // readbacks Chromium keeps this canvas on the CPU, so these are the cost of
  // a software canvas (as on a machine without a GPU), not of the real view.
  const sync = async () => { const r = await cdp.run('window.RefBoard.compareBenchForTest(15)'); return { median: round(r.median), max: round(r.max) }; };
  out.cpuCanvasGrayDifferenceFit = await sync();
  await pressKey('w', 'KeyW', 87, 'w');
  out.cpuCanvasGrayWipeFit = await sync();
  console.log(JSON.stringify(out, null, 2));
}
