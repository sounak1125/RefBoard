/**
 * Copy stays fast, and what lands on the clipboard is still usable.
 *
 * Copy used to render and PNG-encode the selection at up to 8192px before
 * saying a word: measured at 1453ms for one 4000x3000 photo and 1332ms for
 * twenty-four references. PNG encoding is the whole cost and it scales with
 * pixels, so the flattened image is now capped at CLIPBOARD_IMAGE_DIM, which
 * brings the same three cases to roughly 115ms, 100ms and 115ms.
 *
 * Three things have to hold together, and each would pass on its own while the
 * feature was broken: the copy is fast, the clipboard really holds an image
 * afterwards, and a paste back into the board rebuilds real items rather than
 * a flattened screenshot of them.
 *
 * This drives the real UI, so the window must be focused — navigator.clipboard
 * .write() throws NotAllowedError otherwise. Hence its own CDP connection and a
 * Page.bringToFront before each scenario, rather than the shared evaluate().
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeProfileDir } from './smoke-profile-cleanup.mjs';

/* Roughly three times the measured 97-180ms, because a CI box is slower than
   a desktop. This exists to catch a return to whole-second copies, not to
   police tens of milliseconds. */
const COPY_BUDGET_MS = 500;

/* Read the cap out of the source rather than keeping a second copy of it:
   a hardcoded duplicate silently stops testing anything the day it drifts. */
const indexHtml = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const capMatch = indexHtml.match(/const CLIPBOARD_IMAGE_DIM = (\d+);/);
if (!capMatch) throw new Error('CLIPBOARD_IMAGE_DIM not found in index.html');
const CLIPBOARD_IMAGE_DIM = Number(capMatch[1]);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const profile = await mkdtemp(path.join(os.tmpdir(), 'refboard-clip-'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const child = spawn(electron, ['.', '--remote-debugging-port=0', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', `--user-data-dir=${profile}`], {
  cwd: root, windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'],
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

async function connect(port) {
  let targets = [];
  for (let attempt = 0; attempt < 80; attempt++) {
    try { targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json()); } catch { /* retry */ }
    if (targets.some(t => t.type === 'page' && String(t.url).includes('index.html'))) break;
    await delay(150);
  }
  const target = targets.find(t => t.type === 'page' && String(t.url).includes('index.html'));
  if (!target) throw new Error(`RefBoard page target never appeared\n${stderr}`);
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { socket.onopen = res; socket.onerror = rej; });
  let id = 0;
  const pending = new Map();
  socket.onmessage = e => {
    const m = JSON.parse(e.data);
    const h = pending.get(m.id);
    if (!h) return;
    pending.delete(m.id);
    if (m.error) h.reject(new Error(m.error.message));
    else h.resolve(m.result);
  };
  socket.onclose = () => { for (const h of pending.values()) h.reject(new Error('CDP socket closed')); pending.clear(); };
  const send = (method, params = {}) => new Promise((res, rej) => {
    if (socket.readyState !== 1) { rej(new Error('CDP socket closed')); return; }
    const n = ++id;
    pending.set(n, { resolve: res, reject: rej });
    socket.send(JSON.stringify({ id: n, method, params }));
  });
  return { send, close: () => { try { socket.close(); } catch { /* already gone */ } } };
}

const SETUP = `(async()=>{
  const wait=ms=>new Promise(r=>setTimeout(r,ms));
  for(let i=0;i<300&&!(window.RefBoard&&window.RefBoard.startupComplete);i++)await wait(50);
  if(!window.RefBoard||!window.RefBoard.startupComplete)throw new Error('RefBoard startup did not complete');
  document.querySelectorAll('.modal.show').forEach(el=>el.classList.remove('show'));
  document.querySelector('#rwNewBoard').click();
  for(let i=0;i<100&&!document.body.classList.contains('board-active');i++)await wait(50);
  if(!document.body.classList.contains('board-active'))throw new Error('New board did not open');
  await wait(400);
  document.querySelectorAll('.modal.show').forEach(el=>el.classList.remove('show'));
  window.__h={
    // Detail plus deterministic noise: a flat fill compresses to nothing and
    // would make every encode look fast for the wrong reason.
    photo: async(w,h,mime,q)=>{
      const c=document.createElement('canvas');c.width=w;c.height=h;
      const g=c.getContext('2d',{willReadFrequently:true});
      const img=g.createImageData(w,h);
      let seed=42;const rnd=()=>{seed=(seed*1103515245+12345)&0x7fffffff;return seed%256;};
      for(let y=0;y<h;y++)for(let x=0;x<w;x++){const i=(y*w+x)*4;
        img.data[i]=(x*255/w+rnd()/6)&255;img.data[i+1]=(y*255/h+rnd()/6)&255;
        img.data[i+2]=(rnd()/4+120)&255;img.data[i+3]=255;}
      g.putImageData(img,0,0);
      return await new Promise(r=>c.toBlob(r,mime,q));
    },
    timeCopy: async()=>{
      const toastEl=document.querySelector('#toast');
      if(!document.hasFocus())return {ms:-3};
      toastEl.textContent=''; await wait(20);
      const t0=performance.now();
      document.querySelector('#sCopy').click();
      for(let i=0;i<900;i++){
        await wait(5);
        const t=toastEl.textContent||'';
        if(/^Copied/.test(t))return {ms:Math.round(performance.now()-t0)};
        if(/Clipboard blocked|Nothing selected/.test(t))return {ms:-2,toast:t};
      }
      return {ms:-1};
    },
    clipboardImage: async()=>{
      try{
        const items=await navigator.clipboard.read();
        for(const item of items){
          if(!item.types.includes('image/png'))continue;
          const bmp=await createImageBitmap(await item.getType('image/png'));
          const size={w:bmp.width,h:bmp.height};
          if(bmp.close)bmp.close();
          return size;
        }
      }catch(e){return {err:String(e.name||e)};}
      return null;
    },
  };
  return true;
})()`;

const scenarioExpr = defs => `(async()=>{
  const wait=ms=>new Promise(r=>setTimeout(r,ms));
  const RB=window.RefBoard, H=window.__h;
  RB.state.items.length=0;RB.state.sel=new Set();RB.updateSelBarForTest();RB.invalidate();await wait(80);
  const files=[];
  for(const d of ${JSON.stringify(defs)}){
    files.push(new File([await H.photo(d.w,d.h,d.mime,d.q)],d.name,{type:d.mime}));
  }
  const added=await RB.addImages(files);
  await wait(800);
  RB.state.sel=new Set(added.map(i=>i.id));
  RB.updateSelBarForTest();await wait(150);
  const runs=[];
  for(let i=0;i<3;i++){ runs.push((await H.timeCopy()).ms); await wait(900); }
  return {count:added.length,runs,onClipboard:await H.clipboardImage()};
})()`;

const ROUND_TRIP = `(async()=>{
  const wait=ms=>new Promise(r=>setTimeout(r,ms));
  const RB=window.RefBoard, H=window.__h;
  RB.state.items.length=0;RB.state.sel=new Set();RB.updateSelBarForTest();RB.invalidate();await wait(80);
  const blob=await H.photo(1200,900,'image/jpeg',0.9);
  const added=await RB.addImages([new File([blob],'round-trip.jpg',{type:'image/jpeg'})]);
  const src=added[0];
  await wait(500);
  RB.state.sel=new Set([src.id]);
  RB.updateSelBarForTest();await wait(120);
  const copy=await H.timeCopy();
  await wait(400);
  const before=RB.state.items.length;
  const t0=performance.now();
  document.querySelector('#btnPaste').click();
  for(let i=0;i<600&&RB.state.items.length===before;i++)await wait(5);
  const pasteMs=Math.round(performance.now()-t0);
  const pasted=RB.state.items[RB.state.items.length-1];
  return {
    copyMs:copy.ms, pasteMs,
    added:RB.state.items.length-before,
    isImage:pasted?pasted.kind!=='note'&&!!pasted.imgId:false,
    sameSource:pasted?pasted.imgId===src.imgId:false,
    w:pasted?Math.round(pasted.w):0, srcW:Math.round(src.w),
  };
})()`;

const SCENARIOS = [
  ['one 4000x3000 JPEG', [{ w: 4000, h: 3000, mime: 'image/jpeg', q: 0.9, name: 'big.jpg' }]],
  ['eight 1600x1200 JPEGs', Array.from({ length: 8 }, (_, i) => ({ w: 1600, h: 1200, mime: 'image/jpeg', q: 0.9, name: `m${i}.jpg` }))],
  ['twenty-four 900x700 JPEGs', Array.from({ length: 24 }, (_, i) => ({ w: 900, h: 700, mime: 'image/jpeg', q: 0.9, name: `s${i}.jpg` }))],
];

let session = null;
try {
  session = await connect(await debuggerPort());
  const { send } = session;
  await send('Page.enable');
  await send('Runtime.enable');
  try { await send('Emulation.setFocusEmulationEnabled', { enabled: true }); }
  catch { /* older Chromium: fall back to bringToFront alone */ }

  const evalIn = async expression => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  /* navigator.clipboard.write() throws NotAllowedError unless the document is
     focused, and on Windows a single bringToFront loses the race against
     whatever else is on screen. Emulation.setFocusEmulationEnabled makes the
     renderer report itself focused regardless; bringToFront is still tried
     first so a visible run behaves like a real one. */
  const focus = async () => {
    for (let attempt = 0; attempt < 12; attempt++) {
      try { await send('Page.bringToFront'); } catch { /* keep trying */ }
      await delay(250);
      const probe = await send('Runtime.evaluate', { expression: 'document.hasFocus()', returnByValue: true });
      if (probe.result?.value === true) return;
    }
    throw new Error('the RefBoard window never took focus, so the clipboard could not be written');
  };

  await focus();
  await evalIn(SETUP);

  for (const [label, defs] of SCENARIOS) {
    await focus();
    const r = await evalIn(scenarioExpr(defs));

    assert.ok(
      !r.runs.includes(-3),
      `${label}: the window lost focus, so navigator.clipboard.write could not run — rerun with the window visible`,
    );
    assert.ok(!r.runs.includes(-2), `${label}: the clipboard refused the write`);
    assert.ok(!r.runs.includes(-1), `${label}: copy never reported completion`);

    const worst = Math.max(...r.runs);
    assert.ok(
      worst <= COPY_BUDGET_MS,
      `${label}: slowest copy took ${worst}ms, over the ${COPY_BUDGET_MS}ms budget `
      + `(runs: ${r.runs.join(', ')}) — a full-size render is back on the critical path`,
    );

    // Fast is worthless if nothing reaches the clipboard.
    assert.ok(r.onClipboard && !r.onClipboard.err, `${label}: no image on the clipboard (${JSON.stringify(r.onClipboard)})`);
    assert.ok(
      r.onClipboard.w > 0 && r.onClipboard.h > 0,
      `${label}: the clipboard image is empty (${r.onClipboard.w}x${r.onClipboard.h})`,
    );
    // The cap is what keeps it fast, so it has to actually apply.
    assert.ok(
      Math.max(r.onClipboard.w, r.onClipboard.h) <= CLIPBOARD_IMAGE_DIM,
      `${label}: the clipboard image is ${r.onClipboard.w}x${r.onClipboard.h}, above the ${CLIPBOARD_IMAGE_DIM}px cap`,
    );

    console.log(
      `  ${label.padEnd(28)} (${String(r.count).padStart(2)} img) `
      + `${r.runs.map(x => `${x}ms`).join(', ').padEnd(22)} clipboard ${r.onClipboard.w}x${r.onClipboard.h}`,
    );
  }

  await focus();
  const rt = await evalIn(ROUND_TRIP);
  assert.ok(rt.copyMs >= 0, 'the round-trip copy did not complete');
  assert.equal(rt.added, 1, `paste added ${rt.added} items, expected 1`);
  assert.equal(rt.isImage, true, 'paste must produce a real image item');
  assert.equal(rt.sameSource, true, 'a same-board paste must reuse the source image, not re-import a render');
  assert.equal(rt.w, rt.srcW, 'the pasted image must match the original size');
  assert.ok(
    rt.pasteMs <= COPY_BUDGET_MS,
    `paste took ${rt.pasteMs}ms, over the ${COPY_BUDGET_MS}ms budget`,
  );
  console.log(`  round trip                            copy ${rt.copyMs}ms -> paste ${rt.pasteMs}ms, reused the source image at ${rt.w}px`);

  console.log('clipboard latency Electron smoke passed — copies stay fast and paste still rebuilds real items');
} finally {
  session?.close();
  if (child.exitCode === null) child.kill();
  await Promise.race([once(child, 'exit'), delay(3000)]).catch(() => {});
  await removeProfileDir(profile);
}
