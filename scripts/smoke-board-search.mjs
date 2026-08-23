/**
 * Board search (Ctrl+F): find notes, image names and groups, then fly to them.
 *
 * A reference board of a few hundred images previously had no way to locate
 * anything. This drives the real UI — keyboard open, typing, arrow stepping,
 * Enter to commit, Escape to cancel — and checks the view actually moves to the
 * chosen item and returns when the search is cancelled.
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
const profile = await mkdtemp(path.join(os.tmpdir(), 'refboard-search-'));
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
  document.querySelectorAll('.modal.show').forEach(el=>el.classList.remove('show'));
  document.querySelector('#rwNewBoard')?.click();
  for(let attempt=0;attempt<100&&!document.body.classList.contains('board-active');attempt++)await wait(50);
  if(!document.body.classList.contains('board-active'))throw new Error('New board did not open');
  await wait(250);
  document.querySelectorAll('.modal.show').forEach(el=>el.classList.remove('show'));

  // Images with distinct names, plus notes with distinct text, spread far apart
  // so a successful jump is unambiguous in the view transform.
  const c=document.createElement('canvas');c.width=c.height=48;
  const cg=c.getContext('2d');cg.fillStyle='#6ab';cg.fillRect(0,0,48,48);
  const blob=await new Promise(r=>c.toBlob(r,'image/png'));
  const files=[];
  for(const name of ['alpha-swatch.png','beta-texture.png','gamma-lighting.png'])
    files.push(new File([blob],name,{type:'image/png'}));
  await window.RefBoard.addImages(files);
  await wait(300);
  const items=window.RefBoard.state.items;
  items.push(window.RefBoard.makeNoteForTest({x:5000,y:4200,text:'colour palette for the finale'}));
  items.push(window.RefBoard.makeNoteForTest({x:-4000,y:-3000,text:'unrelated scratch note'}));
  window.RefBoard.reconcileNotesForTest();
  window.RefBoard.fitAll();
  await frame(); await wait(200);

  const modal=document.querySelector('#searchModal');
  const input=document.querySelector('#searchInput');
  const results=()=>[...document.querySelectorAll('.search-hit')];
  const key=(el,k)=>el.dispatchEvent(new KeyboardEvent('keydown',{key:k,bubbles:true,cancelable:true}));
  const type=async v=>{input.value=v;input.dispatchEvent(new Event('input',{bubbles:true}));await wait(60);};

  // --- open with the real Ctrl+F path ---
  document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'f',ctrlKey:true,bubbles:true,cancelable:true}));
  await wait(120);
  const openedByShortcut=modal.classList.contains('show');
  const focused=document.activeElement===input;

  const startView={...window.RefBoard.state.view};

  // --- text match against note bodies ---
  await type('palette');
  const noteHits=results().map(el=>el.textContent);

  // --- filename match ---
  await type('texture');
  const nameHits=results().map(el=>el.textContent);

  // --- stepping and committing ---
  await type('a');
  const manyHits=results().length;
  key(input,'ArrowDown');
  await wait(60);
  const secondActive=results().findIndex(el=>el.classList.contains('active'));

  await type('palette');
  key(input,'Enter');
  await wait(500);
  const closedOnEnter=!modal.classList.contains('show');
  const committedView={...window.RefBoard.state.view};
  const selectedAfterCommit=[...window.RefBoard.state.sel];
  const paletteNote=items.find(it=>String(it.text||'').includes('palette'));

  // The committed view must actually frame the chosen note.
  const cx=(paletteNote.x+paletteNote.w/2)*committedView.s+committedView.tx;
  const cy=(paletteNote.y+paletteNote.h/2)*committedView.s+committedView.ty;
  const canvasEl=document.querySelector('canvas');
  const onScreen=cx>0&&cy>0&&cx<canvasEl.clientWidth&&cy<canvasEl.clientHeight;

  // --- Escape restores the camera the search started from ---
  document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'f',ctrlKey:true,bubbles:true,cancelable:true}));
  await wait(120);
  const beforeCancel={...window.RefBoard.state.view};
  await type('unrelated');
  await wait(400);
  const movedWhilePreviewing=Math.abs(window.RefBoard.state.view.tx-beforeCancel.tx)>1
    ||Math.abs(window.RefBoard.state.view.ty-beforeCancel.ty)>1;
  key(input,'Escape');
  await wait(150);
  const closedOnEscape=!modal.classList.contains('show');
  const restored=Math.abs(window.RefBoard.state.view.tx-beforeCancel.tx)<1.5
    &&Math.abs(window.RefBoard.state.view.ty-beforeCancel.ty)<1.5;

  // --- typing in the box must not trigger board shortcuts ---
  document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'f',ctrlKey:true,bubbles:true,cancelable:true}));
  await wait(120);
  const viewBeforeTyping={...window.RefBoard.state.view};
  input.focus();
  input.dispatchEvent(new KeyboardEvent('keydown',{key:'p',bubbles:true,cancelable:true}));
  input.dispatchEvent(new KeyboardEvent('keydown',{key:'f',bubbles:true,cancelable:true}));
  await wait(150);
  const shortcutsSuppressed=Math.abs(window.RefBoard.state.view.s-viewBeforeTyping.s)<1e-6;
  key(input,'Escape');
  await wait(100);

  return {
    openedByShortcut,focused,noteHits,nameHits,manyHits,secondActive,
    closedOnEnter,selectedAfterCommit,paletteNoteId:paletteNote.id,onScreen,
    movedWhilePreviewing,closedOnEscape,restored,shortcutsSuppressed,
    startZoom:startView.s,committedZoom:committedView.s,
  };
})()`;

try {
  const r = await evaluate(await debuggerPort(), smokeExpression);

  assert.equal(r.openedByShortcut, true, 'Ctrl+F must open board search');
  assert.equal(r.focused, true, 'the search field must take focus on open');

  assert.equal(r.noteHits.length, 1, `"palette" should match one note (got ${JSON.stringify(r.noteHits)})`);
  assert.match(r.noteHits[0], /note/, 'a note match should be labelled as a note');
  assert.match(r.noteHits[0], /palette/, 'the matched note text should be shown');

  assert.equal(r.nameHits.length, 1, `"texture" should match one image name (got ${JSON.stringify(r.nameHits)})`);
  assert.match(r.nameHits[0], /image/, 'an image match should be labelled as an image');
  assert.match(r.nameHits[0], /beta-texture/, 'the matched file name should be shown');

  assert.ok(r.manyHits > 1, `a broad query should return several hits (got ${r.manyHits})`);
  assert.equal(r.secondActive, 1, 'ArrowDown must move the active hit to the second result');

  assert.equal(r.closedOnEnter, true, 'Enter must commit and close the search');
  assert.deepEqual(r.selectedAfterCommit, [r.paletteNoteId], 'committing must select the matched item');
  assert.equal(r.onScreen, true, 'the committed view must actually frame the matched item');
  assert.ok(r.committedZoom <= 1.6 + 1e-6, `zoom must be capped when framing one item (got ${r.committedZoom})`);

  assert.equal(r.movedWhilePreviewing, true, 'stepping through hits should preview them by moving the view');
  assert.equal(r.closedOnEscape, true, 'Escape must close the search');
  assert.equal(r.restored, true, 'Escape must restore the camera the search started from');

  assert.equal(r.shortcutsSuppressed, true, 'typing in the search box must not fire board shortcuts');

  console.log('board search Electron smoke passed');
} finally {
  if (child.exitCode === null) child.kill();
  await Promise.race([once(child, 'exit'), delay(3000)]).catch(() => {});
  await removeProfileDir(profile);
}
