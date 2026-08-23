/**
 * Undo history must stay inside a memory budget, not just an entry count.
 *
 * Each undo entry is a full JSON snapshot of the board. With only a count limit
 * (default 200, settable to 1000), a large board retained hundreds of MB of
 * strings. This drives real undoable edits and asserts the byte budget trims
 * the stack, and that undo still works afterwards.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const profile = await mkdtemp(path.join(os.tmpdir(), 'refboard-undo-mem-'));
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
  for(let attempt=0;attempt<100&&!window.RefBoard;attempt++)await wait(50);
  if(!window.RefBoard)throw new Error('RefBoard API unavailable');
  document.querySelectorAll('.modal.show').forEach(el=>el.classList.remove('show'));
  document.querySelector('#rwNewBoard')?.click();
  for(let attempt=0;attempt<100&&!document.body.classList.contains('board-active');attempt++)await wait(50);
  if(!document.body.classList.contains('board-active'))throw new Error('New board did not open');
  await wait(200);
  document.querySelectorAll('.modal.show').forEach(el=>el.classList.remove('show'));

  const source=document.createElement('canvas');source.width=24;source.height=24;
  const g=source.getContext('2d');g.fillStyle='#5aa2ff';g.fillRect(0,0,24,24);
  const blob=await new Promise(resolve=>source.toBlob(resolve,'image/png'));
  const files=[];
  for(let i=0;i<12;i++)files.push(new File([blob],'undo-'+i+'.png',{type:'image/png'}));
  await window.RefBoard.addImages(files);
  await wait(300);

  // Real undoable edits: rotateSelection pushes an undo entry per call.
  window.RefBoard.selectAllForTest();
  const EDITS=60;
  const edit=window.RefBoard.rotateSelectionForTest;
  for(let i=0;i<EDITS;i++){edit(15);}
  await wait(120);
  const generous=window.RefBoard.undoStats();

  // Squeeze the budget to something a handful of snapshots already exceeds.
  // Trimming must kick in immediately and stay in force for later edits.
  const oneSnapshot=Math.max(1,Math.round(generous.bytes/Math.max(1,generous.entries)));
  window.RefBoard.setUndoByteBudgetForTest(oneSnapshot*4);
  const afterSqueeze=window.RefBoard.undoStats();
  for(let i=0;i<EDITS;i++){edit(15);}
  await wait(120);
  const afterMoreEdits=window.RefBoard.undoStats();

  // Undo must still function once the history has been trimmed.
  const before=JSON.stringify(window.RefBoard.state.items.map(it=>it.rot||0));
  window.RefBoard.undoForTest();
  await wait(80);
  const after=JSON.stringify(window.RefBoard.state.items.map(it=>it.rot||0));

  return {generous,afterSqueeze,afterMoreEdits,undoChangedBoard:before!==after,oneSnapshot};
})()`;

try {
  const r = await evaluate(await debuggerPort(), smokeExpression);

  assert.ok(r.generous.entries > 10, `the edits should have produced undo history (got ${r.generous.entries})`);
  assert.ok(r.generous.bytes > 0, 'undo history should report its retained bytes');
  assert.equal(r.generous.budget > r.generous.bytes, true, 'the default budget should comfortably hold a small board');

  assert.ok(
    r.afterSqueeze.entries < r.generous.entries,
    `shrinking the budget must trim the stack (${r.generous.entries} -> ${r.afterSqueeze.entries})`,
  );
  assert.ok(
    r.afterSqueeze.bytes <= r.afterSqueeze.budget || r.afterSqueeze.entries <= 3,
    `trimmed history must fit the budget (${r.afterSqueeze.bytes} > ${r.afterSqueeze.budget})`,
  );

  assert.ok(
    r.afterMoreEdits.bytes <= r.afterMoreEdits.budget || r.afterMoreEdits.entries <= 3,
    `the budget must hold across later edits (${r.afterMoreEdits.bytes} > ${r.afterMoreEdits.budget} at ${r.afterMoreEdits.entries} entries)`,
  );
  assert.ok(
    r.afterMoreEdits.entries <= Math.max(3, Math.ceil(r.afterMoreEdits.budget / r.oneSnapshot) + 1),
    `entry count must stay proportional to the budget (got ${r.afterMoreEdits.entries})`,
  );
  assert.ok(r.afterMoreEdits.entries >= 3, 'a few undo steps must always remain usable');

  assert.equal(r.undoChangedBoard, true, 'undo must still work after the history has been trimmed');

  console.log('undo memory budget Electron smoke passed');
} finally {
  if (child.exitCode === null) child.kill();
  await Promise.race([once(child, 'exit'), delay(3000)]).catch(() => {});
  await rm(profile, { recursive: true, force: true });
}
