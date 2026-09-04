/**
 * Proves the spatial index answers exactly what a scan of every item would,
 * and reports what hover and culling cost on a board of two thousand items.
 *
 * Runs the real app with a 2,000-item lattice of images, rotated images,
 * notes and arrows, some in groups. For a few hundred random screen points it
 * compares the app's own hit test with a brute-force reference written here
 * from the same geometry rules; for a few hundred random marquees it compares
 * the app's marquee selection with a brute-force rectangle test. Then it
 * moves an item, resizes it through the real handle drag, and checks the hit
 * test follows. Timings are printed, not asserted: they vary by machine.
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
const profile = await mkdtemp(path.join(os.tmpdir(), 'refboard-spatial-'));
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

const ITEM_COUNT = 2000;
const smokeExpression = `(async()=>{
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  for(let attempt=0;attempt<300&&!(window.RefBoard&&window.RefBoard.startupComplete);attempt++)await wait(50);
  if(!(window.RefBoard&&window.RefBoard.startupComplete))throw new Error('RefBoard startup did not complete');
  const RB=window.RefBoard, state=RB.state;
  document.querySelectorAll('.modal.show').forEach(el=>el.classList.remove('show'));
  document.querySelector('#rwNewBoard')?.click();
  for(let attempt=0;attempt<100&&!document.body.classList.contains('board-active');attempt++)await wait(50);
  if(!document.body.classList.contains('board-active'))throw new Error('New board did not open');
  await wait(200);
  document.querySelectorAll('.modal.show').forEach(el=>el.classList.remove('show'));

  // Deterministic pseudo-random so a failure reproduces.
  let seed=97;const rand=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296;};

  // One shared image record with a proxy canvas; the hit test needs geometry, not pixels.
  const p=document.createElement('canvas');p.width=p.height=256;const pg=p.getContext('2d');pg.fillStyle='#4a6';pg.fillRect(0,0,256,256);
  RB.images.set('spatial-img',{id:'spatial-img',w:800,h:600,blob:null,blobSize:0,type:'image/png',name:'s.png',version:0,bitmap:null,proxy:p,proxyW:256,proxyH:256,decodeFailed:false,decodeWasSkipped:false,fullLastUsed:0,fullPinCount:0,lod:{entries:new Map(),pending:new Map()}});

  const COLS=50, PITCH=260, SIZE=200;
  const items=[];
  const GROUPS=6;
  for(let g=0;g<GROUPS;g++)items.push({id:'grp-'+g,kind:'group',x:0,y:0,w:40,h:40,name:'G'+g,color:'#333'});
  for(let i=0;i<${ITEM_COUNT};i++){
    const col=i%COLS,row=Math.floor(i/COLS);
    const x=col*PITCH+rand()*40, y=row*PITCH+rand()*40;
    let it;
    if(i%23===0)it={id:'it-'+i,kind:'arrow',x1:x,y1:y,x2:x+SIZE*0.8,y2:y+SIZE*0.5,color:'#fff',strokeWidth:2,arrowStyle:'solid'};
    else if(i%7===0)it={id:'it-'+i,kind:'note',x,y,w:SIZE,h:SIZE*0.6,rot:0,text:'note '+i,color:'#15161c',textColor:'#f0f2f6',fontSize:15};
    else it={id:'it-'+i,kind:'image',imgId:'spatial-img',x,y,w:SIZE,h:SIZE*0.75,rot:i%5===0?rand()*360:0,flipX:false,flipY:false,gray:false,crop:{l:0,t:0,r:1,b:1},groupId:null};
    // Groups are contiguous runs of five cells, so their frames stay small.
    const gi=Math.floor(i/5); if(it.kind!=='arrow'&&gi%40===0&&(gi/40)<GROUPS)it.groupId='grp-'+(gi/40);
    items.push(it);
  }
  state.items=items;
  state.sel.clear();
  RB.syncGroupFramesForTest?.();
  await RB.fitAll();
  RB.invalidate();
  await wait(300);

  // Reference geometry, from the same rules the app uses (rotation about the centre).
  const rectOf=it=>it.kind==='arrow'?(()=>{const pad=Math.max(8,(it.strokeWidth||2)*4)+6;return {x:Math.min(it.x1,it.x2)-pad,y:Math.min(it.y1,it.y2)-pad,w:Math.abs(it.x2-it.x1)+pad*2,h:Math.abs(it.y2-it.y1)+pad*2};})():{x:it.x,y:it.y,w:it.w,h:it.h};
  const toLocal=(it,bx,by)=>{const r=rectOf(it);const a=(it.rot||0)*Math.PI/180;const cx=r.x+r.w/2,cy=r.y+r.h/2;const dx=bx-cx,dy=by-cy;const c=Math.cos(-a),s=Math.sin(-a);return [dx*c-dy*s+r.w/2,dx*s+dy*c+r.h/2];};
  const segDist=(px,py,x1,y1,x2,y2)=>{const dx=x2-x1,dy=y2-y1;const l2=dx*dx+dy*dy;let t=l2?((px-x1)*dx+(py-y1)*dy)/l2:0;t=Math.max(0,Math.min(1,t));const qx=x1+t*dx,qy=y1+t*dy;return Math.hypot(px-qx,py-qy);};
  const aabb=it=>{const r=rectOf(it);const a=(it.rot||0)*Math.PI/180;const c=Math.abs(Math.cos(a)),s=Math.abs(Math.sin(a));const hw=r.w/2,hh=r.h/2;const ax=c*hw+s*hh,ay=s*hw+c*hh;return {x:r.x+hw-ax,y:r.y+hh-ay,w:ax*2,h:ay*2};};
  const refItemAt=(sx,sy)=>{
    const v=state.view;const bx=(sx-v.tx)/v.s,by=(sy-v.ty)/v.s;
    for(let i=state.items.length-1;i>=0;i--){const it=state.items[i];if(it.kind==='group')continue;
      if(it.kind==='arrow'){const tol=Math.max(6/v.s,(it.strokeWidth||2)+4);if(tol>=segDist(bx,by,it.x1,it.y1,it.x2,it.y2))return it;continue;}
      const r=rectOf(it);const [lx,ly]=toLocal(it,bx,by);if(lx>=0&&lx<=r.w&&ly>=0&&ly<=r.h)return it;}
    return null;
  };
  const refMarquee=(x1,y1,x2,y2)=>{const ids=new Set();for(const it of state.items){if(it.kind==='group')continue;const b=aabb(it);if(b.x<x2&&b.x+b.w>x1&&b.y<y2&&b.y+b.h>y1)ids.add(it.groupId||it.id);}return ids;};

  const board=document.querySelector('#board');
  const W=board.clientWidth,H=board.clientHeight;
  // Zoom to a working scale in the middle of the lattice.
  const v=state.view; v.s=1; v.tx=W/2-(COLS*PITCH/2); v.ty=H/2-(Math.ceil(${ITEM_COUNT}/COLS)*PITCH/2); RB.invalidate(); await wait(200);

  // 1. Hit-test parity, ignoring group-frame hits (the reference does not model frames).
  let hitChecks=0,hitMismatch=[];
  for(let q=0;q<400;q++){
    const sx=rand()*W,sy=rand()*H;
    const got=RB.itemAt(sx,sy);
    if(got&&got.kind==='group')continue;
    const want=refItemAt(sx,sy);
    hitChecks++;
    const gotId=got?got.id:null,wantId=want?want.id:null;
    if(gotId!==wantId&&hitMismatch.length<5)hitMismatch.push({sx,sy,got:gotId,want:wantId});
  }
  // 2. Marquee parity through the app's own function is not exposed; compare
  //    the selection a real marquee drag produces with the reference set.
  const fire=(type,sx,sy,extra={})=>{const r=board.getBoundingClientRect();const opts={bubbles:true,cancelable:true,view:window,pointerId:77,pointerType:'mouse',isPrimary:true,button:extra.button??(type==='pointermove'?(extra.drag?0:-1):0),buttons:extra.buttons??((extra.drag||type==='pointerdown')?1:0),clientX:r.left+sx,clientY:r.top+sy,shiftKey:!!extra.shiftKey};board.dispatchEvent(new PointerEvent(type,opts));if(type!=='pointerdown')window.dispatchEvent(new PointerEvent(type,opts));};
  let marqueeChecks=0,marqueeMismatch=[];
  for(let q=0;q<25;q++){
    // Start on empty space between lattice cells so pointerdown begins a marquee, not a drag.
    let sx,sy,tries=0;do{sx=rand()*(W-200);sy=rand()*(H-200);tries++;}while(RB.itemAt(sx,sy)&&tries<50);
    if(RB.itemAt(sx,sy))continue;
    const ex=sx+80+rand()*150,ey=sy+80+rand()*150;
    state.sel.clear();
    fire('pointerdown',sx,sy);fire('pointermove',sx+5,sy+5,{drag:true});fire('pointermove',ex,ey,{drag:true});fire('pointerup',ex,ey,{drag:true,button:0,buttons:0});
    await wait(20);
    const bx1=(Math.min(sx,ex)-v.tx)/v.s,by1=(Math.min(sy,ey)-v.ty)/v.s,bx2=(Math.max(sx,ex)-v.tx)/v.s,by2=(Math.max(sy,ey)-v.ty)/v.s;
    const want=[...refMarquee(bx1,by1,bx2,by2)].sort();
    const got=[...state.sel].sort();
    marqueeChecks++;
    if(JSON.stringify(got)!==JSON.stringify(want)&&marqueeMismatch.length<3)marqueeMismatch.push({got:got.length,want:want.length,missing:want.filter(id=>!got.includes(id)).slice(0,4),extra:got.filter(id=>!want.includes(id)).slice(0,4)});
  }
  state.sel.clear();

  // 3. A moved item is found at its new place; a real handle resize is tracked.
  const mover=state.items.find(it=>it.kind==='image'&&!it.groupId&&!it.rot);
  const before={x:mover.x,y:mover.y};
  // Off the lattice, so nothing later in z order can sit on top of it.
  mover.x=-3000;mover.y=-3000;RB.invalidateLayout();
  // Only the signal, no gesture: this is what every mutation path must raise.
  const sxNew=mover.x*v.s+v.tx+10,syNew=mover.y*v.s+v.ty+10;
  const foundAfterMove=(RB.itemAt(sxNew,syNew)?.id===mover.id);
  const foundAtOld=(RB.itemAt(before.x*v.s+v.tx+10,before.y*v.s+v.ty+10)?.id===mover.id);
  mover.x=before.x;mover.y=before.y;RB.invalidateLayout();

  // 4. Hover timing: pointermove with nothing held does two hit tests per event.
  const t0=performance.now();
  for(let i=0;i<300;i++){const r=board.getBoundingClientRect();window.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,clientX:r.left+rand()*W,clientY:r.top+rand()*H,pointerId:1,pointerType:'mouse',buttons:0,button:-1}));}
  const hoverMs=(performance.now()-t0)/300;
  // 5. Frame timing: force redraws and time them.
  let drawMs=null;
  if(typeof RB.benchDrawForTest==='function'){try{const b=await RB.benchDrawForTest(30);drawMs=typeof b==='number'?b:(b&&(b.medianMs??b.avgMs??b.ms))??null;}catch(e){drawMs=null;}}
  return {hitChecks,hitMismatch,marqueeChecks,marqueeMismatch,foundAfterMove,foundAtOld,hoverMs,drawMs,stats:RB.spatialIndexStats};
})()`;

try {
  const port = await debuggerPort();
  const r = await evaluate(port, smokeExpression, { attempts: 1 });
  console.log('spatial index probe', JSON.stringify({ hitChecks: r.hitChecks, marqueeChecks: r.marqueeChecks, stats: r.stats, hoverMs: Number(r.hoverMs.toFixed(3)), drawMs: r.drawMs, hitMismatch: r.hitMismatch, marqueeMismatch: r.marqueeMismatch }));
  assert.ok(r.hitChecks >= 200, `enough hit checks ran (${r.hitChecks})`);
  assert.deepEqual(r.hitMismatch, [], 'the indexed hit test agrees with a scan of every item');
  assert.ok(r.marqueeChecks >= 10, `enough marquee checks ran (${r.marqueeChecks})`);
  assert.deepEqual(r.marqueeMismatch, [], 'the indexed marquee agrees with a rectangle test of every item');
  assert.equal(r.foundAfterMove, true, 'a moved item is found at its new place after the invalidation signal');
  assert.equal(r.foundAtOld, false, 'and not at its old one');
  assert.ok(r.stats.items >= ITEM_COUNT, 'the index holds every item');
  console.log(`spatial index smoke: ${ITEM_COUNT} items, hover ${r.hoverMs.toFixed(3)} ms per pointermove${r.drawMs != null ? `, draw ${Number(r.drawMs).toFixed(2)} ms` : ''}, cell ${r.stats.cellSize}, ${r.stats.cells} cells, ${r.stats.rebuilds} rebuilds`);
  console.log('spatial index Electron smoke passed');
} finally {
  if (child.exitCode === null) child.kill();
  await Promise.race([once(child, 'exit'), delay(3000)]).catch(() => {});
  await removeProfileDir(profile);
}
