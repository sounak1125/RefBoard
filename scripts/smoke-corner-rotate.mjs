import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeProfileDir } from './smoke-profile-cleanup.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const profile = await mkdtemp(path.join(os.tmpdir(), 'refboard-corner-rotate-smoke-'));
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

async function evaluate(port, expression) {
  let targets = [];
  for (let attempt = 0; attempt < 50; attempt++) {
    try { targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json()); } catch { /* retry */ }
    if (targets.some(entry => entry.type === 'page')) break;
    await delay(100);
  }
  const target = targets.find(entry => entry.type === 'page' && /RefBoard|index\.html/i.test(`${entry.title} ${entry.url}`))
    || targets.find(entry => entry.type === 'page');
  if (!target) throw new Error('RefBoard page target was not available');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let nextId = 0;
  const pending = new Map();
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const handlers = pending.get(message.id); pending.delete(message.id);
    if (message.error) handlers.reject(new Error(message.error.message)); else handlers.resolve(message.result);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
  });
  await send('Runtime.enable');
  const response = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  socket.close();
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  return response.result.value;
}

const smokeExpression = String.raw`(async()=>{
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  Element.prototype.setPointerCapture=()=>{};
  Element.prototype.releasePointerCapture=()=>{};
  for(let attempt=0;attempt<100&&!window.RefBoard;attempt++)await wait(50);
  if(!window.RefBoard)throw new Error('RefBoard API unavailable');
  document.querySelectorAll('.modal.show').forEach(el=>el.classList.remove('show'));
  document.querySelector('#rwNewBoard')?.click();
  for(let attempt=0;attempt<100&&!document.body.classList.contains('board-active');attempt++)await wait(50);
  if(!document.body.classList.contains('board-active'))throw new Error('New board did not open');
  await wait(200);
  document.querySelectorAll('.modal.show').forEach(el=>el.classList.remove('show'));
  const source=document.createElement('canvas');source.width=240;source.height=160;
  const sourceContext=source.getContext('2d');sourceContext.fillStyle='#e44747';sourceContext.fillRect(0,0,240,80);sourceContext.fillStyle='#357bd8';sourceContext.fillRect(0,80,240,80);
  const blob=await new Promise(resolve=>source.toBlob(resolve,'image/png'));
  await window.RefBoard.addImages([new File([blob],'rotate-smoke.png',{type:'image/png'})]);
  await wait(200);
  window.RefBoard.fitAll();
  await wait(80);
  const board=document.getElementById('board');
  if(!board)throw new Error('Board canvas missing');
  const view=()=>window.RefBoard.state.view;
  const toScreen=(x,y)=>{const v=view();return [x*v.s+v.tx,y*v.s+v.ty];};
  const rect=()=>board.getBoundingClientRect();
  const toClient=(sx,sy)=>{const r=rect();return {clientX:r.left+sx,clientY:r.top+sy};};
  const fire=(type,pt,extra={})=>{
    const opts={bubbles:true,cancelable:true,view:window,pointerId:71,pointerType:'mouse',isPrimary:true,
      button:extra.button??(type==='pointermove'?(extra.drag?0:-1):0),
      buttons:extra.buttons??((extra.drag||type==='pointerdown')?1:0),
      clientX:pt.clientX,clientY:pt.clientY,shiftKey:!!extra.shiftKey};
    board.dispatchEvent(new PointerEvent(type,opts));
    if(type!=='pointerdown')window.dispatchEvent(new PointerEvent(type,opts));
  };
  const image=()=>window.RefBoard.state.items.find(it=>(it.kind||'image')==='image');
  const note=()=>window.RefBoard.state.items.find(it=>it.kind==='note');
  const it=image();
  if(!it)throw new Error('Smoke image was not added');
  it.rot=0;
  window.RefBoard.state.sel=new Set([it.id]);
  const seCorner=()=>{
    const item=image();
    const [sx,sy]=toScreen(item.x+item.w,item.y+item.h);
    return toClient(sx,sy);
  };
  const seOutward=()=>{
    const item=image();
    const [csx,csy]=toScreen(item.x+item.w/2,item.y+item.h/2);
    const [sx,sy]=toScreen(item.x+item.w,item.y+item.h);
    const dx=sx-csx,dy=sy-csy,len=Math.hypot(dx,dy)||1;
    return toClient(sx+(dx/len)*22,sy+(dy/len)*22);
  };
  fire('pointermove',seCorner());
  await wait(20);
  const resizeCursor=board.style.cursor||getComputedStyle(board).cursor;
  fire('pointermove',seOutward());
  await wait(20);
  const rotateCursor=board.style.cursor||getComputedStyle(board).cursor;
  const beforeRotate={x:it.x,y:it.y,w:it.w,h:it.h,rot:it.rot||0};
  const [csx,csy]=toScreen(it.x+it.w/2,it.y+it.h/2);
  const startPt=seOutward();
  const startAng=Math.atan2(startPt.clientY-(rect().top+csy),startPt.clientX-(rect().left+csx));
  const endAng=startAng+0.9;
  const radius=Math.hypot(startPt.clientX-(rect().left+csx),startPt.clientY-(rect().top+csy));
  const end={clientX:rect().left+csx+Math.cos(endAng)*radius,clientY:rect().top+csy+Math.sin(endAng)*radius};
  fire('pointerdown',startPt);
  fire('pointermove',end,{drag:true});
  fire('pointerup',end,{drag:true,button:0,buttons:0});
  await wait(40);
  const afterRotate={x:image().x,y:image().y,w:image().w,h:image().h,rot:image().rot||0};
  image().rot=0;image().x=beforeRotate.x;image().y=beforeRotate.y;image().w=beforeRotate.w;image().h=beforeRotate.h;
  window.RefBoard.state.sel=new Set([image().id]);
  const beforeResize={w:image().w,h:image().h,rot:image().rot||0};
  const inner=seCorner();
  const inward={clientX:inner.clientX-40,clientY:inner.clientY-30};
  fire('pointerdown',inner);
  fire('pointermove',inward,{drag:true});
  fire('pointerup',inward,{drag:true,button:0,buttons:0});
  await wait(40);
  const afterResize={w:image().w,h:image().h,rot:image().rot||0};
  const noteItem={id:'smoke-note-1',kind:'note',x:image().x+image().w+48,y:image().y,w:160,h:72,rot:0,text:'Rotate me',color:'#15161c',textColor:'#f0f2f6',opacity:1,fontFamily:'Segoe UI',fontSize:15,scale:1,bold:false,italic:false,underline:false,textAlign:'left',groupId:null};
  window.RefBoard.state.items.push(noteItem);
  window.RefBoard.fitAll();
  await wait(80);
  const img=image();
  const nt=note();
  img.rot=0;nt.rot=0;
  const imgStart={x:img.x,y:img.y,w:img.w,h:img.h,rot:0,cx:img.x+img.w/2,cy:img.y+img.h/2};
  const noteStart={x:nt.x,y:nt.y,w:nt.w,h:nt.h,rot:0,cx:nt.x+nt.w/2,cy:nt.y+nt.h/2};
  window.RefBoard.state.sel=new Set([img.id,nt.id]);
  const originX=(Math.min(img.x,nt.x)+Math.max(img.x+img.w,nt.x+nt.w))/2;
  const originY=(Math.min(img.y,nt.y)+Math.max(img.y+img.h,nt.y+nt.h))/2;
  const seX=Math.max(img.x+img.w,nt.x+nt.w);
  const seY=Math.max(img.y+img.h,nt.y+nt.h);
  const [gcsx,gcsy]=toScreen(originX,originY);
  const [gsx,gsy]=toScreen(seX,seY);
  const gdx=gsx-gcsx,gdy=gsy-gcsy,glen=Math.hypot(gdx,gdy)||1;
  const groupOut=toClient(gsx+(gdx/glen)*22,gsy+(gdy/glen)*22);
  const groupStartAng=Math.atan2(groupOut.clientY-(rect().top+gcsy),groupOut.clientX-(rect().left+gcsx));
  const groupEndAng=groupStartAng+0.9;
  const groupRadius=Math.hypot(groupOut.clientX-(rect().left+gcsx),groupOut.clientY-(rect().top+gcsy));
  const groupEnd={clientX:rect().left+gcsx+Math.cos(groupEndAng)*groupRadius,clientY:rect().top+gcsy+Math.sin(groupEndAng)*groupRadius};
  fire('pointerdown',groupOut);
  fire('pointermove',groupEnd,{drag:true});
  fire('pointerup',groupEnd,{drag:true,button:0,buttons:0});
  await wait(40);
  const multi={imgRot:image().rot||0,noteRot:note().rot||0,imgCx:image().x+image().w/2,imgCy:image().y+image().h/2,noteCx:note().x+note().w/2,noteCy:note().y+note().h/2};
  image().rot=0;image().x=imgStart.x;image().y=imgStart.y;
  note().rot=0;note().x=noteStart.x;note().y=noteStart.y;
  window.RefBoard.state.sel=new Set([image().id]);
  const shiftStart=seOutward();
  const [scx,scy]=toScreen(image().x+image().w/2,image().y+image().h/2);
  const shiftStartAng=Math.atan2(shiftStart.clientY-(rect().top+scy),shiftStart.clientX-(rect().left+scx));
  const shiftEndAng=shiftStartAng+1.1;
  const shiftRadius=Math.hypot(shiftStart.clientX-(rect().left+scx),shiftStart.clientY-(rect().top+scy));
  const shiftEnd={clientX:rect().left+scx+Math.cos(shiftEndAng)*shiftRadius,clientY:rect().top+scy+Math.sin(shiftEndAng)*shiftRadius};
  const rotBeforeShift=image().rot||0;
  fire('pointerdown',shiftStart,{shiftKey:true});
  fire('pointermove',shiftEnd,{drag:true,shiftKey:true});
  fire('pointerup',shiftEnd,{drag:true,button:0,buttons:0,shiftKey:true});
  await wait(40);
  const rotAfterShift=image().rot||0;
  const makeNote=(id,x,y)=>({id,kind:'note',x,y,w:120,h:80,rot:0,text:'n',color:'#15161c',textColor:'#f0f2f6',opacity:1,fontFamily:'Segoe UI',fontSize:15,scale:1,bold:false,italic:false,underline:false,textAlign:'left',groupId:null});
  window.RefBoard.state.items.push(makeNote('bbox-a',0,0),makeNote('bbox-b',200,0),makeNote('bbox-c',0,140));
  window.RefBoard.state.sel=new Set(['bbox-a','bbox-b','bbox-c']);
  window.RefBoard.invalidate();
  window.RefBoard.fitAll();
  await wait(120);
  const notes=window.RefBoard.state.items.filter(it=>['bbox-a','bbox-b','bbox-c'].includes(it.id));
  if(notes.length!==3)throw new Error('gapped multi-select notes were not added');
  const left=Math.min(...notes.map(it=>it.x));
  const top=Math.min(...notes.map(it=>it.y));
  const right=Math.max(...notes.map(it=>it.x+it.w));
  const bottom=Math.max(...notes.map(it=>it.y+it.h));
  const innerRight=Math.max(...notes.filter(it=>it.id!=='bbox-b').map(it=>it.x+it.w));
  const innerBottom=Math.max(...notes.filter(it=>it.id!=='bbox-c').map(it=>it.y+it.h));
  const canvas=document.getElementById('board');
  const dpr=window.devicePixelRatio||1;
  const read=canvas.getContext('2d');
  const boardView=window.RefBoard.state.view;
  const sampleBoard=(bx,by)=>{
    const sx=bx*boardView.s+boardView.tx, sy=by*boardView.s+boardView.ty;
    const px=Math.round(sx*dpr), py=Math.round(sy*dpr);
    let hits=0;
    for(let dy=-3;dy<=3;dy++)for(let dx=-3;dx<=3;dx++){
      const x=px+dx,y=py+dy;
      if(x<0||y<0||x>=canvas.width||y>=canvas.height)continue;
      const p=read.getImageData(x,y,1,1).data;
      if(p[2]>180&&p[0]<140&&p[1]>110&&p[3]>80)hits++;
    }
    return hits;
  };
  const sampleHandle=(bx,by)=>{
    const sx=bx*boardView.s+boardView.tx, sy=by*boardView.s+boardView.ty;
    const px=Math.round(sx*dpr), py=Math.round(sy*dpr);
    let hits=0;
    for(let dy=-5;dy<=5;dy++)for(let dx=-5;dx<=5;dx++){
      const x=px+dx,y=py+dy;
      if(x<0||y<0||x>=canvas.width||y>=canvas.height)continue;
      const p=read.getImageData(x,y,1,1).data;
      if(p[2]>200&&p[1]>170&&p[0]>140&&p[3]>80)hits++;
    }
    return hits;
  };
  const emptyRight=sampleBoard(right,(innerBottom+bottom)/2);
  const emptyBottom=sampleBoard((innerRight+right)/2,bottom);
  const emptyInside=sampleBoard((innerRight+right)/2,(innerBottom+bottom)/2);
  const bboxOriginX=(left+right)/2, bboxOriginY=(top+bottom)/2;
  const [bboxCsx,bboxCsy]=toScreen(bboxOriginX,bboxOriginY);
  const [bboxSx,bboxSy]=toScreen(right,bottom);
  const bboxDx=bboxSx-bboxCsx,bboxDy=bboxSy-bboxCsy,bboxLen=Math.hypot(bboxDx,bboxDy)||1;
  const bboxOut=toClient(bboxSx+(bboxDx/bboxLen)*22,bboxSy+(bboxDy/bboxLen)*22);
  const bboxStartAng=Math.atan2(bboxOut.clientY-(rect().top+bboxCsy),bboxOut.clientX-(rect().left+bboxCsx));
  const bboxEndAng=bboxStartAng+0.3;
  const bboxRadius=Math.hypot(bboxOut.clientX-(rect().left+bboxCsx),bboxOut.clientY-(rect().top+bboxCsy));
  const bboxEnd={clientX:rect().left+bboxCsx+Math.cos(bboxEndAng)*bboxRadius,clientY:rect().top+bboxCsy+Math.sin(bboxEndAng)*bboxRadius};
  fire('pointerdown',bboxOut);
  fire('pointermove',bboxEnd,{drag:true});
  await wait(50);
  const rotatingType=window.RefBoard.mode?.type;
  const itemAabb=it=>{
    const rad=((it.rot||0)*Math.PI)/180;
    const cx=it.x+it.w/2, cy=it.y+it.h/2, hw=it.w/2, hh=it.h/2;
    const pts=[[-hw,-hh],[hw,-hh],[hw,hh],[-hw,hh]].map(([lx,ly])=>[cx+lx*Math.cos(rad)-ly*Math.sin(rad),cy+lx*Math.sin(rad)+ly*Math.cos(rad)]);
    const xs=pts.map(p=>p[0]), ys=pts.map(p=>p[1]);
    return {x:Math.min(...xs),y:Math.min(...ys),r:Math.max(...xs),b:Math.max(...ys)};
  };
  const live=window.RefBoard.state.items.filter(it=>['bbox-a','bbox-b','bbox-c'].includes(it.id)).map(itemAabb);
  const liveRight=Math.max(...live.map(b=>b.r));
  const liveBottom=Math.max(...live.map(b=>b.b));
  const liveTop=Math.min(...live.map(b=>b.y));
  const emptyRightDuringRotate=sampleBoard(liveRight,liveTop+(liveBottom-liveTop)*0.75);
  fire('pointerup',bboxEnd,{drag:true,button:0,buttons:0});
  await wait(50);
  const emptyRightAfterRotate=sampleBoard(liveRight,liveTop+(liveBottom-liveTop)*0.75);
  const handleAfterRotate=sampleHandle(liveRight,liveBottom);
  const reset=[{id:'bbox-a',x:0,y:0},{id:'bbox-b',x:200,y:0},{id:'bbox-c',x:0,y:140}];
  for(const o of reset){
    const it=window.RefBoard.state.items.find(item=>item.id===o.id);
    if(!it)continue;
    it.x=o.x;it.y=o.y;it.rot=0;
  }
  window.RefBoard.invalidate();
  await wait(50);
  const emptyRightUntilted=sampleBoard(right,(innerBottom+bottom)/2);
  return {
    resizeCursor,rotateCursor,beforeRotate,afterRotate,beforeResize,afterResize,
    imgStart,noteStart,multi,rotBeforeShift,rotAfterShift,
    emptyRight,emptyBottom,emptyInside,rotatingType,emptyRightDuringRotate,emptyRightAfterRotate,handleAfterRotate,emptyRightUntilted,
    bbox:{left,top,right,bottom,innerRight,innerBottom}
  };
})()`;

try {
  const port = await debuggerPort();
  const result = await evaluate(port, smokeExpression);
  assert.match(String(result.resizeCursor), /resize/i, 'hovering a corner handle should show a resize cursor');
  assert.match(String(result.rotateCursor), /url\(/, 'hovering just outside a corner should show the rotate cursor');
  assert.match(String(result.rotateCursor), /svg\+xml/, 'the rotate cursor should be an SVG data URI, not a CSS resize cursor');
  assert.doesNotMatch(String(result.rotateCursor), /resize/i, 'the rotate ring must not keep a resize cursor');
  assert.ok(Math.abs(result.afterRotate.rot - result.beforeRotate.rot) > 5, `free corner drag should change rotation (was ${result.beforeRotate.rot}, now ${result.afterRotate.rot})`);
  assert.equal(result.afterRotate.w, result.beforeRotate.w, 'rotate drag should not change width');
  assert.equal(result.afterRotate.h, result.beforeRotate.h, 'rotate drag should not change height');
  assert.ok(Math.abs((result.afterRotate.x + result.afterRotate.w / 2) - (result.beforeRotate.x + result.beforeRotate.w / 2)) < 1.5, 'single-image rotate should keep the item center');
  assert.ok(result.afterResize.w !== result.beforeResize.w || result.afterResize.h !== result.beforeResize.h, 'inner corner drag should still resize');
  assert.equal(result.afterResize.rot, result.beforeResize.rot, 'inner corner drag should not rotate');
  assert.ok(Math.abs(result.multi.imgRot - result.multi.noteRot) < 1, 'multi-select rotate should apply the same delta to image and note');
  assert.ok(Math.abs(result.multi.imgRot) > 5, 'multi-select rotate should change rotation');
  assert.ok(
    Math.hypot(result.multi.imgCx - result.imgStart.cx, result.multi.imgCy - result.imgStart.cy) > 4
    || Math.hypot(result.multi.noteCx - result.noteStart.cx, result.multi.noteCy - result.noteStart.cy) > 4,
    'multi-select rotate should orbit items around the selection center',
  );
  const snapped = ((result.rotAfterShift % 360) + 360) % 360;
  assert.ok(snapped % 90 === 0, `Shift rotate should snap to 90° (got ${result.rotAfterShift})`);
  assert.notEqual(snapped, result.rotBeforeShift, 'Shift rotate should move to a new 90° step');
  assert.ok(result.emptyRight > 0, `empty right edge of a gapped multi-select should be stroked (hits=${result.emptyRight})`);
  assert.ok(result.emptyBottom > 0, `empty bottom edge of a gapped multi-select should be stroked (hits=${result.emptyBottom})`);
  assert.ok(result.emptyInside === 0, `empty interior of a gapped multi-select should not be filled (hits=${result.emptyInside})`);
  assert.equal(result.rotatingType, 'rotate', 'gapped multi-select corner drag should enter rotate mode');
  assert.equal(result.emptyRightDuringRotate, 0, `group box must not stroke during rotate (hits=${result.emptyRightDuringRotate})`);
  assert.equal(result.emptyRightAfterRotate, 0, `group box must stay hidden after leaving a tilted selection (hits=${result.emptyRightAfterRotate})`);
  assert.ok(result.handleAfterRotate > 0, `tilted multi-select should still show corner cubes (hits=${result.handleAfterRotate})`);
  assert.ok(result.emptyRightUntilted > 0, `group box should return once the selection is axis-aligned again (hits=${result.emptyRightUntilted})`);
  console.log('corner rotate Electron smoke passed');
} finally {
  if (child.exitCode === null) child.kill();
  await Promise.race([once(child, 'exit'), delay(3000)]).catch(() => {});
  await removeProfileDir(profile);
}
