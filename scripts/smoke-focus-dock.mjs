/**
 * Focus Flow dock: one chip per board, lit under the cursor, and honest about
 * which board you are actually on.
 *
 * The lift is an inline transform written on an animation frame, while which
 * chip is current is a class written during render. Those two can disagree:
 * click a chip, then step away with the wheel, and the chip you clicked keeps
 * standing up while the board you are now on sits flat. This drives the real
 * pointer and the real wheel and checks they agree after every step.
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
const electron = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const profile = await mkdtemp(path.join(os.tmpdir(), 'refboard-dock-'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const child = spawn(electron, ['.', '--remote-debugging-port=0', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-features=CalculateNativeWinOcclusion', `--user-data-dir=${profile}`], {
  cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
});
let stderr = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', chunk => { stderr += chunk; });

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

const BOARDS = 9;
const HOVER = 6;   // the chip the cursor is parked on
const CLICK = 2;   // the chip clicked before stepping away

const smokeExpression = `(async()=>{
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const frame=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
  for(let attempt=0;attempt<200&&!window.RefBoard;attempt++)await wait(50);
  if(!window.RefBoard)throw new Error('RefBoard API unavailable');
  for(let attempt=0;attempt<300&&!window.RefBoard.startupComplete;attempt++)await wait(50);
  if(!window.RefBoard.startupComplete)throw new Error('RefBoard startup did not complete');
  document.querySelectorAll('.modal.show').forEach(el=>el.classList.remove('show'));

  for(let i=${BOARDS}-1;i>=0;i--){
    await window.RefBoardAPI.addRecentWork({
      path:'C:/DockSmoke/board-'+i+'.refboard', title:'Dock board '+i,
      itemCount:10+i, generateThumbnail:false,
      lastOpened:Date.now()-i*3600000, lastEdited:Date.now()-i*3600000,
    });
  }
  window.RefBoard.appSettings.landingLayout='focus';
  await window.RefBoard.renderRecentWorksForTest();
  for(let attempt=0;attempt<200&&!document.querySelectorAll('#focusDockRow .ff-chip').length;attempt++)await wait(50);
  await wait(400);

  const dock=document.querySelector('#focusDock');
  const row=document.querySelector('#focusDockRow');
  if(!dock||!row)throw new Error('the dock did not render');
  const chips=()=>Array.from(row.querySelectorAll('.ff-chip'));
  if(chips().length<${BOARDS})throw new Error('only '+chips().length+' chips rendered');

  // 'translate3d(0px, -13.4px, 0px) scaleY(1.8)' -> 13.4. Read off the inline
  // string rather than the computed style, because the matrix folds the lift
  // and the scale together and this test is about the lift alone. Taken
  // positionally: the browser rewrites what was set as 'translate3d(0,-13.4px,0)',
  // so nothing here may depend on the exact spelling.
  const liftOf=el=>{
    const t=el.style.transform||'';
    const open=t.indexOf('(');
    const close=t.indexOf(')');
    if(open<0||close<open)return 0;
    const parts=t.slice(open+1,close).split(',');
    if(parts.length<2)return 0;
    const y=parseFloat(parts[1]);
    return Number.isFinite(y)?-y:0;
  };
  const raised=()=>chips().map((c,i)=>liftOf(c)>0.5?i:-1).filter(i=>i>=0);
  const activeIndex=()=>chips().findIndex(c=>c.classList.contains('is-active'));
  const move=x=>{
    const r=dock.getBoundingClientRect();
    dock.dispatchEvent(new PointerEvent('pointermove',{
      clientX:x, clientY:r.top+r.height*0.7, bubbles:true, pointerId:7,
    }));
  };
  const leave=()=>dock.dispatchEvent(new PointerEvent('pointerleave',{bubbles:false,pointerId:7}));

  const chipCount=chips().length;
  const cardCount=document.querySelectorAll('#focusTrack .ff-card').length;

  // --- read before dispatching anything: on a landing nobody has pointed at
  //     yet, the dock still has to show which board you are on ---
  const initialRaised=raised();
  const initialActive=activeIndex();

  // --- at rest, exactly one chip stands up, and it is the current board ---
  leave(); await frame(); await wait(100);
  const restRaised=raised();
  const restActive=activeIndex();
  const restTransforms=chips().map(c=>c.style.transform||'(none)');

  // --- the cursor lifts the chips it is over, in a falloff ---
  const box=chips()[${HOVER}].getBoundingClientRect();
  move(box.left+box.width/2);
  await frame(); await wait(100);
  const hoverNear=chips().map(c=>Number(c.style.getPropertyValue('--near')||0));
  const peak=hoverNear.indexOf(Math.max(...hoverNear));
  const monotoneLeft=hoverNear.slice(0,peak+1).every((v,i,a)=>i===0||v>=a[i-1]);
  const monotoneRight=hoverNear.slice(peak).every((v,i,a)=>i===0||v<=a[i-1]);
  const reached=hoverNear.filter(v=>v>0.05).length;
  const glowMoved=document.querySelector('#focusDockGlow').style.transform;
  leave(); await frame(); await wait(100);

  // --- click a chip, then step away, and check nobody is left stranded ---
  const cbox=chips()[${CLICK}].getBoundingClientRect();
  move(cbox.left+cbox.width/2);
  await frame();
  chips()[${CLICK}].dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,pointerId:7,button:0}));
  chips()[${CLICK}].click();
  await wait(250);
  leave(); await frame(); await wait(150);
  const afterClickActive=activeIndex();
  const afterClickRaised=raised();

  const stage=document.querySelector('#focusStage');
  const wheelSteps=[];
  for(let step=0;step<3;step++){
    stage.dispatchEvent(new WheelEvent('wheel',{deltaY:120,bubbles:true,cancelable:true}));
    await wait(300); await frame();
    wheelSteps.push({active:activeIndex(),raised:raised()});
  }

  // --- and the same going back, so it is not just a forward-only fix ---
  stage.dispatchEvent(new WheelEvent('wheel',{deltaY:-120,bubbles:true,cancelable:true}));
  await wait(300); await frame();
  const backActive=activeIndex();
  const backRaised=raised();

  // --- the row reaches highest on the chip that is BOTH current and under
  //     the cursor, and the counter and hint sit directly above it ---
  const peakBox=chips()[activeIndex()].getBoundingClientRect();
  move(peakBox.left+peakBox.width/2);
  await frame(); await wait(200);
  const peakChip=chips()[activeIndex()].getBoundingClientRect();
  const peakNear=Number(chips()[activeIndex()].style.getPropertyValue('--near')||0);
  const posRect=document.querySelector('#focusPosition').getBoundingClientRect();
  const hintEl=document.querySelector('.ff-hint');
  const hintVisible=!!hintEl&&getComputedStyle(hintEl).display!=='none';
  const hintRect=hintVisible?hintEl.getBoundingClientRect():null;
  const textBottom=Math.max(posRect.bottom,hintRect?hintRect.bottom:-Infinity);
  const headroom=Math.round((peakChip.top-textBottom)*10)/10;
  const dockHeight=Math.round(document.querySelector('#focusDock').getBoundingClientRect().height);
  leave();

  // --- while the row is moving, cards must not offer their controls ---
  // Cards slide under a stationary cursor, so each one passing briefly matches
  // :hover and flashes its buttons. Two halves to this: the stage is marked
  // while a step is in flight, and the rule that reads the mark has to outrank
  // the hover reveal, which sits later in the sheet at the same specificity.
  stage.dispatchEvent(new WheelEvent('wheel',{deltaY:120,bubbles:true,cancelable:true}));
  await frame();
  const marksWhileStepping=stage.classList.contains('is-stepping');
  await wait(900);
  const clearsWhenSettled=!stage.classList.contains('is-stepping');

  const rules=[...document.styleSheets].flatMap(sheet=>{
    try{ return [...sheet.cssRules]; }catch(e){ return []; }
  }).filter(rule=>rule.selectorText);
  const guardIndex=rules.findIndex(rule=>rule.selectorText.includes('.ff-stage.is-stepping')
    && rule.selectorText.includes('.rw-card-clear'));
  const hoverIndex=rules.findIndex(rule=>rule.selectorText.includes('.ff-card:hover')
    && rule.selectorText.includes('.rw-card-clear'));
  const guardSelector=guardIndex>=0?rules[guardIndex].selectorText:null;
  // Only matters when the hover reveal comes later; if it does, the guard needs
  // the extra class to win, and without it the whole thing silently does nothing.
  const guardOutranksHover=guardIndex>=0&&hoverIndex>=0
    ? (hoverIndex<guardIndex||guardSelector.includes('.ff-card .rw-card-clear'))
    : false;

  // --- a handful of boards must still look like a dock ---
  // With chips free to fill the row, three boards becomes three slabs with the
  // current one lit, which is the segmented progress bar the dock replaced.
  const manyWidest=Math.round(Math.max(...chips().map(c=>c.getBoundingClientRect().width))*10)/10;
  await frame();
  for(const entry of await window.RefBoardAPI.getRecentWorks()){
    try{ await window.RefBoardAPI.removeRecentWork(entry.path); }catch(e){}
  }
  for(let i=2;i>=0;i--){
    await window.RefBoardAPI.addRecentWork({
      path:'C:/DockSmoke/few-'+i+'.refboard', title:'Few board '+i,
      itemCount:3+i, generateThumbnail:false,
      lastOpened:Date.now()-i*3600000, lastEdited:Date.now()-i*3600000,
    });
  }
  await window.RefBoard.renderRecentWorksForTest();
  await wait(450); await frame();
  const fewCount=chips().length;
  const fewWidest=Math.round(Math.max(...chips().map(c=>c.getBoundingClientRect().width))*10)/10;

  return {chipCount,cardCount,initialRaised,initialActive,restRaised,restActive,restTransforms,hoverNear,peak,reached,
          monotoneLeft,monotoneRight,glowMoved,afterClickActive,afterClickRaised,
          wheelSteps,backActive,backRaised,peakNear,headroom,dockHeight,hintVisible,
          manyWidest,fewCount,fewWidest,
          marksWhileStepping,clearsWhenSettled,guardSelector,guardOutranksHover};
})()`;

try {
  const r = await evaluate(await debuggerPort(), smokeExpression);

  assert.equal(r.chipCount, BOARDS, `the dock must carry one chip per board (got ${r.chipCount})`);
  assert.equal(r.chipCount, r.cardCount, 'chips and cards must agree on how many boards there are');

  assert.deepEqual(r.initialRaised, [r.initialActive],
    `the dock must show the current board before anyone points at it (raised ${JSON.stringify(r.initialRaised)}, active ${r.initialActive})`);

  assert.deepEqual(r.restRaised, [r.restActive],
    `at rest only the current board should stand up (raised ${JSON.stringify(r.restRaised)}, active ${r.restActive})
  transforms: ${JSON.stringify(r.restTransforms)}`);

  assert.ok(r.hoverNear[r.peak] > 0.9, `the chip under the cursor must lift fully (peak ${r.hoverNear[r.peak]})`);
  assert.equal(r.peak, HOVER, `the peak must sit under the cursor, not elsewhere (peak ${r.peak})`);
  assert.equal(r.monotoneLeft, true, 'the falloff must not rise again to the left of the cursor');
  assert.equal(r.monotoneRight, true, 'the falloff must not rise again to the right of the cursor');
  assert.ok(r.reached < r.chipCount,
    `the whole row must not heave; the reach is meant to be local (${r.reached} of ${r.chipCount} chips moved)`);
  assert.ok(r.glowMoved.includes('translate3d'), 'the light pool must follow the cursor');

  assert.equal(r.afterClickActive, CLICK, 'clicking a chip must select that board');
  assert.deepEqual(r.afterClickRaised, [CLICK], 'after a click only the clicked chip should stand up');

  // The regression: the wheel changes the board, so the lift must move with it.
  // Before the fix the clicked chip stayed up and the new one never rose.
  for (const [i, step] of r.wheelSteps.entries()) {
    assert.equal(step.active, CLICK + 1 + i, `wheel step ${i + 1} should advance one board`);
    assert.deepEqual(step.raised, [step.active],
      `after wheel step ${i + 1} the clicked chip must sit back down (raised ${JSON.stringify(step.raised)}, active ${step.active})`);
  }
  assert.equal(r.backActive, CLICK + 2, 'scrolling back must step back one board');
  assert.deepEqual(r.backRaised, [r.backActive], 'stepping backwards must move the lift too');

  // The counter and the hint sit directly above the row. A chip at full
  // excursion must not climb into them.
  assert.ok(r.peakNear > 0.9, `the worst case needs the cursor on the current chip (near ${r.peakNear})`);
  assert.ok(r.headroom >= 2,
    `a chip at full lift must keep clear air under the counter and hint, but the gap is ${r.headroom}px `+
    `(dock reserves ${r.dockHeight}px, hint shown: ${r.hintVisible})`);

  // The carousel must go quiet while it moves.
  assert.equal(r.marksWhileStepping, true, 'a step must mark the stage so hover reveals can be held back');
  assert.equal(r.clearsWhenSettled, true, 'and the mark must clear once the row settles, or the controls never come back');
  assert.ok(r.guardSelector, 'the stepping guard rule must exist in the sheet');
  assert.equal(r.guardOutranksHover, true,
    `the stepping guard must outrank the hover reveal that follows it: ${r.guardSelector}`);

  // A chip must stay a chip whatever the board count.
  assert.equal(r.fewCount, 3, `expected three chips after reseeding (got ${r.fewCount})`);
  assert.ok(r.fewWidest <= 26,
    `with three boards a chip must stay chip-sized rather than fill the row: widest ${r.fewWidest}px `
    + `(at ${BOARDS} boards it was ${r.manyWidest}px)`);

  console.log('focus dock Electron smoke passed');
} finally {
  if (child.exitCode === null) child.kill();
  await Promise.race([once(child, 'exit'), delay(3000)]).catch(() => {});
  await removeProfileDir(profile);
}
