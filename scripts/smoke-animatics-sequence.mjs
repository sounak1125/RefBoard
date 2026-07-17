import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const profile = await mkdtemp(path.join(os.tmpdir(), 'refboard-animatics-sequence-smoke-'));
const child = spawn(electron, ['.', '--remote-debugging-port=0', `--user-data-dir=${profile}`], {
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
    const handlers = pending.get(message.id);pending.delete(message.id);
    if (message.error) handlers.reject(new Error(message.error.message)); else handlers.resolve(message.result);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;pending.set(id, { resolve, reject });socket.send(JSON.stringify({ id, method, params }));
  });
  await send('Runtime.enable');
  const response = await send('Runtime.evaluate', { expression, awaitPromise:true, returnByValue:true });
  socket.close();
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  return response.result.value;
}

const smokeExpression = String.raw`(async()=>{
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  for(let attempt=0;attempt<100&&!window.RefBoard;attempt++)await wait(50);
  if(!window.RefBoard)throw new Error('RefBoard API unavailable');
  Element.prototype.setPointerCapture=()=>{};Element.prototype.releasePointerCapture=()=>{};
  window.RefBoard.animatics.clear();window.RefBoard.animatics.open();await wait(150);
  const labelWidth=parseFloat(getComputedStyle(document.querySelector('#animaticsWorkspace')).getPropertyValue('--an-track-label-w'));
  document.querySelector('#anSequenceSettings').click();
  const mode=document.querySelector('#anSequenceMode'),field=document.querySelector('#anSequenceDuration');
  const initial={mode:mode.value,value:field.value,disabled:field.disabled,presets:document.querySelectorAll('[data-sequence-seconds]').length,time:document.querySelector('#anTime').textContent,laneWidth:getComputedStyle(document.querySelector('#anTlGrid')).getPropertyValue('--an-lane-width').trim(),helpers:document.querySelectorAll('.an-help').length};
  field.value='00:03:00:00';field.dispatchEvent(new Event('input',{bubbles:true}));
  const modeAfterTyping=mode.value;
  document.querySelector('#anSequenceApply').click();await wait(100);
  const fixedProject=window.RefBoard.animatics.serialize();
  const fixed={duration:fixedProject.sequenceDuration,time:document.querySelector('#anTime').textContent,gridWidth:document.querySelector('#anTlGrid').style.width};
  const scroll=document.querySelector('#anTlScroll'),ruler=document.querySelector('.an-ruler'),scrollRect=scroll.getBoundingClientRect(),rulerRect=ruler.getBoundingClientRect();
  scroll.scrollLeft=0;
  ruler.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:41,clientX:rulerRect.left+10,clientY:rulerRect.top+10,button:0}));
  ruler.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:41,clientX:scrollRect.right+220,clientY:rulerRect.top+10,buttons:1}));
  const playheadFollow={scrollLeft:scroll.scrollLeft,hidden:document.querySelector('.an-playhead').classList.contains('out-of-view')};
  ruler.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:41,clientX:scrollRect.right+220,clientY:rulerRect.top+10,button:0}));
  const rulerOverlaps=[];
  for(const zoomValue of [.1,.5,3,10,90]){
    const zoom=document.querySelector('#anZoom');zoom.value=String(zoomValue);zoom.dispatchEvent(new Event('input',{bubbles:true}));
    const rects=[...document.querySelectorAll('.an-tick')].map(tick=>tick.getBoundingClientRect()).sort((a,b)=>a.left-b.left);
    rulerOverlaps.push(rects.some((rect,index)=>index>0&&rect.left<rects[index-1].right-.5));
  }
  const zoom=document.querySelector('#anZoom');zoom.value='.1';zoom.dispatchEvent(new Event('input',{bubbles:true}));
  const fittedLaneWidth=parseFloat(getComputedStyle(document.querySelector('#anTlGrid')).getPropertyValue('--an-lane-width')),fittedAvailable=scroll.clientWidth-labelWidth,fittedRowWidth=document.querySelector('.an-ruler-row').getBoundingClientRect().width;
  const finiteSurface={laneFills:Math.abs(fittedLaneWidth-fittedAvailable)<1,rowFills:Math.abs(fittedRowWidth-scroll.clientWidth)<1,endVisible:!!document.querySelector('.an-timeline-end'),atMinimum:Math.abs(Number(zoom.value)-Number(zoom.min))<.002};
  document.querySelector('#anSequenceSettings').click();
  const reopened={mode:mode.value,value:field.value};
  mode.value='auto';mode.dispatchEvent(new Event('change',{bubbles:true}));
  const autoFieldValue=field.value;
  document.querySelector('#anSequenceApply').click();await wait(100);
  const autoProject=window.RefBoard.animatics.serialize();
  const autoTime=document.querySelector('#anTime').textContent;

  window.RefBoard.animatics.load({fps:30,sequenceDuration:null,timelineZoom:90,videoTracks:1,clips:[{id:'extended-clip',itemId:'missing-image',track:0,start:29,duration:4,name:'Auto extension',framing:{fit:'contain',scale:1,x:0,y:0}}]},new Map());await wait(80);
  const autoExtended={time:document.querySelector('#anTime').textContent,laneWidth:getComputedStyle(document.querySelector('#anTlGrid')).getPropertyValue('--an-lane-width').trim()};

  window.RefBoard.animatics.load({fps:30,sequenceDuration:37,timelineZoom:1,videoTracks:1,clips:[{id:'full-clip',itemId:'existing-image',track:0,start:34,duration:3,name:'At sequence end',framing:{fit:'contain',scale:1,x:0,y:0}}]},new Map());await wait(80);
  window.RefBoard.animatics.close();window.RefBoard.animatics.open([{id:'board-imported',kind:'image',name:'Imported from board'}]);await wait(120);
  const appendedProject=window.RefBoard.animatics.serialize(),appendedClip=appendedProject.clips.find(clip=>clip.itemId==='board-imported'),appendedLaneWidth=parseFloat(getComputedStyle(document.querySelector('#anTlGrid')).getPropertyValue('--an-lane-width'));
  const fixedAppend={sequenceDuration:appendedProject.sequenceDuration,clipCount:appendedProject.clips.length,start:appendedClip?.start,duration:appendedClip?.duration,time:document.querySelector('#anTime').textContent,stillFitted:Math.abs(appendedLaneWidth-(scroll.clientWidth-labelWidth))<1};

  window.RefBoard.animatics.load({fps:30,sequenceDuration:5,timelineZoom:90,videoTracks:1,clips:[{id:'snap-clip',itemId:'missing-image',track:0,start:0,duration:3,name:'Snap smoke',framing:{fit:'contain',scale:1,x:0,y:0}}]},new Map());await wait(80);
  const trim=document.querySelector('[data-clip="snap-clip"] [data-trim="right"]'),lane=trim.closest('.an-track-lane'),trimRect=trim.getBoundingClientRect(),laneRect=lane.getBoundingClientRect(),snapPx=Number(document.querySelector('#anZoom').value);
  trim.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:42,clientX:trimRect.left+trimRect.width/2,clientY:trimRect.top+5,button:0}));
  trim.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:42,clientX:laneRect.left+5*snapPx-2,clientY:trimRect.top+5,buttons:1}));
  const snapGuide={visible:document.querySelector('.an-snap-guide').classList.contains('show'),label:document.querySelector('.an-snap-guide span').textContent};
  trim.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:42,clientX:laneRect.left+5*snapPx-2,clientY:trimRect.top+5,button:0}));
  const snappedDuration=window.RefBoard.animatics.serialize().clips[0].duration;

  window.RefBoard.animatics.load({fps:30,sequenceDuration:5,texts:[{id:'rotate-text',track:0,start:0,duration:3,content:'Rotate',size:42,color:'#ffffff',scale:1,rotation:0,x:.5,y:.5}]},new Map());await wait(80);
  const canvas=document.querySelector('#anViewer'),canvasRect=canvas.getBoundingClientRect(),cw=canvas.width,ch=canvas.height,unit=cw/1280,size=42*unit,lineH=size*1.18,pad=14*unit,halfH=lineH/2+pad,rotateOffset=30*cw/canvasRect.width,radius=halfH+rotateOffset;
  const clientPoint=(x,y)=>({x:canvasRect.left+x/cw*canvasRect.width,y:canvasRect.top+y/ch*canvasRect.height});
  const center={x:cw*.5,y:ch*.5},start=clientPoint(center.x,center.y-radius),shiftAngle=(-68)*Math.PI/180,shiftTarget=clientPoint(center.x+Math.cos(shiftAngle)*radius,center.y+Math.sin(shiftAngle)*radius),freeAngle=(-67.4)*Math.PI/180,freeTarget=clientPoint(center.x+Math.cos(freeAngle)*radius,center.y+Math.sin(freeAngle)*radius);
  canvas.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:43,clientX:start.x,clientY:start.y,button:0}));
  canvas.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:43,clientX:shiftTarget.x,clientY:shiftTarget.y,buttons:1,shiftKey:true}));
  const shiftRotation=window.RefBoard.animatics.serialize().texts[0].rotation;
  canvas.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:43,clientX:freeTarget.x,clientY:freeTarget.y,buttons:1}));
  const freeRotation=window.RefBoard.animatics.serialize().texts[0].rotation;
  canvas.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:43,clientX:freeTarget.x,clientY:freeTarget.y,button:0}));
  return {labelWidth,initial,modeAfterTyping,fixed,playheadFollow,rulerOverlaps,finiteSurface,reopened,autoFieldValue,autoDuration:autoProject.sequenceDuration,autoTime,autoExtended,fixedAppend,snapGuide,snappedDuration,shiftRotation,freeRotation};
})()`;

try {
  const result = await evaluate(await debuggerPort(), smokeExpression);
  assert.deepEqual(result.initial, { mode:'auto', value:'', disabled:false, presets:0, time:'00:00:00:00 / 00:00:30:00', laneWidth:'2700px', helpers:0 }, 'Auto must open as a clean finite thirty-second timeline');
  assert.equal(result.modeAfterTyping, 'fixed', 'typing a duration must switch to Custom');
  assert.equal(result.fixed.duration, 180, 'three-minute custom timecode must persist as 180 seconds');
  assert.match(result.fixed.time, /00:03:00:00$/, 'transport must use the custom sequence endpoint');
  assert.equal(result.labelWidth,216,'the live timeline must use the widened track-header gutter');
  assert.equal(parseFloat(result.fixed.gridWidth),result.labelWidth+180*90,'timeline ruler surface must expand to the custom duration at the default zoom');
  assert.ok(result.playheadFollow.scrollLeft>100, 'dragging the playhead beyond the viewport edge must scroll the timeline');
  assert.equal(result.playheadFollow.hidden, false, 'the followed playhead must remain visible');
  assert.deepEqual(result.rulerOverlaps, [false,false,false,false,false], 'timecode labels must never overlap across representative zoom levels');
  assert.deepEqual(result.finiteSurface, {laneFills:true,rowFills:true,endVisible:true,atMinimum:true}, 'furthest zoom-out must fit the complete sequence without a blank area');
  assert.deepEqual(result.reopened, { mode:'fixed', value:'00:03:00:00' }, 'custom duration must round-trip through the modal');
  assert.equal(result.autoFieldValue, '', 'switching to Auto must clear the fixed-duration field');
  assert.equal(result.autoDuration, null, 'Auto must restore content-following duration');
  assert.match(result.autoTime, /00:00:30:00$/, 'empty Auto sequence must return to its thirty-second endpoint');
  assert.deepEqual(result.autoExtended, {time:'00:00:00:00 / 00:00:33:00',laneWidth:'2970px'}, 'Auto timeline must extend when content passes thirty seconds');
  assert.deepEqual(result.fixedAppend, {sequenceDuration:40,clipCount:2,start:37,duration:3,time:'00:00:37:00 / 00:00:40:00',stillFitted:true}, 'board import at a fixed endpoint must add the image, extend the sequence, and stay fitted');
  assert.deepEqual(result.snapGuide, {visible:true,label:'00:00:05:00'}, 'right-edge trimming must show a labelled guide at the snapped sequence endpoint');
  assert.equal(result.snappedDuration, 5, 'right-edge trimming must commit the snapped duration');
  assert.equal(result.shiftRotation, 15, 'holding Shift must snap preview rotation to fifteen degrees');
  assert.equal(result.freeRotation, 23, 'releasing Shift must restore one-degree preview rotation');
  console.log('animatics Electron sequence-duration smoke passed');
} finally {
  if (child.exitCode === null) child.kill();
  await Promise.race([once(child, 'exit'), delay(3000)]).catch(() => {});
  await rm(profile, { recursive:true, force:true });
}
