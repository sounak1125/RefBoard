/**
 * Proves the two older board formats open and become a single file on save.
 *
 * Runs the real app twice over: once on a 2.1.0 sidecar pair (index plus
 * .refboard.images store) and once on a legacy embedded JSON board. Each is
 * opened, saved to the same path, and checked: the board is now a single
 * container file, the pair's store is gone, the previous file is kept as
 * .bak, every image reads back with its original bytes, and the Explorer
 * preview extractor finds the preview at the front of the new file.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeProfileDir } from './smoke-profile-cleanup.mjs';
import { evaluate } from './smoke-cdp.mjs';

const require = createRequire(import.meta.url);
const sidecar = require('./board-sidecar.js');
const container = require('./board-container.js');
const { boardHeaderPrefix, boardImageParts } = require('./board-save-format.js');
const { extractPreviewBase64 } = require('./file-icon-composite.js');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const profile = await mkdtemp(path.join(os.tmpdir(), 'refboard-convert-'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Two small PNGs with distinct bytes, made without a browser.
const png = (r, g, b) => {
  // 1x1 PNG built by hand: signature, IHDR, IDAT (stored deflate), IEND.
  const crcTable = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
  const crc = buf => { let c = 0xffffffff; for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'latin1'), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.from([0, r, g, b]);
  const adler = (() => { let a = 1, s = 0; for (const byte of raw) { a = (a + byte) % 65521; s = (s + a) % 65521; } return ((s << 16) | a) >>> 0; })();
  const idat = Buffer.concat([Buffer.from([0x78, 0x01, 0x01, raw.length & 0xff, (raw.length >> 8) & 0xff, (~raw.length) & 0xff, ((~raw.length) >> 8) & 0xff]), raw, Buffer.from([(adler >>> 24) & 0xff, (adler >>> 16) & 0xff, (adler >>> 8) & 0xff, adler & 0xff])]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
};
const imgA = png(200, 30, 30), imgB = png(30, 200, 30);
const preview = Buffer.from('preview-jpeg-bytes-pretend-'.repeat(60)).toString('base64');
const core = (label) => ({
  app: 'refboard', version: 3, view: { tx: 0, ty: 0, s: 1 }, boardGray: false, gridAppearance: 'dots', tagColors: {},
  items: [
    { id: `${label}-1`, kind: 'image', imgId: 'img-a', x: 0, y: 0, w: 200, h: 200, rot: 0, flipX: false, flipY: false, gray: false, crop: { l: 0, t: 0, r: 1, b: 1 }, groupId: null, tags: [] },
    { id: `${label}-2`, kind: 'image', imgId: 'img-b', x: 300, y: 0, w: 200, h: 200, rot: 0, flipX: false, flipY: false, gray: false, crop: { l: 0, t: 0, r: 1, b: 1 }, groupId: null, tags: [] },
  ],
});

// Fixture 1: a 2.1.0 sidecar pair.
const pairPath = path.join(profile, 'pair.refboard');
{
  const store = await sidecar.openSidecarStore(sidecar.sidecarStorePath(pairPath), { create: true });
  const a = await sidecar.appendSidecarImage(store, { id: 'img-a', type: 'image/png' }, imgA);
  const b = await sidecar.appendSidecarImage(store, { id: 'img-b', type: 'image/png' }, imgB);
  await store.handle.close();
  await sidecar.writeSidecarIndex(pairPath, core('pair'), preview, [
    { id: 'img-a', type: 'image/png', name: 'a.png', w: 1, h: 1, size: imgA.length, ...a },
    { id: 'img-b', type: 'image/png', name: 'b.png', w: 1, h: 1, size: imgB.length, ...b },
  ]);
}
// Fixture 2: a legacy embedded board (2.0.x).
const legacyPath = path.join(profile, 'legacy.refboard');
{
  const pa = boardImageParts({ id: 'img-a', type: 'image/png', name: 'a.png', w: 1, h: 1 }, imgA);
  const pb = boardImageParts({ id: 'img-b', type: 'image/png', name: 'b.png', w: 1, h: 1 }, imgB);
  await writeFile(legacyPath, boardHeaderPrefix(core('legacy'), preview) + pa.prefix + pa.base64 + pa.suffix + ',' + pb.prefix + pb.base64 + pb.suffix + ']}');
}

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
    try { const [port] = (await readFile(portFile, 'utf8')).trim().split(/\r?\n/); if (/^\d+$/.test(port)) return Number(port); } catch { /* wait */ }
    await delay(100);
  }
  throw new Error(`Electron debugging port did not become ready\n${stderr}`);
}

const openAndSave = filePath => `(async()=>{
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  for(let attempt=0;attempt<300&&!(window.RefBoard&&window.RefBoard.startupComplete);attempt++)await wait(50);
  const RB=window.RefBoard,state=RB.state;
  document.querySelectorAll('.modal.show').forEach(el=>el.classList.remove('show'));
  const pending=RB.openBoardFromPath(${JSON.stringify(filePath)});let stopped=false;
  const confirmer=(async()=>{while(!stopped){const ok=document.querySelector('#confirmModal.show #confirmOk');if(ok){ok.click();return;}await wait(40);}})();
  await pending;stopped=true;await confirmer;
  for(let a=0;a<80;a++){if(!document.querySelector('#openingOverlay')?.classList.contains('show'))break;await wait(50);}
  const opened=state.items.filter(it=>(it.kind||'image')==='image').length;
  const sizes={};for(const [id,im] of RB.images)sizes[id]=im.blob?im.blob.size:(im.blobSize||null);
  const saved=await RB.saveBoardFile({silent:true,filePath:${JSON.stringify(filePath)}});
  await wait(200);
  return {opened,sizes,saved,stats:RB.lastBoardSaveStats};
})()`;

async function checkConverted(filePath, label) {
  const box = await container.openContainer(filePath, { write: false });
  try {
    assert.ok(box.index, `${label}: the saved board is a container with an index`);
    assert.deepEqual(box.index.images.map(i => i.id).sort(), ['img-a', 'img-b'], `${label}: both images are indexed`);
    const byId = Object.fromEntries(box.index.images.map(i => [i.id, i]));
    assert.ok((await container.readContainerImage(box.handle, byId['img-a'], box.size)).equals(imgA), `${label}: image A has its original bytes`);
    assert.ok((await container.readContainerImage(box.handle, byId['img-b'], box.size)).equals(imgB), `${label}: image B has its original bytes`);
    assert.equal(box.index.items.length, 2, `${label}: items survived`);
  } finally {
    await box.handle.close();
  }
  assert.ok(existsSync(`${filePath}.bak`), `${label}: the previous board file is kept as .bak`);
  assert.equal(typeof extractPreviewBase64(filePath), 'string', `${label}: the Explorer extractor finds a preview at the front`);
}

try {
  const port = await debuggerPort();
  const pair = await evaluate(port, openAndSave(pairPath), { attempts: 1 });
  assert.equal(pair.opened, 2, `the 2.1.0 pair opened both images (${pair.opened})`);
  assert.equal(pair.saved, true, 'the pair saved');
  assert.equal(pair.stats.appended, 0, 'nothing was resent: the store\'s images were copied in main');
  assert.equal(pair.stats.reused, 2, 'both images were reused from the pair');
  await checkConverted(pairPath, 'pair');
  assert.equal(existsSync(sidecar.sidecarStorePath(pairPath)), false, 'the pair\'s .images store is gone');

  const legacy = await evaluate(port, openAndSave(legacyPath), { attempts: 1 });
  assert.equal(legacy.opened, 2, `the legacy board opened both images (${legacy.opened})`);
  assert.equal(legacy.saved, true, 'the legacy board saved');
  assert.equal(legacy.stats.appended, 2, 'a legacy board\'s images are sent once');
  await checkConverted(legacyPath, 'legacy');
  const bak = await readFile(`${legacyPath}.bak`, 'utf8');
  assert.ok(bak.startsWith('{"preview"'), 'the .bak is the original embedded file');

  console.log('board convert Electron smoke passed');
} finally {
  if (child.exitCode === null) child.kill();
  await Promise.race([once(child, 'exit'), delay(3000)]).catch(() => {});
  await removeProfileDir(profile);
}
