/**
 * Note text layout must not be recomputed on every frame.
 *
 * draw() runs layoutNoteLines for every visible note, and that function calls
 * measureText once per line. Uncached, a board with many notes re-measured
 * every line of every note at 60fps. This counts real measureText calls across
 * real frames and asserts the per-frame cost stops scaling with note count.
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
const profile = await mkdtemp(path.join(os.tmpdir(), 'refboard-note-cache-'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const NOTES = 40;
const FRAMES = 30;

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

  // Multi-line notes, spread out, so many are visible at a fitted zoom.
  const text=['Reference note line one','second line of the note','third line here','- a bullet item','1. a numbered item'].join('\\n');
  const items=window.RefBoard.state.items;
  for(let i=0;i<${NOTES};i++){
    items.push(window.RefBoard.makeNoteForTest({
      x:(i%8)*340, y:Math.floor(i/8)*260, text,
    }));
  }
  window.RefBoard.reconcileNotesForTest();
  window.RefBoard.fitAll();
  await frame();
  await wait(300);

  // Count real measureText calls made during real frames.
  const proto=CanvasRenderingContext2D.prototype;
  const original=proto.measureText;
  let calls=0;
  proto.measureText=function(...args){calls++;return original.apply(this,args);};
  try{
    // Warm one frame so first-time cache fills are not counted as steady state.
    window.RefBoard.invalidate();
    await frame();
    const warm=calls;
    calls=0;
    for(let i=0;i<${FRAMES};i++){
      window.RefBoard.invalidate();
      await frame();
    }
    const steady=calls;

    // Draw cost measured directly. Frame-to-frame timing would only report the
    // vsync interval, which says nothing about how much work draw() does.
    const bench=window.RefBoard.benchDrawForTest;
    bench(5);
    const cachedMs=bench(40);
    window.RefBoard.setNoteCacheDefeatForTest(true);
    bench(5);
    const uncachedMs=bench(40);
    window.RefBoard.setNoteCacheDefeatForTest(false);

    // The same frames again with the cache defeated. Those timings above are
    // too noisy to assert on, so the cache is proven by what it removes: the
    // measureText calls every note otherwise makes on every frame.
    window.RefBoard.setNoteCacheDefeatForTest(true);
    window.RefBoard.invalidate();
    await frame();
    calls=0;
    for(let i=0;i<${FRAMES};i++){
      window.RefBoard.invalidate();
      await frame();
    }
    const defeated=calls;
    window.RefBoard.setNoteCacheDefeatForTest(false);

    // A text edit must invalidate the cache, or the cache would be wrong.
    calls=0;
    items[0].text='changed text that must re-measure\\nsecond line';
    window.RefBoard.invalidate();
    await frame();
    const afterEdit=calls;
    return {
      warm, steady, defeated, afterEdit, cachedMs, uncachedMs,
      frames:${FRAMES},
      visibleNotes:items.filter(it=>it.kind==='note').length,
    };
  } finally {
    proto.measureText=original;
  }
})()`;

try {
  const r = await evaluate(await debuggerPort(), smokeExpression);

  assert.equal(r.visibleNotes, NOTES, `the board should hold ${NOTES} notes (got ${r.visibleNotes})`);

  const perFrame = r.steady / r.frames;
  const defeatedPerFrame = r.defeated / r.frames;
  console.log(`  notes=${r.visibleNotes}  warm-frame=${r.warm}  steady=${r.steady} over ${r.frames} frames (${perFrame.toFixed(1)}/frame)  after-edit=${r.afterEdit}`);
  console.log(`  measureText/frame: ${perFrame.toFixed(1)} cached vs ${defeatedPerFrame.toFixed(1)} uncached`);
  const speedup = r.uncachedMs / Math.max(1e-6, r.cachedMs);
  console.log(`  draw(): ${r.cachedMs.toFixed(3)} ms cached vs ${r.uncachedMs.toFixed(3)} ms uncached (${speedup.toFixed(1)}x)`);

  // Uncached this was at least one measureText per line per note per frame:
  // 40 notes x 5 lines = 200+, every frame. Cached it should be far below the
  // note count. Allow generous headroom for non-note text the frame measures.
  assert.ok(
    perFrame < NOTES,
    `layout must not re-measure every note each frame (${perFrame.toFixed(1)} calls/frame with ${NOTES} notes)`,
  );

  assert.ok(
    r.afterEdit > 0,
    'editing note text must invalidate the cache and re-measure, or the cache would go stale',
  );

  // The mirror of the assertion above, and the reason the draw() milliseconds
  // are printed but not asserted on: run-to-run timing noise on this board is
  // larger than the cache saves, while the call count is exact. Every note
  // costs at least one measureText per frame once the cache is defeated (the
  // vertical-metrics probe), so anything below one per note means the cached
  // run was not the cache doing the work.
  assert.ok(
    defeatedPerFrame >= NOTES,
    `defeating the cache must cost at least one measureText per note per frame (${defeatedPerFrame.toFixed(1)} calls/frame with ${NOTES} notes)`,
  );

  console.log('note layout cache Electron smoke passed');
} finally {
  if (child.exitCode === null) child.kill();
  await Promise.race([once(child, 'exit'), delay(3000)]).catch(() => {});
  await removeProfileDir(profile);
}
