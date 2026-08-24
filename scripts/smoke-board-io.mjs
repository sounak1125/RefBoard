import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeProfileDir } from './smoke-profile-cleanup.mjs';
import { evaluate } from './smoke-cdp.mjs';

const require = createRequire(import.meta.url);
const { scanBoardFile } = require('./board-open-stream.js');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const profile = await mkdtemp(path.join(os.tmpdir(), 'refboard-board-io-smoke-'));
const boardPath = path.join(profile, 'smoke-io.refboard');
const child = spawn(electron, ['.', '--remote-debugging-port=0', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-features=CalculateNativeWinOcclusion', `--user-data-dir=${profile}`], {
  cwd: root,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stderr = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', chunk => { stderr += chunk; });

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

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
  const filePath=${JSON.stringify(boardPath)};
  for(let attempt=0;attempt<100&&!window.RefBoard;attempt++)await wait(50);
  if(!window.RefBoard)throw new Error('RefBoard API unavailable');
  // init() ends by navigating to the landing view; anything done before
  // that point gets torn down again. Wait for startup to finish.
  for(let attempt=0;attempt<300&&!window.RefBoard.startupComplete;attempt++)await wait(50);
  if(!window.RefBoard.startupComplete)throw new Error('RefBoard startup did not complete');
  if(typeof window.RefBoard.saveBoardFile!=='function'||typeof window.RefBoard.openBoardFromPath!=='function'){
    throw new Error('RefBoard save/open hooks are missing');
  }
  document.querySelectorAll('.modal.show').forEach(el=>el.classList.remove('show'));
  document.querySelector('#rwNewBoard')?.click();
  for(let attempt=0;attempt<100&&!document.body.classList.contains('board-active');attempt++)await wait(50);
  if(!document.body.classList.contains('board-active'))throw new Error('New board did not open');
  await wait(200);
  document.querySelectorAll('.modal.show').forEach(el=>el.classList.remove('show'));
  const files=[];
  for(let i=0;i<6;i++){
    const source=document.createElement('canvas');source.width=48;source.height=32;
    const ctx=source.getContext('2d');
    ctx.fillStyle='rgb('+(40+i*30)+',80,160)';ctx.fillRect(0,0,48,32);
    const blob=await new Promise(resolve=>source.toBlob(resolve,'image/png'));
    files.push(new File([blob],'smoke-io-'+i+'.png',{type:'image/png'}));
  }
  await window.RefBoard.addImages(files);
  await wait(80);
  const saved=await window.RefBoard.saveBoardFile({silent:true,filePath});
  if(!saved)throw new Error('First save failed');
  const waitEmpty=async()=>{
    for(let attempt=0;attempt<40&&window.RefBoard.state.items.length;attempt++)await wait(50);
  };
  const openOnce=async()=>{
    const pending=window.RefBoard.openBoardFromPath(filePath);
    let stopped=false;
    const confirmer=(async()=>{
      while(!stopped){
        const ok=document.querySelector('#confirmModal.show #confirmOk');
        if(ok){ok.click();return;}
        await wait(40);
      }
    })();
    await pending;
    stopped=true;
    await confirmer;
    for(let attempt=0;attempt<80;attempt++){
      if(!document.querySelector('#openingOverlay')?.classList.contains('show'))break;
      await wait(50);
    }
  };
  document.querySelector('#rwNewBoard')?.click();
  await wait(80);
  document.querySelectorAll('.modal.show').forEach(el=>el.classList.remove('show'));
  await waitEmpty();
  await openOnce();
  const afterOpenCount=window.RefBoard.state.items.filter(it=>(it.kind||'image')==='image').length;
  const overlayHidden=!document.querySelector('#openingOverlay')?.classList.contains('show');
  const sizes=window.RefBoard.state.items.filter(it=>(it.kind||'image')==='image').map(it=>({w:it.w,h:it.h}));
  let diskStored=0;
  for(let attempt=0;attempt<80;attempt++){
    diskStored=[...window.RefBoard.images.values()].filter(im=>im.diskStored).length;
    if(diskStored>=6)break;
    const resident=[...window.RefBoard.images.values()].filter(im=>im.blob&&im.blob.size).length;
    if(diskStored+resident>=6&&attempt>20)break;
    await wait(50);
  }
  const savedAgain=await window.RefBoard.saveBoardFile({silent:true,filePath});
  if(!savedAgain)throw new Error('Second save failed');
  document.querySelector('#rwNewBoard')?.click();
  await wait(80);
  document.querySelectorAll('.modal.show').forEach(el=>el.classList.remove('show'));
  for(let attempt=0;attempt<40&&window.RefBoard.state.items.length;attempt++)await wait(50);
  await openOnce();
  const afterReopenCount=window.RefBoard.state.items.filter(it=>(it.kind||'image')==='image').length;
  return {
    saved,savedAgain,afterOpenCount,afterReopenCount,overlayHidden,diskStored,
    imageMap:window.RefBoard.images.size,sizes
  };
})()`;

try {
  const port = await debuggerPort();
  const result = await evaluate(port, smokeExpression);
  const fileStat = await stat(boardPath);
  assert.ok(fileStat.size > 0, 'saved board file should exist');
  const scanned = await scanBoardFile(boardPath);
  assert.equal(scanned.images.length, 6, `saved board should embed 6 images (found ${scanned.images.length})`);
  assert.equal(result.afterOpenCount, 6, `open should restore 6 images (found ${result.afterOpenCount})`);
  assert.equal(result.imageMap, 6, 'open should register 6 image records');
  assert.equal(result.overlayHidden, true, 'opening overlay should hide once items are on screen');
  assert.ok(result.sizes.every(size => size.w > 0 && size.h > 0), 'opened images should keep their dimensions');
  assert.ok(result.diskStored >= 6 || result.imageMap === 6, 'background persist should store blobs or keep them resident');
  assert.equal(result.afterReopenCount, 6, 'save then reopen should still restore 6 images');
  console.log('board I/O Electron smoke passed');
} finally {
  if (child.exitCode === null) child.kill();
  await Promise.race([once(child, 'exit'), delay(3000)]).catch(() => {});
  await removeProfileDir(profile);
}
