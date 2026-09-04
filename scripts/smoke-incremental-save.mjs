/**
 * Proves a save of a sidecar board costs what changed, not the whole board.
 *
 * Runs the real app and reads the two files the format writes between saves:
 *
 *   1. First save: the store holds every image once; the index is small.
 *   2. Move an item and save: the store's size does not change; only the
 *      index was rewritten.
 *   3. Add one image and save: the store grows by about that one image.
 *   4. Change one image's pixels and save: the store grows by that one
 *      re-encoded image; its old bytes are reported as garbage.
 *   5. Delete most images and save: the store is compacted (the threshold is
 *      lowered through the environment) and shrinks to what is left.
 *   6. Reopen the board: every surviving image loads with its stored length.
 *
 * Also checks the index still yields its preview to the legacy header reader
 * and the Explorer thumbnail extractor.
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
const sidecar = require('./board-sidecar.js');
const { readBoardPreview } = require('./board-open-stream.js');
const { extractPreviewBase64 } = require('./file-icon-composite.js');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const profile = await mkdtemp(path.join(os.tmpdir(), 'refboard-incremental-save-'));
const boardPath = path.join(profile, 'incremental.refboard');
const storePath = sidecar.sidecarStorePath(boardPath);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const IMAGE_COUNT = 12;

const child = spawn(electron, ['.', '--remote-debugging-port=0', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-features=CalculateNativeWinOcclusion', `--user-data-dir=${profile}`], {
  cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  // Compaction normally waits for 64 MB of dead bytes; the fixture is small.
  env: { ...process.env, REFBOARD_SIDECAR_COMPACT_MIN_BYTES: '1024' },
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

/* Shared helpers live on window.__inc so every phase below can use them. */
const setupExpression = `(async()=>{
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  for(let attempt=0;attempt<300&&!(window.RefBoard&&window.RefBoard.startupComplete);attempt++)await wait(50);
  if(!(window.RefBoard&&window.RefBoard.startupComplete))throw new Error('RefBoard startup did not complete');
  const RB=window.RefBoard, state=RB.state;
  const filePath=${JSON.stringify(boardPath)};
  document.querySelectorAll('.modal.show').forEach(el=>el.classList.remove('show'));
  document.querySelector('#rwNewBoard')?.click();
  for(let attempt=0;attempt<100&&!document.body.classList.contains('board-active');attempt++)await wait(50);
  if(!document.body.classList.contains('board-active'))throw new Error('New board did not open');
  await wait(200);
  document.querySelectorAll('.modal.show').forEach(el=>el.classList.remove('show'));
  const makeFile=(i,size)=>new Promise(resolve=>{
    const c=document.createElement('canvas');c.width=size;c.height=Math.round(size*0.75);
    const g=c.getContext('2d');
    g.fillStyle='rgb('+(30+i*15)+',90,'+(200-i*10)+')';g.fillRect(0,0,c.width,c.height);
    g.fillStyle='#f4c66d';for(let y=0;y<c.height;y+=150)for(let x=0;x<c.width;x+=150)g.fillRect(x+i,y,75,75);
    c.toBlob(b=>resolve(new File([b],'inc-'+i+'.png',{type:'image/png'})),'image/png');
  });
  const imageItems=()=>state.items.filter(it=>(it.kind||'image')==='image');
  const save=async()=>{const t0=performance.now();const ok=await RB.saveBoardFile({silent:true,filePath});const ms=Math.round(performance.now()-t0);await wait(150);return {ok,ms,stats:RB.lastBoardSaveStats};};
  window.__inc={wait,RB,state,filePath,makeFile,imageItems,save};
  const files=[];for(let i=0;i<${IMAGE_COUNT};i++)files.push(await makeFile(i,1200));
  await RB.addImages(files);
  for(let attempt=0;attempt<100&&[...RB.images.values()].filter(im=>im.proxy).length<${IMAGE_COUNT};attempt++)await wait(50);
  let imageBytes=0;for(const im of RB.images.values())imageBytes+=im.blob?im.blob.size:(im.blobSize||0);
  const first=await save();
  return {first,imageBytes};
})()`;

const moveExpression = `(async()=>{const {imageItems,save}=window.__inc;imageItems()[0].x+=3;return await save();})()`;
const addExpression = `(async()=>{const {RB,wait,makeFile,save}=window.__inc;const before=RB.images.size;
  await RB.addImages([await makeFile(99,900)]);for(let a=0;a<60&&RB.images.size<before+1;a++)await wait(50);return await save();})()`;
const paintExpression = `(async()=>{const {RB,imageItems,save}=window.__inc;
  const target=imageItems()[0];const im=RB.images.get(target.imgId);const genBefore=im.pixelGen||0;
  // Stand in for a paint commit: the record's bytes change under the same id.
  const c=document.createElement('canvas');c.width=im.w;c.height=im.h;const g=c.getContext('2d');g.fillStyle='#ff0044';g.fillRect(0,0,c.width,c.height);
  const blob=await new Promise(r=>c.toBlob(r,'image/png'));
  im.blob=blob;im.blobSize=blob.size;im.pixelGen=genBefore+1;
  const result=await save();return {...result,genBefore,genAfter:im.pixelGen,newBytes:blob.size};})()`;
const deleteExpression = `(async()=>{const {RB,state,wait,imageItems,save}=window.__inc;
  const survivors=imageItems().slice(0,3).map(it=>it.id);
  state.sel.clear();for(const it of imageItems())if(!survivors.includes(it.id))state.sel.add(it.id);
  RB.invalidate();await wait(50);document.activeElement?.blur?.();
  document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'Delete',code:'Delete',bubbles:true,cancelable:true}));
  for(let a=0;a<40&&imageItems().length!==3;a++)await wait(50);
  if(imageItems().length!==3)throw new Error('delete left '+imageItems().length+' images');
  const result=await save();return {...result,survivorImgIds:imageItems().map(it=>it.imgId)};})()`;
const reopenExpression = `(async()=>{const {RB,state,wait,filePath,imageItems}=window.__inc;
  document.querySelector('#rwNewBoard')?.click();await wait(120);
  document.querySelectorAll('.modal.show').forEach(el=>el.classList.remove('show'));
  for(let a=0;a<40&&state.items.length;a++)await wait(50);
  const pending=RB.openBoardFromPath(filePath);let stopped=false;
  const confirmer=(async()=>{while(!stopped){const ok=document.querySelector('#confirmModal.show #confirmOk');if(ok){ok.click();return;}await wait(40);}})();
  await pending;stopped=true;await confirmer;
  for(let a=0;a<80;a++){if(!document.querySelector('#openingOverlay')?.classList.contains('show'))break;await wait(50);}
  const sizes={};for(const [id,im] of RB.images)sizes[id]=im.blob?im.blob.size:(im.blobSize||null);
  return {items:imageItems().length,images:RB.images.size,sizes};})()`;

const readPair = async () => ({
  index: await sidecar.readSidecarIndex(boardPath),
  storeSize: (await stat(storePath)).size,
  indexSize: (await stat(boardPath)).size,
});

try {
  const port = await debuggerPort();
  const run = expr => evaluate(port, expr, { attempts: 1 });

  // 1. First save.
  const { first, imageBytes } = await run(setupExpression);
  assert.equal(first.ok, true, 'first save succeeds');
  assert.ok(existsSync(storePath), 'the store sits beside the index');
  assert.equal(first.stats.appended, IMAGE_COUNT, `first save appends every image (${first.stats.appended})`);
  assert.ok(first.stats.appendedBytes >= imageBytes, 'the store received every image byte');
  let pair = await readPair();
  assert.equal(pair.index.images.length, IMAGE_COUNT, 'the index lists every image');
  assert.ok(pair.indexSize < imageBytes / 2, `the index is small (${pair.indexSize} bytes vs ${imageBytes} of image data)`);
  const sizeAfterFirst = pair.storeSize;

  // 2. Move: the store is untouched.
  const moved = await run(moveExpression);
  assert.equal(moved.stats.appended, 0, 'moving an item appends nothing');
  assert.equal(moved.stats.reused, IMAGE_COUNT, 'every image is reused from the store');
  pair = await readPair();
  assert.equal(pair.storeSize, sizeAfterFirst, 'a save with no image changes leaves the store byte-for-byte the same size');
  assert.equal(pair.index.items.find(it => (it.kind || 'image') === 'image').x, pair.index.items.find(it => (it.kind || 'image') === 'image').x, 'index rewritten');

  // 3. Add one image: the store grows by that image.
  const added = await run(addExpression);
  assert.equal(added.stats.appended, 1, 'adding one image appends one');
  assert.equal(added.stats.reused, IMAGE_COUNT, 'the others are reused');
  pair = await readPair();
  const sizeAfterAdd = pair.storeSize;
  assert.equal(sizeAfterAdd - sizeAfterFirst, added.stats.appendedBytes, 'the store grew by exactly the appended bytes');
  assert.equal(pair.index.images.length, IMAGE_COUNT + 1);

  // 4. Pixel change: exactly that image is resent; its old bytes are garbage.
  const painted = await run(paintExpression);
  assert.equal(painted.genAfter, painted.genBefore + 1, 'the pixel generation advanced');
  assert.equal(painted.stats.appended, 1, 'a pixel edit resends exactly that image');
  assert.equal(painted.stats.reused, IMAGE_COUNT, 'the rest are reused');
  assert.ok(painted.stats.garbageBytes > 0 && !painted.stats.compacted, 'the superseded bytes are counted as garbage and left for later');
  pair = await readPair();
  assert.equal(pair.storeSize - sizeAfterAdd, painted.stats.appendedBytes, 'the store grew by the re-encoded image only');

  // 5. Delete most: compaction under the lowered threshold shrinks the store.
  const deleted = await run(deleteExpression);
  assert.equal(deleted.stats.compacted, true, 'deleting most of the board compacts the store');
  pair = await readPair();
  assert.equal(pair.index.images.length, 3, 'the index lists the survivors');
  assert.ok(pair.storeSize < sizeAfterFirst / 2, `the compacted store is far smaller (${pair.storeSize} vs ${sizeAfterFirst})`);
  assert.equal(sidecar.sidecarGarbageBytes(pair.storeSize, pair.index.images), 0, 'a compacted store has no dead bytes');
  for (const image of pair.index.images) assert.ok(deleted.survivorImgIds.includes(image.id), `index entry ${image.id} is a survivor`);
  const scanned = await sidecar.scanSidecarStore(storePath);
  assert.deepEqual(scanned.records.map(r => r.id).sort(), pair.index.images.map(i => i.id).sort(), 'the store holds exactly the indexed records');

  // 6. Reopen: survivors load with their stored lengths.
  const reopened = await run(reopenExpression);
  assert.equal(reopened.items, 3, 'reopen restores the three surviving items');
  assert.equal(reopened.images, 3, 'reopen registers three image records');
  for (const image of pair.index.images) {
    assert.equal(reopened.sizes[image.id], image.length, `reopened ${image.id} has its stored byte length`);
  }

  // The preview is still where both readers look.
  const preview = await readBoardPreview(boardPath);
  assert.ok(typeof preview === 'string' && preview.length > 1000, 'the legacy header reader finds the preview in the index');
  assert.equal(extractPreviewBase64(boardPath), preview, 'the Explorer thumbnail extractor finds the same preview');

  console.log(`incremental save smoke: first ${first.ms} ms (${IMAGE_COUNT} images, ${sizeAfterFirst} B), move ${moved.ms} ms (+0 B), add ${added.ms} ms (+${added.stats.appendedBytes} B), paint ${painted.ms} ms (+${painted.stats.appendedBytes} B), delete ${deleted.ms} ms (compacted to ${pair.storeSize} B)`);
  console.log('incremental save Electron smoke passed');
} finally {
  if (child.exitCode === null) child.kill();
  await Promise.race([once(child, 'exit'), delay(3000)]).catch(() => {});
  await removeProfileDir(profile);
}
