/**
 * Proves a zoom pause writes the camera record and leaves the board record
 * untouched.
 *
 * Runs the real app, puts an image on a new board so the board record exists,
 * notes its timestamp, zooms with a wheel event, waits past both debounces,
 * and reads both records back from the same IndexedDB the app uses.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeProfileDir } from './smoke-profile-cleanup.mjs';
import { evaluate } from './smoke-cdp.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const profile = await mkdtemp(path.join(os.tmpdir(), 'refboard-view-persist-'));
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

const smokeExpression = `(async()=>{
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  for(let attempt=0;attempt<300&&!(window.RefBoard&&window.RefBoard.startupComplete);attempt++)await wait(50);
  if(!(window.RefBoard&&window.RefBoard.startupComplete))throw new Error('RefBoard startup did not complete');
  document.querySelectorAll('.modal.show').forEach(el=>el.classList.remove('show'));
  document.querySelector('#rwNewBoard')?.click();
  for(let attempt=0;attempt<100&&!document.body.classList.contains('board-active');attempt++)await wait(50);
  if(!document.body.classList.contains('board-active'))throw new Error('New board did not open');
  await wait(200);
  document.querySelectorAll('.modal.show').forEach(el=>el.classList.remove('show'));

  const source=document.createElement('canvas');source.width=64;source.height=48;
  const g=source.getContext('2d');g.fillStyle='#6a8fd0';g.fillRect(0,0,64,48);
  const blob=await new Promise(resolve=>source.toBlob(resolve,'image/png'));
  await window.RefBoard.addImages([new File([blob],'view-smoke.png',{type:'image/png'})]);
  // Past the 400 ms board debounce and the 1.5 s view debounce, whichever ran.
  await wait(2500);

  const db=await new Promise((resolve,reject)=>{
    const rq=indexedDB.open('refboard',4);
    rq.onsuccess=()=>resolve(rq.result);
    rq.onerror=()=>reject(rq.error||new Error('indexedDB.open failed'));
  });
  const get=key=>new Promise((resolve,reject)=>{
    const r=db.transaction('meta','readonly').objectStore('meta').get(key);
    r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);
  });
  const boardKey='board:main', viewKey='board:main:view';
  const boardBefore=await get(boardKey);
  if(!boardBefore)throw new Error('board record was not written after adding an image');
  const viewBefore=await get(viewKey);
  const scaleBefore=window.RefBoard.state.view.s;

  const board=document.querySelector('#board');
  const rect=board.getBoundingClientRect();
  for(let i=0;i<4;i++){
    board.dispatchEvent(new WheelEvent('wheel',{clientX:rect.left+rect.width/2,clientY:rect.top+rect.height/2,deltaY:-120,bubbles:true,cancelable:true}));
    await wait(40);
  }
  const scaleAfter=window.RefBoard.state.view.s;
  await wait(2500);

  const boardAfter=await get(boardKey);
  const viewAfter=await get(viewKey);
  db.close();
  return {
    scaleBefore,scaleAfter,
    boardSavedAtBefore:boardBefore.savedAt,boardSavedAtAfter:boardAfter?.savedAt,
    boardItemsAfter:Array.isArray(boardAfter?.items)?boardAfter.items.length:null,
    viewBeforeAt:viewBefore?.savedAt??null,
    viewAfter:viewAfter?{s:viewAfter.view?.s,tx:viewAfter.view?.tx,ty:viewAfter.view?.ty,savedAt:viewAfter.savedAt}:null,
  };
})()`;

try {
  const port = await debuggerPort();
  const r = await evaluate(port, smokeExpression, { attempts: 1 });
  assert.ok(r.scaleAfter > r.scaleBefore, `wheel must zoom in (${r.scaleBefore} -> ${r.scaleAfter})`);
  assert.equal(r.boardSavedAtAfter, r.boardSavedAtBefore, 'a zoom pause must not rewrite the board record');
  assert.ok(r.viewAfter, 'a zoom pause must write the view record');
  assert.ok(Math.abs(r.viewAfter.s - r.scaleAfter) < 1e-9, `the view record carries the new zoom (${r.viewAfter.s} vs ${r.scaleAfter})`);
  assert.ok(r.viewAfter.savedAt > r.boardSavedAtBefore, 'the view record is newer than the board record, so restore will prefer it');
  console.log(`view persist smoke: board record untouched at ${r.boardSavedAtBefore}; view record ${r.viewAfter.savedAt} at zoom ${r.viewAfter.s.toFixed(3)}`);
  console.log('view persist Electron smoke passed');
} finally {
  if (child.exitCode === null) child.kill();
  await Promise.race([once(child, 'exit'), delay(3000)]).catch(() => {});
  await removeProfileDir(profile);
}
