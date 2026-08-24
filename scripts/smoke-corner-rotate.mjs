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

const smokeExpression = String.raw`(async()=>{
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  Element.prototype.setPointerCapture=()=>{};
  Element.prototype.releasePointerCapture=()=>{};
  for(let attempt=0;attempt<100&&!window.RefBoard;attempt++)await wait(50);
  if(!window.RefBoard)throw new Error('RefBoard API unavailable');
  // init() ends by navigating to the landing view; anything done before
  // that point gets torn down again. Wait for startup to finish.
  for(let attempt=0;attempt<300&&!window.RefBoard.startupComplete;attempt++)await wait(50);
  if(!window.RefBoard.startupComplete)throw new Error('RefBoard startup did not complete');
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
  const glyphDeg=c=>{const m=decodeURIComponent(c||'').match(/rotate\((-?[\d.]+) 16 16\)/);return m?((+m[1]%360)+360)%360:null;};
  fire('pointermove',groupOut);
  await wait(20);
  const groupGlyphIdle=glyphDeg(board.style.cursor);
  fire('pointerdown',groupOut);
  fire('pointermove',groupEnd,{drag:true});
  await wait(20);
  const groupGlyphDragging=glyphDeg(board.style.cursor);
  fire('pointerup',groupEnd,{drag:true,button:0,buttons:0});
  await wait(40);
  const multi={imgRot:image().rot||0,noteRot:note().rot||0,imgCx:image().x+image().w/2,imgCy:image().y+image().h/2,noteCx:note().x+note().w/2,noteCy:note().y+note().h/2};
  // The frame keeps the angle it was rotated to, so the same spot outside the
  // corner is still a rotate handle and its glyph still reports the new angle.
  fire('pointermove',groupEnd);
  await wait(20);
  const groupGlyphAtRest=glyphDeg(board.style.cursor);
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
  return {
    resizeCursor,rotateCursor,beforeRotate,afterRotate,beforeResize,afterResize,
    imgStart,noteStart,multi,rotBeforeShift,rotAfterShift,
    groupGlyphIdle,groupGlyphDragging,groupGlyphAtRest
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
  assert.equal(result.groupGlyphIdle, 0, 'an unrotated group frame should show an unrotated glyph');
  assert.ok(result.groupGlyphDragging > 5, `the group rotate glyph should turn with the drag (got ${result.groupGlyphDragging})`);
  assert.ok(
    result.groupGlyphAtRest !== null && Math.abs(result.groupGlyphAtRest - result.groupGlyphDragging) < 3,
    `the group frame should keep its angle after release (dragging ${result.groupGlyphDragging}, at rest ${result.groupGlyphAtRest})`,
  );
  const snapped = ((result.rotAfterShift % 360) + 360) % 360;
  assert.ok(snapped % 90 === 0, `Shift rotate should snap to 90° (got ${result.rotAfterShift})`);
  assert.notEqual(snapped, result.rotBeforeShift, 'Shift rotate should move to a new 90° step');
  console.log('corner rotate Electron smoke passed');
} finally {
  if (child.exitCode === null) child.kill();
  await Promise.race([once(child, 'exit'), delay(3000)]).catch(() => {});
  await removeProfileDir(profile);
}
