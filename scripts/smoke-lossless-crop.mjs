/**
 * A cropped image loses no pixels on its way out.
 *
 * The encoder decision table is unit-tested in test-cropped-export.mjs; this
 * proves the decision actually holds in Chromium. For a JPEG and a WebP source
 * it crops, runs the real export encode, and compares the result channel by
 * channel against the same region read straight off the decoded source. Zero
 * differences is the only pass.
 *
 * The 0.98 re-encode both formats used to get is run alongside as a control, so
 * a regression that quietly restores lossy encoding cannot pass by comparing
 * against nothing.
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
const profile = await mkdtemp(path.join(os.tmpdir(), 'refboard-lossless-'));
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
  for(let attempt=0;attempt<200&&!window.RefBoard;attempt++)await wait(50);
  if(!window.RefBoard)throw new Error('RefBoard API unavailable');
  for(let attempt=0;attempt<300&&!window.RefBoard.startupComplete;attempt++)await wait(50);
  if(!window.RefBoard.startupComplete)throw new Error('RefBoard startup did not complete');
  document.querySelectorAll('.modal.show').forEach(el=>el.classList.remove('show'));
  document.querySelector('#rwNewBoard')?.click();
  for(let attempt=0;attempt<100&&!document.body.classList.contains('board-active');attempt++)await wait(50);
  if(!document.body.classList.contains('board-active'))throw new Error('New board did not open');
  await wait(250);
  document.querySelectorAll('.modal.show').forEach(el=>el.classList.remove('show'));

  const RB=window.RefBoard;
  const W=320,H=240;

  // Detail plus deterministic noise. Flat colour would survive a lossy encode
  // and make this test pass for the wrong reason.
  const sourceCanvas=()=>{
    const c=document.createElement('canvas');c.width=W;c.height=H;
    const g=c.getContext('2d',{willReadFrequently:true});
    const img=g.createImageData(W,H);
    let seed=987654321;
    const rnd=()=>{seed=(seed*1103515245+12345)&0x7fffffff;return seed%256;};
    for(let y=0;y<H;y++)for(let x=0;x<W;x++){
      const i=(y*W+x)*4;
      img.data[i]=(x+rnd())&255;
      img.data[i+1]=(y*3+rnd())&255;
      img.data[i+2]=((x^y)+rnd())&255;
      img.data[i+3]=255;
    }
    g.putImageData(img,0,0);
    return c;
  };

  const pixelsOf=async(blob,w,h)=>{
    const bmp=await createImageBitmap(blob);
    const c=document.createElement('canvas');c.width=w;c.height=h;
    const g=c.getContext('2d',{willReadFrequently:true});
    g.drawImage(bmp,0,0);
    return g.getImageData(0,0,w,h).data;
  };
  const compare=(a,b)=>{
    if(a.length!==b.length)return {changed:-1,maxDelta:-1};
    let changed=0,maxDelta=0;
    for(let i=0;i<a.length;i++){const d=Math.abs(a[i]-b[i]);if(d){changed++;if(d>maxDelta)maxDelta=d;}}
    return {changed,maxDelta};
  };

  const run=async(mime,filename)=>{
    const c=sourceCanvas();
    // A genuine file of that format. Whatever loss the format costs happens
    // here, once — the export must not add a second generation on top.
    const sourceBlob=await new Promise(r=>c.toBlob(r,mime,0.9));
    const [item]=await RB.addImages([new File([sourceBlob],filename,{type:mime})]);
    await wait(400);
    const im=RB.images.get(item.imgId);

    item.crop={l:0.2,t:0.15,r:0.8,b:0.85};
    const rect=RB.sourcePixelRectForTest(im,item,true);

    // Expected: that exact region read off the decoded source, no encoder involved.
    // im.blob is released once the bytes reach IndexedDB.
    const srcBmp=await createImageBitmap(await RB.getImageBlobForTest(im));
    const ec=document.createElement('canvas');ec.width=rect.w;ec.height=rect.h;
    const eg=ec.getContext('2d',{willReadFrequently:true});
    eg.drawImage(srcBmp,rect.x,rect.y,rect.w,rect.h,0,0,rect.w,rect.h);
    const expected=eg.getImageData(0,0,rect.w,rect.h).data;

    const out=await RB.itemToExportBlobForTest(item,'original',true);
    const got=await pixelsOf(out.blob,rect.w,rect.h);

    // Control: what the old 0.98 path would have produced from the same pixels.
    const lossyBlob=await new Promise(r=>ec.toBlob(r,mime,0.98));
    const lossy=await pixelsOf(lossyBlob,rect.w,rect.h);

    return {
      mime, rect, outType: out.blob.type, ext: out.ext, bytes: out.blob.size,
      lossless: compare(expected,got),
      control: compare(expected,lossy),
    };
  };

  return { jpeg: await run('image/jpeg','photo.jpg'), webp: await run('image/webp','shot.webp') };
})()`;

try {
  const r = await evaluate(await debuggerPort(), smokeExpression);

  for (const [label, c] of Object.entries(r)) {
    // The control must actually be lossy, or the comparison proves nothing.
    assert.ok(
      c.control.changed > 0,
      `${label}: the 0.98 control lost nothing, so this test cannot detect loss`,
    );
    assert.equal(
      c.lossless.changed, 0,
      `${label}: cropped export changed ${c.lossless.changed} channels (max delta ${c.lossless.maxDelta}) — it is not lossless`,
    );
    console.log(
      `  ${label.padEnd(5)} crop ${c.rect.w}x${c.rect.h} -> ${c.outType} (.${c.ext}, ${c.bytes} bytes): `
      + `0 channels changed; the old 0.98 path would have changed ${c.control.changed} (max delta ${c.control.maxDelta})`,
    );
  }

  // A JPEG cannot be re-encoded losslessly, so keeping the pixels means PNG.
  assert.equal(r.jpeg.outType, 'image/png', 'a cropped JPEG must come out as a PNG');
  assert.equal(r.jpeg.ext, 'png', 'the extension must match the bytes written');

  // WebP can, so it keeps its own format rather than inflating into a PNG.
  assert.equal(r.webp.outType, 'image/webp', 'a cropped WebP must stay WebP');
  assert.equal(r.webp.ext, 'webp', 'the extension must match the bytes written');

  console.log('lossless crop Electron smoke passed — cropped JPEG and WebP exports are pixel-identical to their source');
} finally {
  if (child.exitCode === null) child.kill();
  await Promise.race([once(child, 'exit'), delay(3000)]).catch(() => {});
  await removeProfileDir(profile);
}
