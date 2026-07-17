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
  window.RefBoard.animatics.load({fps:30,sequenceDuration:20,timelineZoom:90,videoTracks:3,clips:[clip('linked-a',0,2,4,'pair'),clip('linked-b',1,2.5,4,'pair')]},new Map());
  window.RefBoard.animatics.open();await wait(120);

  const drag=(id,targetTrack,deltaSeconds,pointerId)=>{
    const element=document.querySelector('[data-clip="'+id+'"]'),source=element.getBoundingClientRect(),lane=document.querySelector('.an-track-lane[data-kind="video"][data-track="'+targetTrack+'"]'),laneRect=lane.getBoundingClientRect(),px=Number(document.querySelector('#anZoom').value),startX=source.left+source.width/2,targetX=startX+deltaSeconds*px,targetY=laneRect.top+laneRect.height/2;
    element.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId,clientX:startX,clientY:source.top+source.height/2,button:0}));
    element.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId,clientX:targetX,clientY:targetY,buttons:1}));
    const project=window.RefBoard.animatics.serialize(),ghosts=[...document.querySelectorAll('.an-drag-ghost')].map(ghost=>{const item=project.clips.find(candidate=>candidate.id===ghost.dataset.clip),target=document.querySelector('.an-track-lane[data-kind="video"][data-track="'+item.track+'"]').getBoundingClientRect();return {id:item.id,topAligned:Math.abs(parseFloat(ghost.style.top)-(target.top+4))<1,leftAligned:Math.abs(parseFloat(ghost.style.left)-(target.left+item.start*px))<2};});
    element.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId,clientX:targetX,clientY:targetY,button:0}));
    return {project,ghosts};
  };

  const blocked=drag('linked-b',0,1,51),blockedCommitted=window.RefBoard.animatics.serialize();
  const moved=drag('linked-a',1,0,52),movedCommitted=window.RefBoard.animatics.serialize();

  window.RefBoard.animatics.load({fps:30,sequenceDuration:20,timelineZoom:90,videoTracks:2,clips:[clip('snap-a',0,0,2,'snap-pair'),clip('snap-b',1,5,2,'snap-pair'),clip('stationary',1,8,2)]},new Map());await wait(80);
  const snapElement=document.querySelector('[data-clip="snap-a"]'),snapRect=snapElement.getBoundingClientRect(),snapPx=Number(document.querySelector('#anZoom').value),snapY=snapRect.top+snapRect.height/2,snapStartX=snapRect.left+snapRect.width/2;
  snapElement.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:53,clientX:snapStartX,clientY:snapY,button:0}));
  snapElement.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:53,clientX:snapStartX+.95*snapPx,clientY:snapY,buttons:1}));
  const snapped=window.RefBoard.animatics.serialize(),snapGuide=document.querySelector('.an-snap-guide span').textContent;
  snapElement.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:53,clientX:snapStartX+.95*snapPx,clientY:snapY,button:0}));
  return {blocked,blockedCommitted,moved,movedCommitted,snapped,snapGuide};
})()`;

try {
  const result = await evaluate(await debuggerPort(), smokeExpression);
  assert.deepEqual(result.blocked.project.clips.map(clip => [clip.id,clip.track,clip.start]), [['linked-a',0,3],['linked-b',1,3.5]], 'boundary drag must preserve linked track spacing and time offsets');
  assert.deepEqual(result.blockedCommitted.clips.map(clip => [clip.id,clip.track,clip.start]), [['linked-a',0,3],['linked-b',1,3.5]]);
  assert.equal(result.blocked.ghosts.length,2,'both linked clips must have drag ghosts');
  assert.ok(result.blocked.ghosts.every(ghost=>ghost.topAligned&&ghost.leftAligned),'every linked ghost must follow its exact clip without lag or index mismatch');
  assert.deepEqual(result.moved.project.clips.map(clip => [clip.id,clip.track,clip.start]), [['linked-a',1,3],['linked-b',2,3.5]], 'linked V1/V2 clips must move intact to V2/V3');
  assert.deepEqual(result.movedCommitted.clips.map(clip => [clip.id,clip.track,clip.start]), [['linked-a',1,3],['linked-b',2,3.5]]);
  assert.ok(result.moved.ghosts.every(ghost=>ghost.topAligned&&ghost.leftAligned));
  assert.deepEqual(result.snapped.clips.map(clip=>[clip.id,Math.round(clip.start*1e9)/1e9]),[['snap-a',1],['snap-b',6],['stationary',8]],'a secondary linked edge must snap the complete group');
  assert.equal(result.snapGuide,'00:00:08:00');
  console.log('animatics Electron linked-drag smoke passed');
} finally {
  if (child.exitCode === null) child.kill();
  await Promise.race([once(child, 'exit'), delay(3000)]).catch(() => {});
  await rm(profile, { recursive:true, force:true });
}
