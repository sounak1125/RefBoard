/**
 * Proves opening a second board window does not wipe the first window's
 * pixel-edit undo history.
 *
 * Crop, draw and content-aware fill keep their "before" bitmaps in the shared
 * IndexedDB `historyBlobs` store. Every window used to clear that store on
 * boot, so the moment a second window opened, undoing a pixel edit in the first
 * resolved to nothing. Runs the real app: seed a history record from window 1,
 * open window 2 through the bridge, wait for it to finish booting, and read the
 * record back.
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
const profile = await mkdtemp(path.join(os.tmpdir(), 'refboard-multi-window-history-'));
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
  const api=window.RefBoardAPI;
  if(!api||typeof api.openBoardInNewWindow!=='function')throw new Error('new-window bridge unavailable');

  // Same database and version the app opens, so this is the real store.
  const db=await new Promise((resolve,reject)=>{
    const rq=indexedDB.open('refboard',4);
    rq.onsuccess=()=>resolve(rq.result);
    rq.onerror=()=>reject(rq.error||new Error('indexedDB.open failed'));
  });
  const tx=store=>db.transaction(store,'readwrite').objectStore(store);
  const key='smoke-history-'+Date.now();
  await new Promise((resolve,reject)=>{
    const r=tx('historyBlobs').put(new Blob(['before-pixels'],{type:'image/png'}),key);
    r.onsuccess=resolve; r.onerror=()=>reject(r.error);
  });
  const readBack=()=>new Promise((resolve,reject)=>{
    const r=db.transaction('historyBlobs','readonly').objectStore('historyBlobs').get(key);
    r.onsuccess=()=>resolve(r.result instanceof Blob&&r.result.size>0);
    r.onerror=()=>reject(r.error);
  });
  const seeded=await readBack();

  const opened=await api.openBoardInNewWindow();
  let count=1;
  for(let attempt=0;attempt<100;attempt++){
    count=await api.getBoardWindowCount();
    if(count>=2)break;
    await wait(50);
  }
  // Window 2 clears the store during init(); give it time to get there and past it.
  await wait(3000);
  const survived=await readBack();
  db.close();
  return {seeded,opened:!!(opened&&opened.opened),count,survived};
})()`;

try {
  const port = await debuggerPort();
  const result = await evaluate(port, smokeExpression, { attempts: 1 });
  assert.equal(result.seeded, true, 'the history record must be written before the second window opens');
  assert.equal(result.opened, true, 'the bridge must open a second window');
  assert.equal(result.count, 2, `two board windows expected, saw ${result.count}`);
  assert.equal(result.survived, true, 'opening a second window must not clear historyBlobs');
  console.log('multi-window history Electron smoke passed');
} finally {
  if (child.exitCode === null) child.kill();
  await Promise.race([once(child, 'exit'), delay(3000)]).catch(() => {});
  await removeProfileDir(profile);
}
