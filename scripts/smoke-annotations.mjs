/**
 * Annotations, driven through the real UI with real mouse input.
 *
 * Covers what only a running board can answer: that the Brush tool writes a
 * word as one ink item (strokes made together merge), that the highlighter is
 * its own item, that an arrow can be drawn and then curved from its middle
 * handle, that the selection bar restyles annotations as one undo step, that
 * clicking a stroke selects it, and that all of it survives a save and reopen.
 *
 * Input goes through CDP Input.dispatchMouseEvent rather than synthetic DOM
 * events, so pointer capture, coalesced events and the window-level move/up
 * listeners all run exactly as they do for a user.
 *
 * Set REFBOARD_SMOKE_SHOT to a .png path to keep a screenshot of the result.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeProfileDir } from './smoke-profile-cleanup.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = process.env.REFBOARD_SMOKE_EXECUTABLE || path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const profile = await mkdtemp(path.join(os.tmpdir(), 'refboard-annot-'));
const workDir = await mkdtemp(path.join(os.tmpdir(), 'refboard-annot-board-'));
const boardPath = path.join(workDir, 'annotated.refboard');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const near = (a, b, msg, eps = 0.5) => assert.ok(Math.abs(a - b) <= eps, `${msg}: expected ${b}, got ${a}`);

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

/* Board point -> client CSS px, computed inside the page from the live view. */
const toClient = (bx, by) => `(()=>{const r=document.getElementById('board').getBoundingClientRect();const v=window.RefBoard.state.view;return [r.left+${bx}*v.s+v.tx, r.top+${by}*v.s+v.ty];})()`;

try {
  const port = await debuggerPort();
  const cdp = await attach(port);
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});

  await cdp.run(`(async()=>{
    const wait=ms=>new Promise(r=>setTimeout(r,ms));
    for(let i=0;i<300&&!(window.RefBoard&&window.RefBoard.startupComplete);i++)await wait(50);
    if(!window.RefBoard?.startupComplete)throw new Error('startup did not complete');
    document.querySelectorAll('.modal.show').forEach(el=>el.classList.remove('show'));
    document.querySelector('#rwNewBoard').click();
    for(let i=0;i<100&&!document.body.classList.contains('board-active');i++)await wait(50);
    await wait(300);
    document.querySelectorAll('.modal.show').forEach(el=>el.classList.remove('show'));
    window.__annotErrors=[];
    window.addEventListener('error',e=>window.__annotErrors.push(e.message));
    const RB=window.RefBoard;
    const c=document.createElement('canvas');c.width=640;c.height=420;
    const g=c.getContext('2d');
    const grad=g.createLinearGradient(0,0,640,0);grad.addColorStop(0,'#e9e4da');grad.addColorStop(1,'#2a2f3a');
    g.fillStyle=grad;g.fillRect(0,0,640,420);
    const blob=await new Promise(r=>c.toBlob(r,'image/png'));
    const c2=document.createElement('canvas');c2.width=300;c2.height=220;
    const g2=c2.getContext('2d');g2.fillStyle='#5b6f8a';g2.fillRect(0,0,300,220);
    const blob2=await new Promise(r=>c2.toBlob(r,'image/png'));
    await RB.addImages([new File([blob],'ref.png',{type:'image/png'}),new File([blob2],'other.png',{type:'image/png'})]);
    await wait(400);
    const [it,it2]=RB.state.items;
    it.x=0;it.y=0;it.w=640;it.h=420;
    it2.x=760;it2.y=100;it2.w=300;it2.h=220;it2.rot=0;
    const board=document.getElementById('board');
    RB.state.view.s=1;
    RB.state.view.tx=Math.round((board.clientWidth-1060)/2);
    RB.state.view.ty=Math.round((board.clientHeight-420)/2);
    RB.state.sel.clear();
    RB.invalidateLayout();RB.invalidate();
    await wait(200);
    return true;
  })()`);

  const mouse = (type, x, y, buttons = 0, clickCount = 1) => cdp.send('Input.dispatchMouseEvent', {
    type, x, y, button: type === 'mouseMoved' ? (buttons ? 'left' : 'none') : 'left', buttons, clickCount,
  });
  async function clickBoard(bx, by, clicks = 1) {
    const [x, y] = await cdp.run(toClient(bx, by));
    await mouse('mouseMoved', x, y);
    for (let c = 1; c <= clicks; c++) {
      await mouse('mousePressed', x, y, 1, c);
      await mouse('mouseReleased', x, y, 0, c);
    }
    await delay(80);
  }
  async function strokeBoard(points, { stepMs = 8 } = {}) {
    const client = [];
    for (const [bx, by] of points) client.push(await cdp.run(toClient(bx, by)));
    await mouse('mouseMoved', client[0][0], client[0][1]);
    await mouse('mousePressed', client[0][0], client[0][1], 1);
    for (let i = 1; i < client.length; i++) {
      await mouse('mouseMoved', client[i][0], client[i][1], 1);
      await delay(stepMs);
    }
    const last = client[client.length - 1];
    await mouse('mouseReleased', last[0], last[1]);
    await delay(60);
  }
  const wave = (x0, y0, w, amp, n = 40) => Array.from({ length: n + 1 }, (_, i) => [x0 + (w * i) / n, y0 + Math.sin((i / n) * Math.PI * 3) * amp]);
  const line = (x0, y0, x1, y1, n = 16) => Array.from({ length: n + 1 }, (_, i) => [x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n]);

  /* Cursive loops at an uneven pace, the way a hand moves: the sample spacing
     swings between tight and wide, which is what shapes a mouse-drawn nib. */
  const loops = (x0, y0, n = 70) => {
    const out = [];
    let t = 0;
    for (let i = 0; i <= n; i++) {
      out.push([x0 + 9 * t - 16 * Math.sin(t), y0 - 22 * Math.cos(t) + 6 * Math.sin(t * 0.5)]);
      t += 0.16 * (1 + 0.85 * Math.sin(i * 0.23));
    }
    return out;
  };

  /* ---- brush: three strokes written together become one item ---- */
  await cdp.run(`(()=>{document.querySelector('#inkPenBtn').click();return true;})()`);
  const cursor = await cdp.run(`document.getElementById('board').style.cursor`);
  assert.match(cursor, /^url\("data:image\/svg\+xml/, 'the brush cursor previews the nib (an invalid cursor value would be dropped)');
  await strokeBoard(loops(60, 95));
  await strokeBoard(line(230, 60, 232, 130));
  await strokeBoard(wave(250, 95, 120, 14, 30));
  const afterBrush = await cdp.run(`(()=>{const ink=window.RefBoard.state.items.filter(i=>i.kind==='ink');return ink.map(i=>({id:i.id,strokes:i.strokes.length,style:i.inkStyle,x:i.x,y:i.y,w:i.w,h:i.h}));})()`);
  assert.equal(afterBrush.length, 1, `a word written in one go should be one ink item, got ${afterBrush.length}`);
  assert.equal(afterBrush[0].strokes, 3, 'all three strokes should land in that item');
  assert.equal(afterBrush[0].style, 'pen');

  /* A stroke far away, after the merge window, is a new item. */
  await delay(1600);
  await strokeBoard(wave(80, 330, 120, 10, 24));
  const inkCount = await cdp.run(`window.RefBoard.state.items.filter(i=>i.kind==='ink').length`);
  assert.equal(inkCount, 2, 'a later stroke elsewhere should start a new ink item');

  /* ---- highlighter ---- */
  await cdp.run(`(()=>{document.querySelector('#inkHighlightBtn').click();return true;})()`);
  await strokeBoard(line(380, 300, 600, 300, 24));
  const hl = await cdp.run(`(()=>{const h=window.RefBoard.state.items.filter(i=>i.kind==='ink'&&i.inkStyle==='highlighter');return {n:h.length,color:h[0]?.color,size:h[0]?.size};})()`);
  assert.equal(hl.n, 1, 'the highlighter should leave its own ink item');
  assert.equal(hl.color, '#ffd60a', 'the highlighter keeps its own colour instead of the pen black');
  const brushSize = await cdp.run(`window.RefBoard.state.items.find(i=>i.kind==='ink'&&i.inkStyle==='pen').size`);
  assert.ok(hl.size > brushSize * 3, `each tool keeps its own width (brush ${brushSize}, highlighter ${hl.size})`);

  /* A quick double-tap with the brush is two dots, not "fit the view". */
  await cdp.run(`(()=>{document.querySelector('#inkPenBtn').click();return true;})()`);
  const viewBefore = await cdp.run(`JSON.stringify(window.RefBoard.state.view)`);
  const inkBefore = await cdp.run(`window.RefBoard.state.items.filter(i=>i.kind==='ink').reduce((n,i)=>n+i.strokes.length,0)`);
  await delay(1500);
  await clickBoard(700, 200, 2);
  await delay(200);
  assert.equal(await cdp.run(`JSON.stringify(window.RefBoard.state.view)`), viewBefore, 'double-tapping with the brush must not refit the view');
  const inkAfter = await cdp.run(`window.RefBoard.state.items.filter(i=>i.kind==='ink').reduce((n,i)=>n+i.strokes.length,0)`);
  assert.equal(inkAfter, inkBefore + 2, 'each tap leaves a dot');

  /* ---- links: drag from one image onto another, Blender-node style ---- */
  await cdp.run(`(()=>{document.querySelector('#arrowSolidBtn').click();return true;})()`);
  let linkId = null;
  const readLink = () => cdp.run(`(()=>{const RB=window.RefBoard;const id=${JSON.stringify(linkId)};const a=RB.state.items.find(i=>i.kind==='arrow'&&(!id||i.id===id));return a&&{id:a.id,x1:a.x1,y1:a.y1,x2:a.x2,y2:a.y2,fromId:a.fromId,toId:a.toId,curve:a.curve,sel:RB.state.sel.has(a.id)};})()`);
  const ids = await cdp.run(`window.RefBoard.state.items.filter(i=>(i.kind||'image')==='image').map(i=>i.id)`);
  const [imgA, imgB] = ids;
  // Hovering an image with the arrow tool shows its sockets.
  const [hx, hy] = await cdp.run(toClient(900, 200));
  await mouse('mouseMoved', hx, hy);
  await delay(80);
  if (process.env.REFBOARD_SMOKE_SHOT) {
    const hover = await cdp.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(process.env.REFBOARD_SMOKE_SHOT.replace(/\.png$/i, '-sockets.png'), Buffer.from(hover.data, 'base64'));
  }
  await strokeBoard(line(520, 200, 900, 210, 14));
  const link = await readLink();
  assert.ok(link, 'a drag from one image onto another makes a link');
  linkId = link.id;
  assert.equal(link.fromId, imgA, 'plugged into the image it started on');
  assert.equal(link.toId, imgB, 'and the one it was dropped on');
  near(link.x1, 640, 'it leaves A from its right edge');
  near(link.x2, 760, 'and enters B on its left edge');
  near(link.y2, 210, 'mid-edge');
  assert.ok(Array.isArray(link.curve) && Math.abs(link.curve[1] - link.y1) < 1e-6 && Math.abs(link.curve[3] - link.y2) < 1e-6,
    'its handles run straight out of each edge, like a node link');

  // A drag that stays inside one image is still a plain annotation arrow.
  await strokeBoard(line(100, 250, 300, 260, 10));
  const free = await cdp.run(`(()=>{const a=window.RefBoard.state.items.filter(i=>i.kind==='arrow').at(-1);return {fromId:a.fromId,toId:a.toId,curve:a.curve,x2:a.x2};})()`);
  assert.deepEqual([free.fromId, free.toId, free.curve], [null, null, null], 'an arrow within one image points at a spot, unlinked');
  near(free.x2, 300, 'and ends where it was released');

  // Move B: the link follows it.
  await cdp.run(`(()=>{document.querySelector('#btnSelectTool').click();window.RefBoard.state.sel.clear();window.RefBoard.updateSelBarForTest();return true;})()`);
  await strokeBoard(line(950, 300, 950, 480, 12));
  const followed = await readLink();
  assert.equal(followed.toId, imgB, 'still plugged in after the move');
  near(followed.y2, 390, 'the link re-routes to B where it now is');
  near(followed.x1, 640, 'and A\'s end stays put');

  // Drag the link's end off B: it unplugs; undo plugs it back.
  await cdp.run(`(()=>{const RB=window.RefBoard;const a=RB.state.items.find(i=>i.kind==='arrow');RB.state.sel=new Set([a.id]);RB.updateSelBarForTest();RB.invalidate();return true;})()`);
  await delay(80);
  await strokeBoard(line(followed.x2, followed.y2, 700, 520, 10));
  const unplugged = await readLink();
  assert.equal(unplugged.toId, null, 'dragging the end off unplugs it');
  near(unplugged.x2, 700, 'and leaves it where it was dropped');
  assert.equal(unplugged.fromId, imgA, 'the other end stays plugged');
  // Re-plug onto B by dragging the loose end back over it.
  await strokeBoard(line(700, 520, 950, 400, 10));
  const replugged = await readLink();
  assert.equal(replugged.toId, imgB, 'dropping the end on an image plugs it in');

  // Deleting an image takes its links with it; undo brings both back.
  await cdp.run(`(()=>{const RB=window.RefBoard;RB.state.sel=new Set([${JSON.stringify(imgB)}]);RB.updateSelBarForTest();document.querySelector('#sDel').click();return true;})()`);
  await delay(120);
  assert.ok(!(await readLink()), 'deleting an image removes its link');
  await cdp.run(`window.RefBoard.undoForTest()`);
  await delay(150);
  const restored = await readLink();
  assert.ok(restored && restored.toId === imgB && restored.fromId === imgA, 'undo restores the image and its link together');
  await cdp.run(`(()=>{const RB=window.RefBoard;RB.state.sel=new Set([${JSON.stringify(linkId)}]);RB.updateSelBarForTest();RB.invalidate();return true;})()`);

  /* ---- selection bar restyles, one undo step ---- */
  const bar = await cdp.run(`(()=>{const b=document.querySelector('#selbar');return {annot:b.classList.contains('annot-sel'),arrow:b.classList.contains('arrow-sel'),swatches:document.querySelectorAll('#sAnnotSwatches .annot-swatch').length};})()`);
  assert.ok(bar.annot && bar.arrow, 'a selected arrow shows the annotation controls');
  assert.ok(bar.swatches >= 6, 'the colour row is populated');
  await cdp.run(`(()=>{document.querySelectorAll('#sAnnotSwatches .annot-swatch')[0].click();document.querySelector('#sArrowHeads').click();return true;})()`);
  const restyled = await cdp.run(`(()=>{const a=window.RefBoard.state.items.find(i=>i.kind==='arrow');return {color:a.color,heads:a.heads};})()`);
  assert.equal(restyled.color, '#ff4d4f');
  assert.equal(restyled.heads, 'both');
  await cdp.run(`window.RefBoard.undoForTest()`);
  await delay(150);
  const undone = await cdp.run(`(()=>{const a=window.RefBoard.state.items.find(i=>i.kind==='arrow');return {color:a.color,heads:a.heads};})()`);
  assert.equal(undone.heads, 'end', 'undo reverts the last restyle');
  assert.equal(undone.color, '#ff4d4f', 'and only the last one');
  await cdp.run(`window.RefBoard.redoForTest()`);
  await delay(150);

  /* ---- clicking a stroke selects the ink, not the image under it ---- */
  const firstInk = afterBrush[0];
  const pick = await cdp.run(`(()=>{const RB=window.RefBoard;const r=document.getElementById('board').getBoundingClientRect();const [cx,cy]=${toClient(60, 73)};const hit=RB.itemAt(cx-r.left,cy-r.top);const miss=RB.itemAt(${toClient(140, 200)}[0]-r.left,${toClient(140, 200)}[1]-r.top);return {hit:hit&&hit.kind,hitId:hit&&hit.id,miss:miss&&miss.kind};})()`);
  assert.equal(pick.hit, 'ink', 'a click on a stroke hits the ink');
  assert.equal(pick.hitId, firstInk.id);
  assert.equal(pick.miss, 'image', 'a click between strokes reaches the image underneath');

  /* ---- outline toggle on ink keeps it in place ---- */
  const outline = await cdp.run(`(()=>{const RB=window.RefBoard;const ink=RB.state.items.find(i=>i.id===${JSON.stringify(firstInk.id)});RB.state.sel=new Set([ink.id]);RB.updateSelBarForTest();const before={cx:ink.x+ink.w/2,cy:ink.y+ink.h/2,bar:document.querySelector('#selbar').classList.contains('arrow-sel')};document.querySelector('#sAnnotThicker').click();const after={cx:ink.x+ink.w/2,cy:ink.y+ink.h/2,size:ink.size};return {before,after};})()`);
  assert.equal(outline.before.bar, false, 'arrow-only controls hide for ink');
  assert.ok(Math.abs(outline.before.cx - outline.after.cx) < 1 && Math.abs(outline.before.cy - outline.after.cy) < 1, 'thickening ink does not move it');

  if (process.env.REFBOARD_SMOKE_SHOT) {
    // The chrome: the Annotate group open with the brush armed, and the
    // selection bar showing an arrow's style controls.
    await cdp.run(`(()=>{const RB=window.RefBoard;document.querySelector('#btnDraw').click();document.querySelector('#inkPenBtn').click();const a=RB.state.items.find(i=>i.kind==='arrow');RB.state.sel=new Set([a.id]);RB.updateSelBarForTest();RB.invalidate();return true;})()`);
    await delay(400);
    const ui = await cdp.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(process.env.REFBOARD_SMOKE_SHOT.replace(/\.png$/i, '-ui.png'), Buffer.from(ui.data, 'base64'));
    await cdp.run(`(()=>{document.querySelector('#btnSelectTool').click();document.querySelector('#btnDraw').click();return true;})()`);
  }
  await cdp.run(`(()=>{const RB=window.RefBoard;RB.state.sel.clear();RB.updateSelBarForTest();RB.invalidate();return true;})()`);
  await delay(250);
  if (process.env.REFBOARD_SMOKE_SHOT) {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(process.env.REFBOARD_SMOKE_SHOT, Buffer.from(shot.data, 'base64'));
  }

  /* ---- save and reopen ---- */
  const savedBefore = await cdp.run(`JSON.stringify(window.RefBoard.state.items.filter(i=>i.kind==='ink'||i.kind==='arrow').map(i=>({kind:i.kind,style:i.inkStyle||i.arrowStyle,strokes:i.strokes?.length,fromId:i.fromId,toId:i.toId,heads:i.heads,color:i.color})))`);
  await cdp.run(`(async()=>{const r=await window.RefBoard.saveBoardFile({silent:true,filePath:${JSON.stringify(boardPath)}});return !!r;})()`);
  await cdp.run(`(async()=>{await window.RefBoard.openBoardFromPath(${JSON.stringify(boardPath)});await new Promise(r=>setTimeout(r,500));return true;})()`);
  const after = await cdp.run(`JSON.stringify(window.RefBoard.state.items.filter(i=>i.kind==='ink'||i.kind==='arrow').map(i=>({kind:i.kind,style:i.inkStyle||i.arrowStyle,strokes:i.strokes?.length,fromId:i.fromId,toId:i.toId,heads:i.heads,color:i.color})))`);
  assert.deepEqual(JSON.parse(after), JSON.parse(savedBefore), 'annotations survive a save and reopen');

  const errors = await cdp.run(`window.__annotErrors`);
  assert.deepEqual(errors, [], 'no runtime errors');
  cdp.close();
  console.log(`annotations Electron smoke passed — ${afterBrush[0].strokes} strokes merged into one word, highlighter, image-to-image link (follows moves, unplugs, re-plugs, deletes with its image), restyle + undo, hit test, save/reopen`);
} catch (err) {
  if (stderr.trim()) console.error(`--- electron stderr ---\n${stderr.trim()}`);
  throw err;
} finally {
  if (child.exitCode === null) child.kill();
  await Promise.race([once(child, 'exit'), delay(3000)]).catch(() => {});
  await removeProfileDir(profile);
  await rm(workDir, { recursive: true, force: true }).catch(() => {});
}
