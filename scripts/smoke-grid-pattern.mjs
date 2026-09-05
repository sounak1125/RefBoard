/**
 * Compares the pattern-filled dot grid to the per-dot loop it replaced,
 * at every device-pixel ratio Windows commonly runs and at pan
 * offsets that exercise rounding, negative phase, and the .5 tie.
 *
 * Runs the real app so the comparison uses the renderer's own canvas
 * rasteriser, then draws the same region twice off-screen: once with the old
 * loop, copied verbatim, and once with scripts/grid-dots.mjs. Interior dot
 * coverage must match exactly; occupied pixels may differ by one RGB unit.
 * The software rasteriser rounds coverage when a dot wraps across the cached
 * tile edge, then composites that tile onto the background. At 125% scale this
 * can shade a dot fringe one unit darker than drawing it directly. Requiring
 * byte equality passes on a GPU but fails on Windows CI's software renderer.
 * Background pixels and opaque alpha must still match exactly.
 * Along the clip rectangle's own edge the two cannot: the loop
 * draws each dot as its own rectangle, so a dot lying wholly inside the clip is
 * not attenuated by the edge's anti-aliasing, while one clipped pattern fill is
 * attenuated along the whole edge. That border is one pixel wide, differs by a
 * few units, and the workspace edge is usually off screen anyway. Run with the
 * default renderer and with --software to exercise both rendering paths.
 * Also prints the time both take on a 1440x900 viewport at 2x, for the
 * record rather than as a gate.
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
const profile = await mkdtemp(path.join(os.tmpdir(), 'refboard-grid-pattern-'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const software = process.argv.includes('--software');

const child = spawn(electron, ['.', ...(software ? ['--disable-gpu'] : []), '--remote-debugging-port=0', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-features=CalculateNativeWinOcclusion', `--user-data-dir=${profile}`], {
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
  const mod=await import('./scripts/grid-dots.mjs');
  const step=10;
  const color=getComputedStyle(document.documentElement).getPropertyValue('--grid-dot').trim()||'rgba(255,255,255,.13)';
  const BG='#101116';

  // The loop this replaces, verbatim from drawGridDotsScreen, over an explicit rect.
  const reference=(ctx,{x,y,w,h,tx,ty})=>{
    const visL=x,visT=y,visR=x+w,visB=y+h;
    const ix0=Math.floor((visL-tx)/step),ix1=Math.ceil((visR-tx)/step);
    const iy0=Math.floor((visT-ty)/step),iy1=Math.ceil((visB-ty)/step);
    ctx.save();ctx.beginPath();ctx.rect(visL,visT,visR-visL,visB-visT);ctx.clip();
    ctx.fillStyle=color;
    for(let ix=ix0;ix<=ix1;ix++){
      const px=Math.round(ix*step+tx)+0.5;
      if(px<visL-1||px>visR+1)continue;
      for(let iy=iy0;iy<=iy1;iy++){
        const py=Math.round(iy*step+ty)+0.5;
        if(py<visT-1||py>visB+1)continue;
        ctx.fillRect(px,py,1,1);
      }
    }
    ctx.restore();
  };
  const make=(W,H,dpr)=>{
    const c=document.createElement('canvas');
    c.width=Math.round(W*dpr);c.height=Math.round(H*dpr);
    // Use the same context options as the board and its cached tile, so the
    // reference and pattern use the same renderer in each process.
    const g=c.getContext('2d');
    g.setTransform(dpr,0,0,dpr,0,0);g.fillStyle=BG;g.fillRect(0,0,W,H);
    return [c,g];
  };
  const bg=(()=>{const [c,g]=make(1,1,1);return g.getImageData(0,0,1,1).data;})();

  const compare=(dpr,tx,ty,draw=mod.drawGridDots)=>{
      const W=640,H=360;
      const rect={x:13.3,y:7.7,w:600.2,h:340.9};
      const [a,ga]=make(W,H,dpr),[b,gb]=make(W,H,dpr);
      reference(ga,{...rect,tx,ty});
      draw(gb,{...rect,tx,ty,step,color,dpr});
      const da=ga.getImageData(0,0,a.width,a.height).data;
      const db=gb.getImageData(0,0,b.width,b.height).data;
      let diff=0,maxd=0,dotPixels=0;const where=[];let interiorDiff=0,interiorFailures=0,interiorMaxChannel=0,coverageMismatch=0,borderDiff=0,borderMaxChannel=0;
      const bx0=Math.floor(rect.x*dpr),bx1=Math.floor((rect.x+rect.w)*dpr),by0=Math.floor(rect.y*dpr),by1=Math.floor((rect.y+rect.h)*dpr);
      for(let i=0;i<da.length;i+=4){
        const d=Math.abs(da[i]-db[i])+Math.abs(da[i+1]-db[i+1])+Math.abs(da[i+2]-db[i+2])+Math.abs(da[i+3]-db[i+3]);
        if(d){diff++;if(d>maxd)maxd=d;const p=i/4,x=p%a.width,y=Math.floor(p/a.width);
          const onBorder=x===bx0||x===bx1||y===by0||y===by1;
          if(onBorder){borderDiff++;for(let c=0;c<4;c++)borderMaxChannel=Math.max(borderMaxChannel,Math.abs(da[i+c]-db[i+c]));}
          else{
            interiorDiff++;
            const aDot=da[i]!==bg[0]||da[i+1]!==bg[1]||da[i+2]!==bg[2];
            const bDot=db[i]!==bg[0]||db[i+1]!==bg[1]||db[i+2]!==bg[2];
            const rgbDelta=Math.max(...[0,1,2].map(c=>Math.abs(da[i+c]-db[i+c])));
            interiorMaxChannel=Math.max(interiorMaxChannel,rgbDelta);
            if(aDot!==bDot)coverageMismatch++;
            if(!aDot||!bDot||rgbDelta>1||da[i+3]!==db[i+3])interiorFailures++;
            if(where.length<12)where.push({x,y,loop:da[i],pattern:db[i]});}}
        if(da[i]!==bg[0]||da[i+1]!==bg[1]||da[i+2]!==bg[2])dotPixels++;
      }
      return {dpr,tx,ty,pixels:da.length/4,dotPixels,diff,interiorDiff,interiorFailures,interiorMaxChannel,coverageMismatch,borderDiff,borderMaxChannel,maxd,where};
  };
  const cases=[];
  for(const dpr of [1,1.25,1.5,2]){
    for(const [tx,ty] of [[0,0],[3.4,-7.6],[-123.5,456.49],[999.5,-0.5],[4.5,4.5],[-1,-1]]){
      cases.push(compare(dpr,tx,ty));
    }
  }
  // The rounding allowance must still reject a displaced grid, wrong shade,
  // and missing dots. Exercise those faults through the real comparison.
  const faults={
    shifted:compare(1.25,-1,-1,(g,o)=>mod.drawGridDots(g,{...o,tx:o.tx+1})),
    recolored:compare(1.25,-1,-1,(g,o)=>mod.drawGridDots(g,{...o,color:'#ffffff'})),
    missing:compare(1.25,-1,-1,()=>{}),
  };

  // Timing, for the record: a 1440x900 viewport at 2x, 20 frames each.
  const time=(fn)=>{const t0=performance.now();for(let i=0;i<20;i++)fn(i);return (performance.now()-t0)/20;};
  const [,gl]=make(1440,900,2),[,gp]=make(1440,900,2);
  const full={x:0,y:0,w:1440,h:900};
  const loopMs=time(i=>reference(gl,{...full,tx:i*3.7,ty:-i*2.1}));
  mod.clearGridDotPatternCache();
  const patternColdMs=time(i=>mod.drawGridDots(gp,{...full,tx:i*3.7,ty:-i*2.1,step,color,dpr:2}));
  const patternWarmMs=time(i=>mod.drawGridDots(gp,{...full,tx:i*3.7,ty:-i*2.1,step,color,dpr:2}));
  return {cases,faults,timing:{loopMs,patternColdMs,patternWarmMs}};
})()`;

try {
  const port = await debuggerPort();
  const { cases, faults, timing } = await evaluate(port, smokeExpression, { attempts: 1 });
  const firstBad = cases.find(c => c.interiorFailures > 0 || c.borderMaxChannel > 10);
  if (firstBad) console.log('first differing case', JSON.stringify(firstBad, null, 1));
  for (const c of cases) {
    assert.ok(c.dotPixels > 500, `reference drew nothing at dpr ${c.dpr} (${c.tx},${c.ty})`);
    assert.equal(c.coverageMismatch, 0, `pattern dot coverage differs at dpr ${c.dpr} offset (${c.tx},${c.ty}): ${c.coverageMismatch} px`);
    assert.equal(c.interiorFailures, 0, `pattern grid exceeds one RGB unit of rounding inside the clip at dpr ${c.dpr} offset (${c.tx},${c.ty}): ${c.interiorFailures} px`);
    assert.ok(c.borderMaxChannel <= 10, `clip-edge anti-aliasing differs by more than a few units at dpr ${c.dpr} offset (${c.tx},${c.ty}): ${c.borderMaxChannel}`);
  }
  for (const [name, fault] of Object.entries(faults)) {
    assert.ok(fault.interiorFailures > 500, `comparison must reject ${name} dots`);
  }
  const border = Math.max(...cases.map(c => c.borderMaxChannel));
  const interior = Math.max(...cases.map(c => c.interiorMaxChannel));
  console.log(`grid pattern smoke (${software ? 'software' : 'default'}): ${cases.length} cases with identical dot coverage, interior RGB delta <= ${interior}/255, clip-edge delta <= ${border}/255; all 3 rendering faults rejected; 1440x900@2x loop ${timing.loopMs.toFixed(2)} ms, pattern cold ${timing.patternColdMs.toFixed(2)} ms, warm ${timing.patternWarmMs.toFixed(2)} ms per frame`);
  console.log('grid pattern Electron smoke passed');
} finally {
  if (child.exitCode === null) child.kill();
  await Promise.race([once(child, 'exit'), delay(3000)]).catch(() => {});
  await removeProfileDir(profile);
}
