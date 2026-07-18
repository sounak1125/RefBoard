import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const profile = await mkdtemp(path.join(os.tmpdir(), 'refboard-animatics-track-controls-smoke-'));
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
  const audio=(id,track,mediaId)=>({id,mediaId,track,start:0,duration:5,sourceIn:0,sourceOut:5,originalDuration:5,name:id,volume:1,type:'audio/mpeg'});
  const blobs=new Map([['audio-0',new Blob(['a'],{type:'audio/mpeg'})],['audio-1',new Blob(['b'],{type:'audio/mpeg'})]]);
  window.RefBoard.animatics.load({fps:30,sequenceDuration:10,timelineZoom:90,videoTracks:2,audioTracks:2,
    clips:[{id:'visual-0',itemId:'board-0',mediaKind:'image',track:0,start:0,duration:4,name:'Visual',enabled:true,framing:{fit:'contain',scale:1,x:0,y:0},strokes:[]}],
    texts:[{id:'text-0',track:0,start:0,duration:4,content:'Locked text',size:42,color:'#ffffff',scale:1,rotation:0,x:.5,y:.5}],
    audio:[audio('sound-0',0,'audio-0'),audio('sound-1',1,'audio-1')]},blobs);
  window.RefBoard.animatics.open();await wait(150);

  const layout=[...document.querySelectorAll('.an-track-label')].map(label=>{const labelRect=label.getBoundingClientRect(),actions=label.querySelector('.an-track-actions'),actionRect=actions?.getBoundingClientRect();return {clientWidth:label.clientWidth,scrollWidth:label.scrollWidth,contained:!actions||actionRect.left>=labelRect.left-1&&actionRect.right<=labelRect.right+1};});
  const side=document.querySelector('.an-side'),resizer=document.querySelector('#anInspectorResizer'),beforeInspectorWidth=side.getBoundingClientRect().width,resizerRect=resizer.getBoundingClientRect(),resizeX=resizerRect.left+resizerRect.width/2;
  resizer.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:70,clientX:resizeX,clientY:resizerRect.top+40,button:0}));
  resizer.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:70,clientX:resizeX+100,clientY:resizerRect.top+40,buttons:1}));
  resizer.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:70,clientX:resizeX+100,clientY:resizerRect.top+40,button:0}));await wait(30);
  const afterInspectorWidth=side.getBoundingClientRect().width,serializedInspectorWidth=window.RefBoard.animatics.serialize().inspectorWidth,tabLayouts=[];
  for(const tab of document.querySelectorAll('.an-tab')){tab.click();const panel=document.querySelector('[data-panel-body="'+tab.dataset.panel+'"]'),panelRect=panel.getBoundingClientRect(),results=new Map(),recordVisible=()=>{for(const button of panel.querySelectorAll('button')){const rect=button.getBoundingClientRect();if(rect.width>0)results.set(button,rect.left>=panelRect.left-1&&rect.right<=panelRect.right+1);}};recordVisible();if(tab.dataset.panel==='draw'){document.querySelector('#anDrawPen').click();recordVisible();document.querySelector('#anDrawColorButton').click();recordVisible();document.querySelector('#anDrawWidthMenuButton').click();recordVisible();}const buttons=[...panel.querySelectorAll('button')].map(button=>results.get(button)===true);tabLayouts.push({tab:tab.dataset.panel,active:tab.classList.contains('on')&&panel.classList.contains('on'),buttons});}
  document.querySelector('[data-panel="draw"]').click();document.querySelector('#anDrawWidthMenuButton').click();await wait(20);const workspace=document.querySelector('#animaticsWorkspace'),drawPanel=document.querySelector('[data-panel-body="draw"]'),menu=document.querySelector('#anDrawWidthMenu'),workspaceRect=workspace.getBoundingClientRect(),sideRect=side.getBoundingClientRect(),timelineRect=document.querySelector('.an-timeline').getBoundingClientRect(),menuRect=menu.getBoundingClientRect(),lastPresetRect=menu.querySelector('[data-an-draw-width="48"]').getBoundingClientRect(),inspectorLayout={timelineFullWidth:Math.abs(timelineRect.left-workspaceRect.left)<=1&&Math.abs(timelineRect.right-workspaceRect.right)<=1,inspectorAboveTimeline:Math.abs(sideRect.bottom-timelineRect.top)<=1,menuParent:menu.parentElement.id,menuWithinViewport:menuRect.left>=0&&menuRect.top>=0&&menuRect.right<=innerWidth&&menuRect.bottom<=innerHeight,lastPresetVisible:lastPresetRect.bottom<=menuRect.bottom+1,panelClientHeight:drawPanel.clientHeight,panelScrollHeight:drawPanel.scrollHeight,panelNoScroll:drawPanel.scrollHeight<=drawPanel.clientHeight+1};document.querySelector('#anDrawWidthMenuButton').click();
  const timelineResizer=document.querySelector('#anTimelineResizer'),beforeTimelineHeight=window.RefBoard.animatics.serialize().timelineHeight,timelineResizerRect=timelineResizer.getBoundingClientRect(),timelineResizeX=timelineResizerRect.left+timelineResizerRect.width/2,timelineResizeY=timelineResizerRect.top+timelineResizerRect.height/2;
  timelineResizer.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:74,clientX:timelineResizeX,clientY:timelineResizeY,button:0}));
  timelineResizer.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:74,clientX:timelineResizeX,clientY:timelineResizeY+50,buttons:1}));
  await wait(80);
  const liveTimelineHeight=window.RefBoard.animatics.serialize().timelineHeight,liveTimelineCss=parseFloat(getComputedStyle(workspace).getPropertyValue('--an-timeline-h'));
  timelineResizer.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:74,clientX:timelineResizeX,clientY:timelineResizeY+50,button:0}));await wait(30);
  const resizedTimelineHeight=window.RefBoard.animatics.serialize().timelineHeight,timelineResizeReleased=!timelineResizer.classList.contains('dragging');
  timelineResizer.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));await wait(30);const resetTimelineHeight=window.RefBoard.animatics.serialize().timelineHeight;
  document.querySelector('[data-toggle-audio-mute="0"]').click();
  document.querySelector('[data-toggle-audio-solo="1"]').click();
  document.querySelector('[data-toggle-track-lock="video"][data-track="0"]').click();
  document.querySelector('[data-toggle-track-lock="audio"][data-track="1"]').click();
  document.querySelector('[data-toggle-track-lock="text"]').click();
  await wait(30);
  const state=window.RefBoard.animatics.serialize();
  const disabledTargets=[document.querySelector('[data-target-track="video"][data-track="0"]').disabled,document.querySelector('[data-target-track="audio"][data-track="1"]').disabled];

  window.__played=[];
  class FakeAudio{constructor(src){this.src=src;this.currentTime=0;this.volume=1;this.paused=true;}play(){this.paused=false;window.__played.push(this.src);return Promise.resolve();}pause(){this.paused=true;}}
  Object.defineProperty(window,'Audio',{value:FakeAudio,configurable:true});
  Object.defineProperty(window,'AudioContext',{value:undefined,configurable:true});
  Object.defineProperty(window,'webkitAudioContext',{value:undefined,configurable:true});
  document.querySelector('#anPlay').click();await wait(40);document.querySelector('#anPlay').click();

  const before=window.RefBoard.animatics.serialize(),visual=document.querySelector('[data-clip="visual-0"]'),rect=visual.getBoundingClientRect();
  visual.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:71,clientX:rect.left+20,clientY:rect.top+10,button:0}));
  visual.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:71,clientX:rect.left+110,clientY:rect.top+10,buttons:1}));
  visual.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:71,clientX:rect.left+110,clientY:rect.top+10,button:0}));
  const sound=document.querySelector('[data-clip="sound-1"]'),soundRect=sound.getBoundingClientRect();
  sound.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:72,clientX:soundRect.left+20,clientY:soundRect.top+10,button:0}));
  sound.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:72,clientX:soundRect.left+110,clientY:soundRect.top+10,buttons:1}));
  sound.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:72,clientX:soundRect.left+110,clientY:soundRect.top+10,button:0}));
  const canvas=document.querySelector('#anViewer'),canvasRect=canvas.getBoundingClientRect(),textX=canvasRect.left+canvasRect.width/2,textY=canvasRect.top+canvasRect.height/2;
  canvas.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:73,clientX:textX,clientY:textY,button:0}));
  canvas.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:73,clientX:textX+80,clientY:textY+50,buttons:1}));
  canvas.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:73,clientX:textX+80,clientY:textY+50,button:0}));
  const after=window.RefBoard.animatics.serialize();
  return {layout,beforeInspectorWidth,afterInspectorWidth,serializedInspectorWidth,tabLayouts,inspectorLayout,beforeTimelineHeight,liveTimelineHeight,liveTimelineCss,resizedTimelineHeight,timelineResizeReleased,resetTimelineHeight,state,disabledTargets,played:window.__played.length,beforeClip:before.clips[0],afterClip:after.clips[0],beforeAudio:before.audio[1],afterAudio:after.audio[1],beforeText:before.texts[0],afterText:after.texts[0],toast:document.querySelector('#anToast').textContent};
})()`;

try {
  const result = await evaluate(await debuggerPort(), smokeExpression);
  assert.ok(result.layout.length>=5,'text, video, and audio track headers must render');
  assert.ok(result.layout.every(row=>row.contained&&row.scrollWidth<=row.clientWidth+1),'every track action group must remain inside the widened fixed header');
  assert.ok(result.afterInspectorWidth>=result.beforeInspectorWidth+99,'dragging the inspector divider must widen the tools panel');
  assert.equal(result.serializedInspectorWidth,result.afterInspectorWidth,'the resized inspector width must persist in project state');
  assert.ok(result.tabLayouts.every(panel=>panel.active&&panel.buttons.every(Boolean)),'every inspector tab and action button must remain usable after resizing');
  assert.equal(result.inspectorLayout.timelineFullWidth,true,'the timeline must retain its original full workspace width');
  assert.equal(result.inspectorLayout.inspectorAboveTimeline,true,'the inspector must remain limited to the viewer row');
  assert.equal(result.inspectorLayout.menuParent,'animaticsWorkspace','the size menu must escape the scrolling panel');
  assert.equal(result.inspectorLayout.menuWithinViewport,true,'the size menu must stay inside the viewport');
  assert.equal(result.inspectorLayout.lastPresetVisible,true,'the size menu must expose every preset without clipping');
  assert.ok(result.inspectorLayout.panelNoScroll,`opening the size menu must not add an inspector scrollbar (${result.inspectorLayout.panelScrollHeight}/${result.inspectorLayout.panelClientHeight})`);
  assert.equal(result.liveTimelineHeight,result.beforeTimelineHeight-50,'timeline height must update on the scheduled animation frame');
  assert.equal(result.liveTimelineCss,result.liveTimelineHeight,'the live timeline CSS height must match the project state');
  assert.equal(result.resizedTimelineHeight,result.liveTimelineHeight,'pointerup must flush and retain the resized timeline height');
  assert.equal(result.timelineResizeReleased,true,'pointerup must clear the timeline divider drag state');
  assert.equal(result.resetTimelineHeight,286,'double-click must still reset the timeline height');
  assert.deepEqual(result.state.audioTrackMuted,[true,false]);
  assert.deepEqual(result.state.audioTrackSolo,[false,true]);
  assert.deepEqual(result.state.videoTrackLocked,[true,false]);
  assert.deepEqual(result.state.audioTrackLocked,[false,true]);
  assert.equal(result.state.textTrackLocked,true);
  assert.deepEqual(result.disabledTargets,[true,true],'locked tracks must not remain paste targets');
  assert.equal(result.played,1,'mute and solo must allow playback only from the effective solo track');
  assert.deepEqual([result.afterClip.track,result.afterClip.start],[result.beforeClip.track,result.beforeClip.start],'locked clips must ignore timeline drag edits');
  assert.deepEqual([result.afterAudio.track,result.afterAudio.start],[result.beforeAudio.track,result.beforeAudio.start],'locked audio clips must ignore timeline drag edits');
  assert.deepEqual([result.afterText.x,result.afterText.y],[result.beforeText.x,result.beforeText.y],'locked text must ignore canvas transforms');
  assert.match(result.toast,/locked/i);
  console.log('animatics Electron track-control smoke passed');
} finally {
  if (child.exitCode === null) child.kill();
  await Promise.race([once(child, 'exit'), delay(3000)]).catch(() => {});
  await rm(profile, { recursive:true, force:true });
}
