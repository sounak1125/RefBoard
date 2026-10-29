/**
 * Content-aware fill, driven through the real UI with the real model.
 *
 * A red disc on a gradient sky is removed with the selection bar's button, a
 * lasso drawn with pointer events and Enter. What only a running app can show:
 * that the disc is actually gone, that not one pixel outside the lasso changed,
 * that Ctrl+Z after Apply brings the disc back as a single board undo, and that
 * inside the tool Ctrl+Z steps back one fill and Esc discards the preview.
 *
 * Needs WebGPU and the model, which is not in the repo: a dev run reads it from
 * inpaint-lab/models/lama-carve/ (see scripts/inpaint-bakeoff/README.md). Not
 * part of CI for that reason; run it locally with `npm run test:inpaint-smoke`.
 * Against an installed build (REFBOARD_SMOKE_EXECUTABLE) the model is not on
 * disk, so the smoke accepts the download prompt and the first run fetches it
 * from the release, which also exercises the real download.
 */
import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeProfileDir } from './smoke-profile-cleanup.mjs';
import { evaluate } from './smoke-cdp.mjs';
import { inpaintGrowPx } from './inpaint-geometry.mjs';

// The test image's size, and how far the tool grows a lasso on it.
const W = 1200, H = 800;
const GROW = inpaintGrowPx(W, H);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const model = path.join(root, 'inpaint-lab', 'models', 'lama-carve', 'lama_fp32.onnx');
if (!process.env.REFBOARD_SMOKE_EXECUTABLE) {
  try {
    await access(model);
  } catch {
    console.error(`smoke-inpaint-fill needs the model at ${model} (see scripts/inpaint-bakeoff/README.md)`);
    process.exit(1);
  }
}

const electron = process.env.REFBOARD_SMOKE_EXECUTABLE || path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const profile = await mkdtemp(path.join(os.tmpdir(), 'refboard-inpaint-'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const child = spawn(electron, [...(process.env.REFBOARD_SMOKE_EXECUTABLE ? [] : ['.']), '--remote-debugging-port=0', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-features=CalculateNativeWinOcclusion', `--user-data-dir=${profile}`], {
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
  const until=async(test,ms,what)=>{
    const end=performance.now()+ms;
    while(performance.now()<end){ const v=test(); if(v)return v; await wait(50); }
    throw new Error('timed out waiting for '+what+' - fill state: '+JSON.stringify(RB.fillStateForTest())+' toast: "'+document.querySelector('#toast').textContent+'"');
  };
  for(let i=0;i<200&&!window.RefBoard;i++)await wait(50);
  const RB=window.RefBoard;
  if(!RB)throw new Error('RefBoard API unavailable');
  for(let i=0;i<300&&!RB.startupComplete;i++)await wait(50);
  document.querySelectorAll('.modal.show').forEach(el=>el.classList.remove('show'));
  document.querySelector('#rwNewBoard').click();
  await until(()=>document.body.classList.contains('board-active'),5000,'a new board');
  await wait(300);
  document.querySelectorAll('.modal.show').forEach(el=>el.classList.remove('show'));
  const runtimeErrors=[];
  window.addEventListener('error',e=>runtimeErrors.push(e.message));
  window.addEventListener('unhandledrejection',e=>runtimeErrors.push(String(e.reason?.message||e.reason)));

  // A red disc on a gradient sky with a little grain, so the fill has texture to match.
  const W=${W},H=${H},GROW=${GROW},CX=600,CY=380,R=120;
  const src=document.createElement('canvas');src.width=W;src.height=H;
  const g=src.getContext('2d');
  const sky=g.createLinearGradient(0,0,0,H);sky.addColorStop(0,'#3a6ea5');sky.addColorStop(1,'#c9dff2');
  g.fillStyle=sky;g.fillRect(0,0,W,H);
  const grain=g.getImageData(0,0,W,H);
  let seed=7;const rnd=()=>((seed=(seed*1103515245+12345)&0x7fffffff)/0x7fffffff);
  for(let i=0;i<grain.data.length;i+=4){const n=(rnd()-.5)*10;grain.data[i]+=n;grain.data[i+1]+=n;grain.data[i+2]+=n;}
  g.putImageData(grain,0,0);
  g.fillStyle='#d02020';g.beginPath();g.arc(CX,CY,R,0,Math.PI*2);g.fill();
  // A second object, for two fills stacked under one Apply.
  const SX=200,SY=610,SH=50;
  g.fillStyle='#20c040';g.fillRect(SX-SH,SY-SH,SH*2,SH*2);
  const original=g.getImageData(0,0,W,H).data;
  const png=await new Promise(r=>src.toBlob(r,'image/png'));
  const [item,other]=await RB.addImages([new File([png],'disc.png',{type:'image/png'}),new File([png],'other.png',{type:'image/png'})]);
  if(!item||!other)throw new Error('images were not added');
  item.x=0;item.y=0;other.x=item.w+80;other.y=0;
  RB.invalidateLayout();RB.fitAll();RB.invalidate();await wait(400);

  const select=ids=>{RB.state.sel=new Set(ids);RB.updateSelBarForTest();};
  const shown=el=>getComputedStyle(el).display!=='none';
  const button=document.querySelector('#sFill');
  select([item.id,other.id]);
  if(shown(button))throw new Error('Remove object must not be offered for two images');
  select([item.id]);
  if(!shown(button))throw new Error('Remove object must be offered for one selected image');

  const pixels=async()=>{
    const im=RB.images.get(item.imgId);
    const bmp=await createImageBitmap(await RB.getImageBlobForTest(im));
    const c=new OffscreenCanvas(bmp.width,bmp.height).getContext('2d');c.drawImage(bmp,0,0);
    return c.getImageData(0,0,bmp.width,bmp.height).data;
  };
  const meanRGB=(d,cx,cy,r)=>{let sr=0,sg=0,sb=0,n=0;for(let y=cy-r;y<cy+r;y++)for(let x=cx-r;x<cx+r;x++){if(Math.hypot(x-cx,y-cy)>r)continue;const i=(y*W+x)*4;sr+=d[i];sg+=d[i+1];sb+=d[i+2];n++;}return {r:sr/n,g:sg/n,b:sb/n};};
  const meanRB=(d,r)=>meanRGB(d,CX,CY,r);
  // Image pixels -> client coordinates, through the item's own placement on the board.
  const canvasEl=document.getElementById('board');
  const toClient=(px,py)=>{const v=RB.state.view;const rect=canvasEl.getBoundingClientRect();
    const bx=item.x+px/W*item.w,by=item.y+py/H*item.h;return [rect.left+bx*v.s+v.tx,rect.top+by*v.s+v.ty];};
  const pointer=(type,[x,y],target=canvasEl)=>target.dispatchEvent(new PointerEvent(type,{clientX:x,clientY:y,button:0,buttons:type==='pointerup'?0:1,pointerId:1,pointerType:'mouse',isPrimary:true,bubbles:true}));
  const lasso=async(radius,cx=CX,cy=CY)=>{
    const pts=[];for(let k=0;k<=40;k++){const a=k/40*Math.PI*2;pts.push(toClient(cx+radius*Math.cos(a),cy+radius*Math.sin(a)));}
    pointer('pointerdown',pts[0]);
    for(const p of pts.slice(1)){pointer('pointermove',p,window);await wait(4);}
    pointer('pointerup',pts.at(-1),window);
  };
  const key=(k,mods={})=>document.body.dispatchEvent(new KeyboardEvent('keydown',{key:k,code:k==='Escape'?'Escape':undefined,bubbles:true,cancelable:true,...mods}));

  // 1. Remove the disc and the square in one session, then apply both at once.
  const t0=performance.now();
  button.click();
  // An installed build has no model yet: say yes to the one-time download.
  for(let i=0;i<40&&!RB.fillStateForTest();i++){
    if(document.querySelector('#confirmModal').classList.contains('show')){document.querySelector('#confirmOk').click();break;}
    await wait(50);
  }
  await until(()=>RB.fillStateForTest()?.status==='Draw around what to remove',600000,'the model to load');
  const loadMs=Math.round(performance.now()-t0);
  if(!document.querySelector('#fillBar').classList.contains('show'))throw new Error('the fill bar did not appear');
  if(!document.querySelector('#fillApply').disabled)throw new Error('Apply should wait for a fill');
  const t1=performance.now();
  await lasso(R+40);
  await until(()=>RB.fillStateForTest()?.fills===1&&!RB.fillStateForTest().busy,60000,'the fill');
  const fillMs=Math.round(performance.now()-t1);
  if(document.querySelector('#fillApply').disabled)throw new Error('Apply should be enabled after a fill');
  const t2=performance.now();
  await lasso(SH*1.6,SX,SY);
  await until(()=>RB.fillStateForTest()?.fills===2&&!RB.fillStateForTest().busy,60000,'the second fill');
  const secondFillMs=Math.round(performance.now()-t2);
  key('Enter');
  await until(()=>!RB.fillStateForTest(),30000,'Apply to finish');
  if(document.querySelector('#toast').textContent!=='Removed 2 areas')throw new Error('expected the toast to count both fills, got "'+document.querySelector('#toast').textContent+'"');
  await wait(300);
  const after=await pixels();
  const inside=meanRB(after,R-20);
  if(!(inside.b-inside.r>40))throw new Error('the disc was not removed: mean red '+inside.r.toFixed(0)+', blue '+inside.b.toFixed(0));
  const square=meanRGB(after,SX,SY,SH-10);
  if(!(square.b-square.g>10))throw new Error('the square was not removed: mean green '+square.g.toFixed(0)+', blue '+square.b.toFixed(0));
  // Nothing outside the two lassos and their growth moves (2 px for the polygon
  // and its antialiased edge); the PNG round trip is lossless.
  let outsideChanged=0,outsideMax=0;
  for(let y=0;y<H;y++)for(let x=0;x<W;x++){
    if(Math.hypot(x-CX,y-CY)<=R+40+GROW+2)continue;
    if(Math.hypot(x-SX,y-SY)<=SH*1.6+GROW+2)continue;
    const i=(y*W+x)*4;const d=Math.max(Math.abs(after[i]-original[i]),Math.abs(after[i+1]-original[i+1]),Math.abs(after[i+2]-original[i+2]));
    if(d){outsideChanged++;if(d>outsideMax)outsideMax=d;}
  }
  if(outsideChanged)throw new Error(outsideChanged+' pixels outside the lasso changed (max '+outsideMax+')');

  // 2. One board undo restores the disc.
  key('z',{ctrlKey:true});
  let undone=null;
  for(let i=0;i<100;i++){undone=meanRB(await pixels(),R-20);if(undone.r-undone.b>100)break;await wait(100);}
  if(!(undone.r-undone.b>100))throw new Error('Ctrl+Z after Apply did not bring the disc back');

  // 3. Inside the tool: a fill, Ctrl+Z steps it back, Esc leaves with the image untouched.
  select([item.id]);
  button.click();
  await until(()=>RB.fillStateForTest()?.status==='Draw around what to remove',60000,'the tool to reopen');
  await lasso(R+40);
  await until(()=>RB.fillStateForTest()?.fills===1&&!RB.fillStateForTest().busy,60000,'the second fill');
  key('z',{ctrlKey:true});
  if(RB.fillStateForTest()?.fills!==0)throw new Error('Ctrl+Z inside the tool should step back the fill');
  key('Escape');
  if(RB.fillStateForTest())throw new Error('Esc should leave the tool');
  await wait(300);
  const kept=meanRB(await pixels(),R-20);
  if(!(kept.r-kept.b>100))throw new Error('leaving the tool with Esc must not change the image');

  if(runtimeErrors.length)throw new Error('runtime errors: '+runtimeErrors.join(' | '));
  return {loadMs,fillMs,secondFillMs,inside:{r:Math.round(inside.r),b:Math.round(inside.b)},outsideChanged};
})()`;

let result;
try {
  const port = await debuggerPort();
  result = await evaluate(port, smokeExpression);
} finally {
  if (child.exitCode === null) child.kill();
  await removeProfileDir(profile);
}
console.log(`inpaint fill smoke passed - model ready in ${result.loadMs} ms, first fill ${result.fillMs} ms, second ${result.secondFillMs} ms, `
  + `disc area now mean R ${result.inside.r} / B ${result.inside.b}, ${result.outsideChanged} pixels changed outside the lassos`);
