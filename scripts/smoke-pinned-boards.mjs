/**
 * Pinned boards: the two or three you live in stop scrolling off the end.
 *
 * Recents are a history capped at 24, so a board you care about disappears
 * after a busy week and there is nothing you can do about it. A pin is kept in
 * addition to the recent slots, so this drives the real button and then opens
 * enough boards to overflow the cap - which is the only thing that proves it.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { removeProfileDir } from './smoke-profile-cleanup.mjs';
import { evaluate } from './smoke-cdp.mjs';

const require = createRequire(import.meta.url);
const { MAX_PINNED, MAX_RECENT } = require('./recent-works.js');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const profile = await mkdtemp(path.join(os.tmpdir(), 'refboard-pin-'));
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

const SEEDED = 6;

const smokeExpression = `(async()=>{
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  for(let attempt=0;attempt<200&&!window.RefBoard;attempt++)await wait(50);
  if(!window.RefBoard)throw new Error('RefBoard API unavailable');
  for(let attempt=0;attempt<300&&!window.RefBoard.startupComplete;attempt++)await wait(50);
  if(!window.RefBoard.startupComplete)throw new Error('RefBoard startup did not complete');
  document.querySelectorAll('.modal.show').forEach(el=>el.classList.remove('show'));

  const seed=async(count,prefix)=>{
    for(let i=count-1;i>=0;i--){
      await window.RefBoardAPI.addRecentWork({
        path:'C:/Pin/'+prefix+i+'.refboard', title:prefix+' '+i,
        itemCount:5+i, generateThumbnail:false,
        lastOpened:Date.now()-i*3600000, lastEdited:Date.now()-i*3600000,
      });
    }
    await window.RefBoard.renderRecentWorksForTest();
    await wait(400);
  };
  // Real clicks: a plain .click() fires no pointerdown, and this app has
  // dismiss handlers that key off it.
  const press=el=>{
    el.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,pointerId:11,button:0}));
    el.click();
  };
  const focusCards=()=>[...document.querySelectorAll('#focusTrack .ff-card')];
  const gridCards=()=>[...document.querySelectorAll('#recentGrid .rw-card')];
  const titlesOf=cards=>cards.map(c=>c.querySelector('.rw-title')?.textContent||'?');

  window.RefBoard.appSettings.landingLayout='focus';
  await seed(${SEEDED},'Board');

  // --- every card offers a pin, and none is on yet ---
  const startCards=focusCards();
  const startPins=[...document.querySelectorAll('#focusTrack .ff-card .rw-card-pin')];
  const focusHasPins=startPins.length===startCards.length&&startCards.length===${SEEDED};
  const noneLitAtFirst=startPins.every(p=>!p.classList.contains('is-on'));

  // --- pinning the third board lights it and moves it to the front ---
  const targetTitle=startCards[2].querySelector('.rw-title').textContent;
  press(startCards[2].querySelector('.rw-card-pin'));
  await wait(900);
  const afterPinTitles=titlesOf(focusCards());
  const litAfterPin=[...document.querySelectorAll('#focusTrack .ff-card .rw-card-pin.is-on')].length;
  const markedAfterPin=document.querySelectorAll('#focusTrack .ff-card.is-pinned').length;

  // --- the classic grid shows the same pin, already on ---
  window.RefBoard.appSettings.landingLayout='classic';
  await window.RefBoard.renderRecentWorksForTest();
  await wait(500);
  const gridPinButtons=document.querySelectorAll('#recentGrid .rw-card .rw-card-pin').length;
  const gridLit=document.querySelectorAll('#recentGrid .rw-card .rw-card-pin.is-on').length;
  const gridFirst=titlesOf(gridCards())[0];
  window.RefBoard.appSettings.landingLayout='focus';
  await window.RefBoard.renderRecentWorksForTest();
  await wait(400);

  // --- the whole point: open enough boards to overflow the cap ---
  await seed(${MAX_RECENT + 4},'Churn');
  const stored=await window.RefBoardAPI.getRecentWorks();
  const survived=stored.filter(w=>w.pinned).map(w=>w.title);
  const storedTotal=stored.length;
  const storedFirst=stored[0]?.title||null;
  const looseKept=stored.filter(w=>!w.pinned).length;

  // --- unpinning gives the board back to the history ---
  const pinnedCard=focusCards().find(c=>c.classList.contains('is-pinned'));
  const unpinnedOk=!!pinnedCard;
  if(pinnedCard) press(pinnedCard.querySelector('.rw-card-pin'));
  await wait(900);
  const afterUnpin=(await window.RefBoardAPI.getRecentWorks()).filter(w=>w.pinned).length;

  // --- the pin limit holds, and says so rather than silently dropping one ---
  const fresh=await window.RefBoardAPI.getRecentWorks();
  for(const work of fresh.slice(0,${MAX_PINNED} + 2)){
    await window.RefBoardAPI.setRecentWorkPinned(work.path, true);
  }
  await window.RefBoard.renderRecentWorksForTest();
  await wait(500);
  const cappedPins=(await window.RefBoardAPI.getRecentWorks()).filter(w=>w.pinned).length;
  const nothingLost=(await window.RefBoardAPI.getRecentWorks()).length;

  return {focusHasPins,noneLitAtFirst,targetTitle,afterPinTitles,litAfterPin,markedAfterPin,
          gridPinButtons,gridLit,gridFirst,
          survived,storedTotal,storedFirst,looseKept,
          unpinnedOk,afterUnpin,cappedPins,nothingLost};
})()`;

try {
  const r = await evaluate(await debuggerPort(), smokeExpression, { focusEmulation: true });

  assert.equal(r.focusHasPins, true, 'every Focus Flow card must offer a pin');
  assert.equal(r.noneLitAtFirst, true, 'nothing is pinned until someone pins it');

  assert.equal(r.afterPinTitles[0], r.targetTitle,
    `a pinned board leads the list (got ${JSON.stringify(r.afterPinTitles.slice(0, 3))})`);
  assert.equal(r.litAfterPin, 1, 'exactly the pinned card shows a lit pin');
  assert.equal(r.markedAfterPin, 1, 'the pinned card is marked so it reads as pinned at a glance');

  assert.equal(r.gridPinButtons > 0, true, 'the classic grid must offer the pin too');
  assert.equal(r.gridLit, 1, 'the pin is the same state in both layouts, not per-layout');
  assert.equal(r.gridFirst, r.targetTitle, 'the classic grid leads with the pin as well');

  // The feature exists for exactly this: churn that would have evicted it.
  assert.deepEqual(r.survived, [r.targetTitle],
    `a pin must outlive ${MAX_RECENT + 4} newer boards (survivors: ${JSON.stringify(r.survived)})`);
  assert.equal(r.storedFirst, r.targetTitle, 'and still lead the list afterwards');
  assert.equal(r.looseKept, MAX_RECENT,
    `pins are kept on top of the recent slots, not instead of them (${r.looseKept} loose entries)`);
  assert.equal(r.storedTotal, MAX_RECENT + 1, 'so the store holds the cap plus the pin');

  assert.equal(r.unpinnedOk, true, 'the pinned card must still be on screen to unpin');
  assert.equal(r.afterUnpin, 0, 'unpinning releases the board back to the history');

  assert.equal(r.cappedPins, MAX_PINNED, `the pin limit holds at ${MAX_PINNED} (got ${r.cappedPins})`);
  assert.ok(r.nothingLost >= MAX_RECENT,
    `refusing a pin must not cost a board (${r.nothingLost} entries left)`);

  console.log('pinned boards Electron smoke passed');
} finally {
  if (child.exitCode === null) child.kill();
  await Promise.race([once(child, 'exit'), delay(3000)]).catch(() => {});
  await removeProfileDir(profile);
}
