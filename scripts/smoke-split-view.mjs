/**
 * Split view: a second independent board pane beside the current one.
 *
 * The control lives next to the minimap. Clicking it opens a right-hand pane
 * on the landing page so the user can pick another board. That pane is a
 * separate RefBoard instance (pane=secondary), so window chrome, New window,
 * and nested split stay hidden.
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
const electron = process.env.REFBOARD_SMOKE_EXECUTABLE || path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const profile = await mkdtemp(path.join(os.tmpdir(), 'refboard-split-'));
const child = spawn(electron, [...(process.env.REFBOARD_SMOKE_EXECUTABLE ? [] : ['.']), '--remote-debugging-port=0', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-features=CalculateNativeWinOcclusion', `--user-data-dir=${profile}`], {
  cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
});
let stderr = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', chunk => { stderr += chunk; });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function debuggerPort() {
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`Electron exited before split smoke setup (${child.exitCode})\n${stderr}`);
    try {
      const [port] = (await readFile(portFile, 'utf8')).trim().split(/\r?\n/);
      if (/^\d+$/.test(port)) return Number(port);
    } catch { /* wait for Chromium */ }
    await delay(100);
  }
  throw new Error(`Electron debugging port did not become ready\n${stderr}`);
}

const primaryExpression = `(async()=>{
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  for(let attempt=0;attempt<300&&!window.RefBoard?.startupComplete;attempt++)await wait(50);
  if(!window.RefBoard?.startupComplete)throw new Error('RefBoard startup did not complete');
  document.querySelectorAll('.modal.show').forEach(el=>el.classList.remove('show'));
  document.querySelector('#rwNewBoard').click();
  for(let i=0;i<100&&!document.body.classList.contains('board-active');i++)await wait(50);
  if(!document.body.classList.contains('board-active'))throw new Error('primary board did not open');
  const image=document.createElement('canvas');image.width=80;image.height=60;
  image.getContext('2d').fillRect(0,0,80,60);
  const blob=await new Promise(resolve=>image.toBlob(resolve));
  await window.RefBoard.addImages([new File([blob],'split.png',{type:'image/png'})]);
  // Exercise the slide with a populated board, not only an empty canvas.
  for(let i=0;i<120;i++)window.RefBoard.state.items.push(window.RefBoard.makeNoteForTest({
    id:'split-note-'+i,x:(i%15)*100,y:Math.floor(i/15)*90,w:90,h:70,
    html:'<p>Split animation '+i+'</p>'}));
  window.RefBoard.invalidate();
  await wait(400);
  const originalItems=JSON.stringify(window.RefBoard.state.items);
  const toggle=document.querySelector('#splitToggle');
  const minimap=document.querySelector('#minimapToggle');
  if(!toggle)throw new Error('split toggle missing');
  if(!minimap)throw new Error('minimap toggle missing');
  const shown=getComputedStyle(toggle).display!=='none';
  if(!shown)throw new Error('split toggle must be visible on the primary pane');
  if(typeof window.RefBoardAPI?.splitEnter!=='function')throw new Error('splitEnter bridge missing');
  window.splitSmokeErrors=[];
  window.addEventListener('error',e=>window.splitSmokeErrors.push(e.message));
  window.splitSmokeMeasure={sets:[],samples:[]};
  const board=document.querySelector('#board');
  for(const key of ['width','height']){
    const descriptor=Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype,key);
    Object.defineProperty(board,key,{...descriptor,set(value){
      window.splitSmokeMeasure.sets.push({key,value,at:performance.now()});
      return descriptor.set.call(this,value);
    }});
  }
  function sampleSlide(){
    const rect=board.getBoundingClientRect();
    window.splitSmokeMeasure.samples.push({at:performance.now(),
      top:rect.top,height:rect.height,rasterHeight:board.height/(devicePixelRatio||1),
      width:parseFloat(document.documentElement.style.getPropertyValue('--split-left'))||innerWidth});
    requestAnimationFrame(sampleSlide);
  }
  requestAnimationFrame(sampleSlide);
  window.splitSmokeFrames=[];
  window.RefBoardAPI.onSplitStateChange(state=>{
    const rect=board.getBoundingClientRect();
    const clip=getComputedStyle(board).clipPath;
    const inset=clip.startsWith('inset(')?clip.slice(6,-1).split(/\\s+/).map(parseFloat):[];
    const right=inset.length>1?inset[1]:(inset[0]||0);
    const left=inset.length>3?inset[3]:right;
    window.splitSmokeFrames.push({...state,at:performance.now(),
      boardWidth:rect.width,boardTop:rect.top,visibleBoardWidth:rect.width-right-left,
      cssWidth:parseFloat(document.documentElement.style.getPropertyValue('--split-left'))||innerWidth});
  });
  toggle.click();
  for(let i=0;i<300;i++){
    const last=window.splitSmokeFrames.at(-1);
    if(last?.split&&!last.animating)break;
    await wait(50);
  }
  const opened=window.splitSmokeFrames.at(-1);
  if(!opened?.split||opened.animating)throw new Error('split opening never completed: '+JSON.stringify(opened));
  return {
    pane: window.RefBoard.boardPane,
    toggleVisible: shown,
    ratio: opened.ratio,
    width:innerWidth, frames:window.splitSmokeFrames,measure:window.splitSmokeMeasure,
    itemsUnchanged:originalItems===JSON.stringify(window.RefBoard.state.items),
  };
})()`;

function checkMotion(label, frames, measure, fullWidth) {
  const narrowWidth=Math.min(...frames.map(frame=>frame.contentWidth));
  const moving=frames.filter(frame=>frame.contentWidth>narrowWidth+5&&frame.contentWidth<fullWidth-5);
  assert.ok(moving.length>=3, `${label} must have intermediate motion frames`);
  const start=frames[0].at, end=frames.at(-1).at;
  const samples=measure.samples.filter(sample=>sample.at>=start&&sample.at<=end
    &&sample.width>narrowWidth+5&&sample.width<fullWidth-5);
  const steps=new Set(samples.map(sample=>sample.width)).size;
  // Compare to the display frames actually available on this machine. Do not
  // require a particular refresh rate or millisecond budget from a loaded CI.
  assert.ok(steps>=Math.min(12,Math.max(3,Math.floor(samples.length/2))),
    `${label} must advance on display frames (${steps} positions in ${samples.length} frames)`);
  const resets=measure.sets;
  for(const key of ['width','height'])assert.ok(resets.filter(set=>set.key===key).length<=3,
    `${label} must keep its canvas surface stable instead of clearing ${key} every frame`);
  for(const sample of samples)assert.ok(Math.abs(sample.height-sample.rasterHeight)<=1,
    `${label} must move the board without stretching its raster surface`);
  const firstTop=frames[0].boardTop,lastTop=frames.at(-1).boardTop;
  if(Math.abs(lastTop-firstTop)>2)assert.ok(moving.some(frame=>frame.boardTop>Math.min(firstTop,lastTop)+1
    &&frame.boardTop<Math.max(firstTop,lastTop)-1),
    `${label} must move the board below the titlebar gradually`);
  const gaps=moving.slice(1).map((frame,i)=>frame.at-moving[i].at).sort((a,b)=>a-b);
  const median=gaps.length?Math.round(gaps[Math.floor(gaps.length/2)]*10)/10:0;
  console.log(`split ${label}: ${steps} visible positions / ${samples.length} display frames; `+
    `${resets.length} canvas dimension writes; ${median} ms median layout interval`);
}

const secondaryExpression = `(async()=>{
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  for(let attempt=0;attempt<300&&!window.RefBoard?.startupComplete;attempt++)await wait(50);
  if(!window.RefBoard?.startupComplete)throw new Error('secondary pane startup did not complete');
  const divider=document.querySelector('#splitDivider');
  const closeBtn=document.querySelector('#titlebarClose');
  const splitBtn=document.querySelector('#splitToggle');
  const newWindow=document.querySelector('#rwNewWindow');
  const landing=document.querySelector('#recentWorks');
  const titlebar=document.querySelector('#titlebar');
  return {
    pane: window.RefBoard.boardPane,
    htmlClass: document.documentElement.classList.contains('pane-secondary'),
    bodyClass: document.body.classList.contains('pane-secondary'),
    dividerPresent: !!divider,
    dividerShown: divider ? getComputedStyle(divider).display!=='none' : false,
    dividerHandle: divider ? getComputedStyle(divider,'::after').content : 'none',
    titlebarHidden: titlebar ? getComputedStyle(titlebar).display==='none' : false,
    closeHidden: closeBtn ? getComputedStyle(closeBtn).display==='none' : false,
    splitHidden: splitBtn ? getComputedStyle(splitBtn).display==='none' : false,
    newWindowHidden: newWindow ? getComputedStyle(newWindow).display==='none' : false,
    landingShown: landing ? getComputedStyle(landing).display!=='none' : false,
  };
})()`;

let failed = false;
try {
  const port = await debuggerPort();
  const primary = await evaluate(port, primaryExpression);
  assert.equal(primary.pane, 'primary');
  assert.equal(primary.toggleVisible, true);
  assert.ok(primary.ratio >= 0.25 && primary.ratio <= 0.75, 'split ratio should stay clamped');
  assert.equal(primary.itemsUnchanged, true, 'opening split must preserve board items');
  const openingFrames = primary.frames.filter(frame => frame.split);
  const finalWidth = openingFrames.at(-1).contentWidth;
  assert.ok(Math.abs(openingFrames[0].contentWidth - primary.width) <= 1, 'opening starts with the full primary board width (allow native DPI rounding)');
  const intermediate = openingFrames.filter(frame => frame.contentWidth < primary.width - 5 && frame.contentWidth > finalWidth + 5);
  assert.ok(new Set(intermediate.map(frame => frame.contentWidth)).size >= 3, 'opening must render several intermediate positions instead of jumping');
  for (let i = 1; i < openingFrames.length; i++) {
    assert.ok(openingFrames[i].contentWidth <= openingFrames[i-1].contentWidth, 'opening advances monotonically');
    assert.equal(openingFrames[i].cssWidth, openingFrames[i].contentWidth, 'left board and native pane use the same width');
    assert.ok(Math.abs(openingFrames[i].visibleBoardWidth-openingFrames[i].contentWidth)<=1, 'the clipped board follows the divider');
  }
  checkMotion('opening', openingFrames, primary.measure, primary.width);

  const secondary = await evaluate(port, secondaryExpression, { urlPattern: /[?&]pane=secondary(?:&|$)/ });
  assert.equal(secondary.pane, 'secondary');
  assert.equal(secondary.htmlClass, true);
  assert.equal(secondary.dividerPresent, true);
  assert.equal(secondary.dividerShown, true);
  assert.ok(!secondary.dividerHandle || secondary.dividerHandle === 'none' || secondary.dividerHandle === 'normal', 'split edge must not paint a handle');
  assert.equal(secondary.titlebarHidden, true);
  assert.equal(secondary.closeHidden, true);
  assert.equal(secondary.splitHidden, true);
  assert.equal(secondary.newWindowHidden, true);
  assert.equal(secondary.landingShown, true);

  const afterExit = await evaluate(port, `(async()=>{
    window.splitSmokeFrames=[];
    window.splitSmokeMeasure={sets:[],samples:[]};
    const r=await window.RefBoardAPI.splitExit();
    const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
    for(let attempt=0;attempt<80;attempt++){
      if(document.querySelector('#splitToggle')?.getAttribute('aria-pressed')==='false')break;
      await wait(50);
    }
    // A second CSS titlebar transition used to stretch the freshly resized
    // canvas after the horizontal slide had already finished.
    await wait(450);
    return {
      pending: !!(r?.pending || r?.closed),
      reason: r?.reason || null,
      pressed: document.querySelector('#splitToggle')?.getAttribute('aria-pressed'),
      frames:window.splitSmokeFrames,measure:window.splitSmokeMeasure,errors:window.splitSmokeErrors,width:innerWidth,
    };
  })()`, { urlPattern: /index\.html\?(?!.*pane=secondary)/i });
  assert.ok(afterExit.pending, 'split-exit should close or wait for the right pane handshake');
  assert.equal(afterExit.pressed, 'false', 'closing must complete');
  assert.deepEqual(afterExit.errors, [], 'split transitions must not throw renderer errors');
  const closingFrames = afterExit.frames;
  assert.ok(closingFrames.some(frame => frame.contentWidth > finalWidth + 5 && frame.contentWidth < afterExit.width - 5), 'closing must also slide through intermediate positions');
  for(const frame of closingFrames)assert.ok(Math.abs(frame.visibleBoardWidth-frame.contentWidth)<=1,
    'closing keeps the clipped canvas and divider aligned');
  checkMotion('closing', closingFrames, afterExit.measure, afterExit.width);
  const settledAt=closingFrames.at(-1).at;
  const settledSamples=afterExit.measure.samples.filter(sample=>sample.at>=settledAt);
  assert.ok(settledSamples.length>=2, 'closing must observe painted frames after the pane is removed');
  for(const sample of settledSamples)assert.ok(Math.abs(sample.height-sample.rasterHeight)<=1,
    'closing must not stretch the canvas vertically after the horizontal motion ends');

  const reopened = await evaluate(port, `(async()=>{
    const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
    window.splitSmokeFrames=[];
    await window.RefBoardAPI.splitEnter(0.65);
    for(let i=0;i<300;i++){
      if(window.splitSmokeFrames.at(-1)?.split&&!window.splitSmokeFrames.at(-1)?.animating)break;
      await wait(50);
    }
    const frame=window.splitSmokeFrames.at(-1);
    // Drag using screen coordinates, as the real divider does.
    window.RefBoardAPI.splitDragMove(window.screenX+innerWidth*0.4);
    await wait(100);
    const dragged=window.splitSmokeFrames.at(-1);
    await window.RefBoardAPI.splitExit();
    for(let i=0;i<100&&document.querySelector('#splitToggle').getAttribute('aria-pressed')!=='false';i++)await wait(50);
    return {frame,dragged,width:innerWidth,errors:window.splitSmokeErrors,
      closed:document.querySelector('#splitToggle').getAttribute('aria-pressed')==='false'};
  })()`, { urlPattern: /index\.html\?(?!.*pane=secondary)/i });
  assert.equal(reopened.frame.animating, false);
  assert.ok(Math.abs(reopened.frame.contentWidth - Math.round(reopened.width * 0.65)) <= 1, 'reopening honors the remembered ratio');
  assert.ok(Math.abs(reopened.dragged.ratio - 0.4) < 0.03, 'divider movement still resizes the panes');
  assert.equal(reopened.closed, true);
  assert.deepEqual(reopened.errors, []);
} catch (err) {
  failed = true;
  console.error(err);
} finally {
  if (!child.killed) child.kill();
  await Promise.race([once(child, 'exit'), delay(3000)]).catch(() => {});
  await removeProfileDir(profile);
}
if (failed) process.exit(1);
console.log('split-view smoke ok — intermediate opening/closing frames, synchronized layout, reopen and divider resize');
