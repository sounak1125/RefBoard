/**
 * Board export as a Viewer (.html) and as a PDF, end to end in the real app.
 *
 * The board: six images (one cropped, one rotated, one flipped, one grey, a
 * large JPEG, a PNG with alpha), a rich note with a link and checkboxes, a
 * note whose text is an XSS attempt, an arrow, an ink stroke, a group, and
 * labels. Then:
 *   1. the dialog: the format row (Viewer default), each format's options,
 *      the estimate moving with the image size;
 *   5. a cancelled save writes nothing;
 *   2. the Viewer, opened in a separate sandboxed window (no RefBoard): image
 *      count and positions at a known zoom, the note as DOM text with a safe
 *      link, arrow and ink as SVG, the label filter, the save button only when
 *      allowed, zero network requests, Fit and zoom, double-click to zoom, and
 *      the XSS note doing nothing;
 *   3. image sizes: 1024 px keeps every long edge <= 1024; Original embeds
 *      the source bytes unchanged, except a cropped image, which is cut to
 *      its crop at full size, pixel for pixel;
 *   4. the PDF: %PDF, one page, the expected MediaBox (capped at 14,400 pt
 *      for a board wider than 200 in), image XObjects, and the temp page and
 *      hidden window gone afterwards.
 *
 * REFBOARD_VIEWER_OUT_DIR keeps the exported files there; REFBOARD_SMOKE_SHOT_DIR
 * saves screenshots of the dialog and the Viewer.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeProfileDir } from './smoke-profile-cleanup.mjs';

const require = createRequire(import.meta.url);
const { pdfPageLayout } = require('./board-export-main.js');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = process.env.REFBOARD_SMOKE_EXECUTABLE || path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const keepDir = process.env.REFBOARD_VIEWER_OUT_DIR || '';
const shotDir = process.env.REFBOARD_SMOKE_SHOT_DIR || '';
const profile = await mkdtemp(path.join(os.tmpdir(), 'refboard-viewer-'));
const outDir = keepDir || await mkdtemp(path.join(os.tmpdir(), 'refboard-viewer-out-'));
await mkdir(outDir, { recursive: true });
if (shotDir) await mkdir(shotDir, { recursive: true });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const children = [];

function launch(args, userDir) {
  const child = spawn(electron, [...args, '--remote-debugging-port=0', '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-features=CalculateNativeWinOcclusion',
    `--user-data-dir=${userDir}`], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderrText = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { child.stderrText += chunk; });
  children.push(child);
  return child;
}

async function debuggerPort(child, userDir) {
  const portFile = path.join(userDir, 'DevToolsActivePort');
  for (let attempt = 0; attempt < 150; attempt++) {
    if (child.exitCode !== null) throw new Error(`Electron exited early (${child.exitCode})\n${child.stderrText}`);
    try {
      const [port] = (await readFile(portFile, 'utf8')).trim().split(/\r?\n/);
      if (/^\d+$/.test(port)) return Number(port);
    } catch { /* not yet */ }
    await delay(100);
  }
  throw new Error(`no debugging port\n${child.stderrText}`);
}

const listTargets = port => fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json());

async function attach(port, match) {
  let target = null;
  for (let attempt = 0; attempt < 150 && !target; attempt++) {
    try { target = (await listTargets(port)).find(t => t.type === 'page' && match(t.url || '')); } catch { /* retry */ }
    if (!target) await delay(100);
  }
  if (!target) throw new Error('no page target');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let nextId = 0;
  const pending = new Map();
  const listeners = new Map();
  socket.onmessage = event => {
    const msg = JSON.parse(event.data);
    if (msg.method) { for (const fn of listeners.get(msg.method) || []) fn(msg.params); return; }
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
  const on = (method, fn) => { if (!listeners.has(method)) listeners.set(method, []); listeners.get(method).push(fn); };
  return { send, run, on, url: target.url, close: () => socket.close() };
}

async function waitFor(cdp, expression, label, tries = 200, ms = 50) {
  for (let i = 0; i < tries; i++) {
    if (await cdp.run(expression)) return;
    await delay(ms);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/* ---------------- image headers ---------------- */
function imageSize(buf) {
  if (buf.length > 24 && buf.toString('latin1', 1, 4) === 'PNG') return { type: 'png', w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const m = buf[i + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { type: 'jpeg', h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    const chunk = buf.toString('latin1', 12, 16);
    if (chunk === 'VP8X') return { type: 'webp', w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
    if (chunk === 'VP8 ') return { type: 'webp', w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
    if (chunk === 'VP8L') {
      const b = buf.readUInt32LE(21);
      return { type: 'webp', w: 1 + (b & 0x3fff), h: 1 + ((b >> 14) & 0x3fff) };
    }
  }
  throw new Error('unknown image format');
}

/** The embedded images and the payload of a Viewer file. */
function readViewer(html) {
  const blocks = [...html.matchAll(/<script type="text\/plain" data-rb-img="(\d+)" data-mime="([^"]+)">([^<]*)<\/script>/g)]
    .map(m => ({ index: Number(m[1]), mime: m[2], bytes: Buffer.from(m[3], 'base64') }));
  const json = html.match(/<script type="application\/json" id="rb-payload">([^<]*)<\/script>/);
  return { blocks, payload: JSON.parse(json[1]) };
}

function pdfFacts(buf) {
  const text = buf.toString('latin1');
  const pages = (text.match(/\/Type\s*\/Page(?![s\w])/g) || []).length;
  const boxes = [...text.matchAll(/\/MediaBox\s*\[\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s*\]/g)].map(m => m.slice(1, 5).map(Number));
  const imagesXObjects = (text.match(/\/Subtype\s*\/Image\b/g) || []).length;
  return { head: text.slice(0, 5), pages, boxes, imagesXObjects };
}

const appChild = launch(['.'], profile);
let viewerProfile = null;
try {
  const appPort = await debuggerPort(appChild, profile);
  const cdp = await attach(appPort, url => /index\.html/i.test(url) && !/pane=secondary/i.test(url));
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
  const mouse = (type, x, y, extra = {}) => cdp.send('Input.dispatchMouseEvent', {
    type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1, ...extra,
  });
  async function click(selector) {
    const at = await cdp.run(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});
      if(!el||el.closest('[hidden]')||getComputedStyle(el).display==='none')return null;
      const r=el.getBoundingClientRect();if(!r.width||!r.height)return null;return [r.left+r.width/2,r.top+r.height/2];})()`);
    if (!at) return false;
    await mouse('mouseMoved', at[0], at[1]);
    await mouse('mousePressed', at[0], at[1]);
    await mouse('mouseReleased', at[0], at[1]);
    await delay(120);
    return true;
  }
  async function ctrlE() {
    const base = { key: 'e', code: 'KeyE', windowsVirtualKeyCode: 69, nativeVirtualKeyCode: 69, modifiers: 2 };
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    await waitFor(cdp, `document.querySelector('#exportModal')?.classList.contains('show')`, 'Ctrl+E');
    await cdp.run(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))`);
  }
  async function closeDialog() {
    await cdp.run(`(document.querySelector('#expCancel').click(),true)`);
    await waitFor(cdp, `!document.querySelector('#exportModal').classList.contains('show')`, 'dialog to close');
  }
  async function shootApp(name) {
    if (!shotDir) return;
    await cdp.run(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))`);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(path.join(shotDir, name), Buffer.from(shot.data, 'base64'));
  }

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
    window.__errors=[];
    window.addEventListener('error',e=>window.__errors.push(e.message));
    return true;
  })()`);

  /* ---------------- the board ---------------- */
  const XSS = '</script><script>alert(1)</script>';
  const ONERR = '<img src=x onerror="alert(2)">';
  const ids = await cdp.run(`(async()=>{
    const RB=window.RefBoard;
    window.__src={};
    const enc=async(c,type,name)=>{const b=await new Promise(r=>c.toBlob(r,type,0.92));
      const buf=new Uint8Array(await b.arrayBuffer());let s='';for(let i=0;i<buf.length;i+=0x8000)s+=String.fromCharCode.apply(null,buf.subarray(i,i+0x8000));
      window.__src[name]=btoa(s);return new File([b],name,{type});};
    const canvas=(w,h,paint)=>{const c=document.createElement('canvas');c.width=w;c.height=h;paint(c.getContext('2d'),w,h);return c;};
    const quad=(g,w,h)=>{g.fillStyle='#d23c3c';g.fillRect(0,0,w/2,h/2);g.fillStyle='#3c8cd2';g.fillRect(w/2,0,w/2,h/2);
      g.fillStyle='#3cd278';g.fillRect(0,h/2,w/2,h/2);g.fillStyle='#e6c83c';g.fillRect(w/2,h/2,w/2,h/2);
      g.fillStyle='#fff';g.font='bold '+(h/6)+'px sans-serif';g.fillText('R',w*0.05,h*0.2);};
    const files=[
      await enc(canvas(2400,1600,quad),'image/png','cropped.png'),
      await enc(canvas(400,300,quad),'image/png','rotated.png'),
      await enc(canvas(400,300,quad),'image/png','flipped.png'),
      await enc(canvas(400,300,quad),'image/png','gray.png'),
      await enc(canvas(3000,2000,(g,w,h)=>{const gr=g.createLinearGradient(0,0,w,h);gr.addColorStop(0,'#203a5c');gr.addColorStop(1,'#e8a05a');
        g.fillStyle=gr;g.fillRect(0,0,w,h);for(let i=0;i<400;i++){g.fillStyle='hsl('+(i*37%360)+',70%,55%)';g.fillRect((i*733)%w,(i*397)%h,60,40);}}),'image/jpeg','large.jpg'),
      await enc(canvas(300,300,(g,w,h)=>{g.fillStyle='#ff4d8a';g.beginPath();g.arc(w/2,h/2,w*0.4,0,Math.PI*2);g.fill();}),'image/png','alpha.png'),
    ];
    const added=await RB.addImages(files);
    await new Promise(r=>setTimeout(r,600));
    if(added.length!==6)throw new Error('expected six images, got '+added.length);
    const [crop,rot,flip,gray,large,alpha]=added;
    const put=(it,x,y,w,h)=>{it.x=x;it.y=y;it.w=w;it.h=h;it.rot=0;};
    put(crop,0,0,300,200); crop.crop={l:0.25,t:0.25,r:0.75,b:0.75};
    put(rot,380,0,240,180); rot.rot=30;
    put(flip,700,0,240,180); flip.flipX=true;
    put(gray,0,300,240,180); gray.gray=true;
    put(large,300,300,450,300);
    put(alpha,800,300,150,150);
    crop.tags=['warm']; flip.tags=['warm','sky']; large.tags=['sky'];
    const note=RB.makeNoteForTest({x:0,y:680});
    note.text='[x] Pick the palette\\n[ ] Ask about [the brief](https://example.com/brief)\\n- Mood: warm, late sun';
    note.color='#ffd166';note.textColor='#15161c';note.bold=true;note.tags=['sky'];
    const xss=RB.makeNoteForTest({x:520,y:680});
    xss.text=${JSON.stringify(XSS)}+'\\n'+${JSON.stringify(ONERR)}+'\\n[x](javascript:alert(3))';
    RB.state.items.push(note,xss);
    const gid='grp-viewer-smoke';
    RB.state.items.push({id:gid,kind:'group',x:-40,y:-40,w:700,h:300,rot:0,padding:40,color:'#c084fc',locked:false,name:'Mood'});
    crop.groupId=gid; rot.groupId=gid;
    RB.state.items.push({id:'arrow-smoke',kind:'arrow',x1:330,y1:520,x2:520,y2:700,strokeWidth:6,color:'#ff4d4f',heads:'end',outline:true,arrowStyle:'solid'});
    const strokes=[[0,0,0.5,40,20,0.8,80,10,0.6,120,40,0.7,160,30,0.5]];
    RB.state.items.push({id:'ink-smoke',kind:'ink',x:780,y:520,w:180,h:60,bw:180,bh:60,rot:0,inkStyle:'pen',color:'#2fd28a',size:6,outline:true,strokes});
    RB.invalidateLayout();
    RB.fitAll();RB.invalidate();
    await new Promise(r=>setTimeout(r,500));
    return {crop:crop.id,rot:rot.id,flip:flip.id,gray:gray.id,large:large.id,alpha:alpha.id,note:note.id,xss:xss.id,group:gid};
  })()`);
  // Note boxes hug their text the way an edit leaves them.
  await cdp.run(`(()=>{const RB=window.RefBoard;RB.reconcileNotesForTest();RB.invalidateLayout();RB.fitAll();RB.invalidate();return true;})()`);

  /* ---------------- 1. the dialog ---------------- */
  await cdp.run(`(window.RefBoard.state.sel=new Set(),window.RefBoard.updateSelBarForTest(),true)`);
  await ctrlE();
  const dlg = () => cdp.run(`(()=>{const vis=s=>{const el=document.querySelector(s);return !!el&&!el.closest('[hidden]')&&getComputedStyle(el).display!=='none';};
    return {tab:[...document.querySelectorAll('#expTabs button.on')].map(b=>b.dataset.tab),
      formats:[...document.querySelectorAll('#expBoardFormat button')].map(b=>b.textContent.trim()),
      on:[...document.querySelectorAll('#expBoardFormat button.on')].map(b=>b.dataset.format),
      viewer:vis('#expViewerOpts'),png:vis('#expPngOpts'),pdf:vis('#expPdfOpts'),labels:vis('#expViewerLabelsRow'),
      vSize:document.querySelector('#expViewerSize .on')?.dataset.v,
      notes:document.querySelector('#expViewerNotes').checked,lab:document.querySelector('#expViewerLabels').checked,save:document.querySelector('#expViewerSave').checked,
      vEst:document.querySelector('#expViewerEst').textContent,vEstBytes:Number(document.querySelector('#expViewerEst').dataset.bytes||0),
      pEst:document.querySelector('#expPdfEst').textContent,pEstBytes:Number(document.querySelector('#expPdfEst').dataset.bytes||0),
      vFoot:document.querySelector('#expViewerFoot').textContent,pFoot:document.querySelector('#expPdfFoot').textContent,
      pBg:document.querySelector('#expPdfBg .on')?.dataset.v};})()`);
  let d = await dlg();
  assert.deepEqual(d.tab, ['board'], 'nothing selected: the Board tab');
  assert.deepEqual(d.formats, ['Viewer', 'PNG', 'PDF'], 'the format row reads Viewer · PNG · PDF');
  assert.deepEqual(d.on, ['viewer'], 'Viewer is the default');
  assert.deepEqual([d.viewer, d.png, d.pdf], [true, false, false], 'only the Viewer options show');
  assert.equal(d.vSize, '2048', 'Image size defaults to 2048 px');
  assert.deepEqual([d.notes, d.lab, d.save], [true, true, false], 'notes on, labels on, saving off');
  assert.equal(d.labels, true, 'the board has labels, so Include labels shows');
  assert.match(d.vFoot, /One \.html file · opens in any browser\s+≈ [\d.]+ (KB|MB)/);
  await delay(300);
  d = await dlg();
  const est2048 = d.vEstBytes;
  await shootApp('dialog-viewer.png');
  assert.equal(await click('#expViewerSize button[data-v="1024"]'), true);
  const est1024 = (await dlg()).vEstBytes;
  assert.equal(await click('#expViewerSize button[data-v="original"]'), true);
  const estOrig = (await dlg()).vEstBytes;
  assert.ok(est1024 < est2048 && est2048 < estOrig, `the estimate follows the image size: 1024 ${est1024} < 2048 ${est2048} < Original ${estOrig}`);
  assert.equal(await click('#expViewerSize button[data-v="2048"]'), true);
  assert.equal(await click('#expBoardFormat button[data-format="png"]'), true);
  d = await dlg();
  assert.deepEqual([d.viewer, d.png, d.pdf], [false, true, false], 'PNG shows the PNG options alone');
  await shootApp('dialog-png.png');
  assert.equal(await click('#expBoardFormat button[data-format="pdf"]'), true);
  d = await dlg();
  assert.deepEqual([d.viewer, d.png, d.pdf], [false, false, true], 'PDF shows the PDF options alone');
  assert.equal(d.pBg, 'board', 'the PDF background defaults to Board');
  assert.match(d.pFoot, /One page, shaped like the board\s+≈ [\d.]+ (KB|MB)/);
  await shootApp('dialog-pdf.png');
  assert.equal(await click('#expBoardFormat button[data-format="viewer"]'), true);
  await closeDialog();
  await ctrlE();
  assert.deepEqual((await dlg()).on, ['viewer'], 'the format is remembered while the app runs');
  await closeDialog();
  // No labels on the board: no Include labels.
  await cdp.run(`(()=>{window.__tags=window.RefBoard.state.items.map(i=>[i,i.tags]);for(const i of window.RefBoard.state.items)if(i.tags)i.tags=[];return true;})()`);
  await ctrlE();
  assert.equal((await dlg()).labels, false, 'a board without labels hides Include labels');
  await closeDialog();
  await cdp.run(`(()=>{for(const [i,t] of window.__tags)if(t)i.tags=t;return true;})()`);

  /* The board as a PNG, for side-by-side comparison with the Viewer and the PDF. */
  await cdp.run(`(()=>{window.__png=null;window.RefBoard.boardExportSinkForTest=async(blob)=>{
    const b=new Uint8Array(await blob.arrayBuffer());let s='';for(let i=0;i<b.length;i+=0x8000)s+=String.fromCharCode.apply(null,b.subarray(i,i+0x8000));window.__png=btoa(s);};return true;})()`);
  await ctrlE();
  await click('#expBoardFormat button[data-format="png"]');
  await click('#expScale button[data-v="1"]');
  await click('#expBg button[data-v="#141519"]');
  await click('#expGo');
  await waitFor(cdp, `!!window.__png`, 'the board PNG', 300);
  await writeFile(path.join(outDir, 'board.png'), Buffer.from(await cdp.run(`window.__png`), 'base64'));
  await ctrlE();
  await click('#expBoardFormat button[data-format="viewer"]');
  await closeDialog();

  /* ---------------- export helper ---------------- */
  async function exportBoard(kind, { size = '2048', notes = true, labels = true, save = false, bg = 'board' } = {}, fileName) {
    const target = fileName ? path.join(outDir, fileName) : null;
    await cdp.run(`(()=>{window.__prevExport=window.RefBoard.lastBoardExportForTest;
      window.RefBoard.boardExportSaveTargetForTest=async()=>${JSON.stringify(target)};return true;})()`);
    await ctrlE();
    assert.equal(await click(`#expBoardFormat button[data-format="${kind}"]`), true);
    const pre = kind === 'pdf' ? 'Pdf' : 'Viewer';
    assert.equal(await click(`#exp${pre}Size button[data-v="${size}"]`), true);
    const setCheck = async (id, want) => {
      if (await cdp.run(`document.querySelector('${id}').checked`) !== want) await click(id);
      assert.equal(await cdp.run(`document.querySelector('${id}').checked`), want);
    };
    await setCheck(`#exp${pre}Notes`, notes);
    if (kind === 'viewer') { await setCheck('#expViewerLabels', labels); await setCheck('#expViewerSave', save); }
    if (kind === 'pdf') assert.equal(await click(`#expPdfBg button[data-v="${bg}"]`), true);
    const estimate = Number(await cdp.run(`document.querySelector('#exp${pre}Est').dataset.bytes||0`));
    assert.equal(await click('#expGo'), true);
    await waitFor(cdp, `window.RefBoard.lastBoardExportForTest!==window.__prevExport&&!window.RefBoard.boardExportRunning`, `the ${kind} export`, 2400, 50);
    const result = await cdp.run(`window.RefBoard.lastBoardExportForTest`);
    return { ...result, target, dialogEstimate: estimate };
  }

  /* ---------------- 5. a cancelled save ---------------- */
  const before = (await readdir(outDir)).sort();
  await cdp.run(`(()=>{const t=document.querySelector('#toast');if(t)t.textContent='';return true;})()`);
  const cancelled = await exportBoard('viewer', {}, null);
  assert.equal(cancelled.canceled, true, 'a cancelled save dialog ends the export');
  assert.deepEqual((await readdir(outDir)).sort(), before, 'a cancelled save writes nothing');
  assert.doesNotMatch(await cdp.run(`document.querySelector('#toast')?.textContent||''`), /Export/, 'and says nothing');

  /* ---------------- 2. the Viewer ---------------- */
  const v2048 = await exportBoard('viewer', { size: '2048', save: true }, 'viewer-2048.html');
  assert.equal(v2048.saved, true, `the Viewer export saved: ${JSON.stringify(v2048)}`);
  assert.equal(v2048.filePath, v2048.target);
  assert.match(await cdp.run(`document.querySelector('#toast').textContent`), /^Exported viewer-2048\.html/, 'the toast names the file');
  const html2048 = await readFile(v2048.target, 'utf8');
  assert.ok(!existsSync(`${v2048.target}.exporting`) && (await readdir(outDir)).every(n => !n.includes('.exporting-')), 'no temp file is left beside it');
  const view2048 = readViewer(html2048);
  const boardState = await cdp.run(`(()=>{const RB=window.RefBoard;return RB.state.items.filter(i=>(i.kind||'image')==='image').map(i=>({id:i.id,x:i.x,y:i.y,w:i.w,h:i.h,rot:i.rot||0,name:RB.images.get(i.imgId)?.name}));})()`);

  viewerProfile = await mkdtemp(path.join(os.tmpdir(), 'refboard-viewer-host-'));
  async function openViewer(file, { width = 1280, height = 800 } = {}) {
    const dir = await mkdtemp(path.join(viewerProfile, 'w-'));
    const log = path.join(dir, 'requests.json');
    const child = launch(['scripts/smoke-board-viewer-host.cjs', `--open=${file}`, `--log=${log}`, `--width=${width}`, `--height=${height}`], dir);
    const port = await debuggerPort(child, dir);
    const v = await attach(port, url => url.startsWith('file:'));
    await v.send('Page.enable');
    await v.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    const dialogs = [];
    v.on('Page.javascriptDialogOpening', p => { dialogs.push(p.message); v.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {}); });
    const requests = [];
    v.on('Network.requestWillBeSent', p => requests.push(p.request.url));
    await v.send('Network.enable');
    await v.send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__alerts=0;window.alert=function(){window.__alerts++;};' });
    await v.send('Page.reload', { ignoreCache: true });
    await delay(300);
    await waitFor(v, `!!window.__refboardViewerReady`, 'the viewer runtime', 200);
    const ready = await v.run(`window.__refboardViewerReady`);
    return { v, child, log, ready, dialogs, requests, port };
  }
  async function closeViewer(h) {
    h.v.close();
    if (h.child.exitCode === null) h.child.kill();
    await Promise.race([once(h.child, 'exit'), delay(3000)]).catch(() => {});
  }
  const vmouse = (v, type, x, y, extra = {}) => v.send('Input.dispatchMouseEvent', {
    type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1, ...extra,
  });
  async function vshot(v, name) {
    if (!shotDir) return;
    await v.run(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))`);
    await delay(150);
    const shot = await v.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(path.join(shotDir, name), Buffer.from(shot.data, 'base64'));
  }

  let h = await openViewer(v2048.target);
  const v = h.v;
  assert.equal(h.ready.ok, true, `the viewer signals ready: ${JSON.stringify(h.ready)}`);
  assert.equal(h.ready.failed, 0, 'every embedded image decodes');
  const facts = await v.run(`(()=>{const q=s=>[...document.querySelectorAll(s)];return {
    imgs:q('.rb-img').length, imgEls:q('.rb-img > img').filter(i=>i.complete&&i.naturalWidth>0).length,
    blank:q('.rb-img > img').filter(i=>!i.src.startsWith('blob:')).length,
    title:document.querySelector('#rb-title')?.textContent, brand:document.querySelector('#rb-brand')?.textContent,
    zoom:q('#rb-zoom button').map(b=>b.textContent), docTitle:document.title,
    scripts:q('script').length, noteImgs:q('.rb-note img').length, bodyImgs:q('body img').length,
    groups:q('.rb-group').map(g=>({name:g.textContent,border:getComputedStyle(g).borderTopColor})),
    svgs:q('.rb-svg').length, svgPaths:q('.rb-svg path').length, save:!!document.querySelector('#rb-save'),
    bg:getComputedStyle(document.body).backgroundColor, labels:q('#rb-labels .rb-lab').map(b=>b.textContent)};})()`);
  assert.equal(facts.imgs, 6, 'six images on the board, six in the Viewer');
  assert.equal(facts.imgEls, 6, 'all six loaded');
  assert.equal(facts.blank, 0, 'images come from blobs decoded in the page');
  assert.equal(facts.title, 'Untitled board', 'the board name at the top left');
  assert.equal(facts.brand, 'Made with RefBoard');
  assert.deepEqual(facts.zoom.map(t => t.replace(/\d+%/, '%')), ['−', '%', '+', 'Fit'], 'zoom controls − / % / + / Fit');
  assert.equal(facts.scripts, view2048.blocks.length + 2, 'no script element beyond the images, payload and runtime');
  assert.equal(facts.noteImgs, 0, 'the onerror note made no <img>');
  assert.equal(facts.bodyImgs, 6, 'the only images are the board images');
  assert.deepEqual(facts.groups.map(g => g.name), ['Mood'], 'the group frame with its name');
  assert.ok(facts.svgs >= 2 && facts.svgPaths >= 3, 'the arrow and the ink are SVG');
  assert.equal(facts.save, true, 'saving allowed: a save button exists');
  assert.deepEqual(facts.labels, ['warm2', 'sky3'], 'labels listed with their counts');
  const ws = await cdp.run(`getComputedStyle(document.documentElement).getPropertyValue('--workspace').trim()`);
  assert.equal(view2048.payload.bg, ws, 'the Viewer background is the theme workspace colour');

  // Positions at a known zoom: every image where the board puts it.
  const S = 0.5, TX = 140, TY = 90;
  await v.run(`(window.__refboardViewer.setView(${S},${TX},${TY}),true)`);
  const rects = await v.run(`(()=>Object.fromEntries([...document.querySelectorAll('.rb-img')].map(n=>{const r=n.getBoundingClientRect();return [n.dataset.rbId,[r.left,r.top,r.width,r.height]];})))()`);
  for (const it of boardState) {
    const a = (it.rot * Math.PI) / 180;
    const bw = Math.abs(it.w * Math.cos(a)) + Math.abs(it.h * Math.sin(a));
    const bh = Math.abs(it.w * Math.sin(a)) + Math.abs(it.h * Math.cos(a));
    const cx = it.x + it.w / 2, cy = it.y + it.h / 2;
    const want = [(cx - bw / 2) * S + TX, (cy - bh / 2) * S + TY, bw * S, bh * S];
    const got = rects[it.id];
    assert.ok(got, `${it.name} is in the Viewer`);
    got.forEach((g, i) => assert.ok(Math.abs(g - want[i]) < 1.5, `${it.name} at ${want.map(n => n.toFixed(1))}, got ${got.map(n => n.toFixed(1))}`));
  }
  const flipT = await v.run(`getComputedStyle(document.querySelector('[data-rb-id="${ids.flip}"]')).transform`);
  assert.match(flipT, /^matrix\(-1, 0, 0, 1/, 'the flipped image is mirrored');
  const grayF = await v.run(`getComputedStyle(document.querySelector('[data-rb-id="${ids.gray}"]')).filter`);
  assert.equal(grayF, 'grayscale(1)', 'the grey image is grey');
  const cropImg = await v.run(`(()=>{const n=document.querySelector('[data-rb-id="${ids.crop}"]');const i=n.querySelector('img');return {ow:n.offsetWidth,iw:i.offsetWidth,left:i.offsetLeft,over:getComputedStyle(n).overflow};})()`);
  assert.equal(cropImg.over, 'hidden', 'the cropped image clips to its crop');
  // 2400 px wide, so at 2048 the crop (the middle 1200x800) is re-encoded with the crop baked in.
  const crop2048 = view2048.payload.items.find(i => i.id === ids.crop);
  assert.deepEqual(crop2048.crop, [0, 0, 1, 1], 'at 2048 the crop is baked into the pixels');
  const cropDims = imageSize(view2048.blocks[crop2048.img].bytes);
  assert.deepEqual([cropDims.w, cropDims.h], [1200, 800], 'only the cropped pixels are embedded, at full resolution (within 2048)');
  assert.ok(Math.abs(cropImg.iw - 300) < 1 && Math.abs(cropImg.left) < 1, `and fill the item (${JSON.stringify(cropImg)})`);

  // The note: real DOM text, a safe link, two checkboxes.
  const note = await v.run(`(()=>{const n=document.querySelector('[data-rb-id="${ids.note}"]');const a=n.querySelector('a');
    return {text:n.textContent,href:a?.getAttribute('href'),rel:a?.rel,target:a?.target,checks:n.querySelectorAll('svg.rb-check').length,
      checked:[...n.querySelectorAll('svg.rb-check')].map(s=>s.getAttribute('aria-label')),font:getComputedStyle(n.querySelector('.rb-note-text')).fontWeight,
      color:getComputedStyle(n.querySelector('.rb-note-text')).color,bg:getComputedStyle(n).backgroundColor};})()`);
  assert.match(note.text, /Pick the palette/);
  assert.match(note.text, /Ask about the brief/);
  assert.equal(note.href, 'https://example.com/brief', 'the link keeps its URL');
  assert.equal(note.rel, 'noopener noreferrer');
  assert.equal(note.target, '_blank');
  assert.deepEqual(note.checked, ['checked', 'unchecked'], 'both checkboxes, one ticked');
  assert.equal(note.font, '700', 'bold');
  assert.equal(note.color, 'rgb(21, 22, 28)');
  assert.match(note.bg, /^rgba?\(255, 209, 102/, 'the note colour');
  const xss = await v.run(`(()=>{const n=document.querySelector('[data-rb-id="${ids.xss}"]');return {text:n.textContent,links:n.querySelectorAll('a').length,kids:[...n.querySelectorAll('*')].map(e=>e.tagName.toLowerCase()).filter((t,i,a)=>a.indexOf(t)===i).sort()};})()`);
  assert.ok(xss.text.includes(XSS) && xss.text.includes(ONERR), 'the XSS note shows its text as text');
  assert.equal(xss.links, 0, 'a javascript: link is not a link');
  assert.deepEqual(xss.kids, ['div', 'span'], 'only the whitelisted elements');
  assert.equal(await v.run(`window.__alerts`), 0, 'nothing in the page called alert');
  assert.deepEqual(h.dialogs, [], 'no dialog opened');

  // Labels: "warm" keeps the cropped and the flipped image (and their group), dims the rest.
  await v.run(`(document.querySelector('#rb-labels .rb-lab[data-rb-tag="0"]').click(),true)`);
  const dim = await v.run(`(()=>Object.fromEntries([...document.querySelectorAll('[data-rb-id]')].map(n=>[n.dataset.rbId,n.classList.contains('rb-dim')])))()`);
  assert.equal(dim[ids.crop], false, 'warm: the cropped image stays');
  assert.equal(dim[ids.flip], false, 'warm: the flipped image stays');
  assert.equal(dim[ids.group], false, 'warm: the group holding a warm image stays');
  for (const k of ['rot', 'gray', 'large', 'alpha', 'note', 'xss']) assert.equal(dim[ids[k]], true, `warm: ${k} dims`);
  assert.equal(await v.run(`document.querySelectorAll('.rb-svg.rb-dim').length`), await v.run(`document.querySelectorAll('.rb-svg').length`), 'annotations dim too, as on the board');
  await v.run(`(window.__refboardViewer.fit(),true)`);
  await vshot(v, 'viewer-label-filter.png');
  await v.run(`(document.querySelector('#rb-labels .rb-lab[data-rb-tag="0"]').click(),true)`);
  assert.equal(await v.run(`document.querySelectorAll('.rb-dim').length`), 0, 'clicking again clears the filter');

  // Fit, zoom, double-click.
  await v.run(`(window.__refboardViewer.fit(),true)`);
  const fitted = await v.run(`window.__refboardViewer.view()`);
  await vshot(v, 'viewer-fitted.png');
  const B = view2048.payload.bounds;
  const vp = await v.run(`({w:innerWidth,h:innerHeight})`);
  // The runtime's fit margin: 48 px, or 6% of the shorter side once the window is
  // under 800 px, which happens when the screen is too small for 1280x800 (CI).
  const margin2 = 2 * Math.min(48, Math.min(vp.w, vp.h) * 0.06);
  const fitInfo = JSON.stringify({ vp, margin2, s: fitted.s, bw: B.w, bh: B.h });
  assert.ok(B.w * fitted.s <= vp.w + 0.5 && B.h * fitted.s <= vp.h + 0.5, `Fit shows the whole board (${fitInfo})`);
  assert.ok(Math.abs(B.w * fitted.s - (vp.w - margin2)) < 1 || Math.abs(B.h * fitted.s - (vp.h - margin2)) < 1, `and fills the window on one side (${fitInfo})`);
  await v.run(`(window.__refboardViewer.setView(3,-400,-300),true)`);
  const keyF = { key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70, nativeVirtualKeyCode: 70, text: 'f' };
  await v.send('Input.dispatchKeyEvent', { type: 'keyDown', ...keyF });
  await v.send('Input.dispatchKeyEvent', { type: 'keyUp', ...keyF });
  await delay(450);
  const afterF = await v.run(`window.__refboardViewer.view()`);
  assert.ok(Math.abs(afterF.s - fitted.s) < 1e-6 && Math.abs(afterF.tx - fitted.tx) < 0.01, 'F fits the board again');
  // Wheel zooms about the cursor: the board point under it stays put.
  const px = 500, py = 300;
  const under = { x: (px - afterF.tx) / afterF.s, y: (py - afterF.ty) / afterF.s };
  await vmouse(v, 'mouseMoved', px, py);
  await v.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: px, y: py, deltaX: 0, deltaY: -240 });
  await delay(120);
  const wheeled = await v.run(`window.__refboardViewer.view()`);
  assert.ok(wheeled.s > afterF.s * 1.2, 'the wheel zooms in');
  assert.ok(Math.abs((px - wheeled.tx) / wheeled.s - under.x) < 0.01 && Math.abs((py - wheeled.ty) / wheeled.s - under.y) < 0.01, 'about the cursor');
  await v.run(`(document.querySelector('#rb-zfit').click(),true)`);
  await delay(450);
  const z0 = (await v.run(`window.__refboardViewer.view()`)).s;
  await v.run(`(document.querySelector('#rb-zoom button').click(),true)`);   // −
  assert.ok(Math.abs((await v.run(`window.__refboardViewer.view()`)).s - z0 / 1.25) < 1e-6, '− zooms out');
  assert.equal(await v.run(`document.querySelector('#rb-zpct').textContent`), `${Math.round(z0 / 1.25 * 100)}%`, 'the % shows the zoom');
  // Drag pans.
  const p0 = await v.run(`window.__refboardViewer.view()`);
  const dx = vp.w / 2, dy = vp.h - 40;   // empty bottom-centre, clear of the zoom bar
  await vmouse(v, 'mouseMoved', dx, dy);
  await vmouse(v, 'mousePressed', dx, dy);
  await vmouse(v, 'mouseMoved', dx + 60, dy - 40, { buttons: 1 });
  await vmouse(v, 'mouseReleased', dx + 60, dy - 40);
  const p1 = await v.run(`window.__refboardViewer.view()`);
  assert.ok(Math.abs(p1.tx - p0.tx - 60) < 0.5 && Math.abs(p1.ty - p0.ty + 40) < 0.5, 'a drag pans the board');
  // Double-click an image zooms to it; again returns.
  await v.run(`(window.__refboardViewer.fit(),true)`);
  const home = await v.run(`window.__refboardViewer.view()`);
  const largeAt = await v.run(`(()=>{const r=document.querySelector('[data-rb-id="${ids.large}"]').getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2];})()`);
  await vmouse(v, 'mouseMoved', largeAt[0], largeAt[1]);
  // Hovering an image offers the save button.
  await delay(80);
  assert.equal(await v.run(`document.querySelector('#rb-save').classList.contains('show')`), true, 'hovering an image shows its save button');
  for (const clickCount of [1, 2]) {
    await vmouse(v, 'mousePressed', largeAt[0], largeAt[1], { clickCount });
    await vmouse(v, 'mouseReleased', largeAt[0], largeAt[1], { clickCount });
  }
  await delay(450);
  const zoomed = await v.run(`window.__refboardViewer.view()`);
  const largeRect = await v.run(`(()=>{const r=document.querySelector('[data-rb-id="${ids.large}"]').getBoundingClientRect();return [r.width,r.height];})()`);
  assert.ok(zoomed.s > home.s * 1.5, 'double-click zooms to the image');
  assert.ok(Math.abs(largeRect[0] - (vp.w - margin2)) < 2 || Math.abs(largeRect[1] - (vp.h - margin2)) < 2, `the image fills the window (${largeRect}, ${fitInfo})`);
  for (const clickCount of [1, 2]) {
    await vmouse(v, 'mousePressed', vp.w / 2, vp.h / 2, { clickCount });
    await vmouse(v, 'mouseReleased', vp.w / 2, vp.h / 2, { clickCount });
  }
  await delay(450);
  const back = await v.run(`window.__refboardViewer.view()`);
  assert.ok(Math.abs(back.s - home.s) < 1e-6 && Math.abs(back.tx - home.tx) < 0.01, 'double-click again goes back');
  // Zoomed on the note, for the screenshot.
  const noteBox = view2048.payload.items.find(i => i.id === ids.note);
  await v.run(`(()=>{const vw=innerWidth,vh=innerHeight;const s=Math.min((vw-80)/${noteBox.w},(vh-80)/${noteBox.h});
    window.__refboardViewer.setView(s,(vw-${noteBox.w}*s)/2-${noteBox.x}*s,(vh-${noteBox.h}*s)/2-${noteBox.y}*s);return true;})()`);
  await vshot(v, 'viewer-zoomed-note.png');
  // A text check while zoomed: no note line wider than its note.
  const spill = await v.run(`(()=>[...document.querySelectorAll('.rb-note')].map(n=>{const r=n.getBoundingClientRect();
    return [...n.querySelectorAll('.rb-lc')].some(l=>{const q=l.getBoundingClientRect();return q.width>0&&(q.right>r.right+1||q.left<r.left-1);});}))()`);
  assert.ok(spill.every(s => !s), 'no note line runs outside its note');

  // Zero network: only the file itself was requested.
  const logged = JSON.parse(await readFile(h.log, 'utf8'));
  const outside = logged.filter(r => !r.url.startsWith('blob:') && !r.url.startsWith('data:') && r.url !== h.v.url);
  assert.deepEqual(outside, [], 'the Viewer made no request beyond its own file');
  assert.deepEqual(h.requests.filter(u => !/^(blob|data):/.test(u) && u !== h.v.url), [], 'and CDP saw none either');
  await closeViewer(h);

  // Phone-sized, touch.
  h = await openViewer(v2048.target, { width: 390, height: 844 });
  await h.v.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await h.v.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await h.v.run(`(window.__refboardViewer.fit(),true)`);
  await delay(200);
  const phone0 = await h.v.run(`window.__refboardViewer.view()`);
  // Pinch out about the screen centre.
  const touch = (type, pts) => h.v.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p, i) => ({ x: p[0], y: p[1], id: i })) });
  await touch('touchStart', [[150, 420], [240, 420]]);
  await touch('touchMove', [[110, 420], [280, 420]]);
  await touch('touchMove', [[70, 420], [320, 420]]);
  await touch('touchEnd', []);
  await delay(100);
  const phone1 = await h.v.run(`window.__refboardViewer.view()`);
  assert.ok(phone1.s > phone0.s * 2, `a pinch zooms in (${phone0.s} -> ${phone1.s})`);
  await h.v.run(`(window.__refboardViewer.fit(),true)`);
  await delay(150);
  await vshot(h.v, 'viewer-phone.png');
  assert.equal(await h.v.run(`document.querySelector('#rb-labels').classList.contains('collapsed')`), true, 'on a phone the label panel starts collapsed');
  await closeViewer(h);

  /* ---------------- 3. image sizes ---------------- */
  const v1024 = await exportBoard('viewer', { size: '1024', save: false }, 'viewer-1024.html');
  assert.equal(v1024.saved, true);
  const view1024 = readViewer(await readFile(v1024.target, 'utf8'));
  assert.equal(view1024.blocks.length, view1024.payload.images.length);
  for (const b of view1024.blocks) {
    const size = imageSize(b.bytes);
    assert.ok(Math.max(size.w, size.h) <= 1024, `1024 px: embedded ${size.w}x${size.h}`);
    assert.equal(size.w, view1024.payload.images[b.index].w, 'the payload knows the embedded size');
  }
  const largeBlock = view1024.blocks.find(b => view1024.payload.images[b.index].name === 'large.jpg');
  assert.deepEqual(imageSize(largeBlock.bytes), { type: 'jpeg', w: 1024, h: 683 }, 'the 3000 px JPEG comes down to 1024 px, as JPEG');
  const alphaBlock = view1024.blocks.find(b => view1024.payload.images[b.index].name === 'alpha.png');
  assert.equal(alphaBlock.mime, 'image/png', 'a small image within the edge keeps its own bytes (never upscaled or re-encoded)');
  assert.equal(alphaBlock.bytes.toString('base64'), await cdp.run(`window.__src['alpha.png']`));
  h = await openViewer(v1024.target);
  assert.equal(await h.v.run(`!!document.querySelector('#rb-save')`), false, 'saving not allowed: no save button');
  await closeViewer(h);
  // The cropped image at 1024: the 1200x800 crop comes down to 1024x683.
  const v1024crop = view1024.payload.items.find(i => i.id === ids.crop);
  assert.deepEqual(v1024crop.crop, [0, 0, 1, 1], 'a re-encoded crop is baked in');
  const cropBlock = imageSize(view1024.blocks[v1024crop.img].bytes);
  assert.deepEqual([cropBlock.w, cropBlock.h], [1024, 683], 'the crop at 1024 px');

  const vOrig = await exportBoard('viewer', { size: 'original', save: true }, 'viewer-original.html');
  const viewOrig = readViewer(await readFile(vOrig.target, 'utf8'));
  const srcB64 = await cdp.run(`window.__src`);
  assert.equal(viewOrig.blocks.length, 6, 'Original: one embedded file per image');
  const origCrop = viewOrig.payload.items.find(i => i.id === ids.crop);
  for (const b of viewOrig.blocks) {
    if (b.index === origCrop.img) continue;
    const name = viewOrig.payload.images[b.index].name;
    assert.equal(b.bytes.toString('base64'), srcB64[name], `Original embeds ${name} byte for byte`);
  }
  // The cropped image: the crop baked in at full size, so the cut-away part is
  // not in the file. Its source is a PNG, so the crop stays lossless.
  assert.deepEqual(origCrop.crop, [0, 0, 1, 1], 'Original bakes the crop in');
  const origCropBlock = viewOrig.blocks.find(b => b.index === origCrop.img);
  assert.equal(origCropBlock.mime, 'image/png', 'a cropped PNG stays PNG at Original');
  assert.deepEqual(imageSize(origCropBlock.bytes), { type: 'png', w: 1200, h: 800 }, 'the crop at its full source size');
  const cropDiff = await cdp.run(`(async()=>{
    const bytes = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
    const read = bmp => { const c = new OffscreenCanvas(bmp.width, bmp.height); const g = c.getContext('2d'); g.drawImage(bmp, 0, 0); return g.getImageData(0, 0, bmp.width, bmp.height).data; };
    const src = read(await createImageBitmap(new Blob([bytes(window.__src['cropped.png'])], { type: 'image/png' }), 600, 400, 1200, 800));
    const out = read(await createImageBitmap(new Blob([bytes(${JSON.stringify(origCropBlock.bytes.toString('base64'))})], { type: 'image/png' })));
    if (src.length !== out.length) return -1;
    let diff = 0;
    for (let i = 0; i < src.length; i++) if (src[i] !== out[i]) diff++;
    return diff;
  })()`);
  assert.equal(cropDiff, 0, 'and its pixels are the source pixels exactly');

  // A board that would need re-encoding: the long edge is 2048 for the large JPEG.
  const big2048 = view2048.blocks.find(b => view2048.payload.images[b.index].name === 'large.jpg');
  assert.deepEqual(imageSize(big2048.bytes), { type: 'jpeg', w: 2048, h: 1365 });

  /* ---------------- 4. the PDF ---------------- */
  const appTargetsBefore = (await listTargets(appPort)).filter(t => t.type === 'page').length;
  const pdf = await exportBoard('pdf', { size: '2048' }, 'board.pdf');
  assert.equal(pdf.saved, true, `the PDF export saved: ${JSON.stringify(pdf)}`);
  assert.match(await cdp.run(`document.querySelector('#toast').textContent`), /^Exported board\.pdf/, 'the toast names the PDF');
  const pdfBuf = await readFile(pdf.target);
  const pf = pdfFacts(pdfBuf);
  assert.equal(pf.head, '%PDF-', 'the file is a PDF');
  assert.equal(pf.pages, 1, 'exactly one page');
  const want = pdfPageLayout(view2048.payload.bounds.w, view2048.payload.bounds.h);
  assert.equal(pf.boxes.length, 1, 'one MediaBox');
  const [, , mw, mh] = pf.boxes[0];
  assert.ok(Math.abs(mw - want.wPt) <= 1 && Math.abs(mh - want.hPt) <= 1, `MediaBox ${mw}x${mh} pt, expected ${want.wPt}x${want.hPt}`);
  assert.ok(pf.imagesXObjects >= 6, `image XObjects embedded (${pf.imagesXObjects})`);
  assert.equal(existsSync(pdf.tempHtml), false, 'the temp page is gone');
  assert.equal(existsSync(path.dirname(pdf.tempHtml)), false, 'and its temp folder');
  assert.equal(pdf.blockedRequests, 0, 'the PDF page asked for nothing outside itself');
  const appTargets = (await listTargets(appPort)).filter(t => t.type === 'page');
  assert.equal(appTargets.length, appTargetsBefore, 'the hidden PDF window is gone');
  assert.ok(!appTargets.some(t => /refboard-pdf-|board\.html/i.test(t.url || '')), 'no page of the PDF window remains');

  const pdfWhite = await exportBoard('pdf', { size: '1024', bg: 'white' }, 'board-white.pdf');
  assert.equal(pdfWhite.saved, true);
  assert.equal(pdfFacts(await readFile(pdfWhite.target)).pages, 1);

  // A board wider than 200 in: the page caps at 14,400 pt.
  await cdp.run(`(()=>{const RB=window.RefBoard;const src=RB.state.items.find(i=>i.id===${JSON.stringify(ids.alpha)});
    RB.state.items.push({...src,id:'far-away',x:40000,y:0,tags:[]});RB.invalidateLayout();RB.invalidate();return true;})()`);
  const wide = await exportBoard('pdf', { size: '1024' }, 'board-wide.pdf');
  const wf = pdfFacts(await readFile(wide.target));
  assert.equal(wf.pages, 1, 'the wide board is still one page');
  assert.ok(Math.abs(wf.boxes[0][2] - 14400) <= 1, `a board wider than 200 in gets a 14,400 pt page (${wf.boxes[0]})`);
  assert.ok(wf.boxes[0][3] < 14400 && wf.boxes[0][3] > 0, 'its height scales down with it');
  await cdp.run(`(()=>{const RB=window.RefBoard;RB.state.items=RB.state.items.filter(i=>i.id!=='far-away');RB.invalidateLayout();RB.invalidate();return true;})()`);

  // The PDF as Electron's PDF viewer shows it, for the record.
  if (shotDir) {
    for (const [file, png] of [[pdf.target, 'pdf-rendered.png'], [pdfWhite.target, 'pdf-white-rendered.png']]) {
      const dir = await mkdtemp(path.join(viewerProfile, 'p-'));
      const child = launch(['scripts/smoke-board-viewer-host.cjs', `--open=${file}`, '--pdf', `--capture=${path.join(shotDir, png)}`, '--delay=3500', '--width=1280', '--height=900'], dir);
      await Promise.race([once(child, 'exit'), delay(20000)]);
      if (child.exitCode === null) child.kill();
    }
  }

  const errors = await cdp.run(`window.__errors`);
  assert.deepEqual(errors, [], 'no renderer errors');
  console.log('board viewer Electron smoke passed — format row and options, estimate follows size, cancel writes nothing, '
    + 'Viewer: images placed at board coordinates, crop/rotate/flip/grey, note as DOM text with a safe link, arrow and ink SVG, '
    + 'label filter, save button only when allowed, zero network, Fit/F/wheel/drag/double-click/pinch, XSS inert; '
    + '1024 px long edges, Original bytes equal; PDF one page with the right MediaBox (14,400 pt cap), image XObjects, temp page and window gone');
} catch (err) {
  for (const c of children) if (c.stderrText.trim()) console.error(`--- electron stderr ---\n${c.stderrText.trim().slice(-4000)}`);
  throw err;
} finally {
  for (const c of children) if (c.exitCode === null) c.kill();
  await Promise.all(children.map(c => Promise.race([once(c, 'exit'), delay(3000)]).catch(() => {})));
  await removeProfileDir(profile);
  if (viewerProfile) await rm(viewerProfile, { recursive: true, force: true }).catch(() => {});
  if (!keepDir) await rm(outDir, { recursive: true, force: true }).catch(() => {});
}
