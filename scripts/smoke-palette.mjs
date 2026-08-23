/**
 * Palette extraction: pull the dominant colours out of a reference image.
 *
 * Feeds an image built from known colour blocks and checks the swatches the
 * median-cut produces actually match those colours, that they land on the board
 * as usable items, and that the hex label stays legible against each swatch.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeProfileDir } from './smoke-profile-cleanup.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const profile = await mkdtemp(path.join(os.tmpdir(), 'refboard-palette-'));
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

async function evaluate(port, expression) {
  let targets = [];
  for (let attempt = 0; attempt < 50; attempt++) {
    try { targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json()); } catch { /* retry */ }
    if (targets.some(entry => entry.type === 'page')) break;
    await delay(100);
  }
  const target = targets.find(entry => entry.type === 'page' && /RefBoard|index\.html/i.test(`${entry.title} ${entry.url}`))
    || targets.find(entry => entry.type === 'page');
  if (!target) throw new Error('RefBoard page target was not available');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let nextId = 0;
  const pending = new Map();
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const handlers = pending.get(message.id); pending.delete(message.id);
    if (message.error) handlers.reject(new Error(message.error.message)); else handlers.resolve(message.result);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
  });
  await send('Runtime.enable');
  const response = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  socket.close();
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  return response.result.value;
}

const smokeExpression = `(async()=>{
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const frame=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
  for(let attempt=0;attempt<200&&!window.RefBoard;attempt++)await wait(50);
  if(!window.RefBoard)throw new Error('RefBoard API unavailable');
  // init() ends by navigating to the landing view; anything done before
  // that point gets torn down again. Wait for startup to finish.
  for(let attempt=0;attempt<300&&!window.RefBoard.startupComplete;attempt++)await wait(50);
  if(!window.RefBoard.startupComplete)throw new Error('RefBoard startup did not complete');
  document.querySelectorAll('.modal.show').forEach(el=>el.classList.remove('show'));
  document.querySelector('#rwNewBoard')?.click();
  for(let attempt=0;attempt<100&&!document.body.classList.contains('board-active');attempt++)await wait(50);
  if(!document.body.classList.contains('board-active'))throw new Error('New board did not open');
  await wait(250);
  document.querySelectorAll('.modal.show').forEach(el=>el.classList.remove('show'));

  // Four equal blocks of known, well-separated colours.
  const want=[[220,30,40],[30,180,70],[40,70,220],[240,235,225]];
  const c=document.createElement('canvas');c.width=240;c.height=240;
  const g=c.getContext('2d');
  want.forEach((rgb,i)=>{
    g.fillStyle='rgb('+rgb.join(',')+')';
    g.fillRect((i%2)*120,Math.floor(i/2)*120,120,120);
  });
  const blob=await new Promise(r=>c.toBlob(r,'image/png'));
  const added=await window.RefBoard.addImages([new File([blob],'palette-source.png',{type:'image/png'})]);
  await wait(500);
  const image=added[0];

  const before=window.RefBoard.state.items.length;
  await window.RefBoard.extractPaletteForTest(image,4);
  await wait(300); await frame();

  const items=window.RefBoard.state.items;
  const swatches=items.filter(it=>it.kind==='note'&&/^#[0-9a-f]{6}$/i.test(String(it.text||'')));
  const hexes=swatches.map(s=>s.text.toLowerCase());
  const colors=swatches.map(s=>String(s.color||'').toLowerCase());
  const inks=swatches.map(s=>String(s.textColor||'').toLowerCase());
  const belowImage=swatches.every(s=>s.y>image.y+image.h-1);
  const selected=[...window.RefBoard.state.sel].length;

  // Undo must remove the whole palette in one step.
  window.RefBoard.undoForTest();
  await wait(200);
  const afterUndo=window.RefBoard.state.items.length;

  return {want,hexes,colors,inks,belowImage,selected,
          addedCount:items.length-before,before,afterUndo};
})()`;

const hexToRgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

try {
  const r = await evaluate(await debuggerPort(), smokeExpression);

  assert.equal(r.addedCount, 4, `four swatches should be added (got ${r.addedCount})`);
  assert.equal(r.hexes.length, 4, `four hex-labelled notes should exist (got ${JSON.stringify(r.hexes)})`);

  // The swatch fill must match its own label, or the board lies about the colour.
  assert.deepEqual(r.colors, r.hexes, 'each swatch fill must match the hex it displays');

  // Every source colour must be represented by a reasonably close swatch.
  for (const target of r.want) {
    const best = Math.min(...r.hexes.map(h => dist(hexToRgb(h), target)));
    assert.ok(
      best < 40,
      `no swatch matched rgb(${target}) closely enough (nearest distance ${best.toFixed(1)}, got ${JSON.stringify(r.hexes)})`,
    );
  }

  // Legibility: the label ink must contrast with its swatch.
  r.hexes.forEach((hex, i) => {
    const [rr, gg, bb] = hexToRgb(hex);
    const lin = v => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    const L = 0.2126 * lin(rr) + 0.7152 * lin(gg) + 0.0722 * lin(bb);
    const expectDark = L > 0.36;
    assert.equal(
      r.inks[i] === '#101217', expectDark,
      `swatch ${hex} (luminance ${L.toFixed(3)}) should use ${expectDark ? 'dark' : 'light'} ink, got ${r.inks[i]}`,
    );
  });

  assert.equal(r.belowImage, true, 'swatches should be placed below the source image, not on top of it');
  assert.equal(r.selected, 4, 'the new swatches should be left selected');
  assert.equal(r.afterUndo, r.before, 'one undo must remove the whole palette');

  console.log('palette extraction Electron smoke passed');
} finally {
  if (child.exitCode === null) child.kill();
  await Promise.race([once(child, 'exit'), delay(3000)]).catch(() => {});
  await removeProfileDir(profile);
}
