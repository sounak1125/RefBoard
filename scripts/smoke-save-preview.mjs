/**
 * Proves a save writes its preview once, in the header, without decoding the
 * originals.
 *
 * Runs the real app: adds twelve 1200x900 images, drops their decoded full
 * bitmaps so only the 256px proxies are resident, saves silently to a temp
 * path, and checks that the file already carries a preview when the save
 * resolves, that nothing rewrites the file afterwards (no .bak appears and the
 * mtime holds), and that no full bitmap was decoded for the composite.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeProfileDir } from './smoke-profile-cleanup.mjs';
import { evaluate } from './smoke-cdp.mjs';

const require = createRequire(import.meta.url);
const { readBoardPreview, scanBoardFile } = require('./board-open-stream.js');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const profile = await mkdtemp(path.join(os.tmpdir(), 'refboard-save-preview-'));
const boardPath = path.join(profile, 'preview-smoke.refboard');
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
  const filePath=${JSON.stringify(boardPath)};
  for(let attempt=0;attempt<300&&!(window.RefBoard&&window.RefBoard.startupComplete);attempt++)await wait(50);
  if(!(window.RefBoard&&window.RefBoard.startupComplete))throw new Error('RefBoard startup did not complete');
  document.querySelectorAll('.modal.show').forEach(el=>el.classList.remove('show'));
  document.querySelector('#rwNewBoard')?.click();
  for(let attempt=0;attempt<100&&!document.body.classList.contains('board-active');attempt++)await wait(50);
  if(!document.body.classList.contains('board-active'))throw new Error('New board did not open');
  await wait(200);
  document.querySelectorAll('.modal.show').forEach(el=>el.classList.remove('show'));

  const files=[];
  for(let i=0;i<12;i++){
    const c=document.createElement('canvas');c.width=1200;c.height=900;
    const g=c.getContext('2d');
    g.fillStyle='rgb('+(30+i*15)+',90,'+(200-i*10)+')';g.fillRect(0,0,1200,900);
    g.fillStyle='#f4c66d';for(let y=0;y<900;y+=150)for(let x=0;x<1200;x+=150)g.fillRect(x,y,75,75);
    const blob=await new Promise(r=>c.toBlob(r,'image/png'));
    c.width=c.height=0;
    files.push(new File([blob],'preview-'+i+'.png',{type:'image/png'}));
  }
  await window.RefBoard.addImages(files);
  for(let attempt=0;attempt<100;attempt++){
    const ready=[...window.RefBoard.images.values()].filter(im=>im.proxy).length;
    if(ready>=12)break;
    await wait(50);
  }
  // Image intake decodes each original once. Drop those so the only resident
  // surfaces are the proxies; a save that needs originals will have to decode.
  for(const im of window.RefBoard.images.values()){try{im.bitmap?.close?.();}catch(e){}im.bitmap=null;}
  await wait(300);
  const before=(await window.RefBoard.memoryStats()).images;
  const t0=performance.now();
  const saved=await window.RefBoard.saveBoardFile({silent:true,filePath});
  const saveMs=performance.now()-t0;
  const after=(await window.RefBoard.memoryStats()).images;
  return {saved,saveMs,proxies:after.stableProxyCount,fullBefore:before.decodedFullCount,fullAfter:after.decodedFullCount};
})()`;

try {
  const port = await debuggerPort();
  const r = await evaluate(port, smokeExpression, { attempts: 1 });
  assert.equal(r.saved, true, 'the silent save must succeed');
  const preview = await readBoardPreview(boardPath);
  assert.ok(typeof preview === 'string' && preview.length > 1000, 'the file must carry a preview the moment the save resolves');
  const scanned = await scanBoardFile(boardPath);
  assert.equal(scanned.images.length, 12, 'all twelve images are embedded');
  const statAfterSave = await stat(boardPath);
  await delay(2500);
  const statLater = await stat(boardPath);
  assert.equal(statLater.mtimeMs, statAfterSave.mtimeMs, 'nothing rewrites the file after the save');
  assert.equal(existsSync(`${boardPath}.bak`), false, 'a first save leaves no .bak, so no second write happened');
  assert.equal(r.proxies, 12, `all twelve proxies are resident (${r.proxies})`);
  assert.equal(r.fullBefore, 0, 'the fixture starts with no full bitmaps resident');
  assert.equal(r.fullAfter, 0, `the composite must draw from proxies, not decode originals (${r.fullAfter} decoded)`);
  console.log(`save preview smoke: preview ${Math.round(preview.length * 3 / 4 / 1024)} KB in the header, save took ${r.saveMs.toFixed(0)} ms, 0 full decodes`);
  console.log('save preview Electron smoke passed');
} finally {
  if (child.exitCode === null) child.kill();
  await Promise.race([once(child, 'exit'), delay(3000)]).catch(() => {});
  await removeProfileDir(profile);
}
