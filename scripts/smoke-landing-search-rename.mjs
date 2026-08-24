/**
 * Home search and rename (landing page), driven through the real UI.
 *
 * Rename moves a file on disk, so the only honest check is a real one: seed
 * actual .refboard files, type into the real search field, click the real
 * pencil, and then look at the file system and the recents store afterwards.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeProfileDir } from './smoke-profile-cleanup.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const profile = await mkdtemp(path.join(os.tmpdir(), 'refboard-home-'));
const boardsDir = await mkdtemp(path.join(os.tmpdir(), 'refboard-home-boards-'));
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
    const handlers = pending.get(message.id); pending.delete(message.id);
    if (message.error) handlers.reject(new Error(message.error.message)); else handlers.resolve(message.result);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
  });
  await send('Runtime.enable');
  const response = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  socket.close();
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  return response.result.value;
}

// A fourth board exists solely for the Focus Flow leg, so the file checks for
// the earlier legs still describe untouched files when the run ends.
const seedNames = ['Trip moodboard', 'Kitchen refs', 'Character sheet', 'Lighting study', 'Colour keys'];
const seedBoards = seedNames.map(name => ({ name, path: path.join(boardsDir, `${name}.refboard`) }));

const smokeExpression = `(async()=>{
  const seeds=${JSON.stringify(seedBoards)};
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  for(let attempt=0;attempt<200&&!window.RefBoard;attempt++)await wait(50);
  if(!window.RefBoard)throw new Error('RefBoard API unavailable');
  for(let attempt=0;attempt<300&&!window.RefBoard.startupComplete;attempt++)await wait(50);
  if(!window.RefBoard.startupComplete)throw new Error('RefBoard startup did not complete');
  document.querySelectorAll('.modal.show').forEach(el=>el.classList.remove('show'));

  // Real board files, so the rename has something to actually move.
  const core={items:[],view:{tx:0,ty:0,s:1},boardGray:false,gridAppearance:'dots'};
  for(const seed of seeds){
    const begin=await window.RefBoardAPI.beginBoardSave(seed.name,seed.path,core,null,false);
    if(!begin?.started)throw new Error('could not seed '+seed.name);
    const done=await window.RefBoardAPI.finishBoardSave(begin.token);
    if(!done?.saved)throw new Error('could not finish '+seed.name);
    await window.RefBoardAPI.addRecentWork({path:seed.path,title:seed.name,itemCount:0,generateThumbnail:false});
  }
  await window.RefBoard.renderRecentWorksForTest();
  await wait(150);

  const titles=()=>[...document.querySelectorAll('#recentGrid .rw-card:not(.rw-card-current) .rw-title')].map(el=>el.textContent);
  const cardFor=name=>[...document.querySelectorAll('#recentGrid .rw-card')]
    .find(card=>card.querySelector('.rw-title')?.textContent===name)||null;
  const input=document.querySelector('#rwSearchInput');
  const type=async v=>{input.value=v;input.dispatchEvent(new Event('input',{bubbles:true}));await wait(220);};

  const seeded=titles();
  const searchVisible=!document.querySelector('#rwToolrow').hidden;

  // --- Ctrl+F focuses the field ---
  document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'f',ctrlKey:true,bubbles:true,cancelable:true}));
  await wait(120);
  const focusedByShortcut=document.activeElement===input;

  // --- filtering ---
  await type('kitchen');
  const kitchenOnly=titles();
  const kitchenHighlighted=!!cardFor('Kitchen refs')?.querySelector('.rw-title mark');
  const countText=document.querySelector('#rwSearchCount').textContent;

  await type('zzzz');
  const noneShown=titles().length;
  const noResultsShown=!document.querySelector('#recentNoResults').classList.contains('hide');
  const emptyStateHidden=document.querySelector('#recentEmpty').classList.contains('hide');

  // --- clearing restores every board ---
  document.querySelector('#rwNoResultsClear').click();
  await wait(220);
  const restored=titles();

  // --- rename through the pencil ---
  const card=cardFor('Trip moodboard');
  card.querySelector('.rw-card-rename').click();
  await wait(120);
  const renameField=card.querySelector('.rw-rename-input');
  const renameOpened=!!renameField&&document.activeElement===renameField;
  const prefilled=renameField?renameField.value:null;
  renameField.value='Iceland trip';
  renameField.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
  await wait(700);
  const afterRename=titles();

  // --- a name that collides is refused, and the card keeps its old name ---
  const kitchenCard=cardFor('Kitchen refs');
  kitchenCard.querySelector('.rw-card-rename').click();
  await wait(120);
  const collide=kitchenCard.querySelector('.rw-rename-input');
  collide.value='Iceland trip';
  collide.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
  await wait(600);
  const afterCollision=titles();
  const collisionToast=document.querySelector('#toast')?.textContent||'';

  // --- an illegal name is refused too ---
  const badCard=cardFor('Kitchen refs');
  badCard.querySelector('.rw-card-rename').click();
  await wait(120);
  const bad=badCard.querySelector('.rw-rename-input');
  bad.value='bad/name';
  bad.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
  await wait(600);
  const afterIllegal=titles();

  // --- Escape abandons a rename without touching the file ---
  const escCard=cardFor('Character sheet');
  escCard.querySelector('.rw-card-rename').click();
  await wait(120);
  const esc=escCard.querySelector('.rw-rename-input');
  esc.value='Should not stick';
  esc.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
  await wait(300);
  const afterEscape=titles();
  const escapeClosedField=!escCard.querySelector('.rw-rename-input');

  // --- the click that dismisses a rename must not open the board ---
  const clickCard=cardFor('Character sheet');
  clickCard.querySelector('.rw-card-rename').click();
  await wait(120);
  clickCard.querySelector('.rw-rename-input').blur();
  clickCard.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));
  await wait(400);
  const stayedOnHome=!document.body.classList.contains('board-active');

  // --- F2 on a focused card renames it without a pointer ---
  const noRenameOpen=!window.RefBoard.landingSearchStateForTest().renaming;
  const keyCard=cardFor('Colour keys');
  keyCard.focus();
  document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'F2',bubbles:true,cancelable:true}));
  await wait(200);
  const keyField=keyCard.querySelector('.rw-rename-input');
  const f2Opened=!!keyField;
  if(keyField){
    keyField.value='Colour script';
    keyField.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
    await wait(700);
  }
  const afterF2=titles();

  // --- Focus Flow carries the same two features ---
  window.RefBoard.appSettings.landingLayout='focus';
  await window.RefBoard.renderRecentWorksForTest();
  await wait(400);
  const ffTitle=()=>document.querySelector('#focusTrack .ff-card.is-active .rw-title')?.textContent||null;
  await type('lighting');
  const ffCards=document.querySelectorAll('#focusTrack .ff-card').length;
  const ffFiltered=ffTitle();
  const ffHighlighted=!!document.querySelector('#focusTrack .ff-card.is-active .rw-title mark');
  const ffPosition=document.querySelector('#focusPosition').textContent;

  // F2 must reach the centred card without a pointer.
  document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'F2',bubbles:true,cancelable:true}));
  await wait(200);
  const ffField=document.querySelector('#focusTrack .ff-card.is-active .rw-rename-input');
  const ffRenameOpened=!!ffField;
  if(ffField){
    ffField.value='Key light study';
    ffField.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
    await wait(700);
  }
  await type('key light');
  const ffAfterRename=ffTitle();
  await type('');

  const recents=await window.RefBoardAPI.getRecentWorks();
  return {
    noRenameOpen,f2Opened,afterF2,
    ffCards,ffFiltered,ffHighlighted,ffPosition,ffRenameOpened,ffAfterRename,
    seeded,searchVisible,focusedByShortcut,kitchenOnly,kitchenHighlighted,countText,
    noneShown,noResultsShown,emptyStateHidden,restored,
    renameOpened,prefilled,afterRename,afterCollision,collisionToast,afterIllegal,
    afterEscape,escapeClosedField,stayedOnHome,
    recentPaths:recents.map(w=>w.path),
    recentTitles:recents.map(w=>w.title),
  };
})()`;

try {
  const r = await evaluate(await debuggerPort(), smokeExpression);

  assert.deepEqual(r.seeded.sort(), ['Character sheet', 'Colour keys', 'Kitchen refs', 'Lighting study', 'Trip moodboard'], 'every seeded board must appear on Home');
  assert.equal(r.searchVisible, true, 'the search field must be shown once boards exist');
  assert.equal(r.focusedByShortcut, true, 'Ctrl+F on Home must focus the search field');

  assert.deepEqual(r.kitchenOnly, ['Kitchen refs'], `typing must narrow the grid (got ${JSON.stringify(r.kitchenOnly)})`);
  assert.equal(r.kitchenHighlighted, true, 'the matched part of a title must be highlighted');
  assert.match(r.countText, /1 of 5 boards/, `the count must report the filter (got "${r.countText}")`);

  assert.equal(r.noneShown, 0, 'a query with no matches must show no cards');
  assert.equal(r.noResultsShown, true, 'a query with no matches must explain itself');
  assert.equal(r.emptyStateHidden, true, '"Create your first board" must not appear when boards exist but none match');
  assert.deepEqual(r.restored.sort(), ['Character sheet', 'Colour keys', 'Kitchen refs', 'Lighting study', 'Trip moodboard'], 'clearing the search must restore every board');

  assert.equal(r.renameOpened, true, 'the pencil must open a focused rename field');
  assert.equal(r.prefilled, 'Trip moodboard', 'the rename field must start from the current name');
  assert.ok(r.afterRename.includes('Iceland trip'), `the card must show the new name (got ${JSON.stringify(r.afterRename)})`);
  assert.ok(!r.afterRename.includes('Trip moodboard'), 'the old name must be gone from Home');

  assert.equal(existsSync(path.join(boardsDir, 'Iceland trip.refboard')), true, 'the file on disk must be renamed');
  assert.equal(existsSync(path.join(boardsDir, 'Trip moodboard.refboard')), false, 'the old file must not linger');
  assert.ok(r.recentPaths.some(p => p.endsWith('Iceland trip.refboard')), 'recents must point at the new path');
  assert.ok(!r.recentPaths.some(p => p.endsWith('Trip moodboard.refboard')), 'recents must not keep the old path');
  assert.ok(r.recentTitles.includes('Iceland trip'), 'recents must carry the new title');

  assert.ok(r.afterCollision.includes('Kitchen refs'), 'a colliding rename must leave the card alone');
  assert.match(r.collisionToast, /already/i, `a collision must be explained (got "${r.collisionToast}")`);
  assert.equal(existsSync(path.join(boardsDir, 'Kitchen refs.refboard')), true, 'a refused rename must not move the file');

  assert.ok(r.afterIllegal.includes('Kitchen refs'), 'an illegal name must leave the card alone');

  assert.ok(r.afterEscape.includes('Character sheet'), 'Escape must abandon the rename');
  assert.equal(r.escapeClosedField, true, 'Escape must close the rename field');
  assert.equal(existsSync(path.join(boardsDir, 'Character sheet.refboard')), true, 'an abandoned rename must not touch the file');
  assert.equal(existsSync(path.join(boardsDir, 'Should not stick.refboard')), false);

  assert.equal(r.stayedOnHome, true, 'the click that dismisses a rename must not open the board');

  assert.equal(r.noRenameOpen, true, 'blurring a rename field must close its session, not leave it open');
  assert.equal(r.f2Opened, true, 'F2 on a focused Home card must open its rename field');
  assert.ok(r.afterF2.includes('Colour script'), `F2 rename must take effect (got ${JSON.stringify(r.afterF2)})`);
  assert.equal(existsSync(path.join(boardsDir, 'Colour script.refboard')), true, 'the F2 rename must move the real file');
  assert.equal(existsSync(path.join(boardsDir, 'Colour keys.refboard')), false, 'the old file must not linger after an F2 rename');

  assert.equal(r.ffCards, 1, `Focus Flow must stage only the matching board (got ${r.ffCards})`);
  assert.equal(r.ffFiltered, 'Lighting study', 'Focus Flow must centre the match');
  assert.equal(r.ffHighlighted, true, 'Focus Flow must highlight the matched part of the title');
  assert.match(r.ffPosition, /1 of 1/, `the carousel position must reflect the filter (got "${r.ffPosition}")`);
  assert.equal(r.ffRenameOpened, true, 'F2 must open a rename on the centred Focus Flow card');
  assert.equal(r.ffAfterRename, 'Key light study', 'the Focus Flow rename must take effect');
  assert.equal(existsSync(path.join(boardsDir, 'Key light study.refboard')), true, 'the Focus Flow rename must move the real file');
  assert.equal(existsSync(path.join(boardsDir, 'Lighting study.refboard')), false, 'the old file must not linger after a Focus Flow rename');

  console.log('Home search + rename Electron smoke passed');
} finally {
  if (child.exitCode === null) child.kill();
  await Promise.race([once(child, 'exit'), delay(3000)]).catch(() => {});
  await removeProfileDir(profile);
  await rm(boardsDir, { recursive: true, force: true }).catch(() => {});
}
