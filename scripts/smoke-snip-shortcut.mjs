/**
 * The Snip shortcut setting, driven through the real Settings → Shortcuts UI
 * with real pointer and key events, checked against what main.js actually
 * holds (globalShortcut.isRegistered, through the REFBOARD_SNIP_TEST hook).
 *
 * - Recording takes Ctrl+S and the board neither saves nor turns dirty; a
 *   bare key only hints. The old combination is let go, the new one held.
 * - A combination another app holds is refused and the old one stays held.
 *   The conflict is real: scripts/smoke-hotkey-holder.cjs, a second Electron
 *   app, registers it first.
 * - Off releases everything, and survives a restart on the same profile.
 * - Restore defaults brings back Ctrl+Alt+S, on.
 * - At startup a taken combination gets the toast that says where to fix it.
 *
 * Note: while it runs, the combinations it records are global on this machine
 * for a moment each (Ctrl+S included).
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeProfileDir } from './smoke-profile-cleanup.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const app = process.env.REFBOARD_SMOKE_EXECUTABLE || electron;
const profile = await mkdtemp(path.join(os.tmpdir(), 'refboard-snip-shortcut-smoke-'));
const holderProfile = await mkdtemp(path.join(os.tmpdir(), 'refboard-snip-holder-'));
const screenshotPath = path.join(os.tmpdir(), 'refboard-snip-shortcut-settings.png');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function cdp(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let nextId = 0;
  const pending = new Map();
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const handlers = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) handlers.reject(new Error(message.error.message));
    else handlers.resolve(message.result);
  };
  socket.onclose = () => {
    for (const handlers of pending.values()) handlers.reject(new Error('CDP socket closed'));
    pending.clear();
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    if (socket.readyState !== 1) { reject(new Error('CDP socket closed')); return; }
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const run = async expression => {
    const response = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    return response.result.value;
  };
  return { send, run, close: () => { try { socket.close(); } catch { /* gone */ } } };
}

/* One launch of the app: its renderer (index.html) and its main process. */
async function launch() {
  // A restart on the same profile must not read the last run's port.
  await rm(path.join(profile, 'DevToolsActivePort'), { force: true });
  const child = spawn(app, [...(process.env.REFBOARD_SMOKE_EXECUTABLE ? [] : ['.']), '--inspect=0', '--remote-debugging-port=0', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-features=CalculateNativeWinOcclusion', `--user-data-dir=${profile}`], {
    cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, REFBOARD_SNIP_TEST: '1' },
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  const portFile = path.join(profile, 'DevToolsActivePort');
  let port = 0;
  for (let attempt = 0; attempt < 100 && !port; attempt++) {
    if (child.exitCode !== null) throw new Error(`Electron exited early (${child.exitCode})\n${stderr}`);
    try {
      const [line] = (await readFile(portFile, 'utf8')).trim().split(/\r?\n/);
      if (/^\d+$/.test(line)) port = Number(line);
    } catch { /* starting */ }
    if (!port) await delay(100);
  }
  if (!port) throw new Error(`no debugging port\n${stderr}`);
  let inspector = null;
  for (let attempt = 0; attempt < 100 && !inspector; attempt++) {
    inspector = stderr.match(/Debugger listening on (ws:\/\/\S+)/)?.[1] || null;
    if (!inspector) await delay(100);
  }
  if (!inspector) throw new Error(`no main-process inspector\n${stderr}`);
  const main = await cdp(inspector);
  let page = null;
  for (let attempt = 0; attempt < 100 && !page; attempt++) {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json()).catch(() => []);
    const target = targets.find(t => t.type === 'page' && /index\.html/.test(t.url) && !/pane=secondary/.test(t.url));
    if (target) page = await cdp(target.webSocketDebuggerUrl);
    else await delay(100);
  }
  if (!page) throw new Error('no board page');
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  await page.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
  for (let attempt = 0; attempt < 300; attempt++) {
    const ready = await page.run('!!(window.RefBoard && window.RefBoard.startupComplete)').catch(() => false);
    if (ready) break;
    await delay(100);
  }
  const hook = expression => main.run(`(async () => { const T = globalThis.__refboardSnipTest; if (!T) throw new Error('snip test hook missing'); ${expression} })()`);
  const close = async () => {
    page.close();
    main.close();
    if (child.exitCode === null) child.kill();
    await Promise.race([once(child, 'exit'), delay(4000)]).catch(() => {});
  };
  /* A real quit (app.quit), so will-quit runs: a kill would skip the flush
     of a save still in flight, which is one of the things checked here. */
  const quit = async () => {
    await hook('setTimeout(() => T.quit(), 0); return true;').catch(() => {});
    // Node holds the process open while an inspector client is attached.
    main.close();
    const exited = await Promise.race([once(child, 'exit').then(() => true), delay(15000).then(() => false)]);
    const state = exited ? null : await page.run(`JSON.stringify({modals:[...document.querySelectorAll('.modal.show')].map(m=>m.id),dirty:window.RefBoard?.boardFileDirtyForTest,toast:document.getElementById('toast').textContent})`).catch(e => String(e));
    if (!exited) console.error('stderr tail at quit timeout:', stderr.slice(-600));
    page.close();
    main.close();
    if (!exited) {
      child.kill();
      throw new Error(`the app did not quit: ${state}`);
    }
  };
  return { child, page, main, hook, close, quit };
}

function startHolder(accelerator) {
  const child = spawn(electron, [path.join(root, 'scripts', 'smoke-hotkey-holder.cjs'), `--hold=${accelerator}`, `--user-data-dir=${holderProfile}`], {
    cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => { out += chunk; });
  const held = (async () => {
    for (let i = 0; i < 100; i++) {
      const m = out.match(/HELD \S+ (true|false)/);
      if (m) return m[1] === 'true';
      await delay(100);
    }
    return false;
  })();
  return {
    held,
    stop: async () => {
      if (child.exitCode === null) child.kill();
      await Promise.race([once(child, 'exit'), delay(3000)]).catch(() => {});
    },
  };
}

const MODS = { alt: 1, ctrl: 2, shift: 8 };
async function key(page, code, mods = []) {
  const k = /^Key/.test(code) ? code.slice(3).toLowerCase() : /^Digit/.test(code) ? code.slice(5) : code;
  const vk = /^Key/.test(code) ? code.charCodeAt(3) : /^Digit/.test(code) ? code.charCodeAt(5) : code === 'Escape' ? 27 : 0;
  const modifiers = mods.reduce((sum, m) => sum + MODS[m], 0);
  await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
}

async function click(page, selector, button = 'left') {
  const rect = await page.run(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)return null;el.scrollIntoView({block:'nearest'});const r=el.getBoundingClientRect();return r.width&&r.height?[r.x+r.width/2,r.y+r.height/2]:null;})()`);
  assert.ok(rect, `${selector} is on screen`);
  const [x, y] = rect;
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons: button === 'left' ? 1 : 2, clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0, clickCount: 1 });
}

async function waitFor(check, what, tries = 100, ms = 50) {
  for (let i = 0; i < tries; i++) {
    const value = await check();
    if (value) return value;
    await delay(ms);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const block = page => page.run(`(()=>{const b=document.getElementById('s2SnipBlock');if(!b)return null;
  const subs=[...b.querySelectorAll('.s2-row:nth-of-type(2) .s2-sub, .s2-row .s2-sub')].map(e=>e.textContent);
  return {status:b.querySelector('#setSnipStatus')?.textContent,on:b.querySelector('#setSnipEnabled')?.classList.contains('on'),
    keys:[...b.querySelectorAll('#setSnipKeys kbd')].map(k=>k.textContent),recording:b.querySelector('#setSnipKeys')?.textContent,
    change:b.querySelector('#setSnipChange')?.textContent,resetShown:!b.querySelector('#setSnipReset')?.hidden,
    subs:[...new Set(subs)],first:b.parentElement.firstElementChild===b};})()`);

/* Change starts a recording; keys sent before it shows would go to Settings. */
async function startRecording(page) {
  await click(page, '#setSnipChange');
  await waitFor(async () => (await block(page))?.recording === 'Press a shortcut…', 'the recording to start');
}

async function openShortcutSettings(page) {
  // Settings sits in the board's right-click menu.
  await page.run(`document.querySelectorAll('.modal.show').forEach(el=>el.classList.remove('show'))`);
  // The new board's opening overlay fades out first and catches clicks until then.
  await waitFor(() => page.run(`getComputedStyle(document.getElementById('openingOverlay')).visibility==='hidden'`), 'the opening overlay to go');
  await click(page, '#board', 'right');
  await waitFor(() => page.run(`[...document.querySelectorAll('#ctxmenu .mi')].some(e=>e.textContent.trim()==='Settings')`), 'the board menu');
  await page.run(`[...document.querySelectorAll('#ctxmenu .mi')].find(e=>e.textContent.trim()==='Settings').id='smokeSettingsItem'`);
  await click(page, '#smokeSettingsItem');
  await waitFor(() => page.run(`document.getElementById('settingsModal').classList.contains('show')`), 'Settings to open').catch(async error => {
    const state = await page.run(`(()=>{const el=document.getElementById('smokeSettingsItem');const r=el?.getBoundingClientRect();
      return {viewport:[innerWidth,innerHeight],item:r&&[r.x,r.y,r.width,r.height],menuShown:getComputedStyle(document.getElementById('ctxmenu')).display,
        hit:r?document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.outerHTML.slice(0,120):null};})()`).catch(() => null);
    throw new Error(`${error.message}: ${JSON.stringify(state)}`);
  });
  await click(page, '.s2-tab[data-pane="shortcuts"]');
  await waitFor(() => page.run(`!document.querySelector('.s2-pane[data-pane="shortcuts"]').hidden && !!document.getElementById('s2SnipBlock')`), 'the Shortcuts pane');
}

let step = 'launch';
let run = null;
let holder = null;
const report = {};
try {
  /* ---- first launch: defaults, recording, conflict, off ---- */
  run = await launch();
  let { page, hook } = run;
  await page.run(`(async()=>{document.querySelectorAll('.modal.show').forEach(el=>el.classList.remove('show'));document.querySelector('#rwNewBoard').click();
    for(let i=0;i<100&&!document.body.classList.contains('board-active');i++)await new Promise(r=>setTimeout(r,50));})()`);
  await delay(300);
  assert.deepEqual(await hook('return T.shortcut();'), { enabled: true, accelerator: 'Control+Alt+S', registered: true, error: null }, 'defaults: on, Ctrl+Alt+S, held');

  step = 'Settings → Shortcuts';
  await openShortcutSettings(page);
  let b = await block(page);
  assert.equal(b.first, true, 'the snip block is at the top of the pane');
  assert.equal(b.status, 'Works in every app while RefBoard is open');
  assert.equal(b.on, true);
  assert.deepEqual(b.keys, ['Ctrl', 'Alt', 'S']);
  assert.equal(b.resetShown, false, 'no Reset on the default');
  assert.ok(b.subs.includes('On keyboards with AltGr, this also blocks AltGr+S, which may type a letter.'), 'the default warns about AltGr');
  const shot = await page.send('Page.captureScreenshot', { format: 'png' });
  await writeFile(screenshotPath, Buffer.from(shot.data, 'base64'));

  // The settings search re-runs over the pane; the block must still be there
  // and filter like the other rows.
  await page.run(`(()=>{const s=document.getElementById('settingsSearch');s.value='snip';s.dispatchEvent(new Event('input'));})()`);
  const filtered = await page.run(`[...document.querySelectorAll('#s2SnipBlock .s2-row')].map(r=>r.style.display!=='none')`);
  assert.deepEqual(filtered, [true, false], 'search for "snip" keeps the Snip row and hides the Shortcut row');
  await page.run(`(()=>{const s=document.getElementById('settingsSearch');s.value='';s.dispatchEvent(new Event('input'));})()`);

  step = 'record Ctrl+S (refused)';
  const dirtyBefore = await page.run('window.RefBoard.boardFileDirtyForTest');
  const saveBefore = await page.run('JSON.stringify(window.RefBoard.lastBoardSaveStats)');
  await click(page, '#setSnipChange');
  b = await block(page);
  assert.equal(b.recording, 'Press a shortcut…');
  assert.equal(b.change, 'Cancel');
  assert.equal(await hook('return T.recording;'), true);
  assert.equal(await hook("return T.isRegistered('Control+Alt+S');"), false, 'the current combo is let go while recording');
  await key(page, 'KeyK');
  b = await block(page);
  assert.ok(b.subs.includes('Use two of Ctrl, Alt and Shift'), 'a bare key only hints');
  assert.equal(b.recording, 'Press a shortcut…', 'and recording goes on');
  // One modifier is refused: a global Ctrl+S would take Save from every app.
  await key(page, 'KeyS', ['ctrl']);
  await delay(400);
  b = await block(page);
  assert.ok(b.subs.includes('Use two of Ctrl, Alt and Shift'), 'Ctrl+S shows the two-modifier hint');
  assert.equal(b.recording, 'Press a shortcut…', 'Ctrl+S changes nothing; recording goes on');
  assert.deepEqual(await hook('return T.shortcut();'), { enabled: true, accelerator: 'Control+Alt+S', registered: false, error: null }, 'main still has Ctrl+Alt+S (let go only while recording)');
  assert.equal(await hook("return T.isRegistered('Control+S');"), false, 'Control+S is never registered');
  report.ctrlS = {
    dirtyBefore,
    dirtyAfter: await page.run('window.RefBoard.boardFileDirtyForTest'),
    saved: (await page.run('JSON.stringify(window.RefBoard.lastBoardSaveStats)')) !== saveBefore,
    toast: await page.run(`document.getElementById('toast').textContent`),
  };
  assert.equal(report.ctrlS.dirtyAfter, dirtyBefore, 'pressing Ctrl+S while recording does not dirty the board');
  assert.equal(report.ctrlS.saved, false, 'pressing Ctrl+S while recording does not save the board');
  assert.doesNotMatch(report.ctrlS.toast, /Sav/, 'no save toast either');
  assert.equal(await page.run(`document.getElementById('settingsModal').classList.contains('show')`), true, 'Settings stays open');
  await key(page, 'Escape');
  await waitFor(async () => !(await hook('return T.recording;')), 'Esc to end the recording');
  assert.equal(await hook("return T.isRegistered('Control+Alt+S');"), true, 'after the refusal the old combo is held again');
  assert.equal(await hook("return T.isRegistered('Control+S');"), false);

  step = 'record Ctrl+Shift+K';
  await startRecording(page);
  await key(page, 'KeyK', ['ctrl', 'shift']);
  const afterK = await waitFor(async () => { const x = await hook('return T.shortcut();'); return x.accelerator === 'Control+Shift+K' && x; }, 'Ctrl+Shift+K to be taken');
  assert.deepEqual(afterK, { enabled: true, accelerator: 'Control+Shift+K', registered: true, error: null });
  assert.equal(await hook("return T.isRegistered('Control+Shift+K');"), true);
  assert.equal(await hook("return T.isRegistered('Control+Alt+S');"), false, 'the old combo is released');
  b = await waitFor(async () => { const x = await block(page); return x.keys.join('+') === 'Ctrl+Shift+K' && x; }, 'the pane to show Ctrl+Shift+K');
  assert.equal(b.resetShown, true, 'Reset shows for a custom combo');
  assert.ok(!b.subs.some(t => /AltGr/.test(t)), 'no AltGr warning without Ctrl+Alt');

  step = 'record Ctrl+Alt+K, then Esc cancels a recording';
  await startRecording(page);
  await key(page, 'KeyK', ['ctrl', 'alt']);
  await waitFor(async () => (await hook('return T.shortcut();')).accelerator === 'Control+Alt+K', 'Ctrl+Alt+K to be taken');
  assert.equal(await hook("return T.isRegistered('Control+Alt+K');"), true);
  assert.equal(await hook("return T.isRegistered('Control+Shift+K');"), false);
  b = await waitFor(async () => { const x = await block(page); return x.keys.join('+') === 'Ctrl+Alt+K' && x; }, 'the pane to show Ctrl+Alt+K');
  assert.ok(b.subs.includes('On keyboards with AltGr, this also blocks AltGr+K, which may type a letter.'));
  await startRecording(page);
  await key(page, 'Escape');
  b = await block(page);
  assert.deepEqual(b.keys, ['Ctrl', 'Alt', 'K'], 'Esc ends the recording and keeps the combo');
  assert.equal(await page.run(`document.getElementById('settingsModal').classList.contains('show')`), true, 'Esc during recording does not close Settings');
  assert.equal(await hook('return T.recording;'), false);
  assert.equal(await hook("return T.isRegistered('Control+Alt+K');"), true, 'and holds it again');

  step = 'a combo another app holds';
  holder = startHolder('Control+Alt+J');
  assert.equal(await holder.held, true, 'the holder app took Ctrl+Alt+J');
  await startRecording(page);
  await key(page, 'KeyJ', ['ctrl', 'alt']);
  const refused = await waitFor(async () => { const s = await hook('return T.shortcut();'); return s.error && s; }, 'the refusal');
  assert.deepEqual(refused, { enabled: true, accelerator: 'Control+Alt+K', registered: true, error: { code: 'in-use', accelerator: 'Control+Alt+J' } });
  assert.equal(await hook("return T.isRegistered('Control+Alt+K');"), true, 'the old combo stays held');
  assert.equal(await hook("return T.isRegistered('Control+Alt+J');"), false);
  b = await waitFor(async () => { const x = await block(page); return x.subs.some(t => /in use/.test(t)) && x; }, 'the refusal in the pane');
  assert.ok(b.subs.includes('Ctrl+Alt+J is in use by another app'), `the refusal is shown: ${JSON.stringify(b.subs)}`);
  assert.deepEqual(b.keys, ['Ctrl', 'Alt', 'K']);
  await holder.stop();
  holder = null;

  step = 'recording abandoned by a reload';
  await click(page, '#setSnipChange');
  assert.equal(await hook('return T.recording;'), true);
  assert.equal(await hook("return T.isRegistered('Control+Alt+K');"), false);
  await page.run('window.__beforeReload = true');
  await page.send('Page.reload');
  await waitFor(async () => !(await hook('return T.recording;')), 'the reload to end the recording');
  assert.equal(await hook("return T.isRegistered('Control+Alt+K');"), true, 'a reload mid-recording gives the combo back');
  for (let attempt = 0; attempt < 300; attempt++) {
    if (await page.run('!window.__beforeReload && document.readyState !== "loading" && !!(window.RefBoard && window.RefBoard.startupComplete)').catch(() => false)) break;
    await delay(100);
  }
  await page.run(`(async()=>{document.querySelectorAll('.modal.show').forEach(el=>el.classList.remove('show'));document.querySelector('#rwNewBoard')?.click();
    for(let i=0;i<100&&!document.body.classList.contains('board-active');i++)await new Promise(r=>setTimeout(r,50));})()`);
  await delay(300);
  await openShortcutSettings(page);

  step = 'recording abandoned: the backstop timer';
  await hook('T.recordingTimeoutMs = 800; return true;');
  await click(page, '#setSnipChange');
  assert.equal(await hook('return T.recording;'), true);
  await waitFor(async () => !(await hook('return T.recording;')), 'the backstop to end the recording', 60);
  assert.equal(await hook("return T.isRegistered('Control+Alt+K');"), true, 'the backstop gives the combo back');
  await hook('T.recordingTimeoutMs = 30000; return true;');
  await click(page, '#setSnipChange'); // the page's own 30 s has not run out; cancel it
  b = await block(page);
  assert.notEqual(b.recording, 'Press a shortcut…');

  step = 'recording abandoned: Settings closed';
  await click(page, '#setSnipChange');
  assert.equal(await hook('return T.recording;'), true);
  await click(page, '#settingsClose');
  await waitFor(async () => !(await hook('return T.recording;')), 'closing Settings to end the recording');
  assert.equal(await hook("return T.isRegistered('Control+Alt+K');"), true);
  await openShortcutSettings(page);

  step = 'off';
  // Hold the save back so the quit below lands while it is still in flight:
  // only the synchronous flush in will-quit can get it to disk.
  await hook('T.saveDelayMs = 20000; return true;');
  await click(page, '#setSnipEnabled');
  await waitFor(async () => !(await hook('return T.shortcut();')).enabled, 'Snip to turn off');
  assert.deepEqual(await hook('return T.shortcut();'), { enabled: false, accelerator: 'Control+Alt+K', registered: false, error: null });
  for (const acc of ['Control+Alt+K', 'Control+Alt+S', 'Control+S']) {
    assert.equal(await hook(`return T.isRegistered(${JSON.stringify(acc)});`), false, `${acc} is not held when off`);
  }
  b = await waitFor(async () => { const x = await block(page); return x.status === 'Off' && x; }, 'the pane to say Off');
  assert.equal(b.status, 'Off');
  assert.equal(b.on, false);
  assert.match(await page.run(`document.getElementById('helpSnipDesc').textContent`), /off/i, 'the ? panel says it is off');
  const beforeQuit = await readFile(path.join(profile, 'snip-shortcut.json'), 'utf8').then(JSON.parse).catch(() => null);
  assert.notDeepEqual(beforeQuit, { enabled: false, accelerator: 'Control+Alt+K' }, 'the held-back save has not reached disk before the quit');
  await run.quit();

  /* ---- second launch, same profile: the setting persisted ---- */
  step = 'restart';
  run = await launch();
  ({ page, hook } = run);
  assert.deepEqual(await hook('return T.shortcut();'), { enabled: false, accelerator: 'Control+Alt+K', registered: false, error: null }, 'off and Ctrl+Alt+K survive a restart');
  assert.equal(await hook("return T.isRegistered('Control+Alt+K');"), false);
  assert.deepEqual(JSON.parse(await readFile(path.join(profile, 'snip-shortcut.json'), 'utf8')), { enabled: false, accelerator: 'Control+Alt+K' }, 'the save in flight at quit was written');

  step = 'Restore defaults';
  await page.run(`(async()=>{document.querySelectorAll('.modal.show').forEach(el=>el.classList.remove('show'));document.querySelector('#rwNewBoard').click();
    for(let i=0;i<100&&!document.body.classList.contains('board-active');i++)await new Promise(r=>setTimeout(r,50));})()`);
  await delay(300);
  await openShortcutSettings(page);
  await click(page, '#settingsRestore');
  // Restore defaults asks first.
  await waitFor(() => page.run(`document.getElementById('confirmModal').classList.contains('show')`), 'the restore confirm');
  await click(page, '#confirmOk');
  await waitFor(async () => (await hook('return T.shortcut();')).enabled, 'defaults to come back');
  assert.deepEqual(await hook('return T.shortcut();'), { enabled: true, accelerator: 'Control+Alt+S', registered: true, error: null });
  assert.equal(await hook("return T.isRegistered('Control+Alt+S');"), true);
  b = await waitFor(async () => { const x = await block(page); return x.keys.join('+') === 'Ctrl+Alt+S' && x; }, 'the pane to show the default');
  assert.equal(b.status, 'Works in every app while RefBoard is open');
  // Quit straight away: no waiting for the write.
  await run.quit();

  /* ---- third launch with the default taken: the startup toast ---- */
  step = 'startup toast';
  holder = startHolder('Control+Alt+S');
  assert.equal(await holder.held, true, 'the holder app took Ctrl+Alt+S');
  run = await launch();
  ({ page, hook } = run);
  const toast = await waitFor(() => page.run(`document.getElementById('toast').textContent`).then(t => /in use/.test(t) && t), 'the startup toast')
    .catch(async error => {
      const seen = await page.run(`document.getElementById('toast').textContent`).catch(() => '?');
      throw new Error(`${error.message}; toast reads ${JSON.stringify(seen)}; main has ${JSON.stringify(await hook('return T.shortcut();').catch(() => null))}`);
    });
  assert.equal(toast, 'Ctrl+Alt+S is in use by another app, so Snip is off. Change it in Settings → Shortcuts.');
  assert.deepEqual(await hook('return T.shortcut();'), { enabled: true, accelerator: 'Control+Alt+S', registered: false, error: { code: 'in-use', accelerator: 'Control+Alt+S' } });
  await page.run(`(async()=>{document.querySelectorAll('.modal.show').forEach(el=>el.classList.remove('show'));document.querySelector('#rwNewBoard').click();
    for(let i=0;i<100&&!document.body.classList.contains('board-active');i++)await new Promise(r=>setTimeout(r,50));})()`);
  await delay(300);
  await openShortcutSettings(page);
  b = await block(page);
  assert.equal(b.status, 'Ctrl+Alt+S is in use by another app');
  const shotTaken = await page.send('Page.captureScreenshot', { format: 'png' });
  await writeFile(screenshotPath.replace(/\.png$/, '-in-use.png'), Buffer.from(shotTaken.data, 'base64'));
  await run.close();
  run = null;
  await holder.stop();
  holder = null;

  console.log(`recorded Ctrl+S: board dirty ${report.ctrlS.dirtyBefore} -> ${report.ctrlS.dirtyAfter}, saved ${report.ctrlS.saved}`);
  console.log(`screenshots: ${screenshotPath} and ${screenshotPath.replace(/\.png$/, '-in-use.png')}`);
  console.log('snip shortcut Electron smoke passed');
} catch (error) {
  console.error(`snip shortcut smoke failed at "${step}"`);
  throw error;
} finally {
  await run?.close().catch(() => {});
  await holder?.stop().catch(() => {});
  await removeProfileDir(profile);
  await removeProfileDir(holderProfile);
}
