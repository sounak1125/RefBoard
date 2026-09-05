/** Focus Flow: real input, responsive geometry, stable previews and quiet frames. */
import electron from 'electron';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeProfileDir } from './smoke-profile-cleanup.mjs';

const { app, BrowserWindow } = electron;
app.on('window-all-closed', () => {}); // Exit explicitly after profile cleanup, preserving failures.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'refboard-focus-'));
const output = path.join(root, 'stress-out-smoke', 'focus-flow');
await fs.mkdir(output, { recursive: true });
app.setPath('userData', profile);
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let win;
const run = async expression => {
  let timer;
  try {
    return await Promise.race([win.webContents.executeJavaScript(expression), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Renderer timed out: ' + expression.slice(0, 100))), 10000);
    })]);
  } finally { clearTimeout(timer); }
};
async function waitFor(expression, label) {
  for (let i = 0; i < 200; i++) {
    if (await run(`Boolean(${expression})`).catch(() => false)) return;
    await delay(30);
  }
  throw new Error('Timed out: ' + label);
}
async function click(selector) {
  const point = await run(`(() => {
    const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  win.webContents.sendInputEvent({ type: 'mouseMove', ...point });
  win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
  win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
  await delay(50);
}
async function key(keyCode) {
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode });
  await delay(40);
}
const active = () => run(`Number(document.querySelector('.ff-card.is-active').dataset.focusIndex)`);
const capture = async name => {
  await delay(400);
  const png = await win.webContents.capturePage();
  await fs.writeFile(path.join(output, name + '.png'), png.toPNG());
  return png;
};
const geometry = `(() => {
  const rect = selector => document.querySelector(selector).getBoundingClientRect();
  const page = document.querySelector('#recentWorks');
  const card = rect('.ff-card.is-active'), stage = rect('#focusStage'), footer = rect('.ff-footer');
  const title = rect('.ff-card.is-active .rw-title'), thumb = rect('.ff-card.is-active .rw-thumb');
  const search = rect('#rwSearchInput'), header = rect('.rw-header');
  return { width:innerWidth, height:innerHeight,
    horizontalOverflow:page.scrollWidth - page.clientWidth,
    verticalOverflow:page.scrollHeight - page.clientHeight,
    cardTop:card.top-stage.top, cardBottom:stage.bottom-card.bottom,
    footerGap:footer.top-card.bottom, footerBottom:innerHeight-footer.bottom,
    titleHeight:title.height, titleFits:title.bottom <= card.bottom,
    previewHeight:thumb.height, searchFits:search.right <= header.right + 1,
    pageScroll:page.scrollTop,
  };
})()`;

async function main() {
try {
  await app.whenReady();
  win = new BrowserWindow({ show: false, width: 1440, height: 900, frame: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
  const errors = [];
  win.webContents.on('console-message', details => {
    if (/Uncaught|SyntaxError|ReferenceError|TypeError/.test(details.message || '')) errors.push(details.message);
  });
  await win.loadFile(path.join(root, 'index.html'));
  await waitFor('window.RefBoard?.startupComplete', 'startup');
  const preview = (await fs.readFile(path.join(root, 'build', 'icon.png'))).toString('base64');
  await run(`localStorage.setItem('refboard.settings', JSON.stringify({ landingLayout:'focus' }));
    localStorage.setItem('refboard.recentWorks', JSON.stringify(Array.from({length:24}, (_,i) => ({
      path:'C:/FocusSmoke/board-'+i+'.refboard', title:i === 0 ? 'Architecture references' : 'Study '+i,
      itemCount:24-i, thumbnailData:${JSON.stringify(preview)}, thumbnail:'preview.png', lastEdited:Date.now()-i*86400000
    }))));`);
  win.webContents.reloadIgnoringCache();
  await waitFor('window.RefBoard?.startupComplete && document.querySelectorAll(".ff-chip img").length === 24', 'preview strip');
  await delay(400);
  assert.equal(await active(), 0);

  // Refresh must retain the actual decoded images and focused button.
  const reused = await run(`(async () => {
    const card = document.querySelector('.ff-card'), image = card.querySelector('img');
    const chip = document.querySelector('.ff-chip'); chip.focus();
    await window.RefBoard.renderRecentWorksForTest();
    return card === document.querySelector('.ff-card') && image === card.querySelector('img') && document.activeElement === chip;
  })()`);
  assert.ok(reused, 'refresh must retain loaded previews and keyboard focus');
  await click('#focusNext');
  assert.equal(await active(), 1, 'next arrow selects next board');
  await run('document.querySelector(".ff-chip.is-active").focus()');
  await key('RIGHT');
  assert.equal(await active(), 2, 'strip supports arrow keys');
  await key('END');
  assert.equal(await active(), 23, 'End reaches last board');
  assert.ok(await run(`(() => {
    const row=document.querySelector('.ff-dock-row'), a=document.querySelector('.ff-chip.is-active');
    const r=row.getBoundingClientRect(), c=a.getBoundingClientRect();
    return c.left>=r.left && c.right<=r.right && row.scrollLeft>0 && document.querySelector('#recentWorks').scrollTop===0;
  })()`), 'last preview scrolls into strip without shifting page');
  await key('HOME');
  assert.equal(await active(), 0);
  await click('.ff-chip:nth-child(4)');
  assert.equal(await active(), 3, 'clicking preview selects board');

  // Hover has stable hit targets and identifies a board without selecting it.
  const hoverBox = await run(`document.querySelector('.ff-chip:nth-child(7)').getBoundingClientRect().toJSON()`);
  win.webContents.sendInputEvent({type:'mouseMove', x:Math.round(hoverBox.x+hoverBox.width/2), y:Math.round(hoverBox.y+hoverBox.height/2)});
  await delay(250);
  const hover = await run(`(() => {
    const chip=document.querySelector('.ff-chip:nth-child(7)'), face=chip.querySelector('.ff-chip-face');
    const row=document.querySelector('#focusDockRow').getBoundingClientRect();
    const rect=face.getBoundingClientRect(), label=document.querySelector('#focusDockCaption').getBoundingClientRect();
    return {box:chip.getBoundingClientRect().toJSON(), faceTop:rect.top,
      faceFits:rect.top>=row.top && rect.bottom<=row.bottom,
      caption:document.querySelector('#focusDockCaptionName').textContent,
      visible:getComputedStyle(document.querySelector('#focusDockCaption')).opacity,
      captionFits:label.left>=0 && label.right<=innerWidth && label.top>=document.querySelector('.ff-card.is-active').getBoundingClientRect().bottom,
      selected:document.querySelector('.ff-chip.is-active').dataset.focusIndex};
  })()`);
  assert.deepEqual(hover.box, hoverBox, 'hover animation must not move the hit target');
  assert.ok(hover.faceTop < hoverBox.top && hover.faceFits && hover.captionFits, 'lift and caption must fit without clipping: '+JSON.stringify(hover));
  assert.equal(hover.caption, 'Study 6');
  assert.equal(hover.visible, '1');
  assert.equal(hover.selected, '3', 'hover previews the label without changing selection');
  await capture('dock-hover');

  // Dragging the strip browses boards and suppresses the trailing click.
  win.webContents.sendInputEvent({type:'mouseDown', x:Math.round(hoverBox.x+hoverBox.width/2), y:Math.round(hoverBox.y+hoverBox.height/2), button:'left', clickCount:1});
  win.webContents.sendInputEvent({type:'mouseMove', x:Math.round(hoverBox.x+hoverBox.width/2-126), y:Math.round(hoverBox.y+hoverBox.height/2)});
  await delay(30);
  win.webContents.sendInputEvent({type:'mouseUp', x:Math.round(hoverBox.x+hoverBox.width/2-126), y:Math.round(hoverBox.y+hoverBox.height/2), button:'left', clickCount:1});
  await delay(400);
  assert.equal(await active(), 5, 'dragging strip should advance two boards');
  assert.equal(await run('document.body.classList.contains("board-active")'), false);

  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {type:'mouseWheel',x:Math.round(hoverBox.x),y:Math.round(hoverBox.y+hoverBox.height/2),deltaY:120,deltaX:0});
  await delay(250);
  assert.equal(await active(), 6, 'wheel over strip browses the collection');
  await click('.ff-chip:nth-child(4)');

  win.webContents.sendInputEvent({ type:'mouseMove', x:720, y:440 });
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type:'mouseWheel', x:720, y:440, deltaY:120, deltaX:0 });
  await delay(400);
  assert.equal(await active(), 4, 'wheel steps one board');
  const dragStart = await run(`(() => {
    window.__dragCard = document.querySelector('.ff-card.is-active');
    const r = window.__dragCard.getBoundingClientRect(); return r.left + r.width / 2;
  })()`);
  const dragSamples = [];
  win.webContents.sendInputEvent({ type:'mouseDown', x:720, y:440, button:'left', clickCount:1 });
  for (const dx of [24, 48, 72, 96, 120, 140]) {
    // Register before dispatch: sendInputEvent queues native input, so a RAF
    // requested by executeJavaScript alone can run before that input arrives.
    await run(`window.__nextDragFrame = new Promise(resolve => {
      document.querySelector('#focusStage').addEventListener('pointermove', () => requestAnimationFrame(() => {
        const r=window.__dragCard.getBoundingClientRect(); resolve(r.left+r.width/2);
      }), {once:true});
    }); true`);
    win.webContents.sendInputEvent({ type:'mouseMove', x:720-dx, y:440 });
    const center = await run('window.__nextDragFrame');
    dragSamples.push({ pointerDelta:-dx, cardDelta:center-dragStart });
    assert.ok(Math.abs(center-dragStart+dx)<.75, 'large cards must follow each pointer move in the next frame: '+JSON.stringify(dragSamples));
  }
  win.webContents.sendInputEvent({ type:'mouseUp', x:580, y:440, button:'left', clickCount:1 });
  await delay(400);
  assert.equal(await active(), 5, 'drag steps without opening board');
  assert.equal(await run('document.body.classList.contains("board-active")'), false);

  const interruptedDrag = await run(`(async () => {
    const stage=document.querySelector('#focusStage');
    document.querySelector('#focusNext').click();
    await new Promise(requestAnimationFrame);
    const card=document.querySelector('.ff-card.is-active');
    const center=()=>{const r=card.getBoundingClientRect();return r.left+r.width/2;};
    const before=center();
    const pointer=(type,x)=>stage.dispatchEvent(new PointerEvent(type,{bubbles:true,button:0,pointerId:191,clientX:x,clientY:440}));
    pointer('pointerdown',720);
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    const held=center();
    pointer('pointermove',680);
    await new Promise(requestAnimationFrame);
    const moved=center();
    pointer('pointercancel',680);
    return {grabJump:held-before, dragDelta:moved-held, cancelled:!stage.classList.contains('dragging')};
  })()`);
  assert.ok(Math.abs(interruptedDrag.grabJump)<.75 && Math.abs(interruptedDrag.dragDelta+40)<.75 && interruptedDrag.cancelled,
    'grabbing a moving card must freeze its current position without jumping: '+JSON.stringify(interruptedDrag));
  await waitFor('!document.querySelector("#focusStage").classList.contains("is-stepping")', 'cancelled drag settling');

  // A large board can remain loaded underneath Home. Pointer browsing must
  // never read its geometry or search those items for canvas hover targets.
  const hiddenBoardWork = await run(`(() => {
    const state=window.RefBoard.state, canvas=document.querySelector('#board');
    const itemsDescriptor=Object.getOwnPropertyDescriptor(state,'items');
    const rectDescriptor=Object.getOwnPropertyDescriptor(canvas,'getBoundingClientRect');
    const readRect=canvas.getBoundingClientRect.bind(canvas);
    const items=Array.from({length:2000},(_,i)=>window.RefBoard.makeNoteForTest({x:i*250,y:0,text:'Hidden note '+i}));
    let itemReads=0, geometryReads=0;
    try {
      Object.defineProperty(state,'items',{configurable:true,get(){itemReads++;return items;}});
      canvas.getBoundingClientRect=()=>{geometryReads++;return readRect();};
      for(let i=0;i<100;i++) document.querySelector('#focusStage').dispatchEvent(new PointerEvent('pointermove',{
        bubbles:true,pointerId:192,clientX:700-i,clientY:440
      }));
      return {itemCount:items.length,moves:100,itemReads,geometryReads};
    } finally {
      Object.defineProperty(state,'items',itemsDescriptor);
      if(rectDescriptor) Object.defineProperty(canvas,'getBoundingClientRect',rectDescriptor);
      else delete canvas.getBoundingClientRect;
    }
  })()`);
  assert.equal(hiddenBoardWork.itemReads,0,'Home pointer movement must not inspect hidden board items');
  assert.equal(hiddenBoardWork.geometryReads,0,'Home pointer movement must not measure the hidden canvas');

  await run('document.querySelector(".ff-card.is-active").focus()');
  await key('END');
  await waitFor('document.activeElement === document.querySelector(".ff-card.is-active")', 'focus after jumping to the last card');
  assert.equal(await active(),23);
  await click('.ff-chip:nth-child(6)');

  // Every frame during fast travel retains a preview, header and footer.
  const frames = await run(`(async () => {
    const result=[];
    for(let i=0;i<80;i++){
      if(i%7===0) document.querySelector(i<42?'#focusNext':'#focusPrev').click();
      await new Promise(requestAnimationFrame);
      const card=document.querySelector('.ff-card.is-active'), img=card.querySelector('img');
      result.push({ preview:img.complete && img.naturalWidth>0,
        header:document.querySelector('.rw-header').getBoundingClientRect().top,
        footer:document.querySelector('.ff-footer').getBoundingClientRect().top,
        buttons:[...document.querySelectorAll('.ff-card .rw-card-rename')].filter(b=>getComputedStyle(b).opacity!=='0').length });
    }
    return result;
  })()`);
  assert.ok(frames.every(f => f.preview && f.buttons <= 1), 'travel must not blank previews or flash controls across cards');
  assert.equal(new Set(frames.map(f => f.header)).size, 1, 'header must stay fixed');
  assert.equal(new Set(frames.map(f => f.footer)).size, 1, 'footer must stay fixed');
  win.webContents.sendInputEvent({ type:'mouseMove', x:10, y:20 });
  await delay(700);
  const first = (await win.webContents.capturePage()).toPNG();
  await delay(400);
  const second = (await win.webContents.capturePage()).toPNG();
  assert.ok(first.equals(second), 'idle landing frames must be pixel-identical');

  const sizes = [[1440,900],[1920,1080],[1024,768],[800,600],[720,480],[1440,480]];
  const layouts = [];
  for (const [width,height] of sizes) {
    win.setContentSize(width,height);
    await delay(400);
    const g = await run(geometry); layouts.push(g);
    assert.ok(g.horizontalOverflow<=1 && g.verticalOverflow<=1, 'landing must fit: '+JSON.stringify(g));
    assert.ok(g.cardTop>=0 && g.cardBottom>=0 && g.footerGap>=8 && g.footerBottom>=0, 'cards must clear footer: '+JSON.stringify(g));
    assert.ok(g.titleFits && g.titleHeight>=18 && g.previewHeight>=80 && g.searchFits, 'content must remain usable: '+JSON.stringify(g));
    await capture(width+'x'+height);
    if (width===720 && height===480) {
      const edge = await run(`(async()=>{
        const stage=document.querySelector('#focusStage');
        const i=Number(document.querySelector('.ff-card.is-active').dataset.focusIndex);
        const outgoing=document.querySelectorAll('.ff-card')[i-1];
        const pointer=(type,x)=>stage.dispatchEvent(new PointerEvent(type,{bubbles:true,button:0,pointerId:193,clientX:x,clientY:250}));
        pointer('pointerdown',360); pointer('pointermove',336);
        await new Promise(requestAnimationFrame);
        const result={visibility:getComputedStyle(outgoing).visibility,opacity:Number(getComputedStyle(outgoing).opacity)};
        pointer('pointercancel',336); return result;
      })()`);
      assert.ok(edge.visibility==='visible' && edge.opacity>.1,'outgoing side preview must not disappear at drag start: '+JSON.stringify(edge));
      await delay(300);
    }
    const point = await run(`(() => {const r=document.querySelector('.ff-chip.is-active').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
    win.webContents.sendInputEvent({type:'mouseMove', ...point});
    await delay(220);
    assert.ok(await run(`(() => {
      const face=document.querySelector('.ff-chip.is-active .ff-chip-face').getBoundingClientRect();
      const row=document.querySelector('#focusDockRow').getBoundingClientRect();
      const caption=document.querySelector('#focusDockCaption').getBoundingClientRect();
      return face.top>=row.top && face.bottom<=row.bottom && caption.left>=0 && caption.right<=innerWidth
        && caption.top>=document.querySelector('.ff-card.is-active').getBoundingClientRect().bottom;
    })()`), 'dock hover must remain unclipped at '+width+'x'+height);
    win.webContents.sendInputEvent({type:'mouseMove',x:10,y:20});
  }

  await run(`document.documentElement.dataset.theme='black'`);
  await capture('black-theme-dock');
  await run(`delete document.documentElement.dataset.theme`);

  await run(`document.querySelector('#rwSearchInput').value='Architecture'; document.querySelector('#rwSearchInput').dispatchEvent(new Event('input',{bubbles:true}));`);
  await waitFor('document.querySelectorAll(".ff-card").length===1', 'single result');
  assert.ok(await run('document.querySelector("#focusPrev").disabled && document.querySelector("#focusNext").disabled'));
  await capture('single-result');
  await run(`document.querySelector('#rwSearchInput').value='No matching boards'; document.querySelector('#rwSearchInput').dispatchEvent(new Event('input',{bubbles:true}));`);
  await waitFor('!document.querySelector("#recentNoResults").classList.contains("hide")', 'no results');
  await capture('no-results');
  await click('#rwNoResultsClear');
  await waitFor('document.querySelectorAll(".ff-card").length===24', 'search clear');

  win.setContentSize(720,480);
  await run('document.querySelector("#rwRestore").hidden=false');
  await delay(400);
  const restore = await run(geometry);
  assert.ok(restore.cardBottom>=0 && restore.footerGap>=8, 'restore prompt must not overlap stage');
  assert.ok(await run(`document.querySelector('#recentWorks').scrollHeight>=document.querySelector('.rw-inner').scrollHeight`), 'overflow must remain scrollable');
  await capture('restore');
  await run('document.querySelector("#rwRestore").hidden=true');

  // Reusing a card must not preserve a stale preview when the board was edited.
  const updatedPreview = (await fs.readFile(path.join(root, 'assets/icons/sel/norm-scale.png'))).toString('base64');
  await run(`(async()=>{
    const works=JSON.parse(localStorage.getItem('refboard.recentWorks'));
    works[0].lastEdited+=60000; works[0].thumbnailData=${JSON.stringify(updatedPreview)};
    localStorage.setItem('refboard.recentWorks',JSON.stringify(works));
    await window.RefBoard.renderRecentWorksForTest();
  })()`);
  assert.ok(await run(`document.querySelector('.ff-card .rw-thumb img').src.endsWith(${JSON.stringify(updatedPreview)})`), 'an edited board must refresh its preview');

  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
    features:[{name:'prefers-reduced-motion',value:'reduce'}],
  });
  await click('#focusNext');
  assert.equal(await run('getComputedStyle(document.querySelector(".ff-card")).transitionDuration'), '0s', 'reduced motion disables carousel animation');
  assert.equal(await run('getComputedStyle(document.querySelector(".ff-chip-face")).transform'), 'none', 'reduced motion disables dock magnification');
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {features:[]});

  await run(`localStorage.setItem('refboard.recentWorks','[]');`);
  win.webContents.reloadIgnoringCache();
  await waitFor('window.RefBoard?.startupComplete && !document.querySelector("#recentEmpty").classList.contains("hide")', 'empty landing');
  await capture('empty');
  assert.ok(await run(`(() => { const p=document.querySelector('#recentWorks');return p.scrollHeight<=p.clientHeight+1 && document.querySelector('#rwToolrow').hidden; })()`));
  assert.deepEqual(errors, [], 'renderer errors');
  await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({layouts, restore, dragSamples, interruptedDrag, hiddenBoardWork, idleFramesIdentical:true, sampledFrames:frames.length}, null, 2));
  console.log('Focus Flow Electron smoke passed: pointer tracking, interrupted drag, no hidden-board hit tests, hover, wheel, keyboard, previews, search, six window sizes, restore, empty state and identical idle frames.');
} catch (error) {
  console.error(error);
  if (win && !win.isDestroyed()) await capture('failure').catch(() => {});
  process.exitCode = 1;
} finally {
  if (win && !win.isDestroyed()) win.destroy();
  await removeProfileDir(profile);
  app.exit(process.exitCode || 0);
}
}
void main();
