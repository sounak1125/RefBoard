import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const profile = await mkdtemp(path.join(os.tmpdir(), 'refboard-animatics-smoke-'));
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
  Element.prototype.setPointerCapture=()=>{};Element.prototype.releasePointerCapture=()=>{};
  for(let attempt=0;attempt<100&&!window.RefBoard;attempt++)await wait(50);
  if(!window.RefBoard)throw new Error('RefBoard API unavailable');
  const source=document.createElement('canvas');source.width=90;source.height=160;
  const sourceContext=source.getContext('2d');sourceContext.fillStyle='#e44747';sourceContext.fillRect(0,0,90,80);sourceContext.fillStyle='#357bd8';sourceContext.fillRect(0,80,90,80);
  const blob=await new Promise(resolve=>source.toBlob(resolve,'image/png'));
  await window.RefBoard.addImages([new File([blob],'portrait-smoke.png',{type:'image/png'})]);await wait(250);
  const item=window.RefBoard.state.items.filter(entry=>(entry.kind||'image')==='image').at(-1);
  if(!item)throw new Error('Smoke image was not added');
  item.crop={l:.1,t:.2,r:.9,b:.8};item.rot=90;item.w=90;item.h=160;item.flipX=true;item.gray=true;
  window.RefBoard.animatics.open([item]);await wait(300);
  const savedProject=window.RefBoard.animatics.serialize(),rotatedClip=savedProject.clips.at(-1);
  const imported={...rotatedClip.boardTransform,sourceAssetKey:rotatedClip.sourceAssetKey};
  const viewer=document.querySelector('#anViewer'),edgePixel=[...viewer.getContext('2d').getImageData(Math.round(viewer.width*.05),Math.round(viewer.height*.5),1,1).data];
  window.RefBoard.animatics.close();window.RefBoard.animatics.clear();window.RefBoard.animatics.load(savedProject,new Map());window.RefBoard.animatics.open();await wait(200);
  const reloaded=window.RefBoard.animatics.serialize().clips.at(-1).boardTransform;
  window.RefBoard.animatics.close();window.RefBoard.animatics.clear();item.rot=0;item.flipX=false;item.gray=false;
  window.RefBoard.animatics.open([item]);await wait(250);document.querySelector('#anFrameFill').click();await wait(100);const fillScale=document.querySelector('#anFrameScaleVal')?.textContent;
  const scaleInput=document.querySelector('#anFrameScale'),scaleHistoryBefore=window.RefBoard.animatics.historyState().undo,originalDrawImage=CanvasRenderingContext2D.prototype.drawImage;let scalePreviewPaints=0;CanvasRenderingContext2D.prototype.drawImage=function(...args){if(this.canvas===viewer)scalePreviewPaints++;return originalDrawImage.apply(this,args);};for(let value=320;value<=419;value++){scaleInput.value=String(value);scaleInput.dispatchEvent(new Event('input',{bubbles:true}));}const liveScaleLabel=document.querySelector('#anFrameScaleVal').textContent,liveScaleFocus=(()=>{scaleInput.focus();return document.activeElement===scaleInput;})();await Promise.race([new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))),wait(250)]);const paintsBeforeScaleCommit=scalePreviewPaints;scaleInput.dispatchEvent(new Event('change',{bubbles:true}));await wait(100);const paintsAfterScaleCommit=scalePreviewPaints,scaleHistoryAfter=window.RefBoard.animatics.historyState().undo;CanvasRenderingContext2D.prototype.drawImage=originalDrawImage;
  const framingRect=viewer.getBoundingClientRect(),framingPoint=(x,y)=>({clientX:framingRect.left+framingRect.width*x,clientY:framingRect.top+framingRect.height*y});viewer.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,...framingPoint(.5,.5)}));const wheelScaleBefore=Number(scaleInput.value);viewer.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,deltaY:-180,...framingPoint(.5,.5)}));await wait(220);const wheelScaleAfter=Number(scaleInput.value);viewer.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:49,button:0,...framingPoint(.5,.5)}));viewer.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:49,buttons:1,...framingPoint(.62,.5)}));viewer.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:49,button:0,...framingPoint(.62,.5)}));await wait(80);const framingDragX=window.RefBoard.animatics.serialize().clips.at(-1).framing.x;viewer.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,...framingPoint(.5,.5)}));
  const tapSpace=target=>{target.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,cancelable:true,key:' ',code:'Space'}));target.dispatchEvent(new KeyboardEvent('keyup',{bubbles:true,cancelable:true,key:' ',code:'Space'}));};
  const clipDuration=document.querySelector('#anDuration'),durationHistoryBefore=window.RefBoard.animatics.historyState().undo;for(const value of ['2.6','2.5','2.4']){clipDuration.value=value;clipDuration.dispatchEvent(new Event('input',{bubbles:true}));}const liveClipDuration=window.RefBoard.animatics.serialize().clips.at(-1).duration;clipDuration.focus();tapSpace(clipDuration);await wait(40);const durationSpacePlayed=document.querySelector('#anPlay').dataset.playing==='1',durationFocusRetained=document.activeElement===clipDuration,durationHistoryAfter=window.RefBoard.animatics.historyState().undo;document.querySelector('#anPlay').click();
  document.querySelector('[data-panel="text"]').click();const textArea=document.querySelector('#anText');textArea.value='Live title';document.querySelector('#anAddText').click();await wait(30);const textSize=document.querySelector('#anTextSize');for(const value of ['58','64','68']){textSize.value=value;textSize.dispatchEvent(new Event('input',{bubbles:true}));}const liveTextSize=window.RefBoard.animatics.serialize().texts.at(-1).size;textSize.focus();tapSpace(textSize);await wait(40);const textSizeSpacePlayed=document.querySelector('#anPlay').dataset.playing==='1',textSizeFocusRetained=document.activeElement===textSize;document.querySelector('#anPlay').click();textArea.focus();tapSpace(textArea);await wait(30);const textareaSpaceDidNotPlay=document.querySelector('#anPlay').dataset.playing!=='1';
  document.querySelector('[data-panel="draw"]').click();
  const key=(value,code='')=>document.body.dispatchEvent(new KeyboardEvent('keydown',{key:value,code,bubbles:true}));
  key('d','KeyD');await wait(30);
  document.querySelector('#anDrawPen').click();document.querySelector('[data-an-brush="marker"]').click();
  document.querySelector('#anDrawColorButton').click();document.querySelector('[data-an-draw-color="#5aa2ff"]').click();
  key(']','BracketRight');key(']','BracketRight');
  const drawRect=viewer.getBoundingClientRect(),point=(x,y)=>({clientX:drawRect.left+drawRect.width*x,clientY:drawRect.top+drawRect.height*y});
  viewer.dispatchEvent(new PointerEvent('pointerenter',{...point(.2,.3),pointerId:51}));
  viewer.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:51,button:0,...point(.2,.3)}));
  viewer.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:51,buttons:1,...point(.7,.3)}));
  viewer.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:51,button:0,...point(.7,.3)}));await wait(40);
  const penStroke=structuredClone(window.RefBoard.animatics.serialize().clips.at(-1).strokes.at(-1));
  key('e','KeyE');const eraserStart=Number(document.querySelector('#anDrawWidthVal').value);key('[','BracketLeft');
  viewer.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:52,button:0,...point(.45,.2)}));
  viewer.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:52,buttons:1,...point(.45,.4)}));
  viewer.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:52,button:0,...point(.45,.4)}));await wait(40);
  const withEraser=window.RefBoard.animatics.serialize().clips.at(-1),eraserStroke=structuredClone(withEraser.strokes.at(-1));
  const widthInput=document.querySelector('#anDrawWidthVal'),widthCombo=document.querySelector('.an-draw-size-combo');widthInput.value='9';widthInput.dispatchEvent(new Event('input',{bubbles:true}));const manualWidth=Number(widthInput.value);widthInput.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('#anDrawWidthMenuButton').click();const preset=document.querySelector('[data-an-draw-width="24"]'),presetVisible=preset.getBoundingClientRect().width>0;preset.click();const presetWidth=Number(widthInput.value),compactWidth=widthCombo.getBoundingClientRect().width,noBracketBadge=!document.querySelector('.an-draw-size-row kbd');
  const lock=document.querySelector('[data-toggle-track-lock="video"][data-track="0"]');lock.click();const lockedCount=window.RefBoard.animatics.serialize().clips.at(-1).strokes.length;
  viewer.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:53,button:0,...point(.6,.6)}));viewer.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:53,button:0,...point(.65,.65)}));
  const lockedAttemptCount=window.RefBoard.animatics.serialize().clips.at(-1).strokes.length;document.querySelector('[data-toggle-track-lock="video"][data-track="0"]').click();
  document.querySelector('#anClearDraw').click();const clearedCount=window.RefBoard.animatics.serialize().clips.at(-1).strokes.length;
  document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'z',code:'KeyZ',ctrlKey:true,bubbles:true}));await wait(30);const undoCount=window.RefBoard.animatics.serialize().clips.at(-1).strokes.length;
  return {
    imported,
    reloaded,
    edgePixel,
    fillScale,
    noPositionFields:!document.querySelector('#anTextX')&&!document.querySelector('#anTextY'),
    rotationStep:document.querySelector('#anTextRotation')?.step,
    selectionPath:document.querySelector('[data-an-tool="select"] path')?.getAttribute('d'),
    workspaceOpen:document.querySelector('#animaticsWorkspace')?.classList.contains('open'),
    liveScaleLabel,liveScaleFocus,paintsBeforeScaleCommit,paintsAfterScaleCommit,scaleHistoryBefore,scaleHistoryAfter,wheelScaleBefore,wheelScaleAfter,framingDragX,
    liveClipDuration,durationSpacePlayed,durationFocusRetained,durationHistoryBefore,durationHistoryAfter,liveTextSize,textSizeSpacePlayed,textSizeFocusRetained,textareaSpaceDidNotPlay,
    penStroke,eraserStroke,eraserStart,manualWidth,presetWidth,presetVisible,compactWidth,noBracketBadge,lockedCount,lockedAttemptCount,clearedCount,undoCount,
    drawToggleOn:document.querySelector('#anDrawToggle').classList.contains('on'),
    drawPreviewTool:document.querySelector('#anDrawSizePreview').dataset.tool,
    customColor:document.querySelector('#anDrawColorSwatch').style.backgroundColor,
  };
})()`;

try {
  const result = await evaluate(await debuggerPort(), smokeExpression);
  assert.deepEqual(result.imported.crop, { l:.1, t:.2, r:.9, b:.8 });
  assert.equal(result.imported.rotation, 90);
  assert.equal(result.imported.flipX, true);
  assert.equal(result.imported.gray, true);
  assert.ok(result.imported.sourceAssetKey, 'transformed still must have a stable asset key');
  const { sourceAssetKey, ...importedTransform } = result.imported;
  assert.deepEqual(result.reloaded,importedTransform,'board transform must survive save and reopen');
  assert.ok(result.edgePixel[0]>10&&result.edgePixel[3]===255, 'rotated 9:16 still must fill the landscape viewer width');
  assert.ok(Math.abs(result.edgePixel[0]-result.edgePixel[1])<=1&&Math.abs(result.edgePixel[1]-result.edgePixel[2])<=1, 'board grayscale must render in Animatics');
  assert.equal(result.fillScale, '316%', 'Fill must display effective portrait-to-landscape scaling');
  assert.equal(result.noPositionFields, true);
  assert.equal(result.rotationStep, '1');
  assert.equal(result.selectionPath, 'M5 3l14 7.5-6 .75L9 20l-1.5-6.5L5 3z');
  assert.equal(result.workspaceOpen, true);
  assert.equal(result.liveScaleLabel, '419%', 'the scale slider must apply its latest value immediately');
  assert.equal(result.liveScaleFocus, true, 'live scaling must retain focus on the slider');
  assert.ok(result.paintsBeforeScaleCommit>=1&&result.paintsBeforeScaleCommit<=2, `100 rapid scale events must coalesce into one animation-frame preview (painted ${result.paintsBeforeScaleCommit})`);
  assert.ok(result.paintsAfterScaleCommit-result.paintsBeforeScaleCommit>=1&&result.paintsAfterScaleCommit-result.paintsBeforeScaleCommit<=2, 'releasing the scale slider must perform one final normal render');
  assert.equal(result.scaleHistoryAfter-result.scaleHistoryBefore, 1, 'continuous scale input must create one undo step');
  assert.ok(result.wheelScaleAfter>result.wheelScaleBefore, 'wheel reframing must update the scale through the optimized preview path');
  assert.ok(result.framingDragX>.1, 'on-canvas framing drag must preserve its final position through the optimized preview path');
  assert.ok(Math.abs(result.liveClipDuration-2.4)<=1/30, 'clip duration must update while typing without Enter');
  assert.equal(result.durationSpacePlayed, true, 'Space must start playback while a clip duration field has focus');
  assert.equal(result.durationFocusRetained, true, 'starting playback must not blur the clip duration field');
  assert.equal(result.durationHistoryAfter-result.durationHistoryBefore, 1, 'continuous duration typing must create one undo step');
  assert.equal(result.liveTextSize, 68, 'text size must update while typing without Enter');
  assert.equal(result.textSizeSpacePlayed, true, 'Space must start playback while a text property field has focus');
  assert.equal(result.textSizeFocusRetained, true, 'starting playback must not blur the text property field');
  assert.equal(result.textareaSpaceDidNotPlay, true, 'Space in the text content editor must remain text input');
  assert.equal(result.drawToggleOn, true, 'D must activate drawing mode');
  assert.equal(result.penStroke.tool, 'pen');
  assert.equal(result.penStroke.brush, 'marker');
  assert.equal(result.penStroke.color, '#5aa2ff');
  assert.equal(result.penStroke.width, 4, 'brackets must resize the active pen');
  assert.equal(result.eraserStart, 15, 'eraser must retain its independent default size');
  assert.equal(result.eraserStroke.tool, 'eraser');
  assert.equal(result.eraserStroke.width, 14, 'brackets must resize the active eraser');
  assert.equal(result.eraserStroke.brush, 'marker', 'switching tools must preserve the selected pen brush');
  assert.equal(result.manualWidth, 9, 'brush size must accept direct numeric entry');
  assert.equal(result.presetWidth, 24, 'brush size preset menu must apply a selected value');
  assert.equal(result.presetVisible, true, 'brush size presets must open as a usable menu');
  assert.ok(result.compactWidth<=96, 'brush size combobox must stay compact');
  assert.equal(result.noBracketBadge, true, 'the size field must not show the bracket shortcut badge');
  assert.equal(result.lockedAttemptCount, result.lockedCount, 'locked video tracks must reject drawing');
  assert.equal(result.clearedCount, 0, 'Clear drawing must remove the overlay');
  assert.equal(result.undoCount, 2, 'cleared drawing must be undoable');
  assert.equal(result.drawPreviewTool, 'eraser', 'cursor preview must follow the active tool');
  assert.equal(result.customColor, 'rgb(90, 162, 255)');
  console.log('animatics Electron transform smoke passed');
} finally {
  if (child.exitCode === null) child.kill();
  await Promise.race([once(child, 'exit'), delay(3000)]).catch(() => {});
  await rm(profile, { recursive:true, force:true });
}
