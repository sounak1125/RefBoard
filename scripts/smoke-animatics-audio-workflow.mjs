import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const profile = await mkdtemp(path.join(os.tmpdir(), 'refboard-animatics-audio-workflow-smoke-'));
const child = spawn(electron, ['.', '--remote-debugging-port=0', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', `--user-data-dir=${profile}`], {
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

const smokeExpression = String.raw`Promise.race([(async()=>{
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const waitFor=async test=>{for(let attempt=0;attempt<120;attempt++){const value=test();if(value)return value;await wait(50);}throw new Error('Timed out at '+window.__smokeStep+'; toast='+document.querySelector('#anToast')?.textContent+'; audio='+window.RefBoard.animatics.serialize().audio.length);};
  for(let attempt=0;attempt<100&&!window.RefBoard;attempt++)await wait(50);
  if(!window.RefBoard)throw new Error('RefBoard API unavailable');
  window.__smokeErrors=[];window.addEventListener('error',event=>window.__smokeErrors.push(String(event.error||event.message)));window.addEventListener('unhandledrejection',event=>window.__smokeErrors.push(String(event.reason)));
  Element.prototype.setPointerCapture=()=>{};Element.prototype.releasePointerCapture=()=>{};
  window.RefBoard.animatics.clear();window.RefBoard.animatics.open();await wait(150);

  const sourceCanvas=document.createElement('canvas');sourceCanvas.width=8;sourceCanvas.height=8;const sourceContext=sourceCanvas.getContext('2d');sourceContext.fillStyle='#5a9de7';sourceContext.fillRect(0,0,8,8);const pngBlob=await new Promise(resolve=>sourceCanvas.toBlob(resolve,'image/png'));
  const imageFile=new File([pngBlob],'explorer-drop.png',{type:'image/png'}),imageTransfer=new DataTransfer(),imageDropTransfer=new DataTransfer();imageTransfer.items.add(imageFile);imageDropTransfer.items.add(imageFile);
  const videoLane=document.querySelector('.an-track-lane[data-kind="video"][data-track="0"]');
  videoLane.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:imageTransfer,clientX:videoLane.getBoundingClientRect().left+5,clientY:videoLane.getBoundingClientRect().top+5}));
  videoLane.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:imageDropTransfer,clientX:videoLane.getBoundingClientRect().left+5,clientY:videoLane.getBoundingClientRect().top+5}));
  window.__smokeStep='image drop';await waitFor(()=>window.RefBoard.animatics.serialize().clips.length===1);

  const sampleRate=8000,samples=sampleRate,buffer=new ArrayBuffer(44+samples*2),view=new DataView(buffer),ascii=(offset,value)=>{for(let i=0;i<value.length;i++)view.setUint8(offset+i,value.charCodeAt(i));};
  ascii(0,'RIFF');view.setUint32(4,36+samples*2,true);ascii(8,'WAVE');ascii(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,sampleRate,true);view.setUint32(28,sampleRate*2,true);view.setUint16(32,2,true);view.setUint16(34,16,true);ascii(36,'data');view.setUint32(40,samples*2,true);
  for(let index=0;index<samples;index++)view.setInt16(44+index*2,Math.sin(index/sampleRate*Math.PI*440*2)*12000,true);
  const audioFile=new File([buffer],'explorer-drop.wav',{type:'audio/wav'}),audioTransfer=new DataTransfer();audioTransfer.items.add(audioFile);
  const workspace=document.querySelector('#animaticsWorkspace');workspace.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:audioTransfer,clientX:400,clientY:300}));workspace.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:audioTransfer,clientX:400,clientY:300}));
  window.__smokeStep='audio trimmer';await waitFor(()=>{if(window.__smokeErrors.length)throw new Error(window.__smokeErrors.join('|'));return document.querySelector('#anAudioTrimModal').classList.contains('open');});
  await wait(250);document.querySelector('#anTrimUse').click();
  window.__smokeStep='audio commit';await waitFor(()=>window.RefBoard.animatics.serialize().audio.length===1);
  const waveformPixelHeight=()=>{const canvas=document.querySelector('canvas[data-wave]');if(!canvas?.width||!canvas.height)return 0;const pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;let top=canvas.height,bottom=-1;for(let y=0;y<canvas.height;y++)for(let x=0;x<canvas.width;x++)if(pixels[(y*canvas.width+x)*4+3]){top=Math.min(top,y);bottom=Math.max(bottom,y);}return bottom>=top?bottom-top+1:0;};
  const waveformBeforeGain=await waitFor(()=>waveformPixelHeight()||0);

  const audioClip=document.querySelector('.an-clip[data-kind="audio"]'),clipRect=audioClip.getBoundingClientRect();
  audioClip.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:91,clientX:clipRect.left+12,clientY:clipRect.top+18,button:0}));
  audioClip.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:91,clientX:clipRect.left+12,clientY:clipRect.top+18,button:0}));
  const gainKeyEvent=new KeyboardEvent('keydown',{bubbles:true,cancelable:true,key:'g',code:'KeyG'}),gainKeyDispatch=document.body.dispatchEvent(gainKeyEvent);await wait(100);const gainShortcutHandled=!gainKeyDispatch&&document.querySelector('#anGainModal').classList.contains('open');if(!document.querySelector('#anGainModal').classList.contains('open'))document.querySelector('#anAudioGain').click();
  window.__smokeStep='gain modal';await waitFor(()=>document.querySelector('#anGainModal').classList.contains('open'));
  document.querySelector('#anGainDb').value='-6';document.querySelector('#anGainApply').click();
  const waveformAfterGain=await waitFor(()=>{const height=waveformPixelHeight();return height>0&&height<waveformBeforeGain?height:0;});

  const fadeOutDuration=document.querySelector('#anFadeOutDuration'),fadeOutCurve=document.querySelector('#anFadeOutCurve'),fadeOutShape=document.querySelector('#anFadeOutShape');
  fadeOutDuration.value='.25';fadeOutDuration.dispatchEvent(new Event('change',{bubbles:true}));
  fadeOutCurve.value='custom';fadeOutCurve.dispatchEvent(new Event('change',{bubbles:true}));
  fadeOutShape.value='40';fadeOutShape.dispatchEvent(new Event('input',{bubbles:true}));fadeOutShape.dispatchEvent(new Event('change',{bubbles:true}));

  const fadeIn=document.querySelector('[data-audio-fade="in"]'),fadeRect=fadeIn.getBoundingClientRect(),grid=document.querySelector('#anTlGrid'),zoom=Number(document.querySelector('#anZoom').value)||90;
  fadeIn.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:92,clientX:fadeRect.left+2,clientY:fadeRect.top+2,button:0}));
  const fadeTargetX=fadeRect.left+2+zoom*.515;grid.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:92,clientX:fadeTargetX,clientY:fadeRect.top+2,buttons:1}));await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));const liveFadeDuration=window.RefBoard.animatics.serialize().audio[0].fadeInDuration;
  window.__smokeStep='fade release';grid.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:92,clientX:fadeTargetX,clientY:fadeRect.top+2,button:0}));window.__smokeStep='fade released';

  window.__gainEvents=[];window.__audioPlayCount=0;
  class FakeAudio{constructor(src){this.src=src;this.currentTime=0;this.volume=1;this.paused=true;}play(){this.paused=false;window.__audioPlayCount++;return Promise.resolve();}pause(){this.paused=true;}}
  class FakeParam{constructor(){this.value=1;}cancelScheduledValues(time){window.__gainEvents.push(['cancel',time]);}setValueAtTime(value,time){window.__gainEvents.push(['set',value,time]);}linearRampToValueAtTime(value,time){window.__gainEvents.push(['ramp',value,time]);}}
  class FakeGain{constructor(){this.gain=new FakeParam();}connect(destination){return destination;}disconnect(){}}
  class FakeSource{connect(destination){return destination;}disconnect(){}}
  class FakeContext{constructor(){this.currentTime=10;this.state='running';this.destination={};}resume(){return Promise.resolve();}close(){this.state='closed';return Promise.resolve();}createMediaElementSource(){return new FakeSource();}createGain(){return new FakeGain();}}
  Object.defineProperty(window,'Audio',{value:FakeAudio,configurable:true});Object.defineProperty(window,'AudioContext',{value:FakeContext,configurable:true});Object.defineProperty(window,'webkitAudioContext',{value:undefined,configurable:true});
  window.__smokeStep='playback';const volumeSlider=document.querySelector('#anAudioVolume'),tapSpace=()=>{volumeSlider.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,cancelable:true,key:' ',code:'Space'}));volumeSlider.dispatchEvent(new KeyboardEvent('keyup',{bubbles:true,cancelable:true,key:' ',code:'Space'}));};volumeSlider.focus();tapSpace();await wait(40);const volumeSpacePlayed=window.__audioPlayCount===1;document.querySelector('#anPlay').click();window.__smokeStep='serialized';

  const state=window.RefBoard.animatics.serialize(),audio=state.audio[0],envelope=document.querySelector('.an-fade-envelope polyline')?.getAttribute('points')||'',mediaRefs=window.RefBoard.animatics.mediaRefs();
  return {boardImages:window.RefBoard.state.items.filter(item=>item.kind==='image').length,clipCount:state.clips.length,audio,audioTracks:state.audioTracks,mediaRefs:mediaRefs.map(item=>item.name),gainShortcutHandled,waveformBeforeGain,waveformAfterGain,liveFadeDuration,volumeSpacePlayed,gainModalOpen:document.querySelector('#anGainModal').classList.contains('open'),customVisible:document.querySelector('#anFadeOutCustom').classList.contains('show'),envelope,gainEvents:window.__gainEvents,errors:window.__smokeErrors};
})(),new Promise(resolve=>setTimeout(()=>resolve({timedOut:true,step:window.__smokeStep,errors:window.__smokeErrors||[],toast:document.querySelector('#anToast')?.textContent,clips:window.RefBoard?.animatics?.serialize()?.clips?.length,items:window.RefBoard?.state?.items?.length}),12000))])`;

try {
  const result = await evaluate(await debuggerPort(), smokeExpression);
  assert.equal(result.timedOut, undefined, `live audio smoke timed out: ${JSON.stringify(result)}`);
  assert.equal(result.boardImages, 1, 'Explorer-dropped images must enter the persistent board asset registry');
  assert.equal(result.clipCount, 1, 'Explorer-dropped images must also enter the target Animatics video track');
  assert.equal(result.audioTracks, 1, 'Explorer-dropped audio must create its target audio track');
  assert.ok(result.mediaRefs.includes('explorer-drop.wav'), 'Explorer-dropped audio must remain embedded for board saves and exports');
  assert.ok(Math.abs(result.audio.volume - .501187) < 1e-5, 'G must apply the requested -6 dB gain');
  assert.equal(result.gainShortcutHandled, true, `G must open Audio Gain (${result.errors.join('; ')})`);
  assert.ok(result.waveformAfterGain/result.waveformBeforeGain>=.4&&result.waveformAfterGain/result.waveformBeforeGain<=.65, '-6 dB must visibly reduce the live waveform to approximately half height');
  assert.equal(result.volumeSpacePlayed, true, 'Space must start playback while the edited audio volume slider still has focus');
  assert.ok(Math.abs(result.liveFadeDuration - .515) < .005, 'the fade handle must follow the pointer continuously between project frames');
  assert.ok(Math.abs(result.audio.fadeInDuration - .5) <= 1 / 30, 'dragging the fade-in handle must remain frame-snapped');
  assert.ok(Math.abs(result.audio.fadeOutDuration - .266667) <= 1 / 30, 'typed fade durations must remain frame-snapped');
  assert.equal(result.audio.fadeOutCurve, 'custom');
  assert.equal(result.audio.fadeOutShape, 40);
  assert.equal(result.gainModalOpen, false);
  assert.equal(result.customVisible, true, 'Custom fade controls must be shown for custom automation');
  assert.ok(result.envelope.split(' ').length > 10, 'the timeline must draw the selected curved envelope');
  assert.ok(result.gainEvents.filter(event => event[0] === 'ramp').length > 8, 'live playback must schedule the fade envelope on Web Audio');
  console.log('animatics Electron Explorer-drop, gain, and fade smoke passed');
} finally {
  if (child.exitCode === null) child.kill();
  await Promise.race([once(child, 'exit'), delay(3000)]).catch(() => {});
  await rm(profile, { recursive:true, force:true });
}
