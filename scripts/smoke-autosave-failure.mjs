/**
 * Proves the session autosave tells the truth when IndexedDB refuses a write.
 *
 * Runs the real app, breaks the database underneath it (closing the connection
 * makes every subsequent transaction throw), triggers an autosave tick, and
 * asserts the user is warned instead of being told "Session autosaved".
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
const profile = await mkdtemp(path.join(os.tmpdir(), 'refboard-autosave-fail-'));
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

  // A board with content: runAutosaveTick returns early on an empty board.
  const source=document.createElement('canvas');source.width=32;source.height=32;
  source.getContext('2d').fillStyle='#48f';source.getContext('2d').fillRect(0,0,32,32);
  const blob=await new Promise(resolve=>source.toBlob(resolve,'image/png'));
  await window.RefBoard.addImages([new File([blob],'autosave-probe.png',{type:'image/png'})]);
  // Let the 400ms debounced scheduleSave land while the database still works,
  // so nothing it does can be mistaken for the tick's own reporting below.
  await wait(900);

  const toastEl=document.querySelector('#toast');
  const readToast=()=>({text:toastEl.textContent||'',shown:toastEl.classList.contains('show')});

  // Record every message the toast shows, not just its final state: a
  // regression that toasts "Session autosaved" and is then overwritten by an
  // unrelated warning would otherwise slip through.
  const seen=[];
  const record=()=>{const t=(toastEl.textContent||'').trim();if(t&&seen[seen.length-1]!==t)seen.push(t);};
  const observer=new MutationObserver(record);
  observer.observe(toastEl,{childList:true,characterData:true,subtree:true,attributes:true});

  // Healthy baseline: the tick should still be able to claim success.
  await window.RefBoard.runAutosaveTick();
  await wait(120);
  const healthy=readToast();

  // Break the store. A closed IDBDatabase throws InvalidStateError on every
  // subsequent transaction() call — a real failure, not a stubbed one.
  window.RefBoard.closeDbForTest();
  await wait(50);

  const seenBefore=seen.length;
  await window.RefBoard.runAutosaveTick();
  await wait(250);
  record();
  const broken=readToast();
  const duringBroken=seen.slice(seenBefore);

  // A sticky warning must survive well past the normal 2.4s dismiss window.
  await wait(2800);
  const afterDismissWindow=readToast();
  const hasAction=!!toastEl.querySelector('.toast-action');

  observer.disconnect();
  return {healthy,broken,afterDismissWindow,hasAction,duringBroken};
})()`;

try {
  const result = await evaluate(await debuggerPort(), smokeExpression);

  assert.match(result.healthy.text, /autosaved/i, `a working autosave should still report success (got "${result.healthy.text}")`);

  assert.ok(
    !result.duringBroken.some(text => /Session autosaved/.test(text)),
    `a failed autosave must never claim the session was saved (toasts seen: ${JSON.stringify(result.duringBroken)})`,
  );
  assert.doesNotMatch(
    result.broken.text,
    /Session autosaved/,
    'the toast must not be left claiming success',
  );
  assert.match(
    result.broken.text,
    /Autosave failed/,
    `a failed autosave must say so (got "${result.broken.text}")`,
  );
  assert.equal(result.broken.shown, true, 'the failure warning must be visible');

  assert.equal(
    result.afterDismissWindow.shown, true,
    'the failure warning must still be on screen after the normal toast timeout',
  );
  assert.match(
    result.afterDismissWindow.text,
    /Autosave failed/,
    'the sticky warning must not be replaced or cleared on a timer',
  );
  assert.equal(result.hasAction, true, 'the warning must offer the "Save board…" recovery action');

  console.log('autosave failure Electron smoke passed');
} finally {
  if (child.exitCode === null) child.kill();
  await Promise.race([once(child, 'exit'), delay(3000)]).catch(() => {});
  await removeProfileDir(profile);
}
