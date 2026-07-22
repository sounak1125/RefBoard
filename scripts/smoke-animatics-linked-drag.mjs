import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const profile = await mkdtemp(path.join(os.tmpdir(), 'refboard-animatics-linked-drag-smoke-'));
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
  const target = targets.find(entry => entry.type === 'page' && /RefBoard|index\.html/i.test(`${entry.title} ${entry.url}`)) || targets.find(entry => entry.type === 'page');
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
  const clip=(id,track,start,duration,linkGroupId)=>({id,itemId:id,track,start,duration,name:id,linkGroupId,framing:{fit:'contain',scale:1,x:0,y:0}});
  const video=(id,track,start,duration)=>({id,mediaId:id,mediaKind:'video',track,start,duration,sourceIn:0,sourceOut:duration,originalDuration:10,name:id,framing:{fit:'contain',scale:1,x:0,y:0}});
  const audio=(id,track,start,duration)=>({id,mediaId:id,track,start,duration,sourceIn:0,sourceOut:duration,originalDuration:10,name:id,volume:1});
  window.RefBoard.animatics.load({fps:30,sequenceDuration:20,timelineZoom:90,videoTracks:3,clips:[clip('linked-a',0,2,4,'pair'),clip('linked-b',1,2.5,4,'pair')]},new Map());
  window.RefBoard.animatics.open();await wait(120);

  const drag=async(id,targetTrack,deltaSeconds,pointerId)=>{
    const element=document.querySelector('[data-clip="'+id+'"]'),kind=element.dataset.kind,source=element.getBoundingClientRect(),lane=document.querySelector('.an-track-lane[data-kind="'+kind+'"][data-track="'+targetTrack+'"]'),laneRect=lane.getBoundingClientRect(),px=Number(document.querySelector('#anZoom').value),startX=source.left+source.width/2,targetX=startX+deltaSeconds*px,targetY=laneRect.top+laneRect.height/2;
    element.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId,clientX:startX,clientY:source.top+source.height/2,button:0}));
    const idleGhostCount=document.querySelectorAll('.an-drag-ghost').length;
    element.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId,clientX:targetX,clientY:targetY,buttons:1}));
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    const project=window.RefBoard.animatics.serialize(),items=[...project.clips,...project.audio],ghosts=[...document.querySelectorAll('.an-drag-ghost')].map(ghost=>{const item=items.find(candidate=>candidate.id===ghost.dataset.clip),ghostKind=ghost.dataset.kind,target=document.querySelector('.an-track-lane[data-kind="'+ghostKind+'"][data-track="'+item.track+'"]').getBoundingClientRect(),bounds=ghost.getBoundingClientRect();return {id:item.id,topAligned:Math.abs(bounds.top-(target.top+4))<1,leftAligned:Math.abs(bounds.left-(target.left+item.start*px))<2};}),snapGuide=document.querySelector('.an-snap-guide.show span')?.textContent||'';
    element.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId,clientX:targetX,clientY:targetY,button:0}));
    return {project,ghosts,idleGhostCount,snapGuide};
  };
  const trim=(id,edge,deltaSeconds,pointerId)=>{
    const element=document.querySelector('[data-clip="'+id+'"]'),handle=element.querySelector('[data-trim="'+edge+'"]'),source=element.getBoundingClientRect(),px=Number(document.querySelector('#anZoom').value),startX=edge==='left'?source.left+1:source.right-1,targetX=startX+deltaSeconds*px,y=source.top+source.height/2;
    handle.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId,clientX:startX,clientY:y,button:0}));
    handle.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId,clientX:targetX,clientY:y,buttons:1}));
    const project=window.RefBoard.animatics.serialize(),snapGuide=document.querySelector('.an-snap-guide.show span')?.textContent||'';
    handle.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId,clientX:targetX,clientY:y,button:0}));
    return {project,snapGuide};
  };

  const blocked=await drag('linked-b',0,1,51),blockedCommitted=window.RefBoard.animatics.serialize();
  const moved=await drag('linked-a',1,0,52),movedCommitted=window.RefBoard.animatics.serialize();

  window.RefBoard.animatics.load({fps:30,sequenceDuration:20,timelineZoom:90,videoTracks:2,clips:[clip('snap-a',0,0,2,'snap-pair'),clip('snap-b',1,5,2,'snap-pair'),clip('stationary',1,8,2)]},new Map());await wait(80);
  const snapElement=document.querySelector('[data-clip="snap-a"]'),snapRect=snapElement.getBoundingClientRect(),snapPx=Number(document.querySelector('#anZoom').value),snapY=snapRect.top+snapRect.height/2,snapStartX=snapRect.left+snapRect.width/2;
  snapElement.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:53,clientX:snapStartX,clientY:snapY,button:0}));
  snapElement.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:53,clientX:snapStartX+.95*snapPx,clientY:snapY,buttons:1}));
  const snapped=window.RefBoard.animatics.serialize(),snapGuide=document.querySelector('.an-snap-guide span').textContent;
  snapElement.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:53,clientX:snapStartX+.95*snapPx,clientY:snapY,button:0}));

  window.RefBoard.animatics.load({fps:30,sequenceDuration:20,timelineZoom:90,videoTracks:2,clips:[clip('cross-video',0,0,2),clip('video-anchor',1,5,2)]},new Map());await wait(80);
  const crossVideo=await drag('cross-video',0,2.95,54);
  window.RefBoard.animatics.load({fps:30,sequenceDuration:20,timelineZoom:90,videoTracks:1,audioTracks:2,audio:[audio('cross-audio',0,0,2),audio('audio-anchor',1,5,2)]},new Map());await wait(80);
  const crossAudio=await drag('cross-audio',0,2.95,55);
  window.RefBoard.animatics.load({fps:30,sequenceDuration:20,timelineZoom:90,videoTracks:1,audioTracks:1,clips:[clip('video-to-audio',0,0,2)],audio:[audio('move-audio-anchor',0,5,2)]},new Map());await wait(80);
  const videoToAudio=await drag('video-to-audio',0,2.95,56);
  window.RefBoard.animatics.load({fps:30,sequenceDuration:20,timelineZoom:90,videoTracks:1,audioTracks:1,clips:[clip('move-video-anchor',0,5,2)],audio:[audio('audio-to-video',0,0,2)]},new Map());await wait(80);
  const audioToVideo=await drag('audio-to-video',0,2.95,57);
  window.RefBoard.animatics.load({fps:30,sequenceDuration:20,timelineZoom:90,videoTracks:1,audioTracks:1,clips:[video('trim-video',0,0,2)],audio:[audio('trim-audio-anchor',0,5,2)]},new Map());await wait(80);
  const videoTrimToAudio=trim('trim-video','right',2.95,58);
  window.RefBoard.animatics.load({fps:30,sequenceDuration:20,timelineZoom:90,videoTracks:1,audioTracks:1,clips:[clip('trim-video-anchor',0,5,2)],audio:[audio('trim-audio',0,0,2)]},new Map());await wait(80);
  const audioTrimToVideo=trim('trim-audio','right',2.95,59);

  const denseAudio=Array.from({length:420},(_,index)=>audio('dense-'+index,0,index*2,1));
  window.RefBoard.animatics.load({fps:30,sequenceDuration:900,timelineZoom:90,videoTracks:1,audioTracks:1,audio:denseAudio},new Map());document.querySelector('#anTlScroll').scrollLeft=0;await wait(140);
  const denseGrid=document.querySelector('#anTlGrid'),denseElement=denseGrid.querySelector('[data-clip="dense-0"]'),denseCanvas=denseElement.querySelector('canvas'),denseContext=denseCanvas.getContext('2d');denseContext.fillStyle='#ffffff';denseContext.fillRect(0,0,8,8);
  const denseBefore=denseGrid.querySelectorAll('.an-clip').length,denseRect=denseElement.getBoundingClientRect(),denseLane=denseElement.closest('.an-track-lane').getBoundingClientRect(),denseStartX=denseRect.left+denseRect.width/2,denseY=denseLane.top+denseLane.height/2;
  denseElement.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:81,clientX:denseStartX,clientY:denseY,button:0}));
  const denseOnPointerDown=denseGrid.querySelectorAll('.an-clip').length,rapidStart=performance.now();for(let index=1;index<=120;index++)denseElement.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:81,clientX:denseStartX+index*1.2,clientY:denseY,buttons:1}));const rapidDispatchMs=performance.now()-rapidStart;
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  const denseGhost=document.querySelector('.an-drag-ghost[data-clip="dense-0"]'),ghostCanvas=denseGhost?.querySelector('canvas'),ghostPixelAlpha=ghostCanvas?.getContext('2d').getImageData(2,2,1,1).data[3]||0,ghostBounds=denseGhost?.getBoundingClientRect(),denseDuring=denseGrid.querySelectorAll('.an-clip').length,ghostVisible=!!ghostBounds&&ghostBounds.width>0&&ghostBounds.height>0&&Number(getComputedStyle(denseGhost).opacity)>.8,sourceOpacity=Number(getComputedStyle(denseElement).opacity);
  denseElement.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:81,clientX:denseStartX+144,clientY:denseY,button:0}));await new Promise(resolve=>requestAnimationFrame(resolve));
  const denseAfter=denseGrid.querySelectorAll('.an-clip').length,denseTotal=window.RefBoard.animatics.serialize().audio.length;
  const denseDrag={denseBefore,denseOnPointerDown,denseDuring,denseAfter,denseTotal,rapidDispatchMs,ghostPixelAlpha,ghostVisible,sourceOpacity};
  return {blocked,blockedCommitted,moved,movedCommitted,snapped,snapGuide,crossVideo,crossAudio,videoToAudio,audioToVideo,videoTrimToAudio,audioTrimToVideo,denseDrag};
})()`;

try {
  const result = await evaluate(await debuggerPort(), smokeExpression);
  assert.deepEqual(result.blocked.project.clips.map(clip => [clip.id,clip.track,clip.start]), [['linked-a',0,3],['linked-b',1,3.5]], 'boundary drag must preserve linked track spacing and time offsets');
  assert.deepEqual(result.blockedCommitted.clips.map(clip => [clip.id,clip.track,clip.start]), [['linked-a',0,3],['linked-b',1,3.5]]);
  assert.equal(result.blocked.idleGhostCount,0,'pointer-down selection must not create drag ghosts before movement');
  assert.equal(result.blocked.ghosts.length,2,'both linked clips must have drag ghosts');
  assert.ok(result.blocked.ghosts.every(ghost=>ghost.topAligned&&ghost.leftAligned),'every linked ghost must follow its exact clip without lag or index mismatch');
  assert.deepEqual(result.moved.project.clips.map(clip => [clip.id,clip.track,clip.start]), [['linked-a',1,3],['linked-b',2,3.5]], 'linked V1/V2 clips must move intact to V2/V3');
  assert.deepEqual(result.movedCommitted.clips.map(clip => [clip.id,clip.track,clip.start]), [['linked-a',1,3],['linked-b',2,3.5]]);
  assert.ok(result.moved.ghosts.every(ghost=>ghost.topAligned&&ghost.leftAligned));
  assert.deepEqual(result.snapped.clips.map(clip=>[clip.id,Math.round(clip.start*1e9)/1e9]),[['snap-a',1],['snap-b',6],['stationary',8]],'a secondary linked edge must snap the complete group');
  assert.equal(result.snapGuide,'00:00:08:00');
  assert.equal(result.crossVideo.project.clips.find(clip=>clip.id==='cross-video').start,3,'a video clip must snap to an edge on another video track');
  assert.equal(result.crossVideo.snapGuide,'00:00:05:00','cross-track video alignment must display the full timeline snap guide');
  assert.equal(result.crossAudio.project.audio.find(clip=>clip.id==='cross-audio').start,3,'an audio clip must snap to an edge on another audio track');
  assert.equal(result.crossAudio.snapGuide,'00:00:05:00','cross-track audio alignment must display the full timeline snap guide');
  assert.equal(result.videoToAudio.project.clips.find(clip=>clip.id==='video-to-audio').start,3,'a video clip must snap while moving to an audio edge');
  assert.equal(result.videoToAudio.snapGuide,'00:00:05:00');
  assert.equal(result.audioToVideo.project.audio.find(clip=>clip.id==='audio-to-video').start,3,'an audio clip must snap while moving to a video edge');
  assert.equal(result.audioToVideo.snapGuide,'00:00:05:00');
  assert.equal(result.videoTrimToAudio.project.clips.find(clip=>clip.id==='trim-video').duration,5,'a video right edge must snap to an audio edge');
  assert.equal(result.videoTrimToAudio.snapGuide,'00:00:05:00');
  assert.equal(result.audioTrimToVideo.project.audio.find(clip=>clip.id==='trim-audio').duration,5,'an audio right edge must snap to a video edge');
  assert.equal(result.audioTrimToVideo.snapGuide,'00:00:05:00');
  assert.ok(result.denseDrag.denseBefore<result.denseDrag.denseTotal/4,'large timelines must virtualize most off-screen clips before dragging');
  assert.equal(result.denseDrag.denseOnPointerDown,result.denseDrag.denseBefore,'pointer-down must not mount every off-screen clip');
  assert.equal(result.denseDrag.denseDuring,result.denseDrag.denseBefore,'rapid dragging must keep the virtualized DOM stable');
  assert.ok(result.denseDrag.denseAfter<result.denseDrag.denseTotal/4,'drag commit must return to a bounded virtualized DOM');
  assert.ok(result.denseDrag.ghostVisible,'the compositor-backed drag ghost must remain visible');
  assert.ok(result.denseDrag.ghostPixelAlpha>0,'audio drag ghosts must copy the waveform canvas bitmap');
  assert.ok(result.denseDrag.sourceOpacity>=.4,'the source clip must not disappear while its drag ghost is shown');
  assert.ok(result.denseDrag.rapidDispatchMs<250,`rapid timeline dragging must remain responsive (${result.denseDrag.rapidDispatchMs} ms)`);
  console.log('animatics Electron linked-drag smoke passed');
} finally {
  if (child.exitCode === null) child.kill();
  await Promise.race([once(child, 'exit'), delay(3000)]).catch(() => {});
  await rm(profile, { recursive:true, force:true });
}
