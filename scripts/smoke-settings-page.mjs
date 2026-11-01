/**
 * Settings, driven through the real UI with pointer and key events on a fresh
 * profile: opened from the board's right-click menu, every control changes the
 * setting it names (read back from window.RefBoard.appSettings), the autosave
 * interval and large-image limit only show while their switch is on, search
 * covers every pane and matches keys, Look up a key finds what a combination
 * does (Ctrl+T is looked up, not acted on), Restore defaults asks first, the ?
 * panel lists the same shortcuts, and closing ends a lookup.
 *
 * Set REFBOARD_SMOKE_SHOTS=<folder> to keep a screenshot of each step.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeProfileDir } from './smoke-profile-cleanup.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const app = process.env.REFBOARD_SMOKE_EXECUTABLE || electron;
const profile = await mkdtemp(path.join(os.tmpdir(), 'refboard-settings-smoke-'));
const shots = process.env.REFBOARD_SMOKE_SHOTS || '';
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

const child = spawn(app, [...(process.env.REFBOARD_SMOKE_EXECUTABLE ? [] : ['.']), '--remote-debugging-port=0', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-features=CalculateNativeWinOcclusion', `--user-data-dir=${profile}`], {
  cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
});
let stderr = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', chunk => { stderr += chunk; });

async function connect() {
  const portFile = path.join(profile, 'DevToolsActivePort');
  let port = 0;
  for (let i = 0; i < 150 && !port; i++) {
    if (child.exitCode !== null) throw new Error(`Electron exited early (${child.exitCode})\n${stderr}`);
    try {
      const [line] = (await readFile(portFile, 'utf8')).trim().split(/\r?\n/);
      if (/^\d+$/.test(line)) port = Number(line);
    } catch { /* starting */ }
    if (!port) await delay(100);
  }
  if (!port) throw new Error(`no debugging port\n${stderr}`);
  for (let i = 0; i < 100; i++) {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json()).catch(() => []);
    const target = targets.find(t => t.type === 'page' && /index\.html/.test(t.url) && !/pane=secondary/.test(t.url));
    if (target) return cdp(target.webSocketDebuggerUrl);
    await delay(100);
  }
  throw new Error('no board page');
}

const MODS = { alt: 1, ctrl: 2, shift: 8 };
async function key(page, code, mods = [], keyName) {
  const k = keyName ?? (/^Key/.test(code) ? code.slice(3).toLowerCase() : /^Digit/.test(code) ? code.slice(5) : code);
  const vk = /^Key/.test(code) ? code.charCodeAt(3) : /^Digit/.test(code) ? code.charCodeAt(5) : { Escape: 27, Enter: 13 }[code] || 0;
  const modifiers = mods.reduce((sum, m) => sum + MODS[m], 0);
  await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
}
async function type(page, text) {
  for (const ch of text) await page.send('Input.dispatchKeyEvent', { type: 'char', text: ch });
}
async function click(page, selector, button = 'left') {
  const at = await page.run(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)return null;el.scrollIntoView({block:'nearest'});const r=el.getBoundingClientRect();return r.width&&r.height?[r.x+r.width/2,r.y+r.height/2]:null;})()`);
  assert.ok(at, `${selector} is on screen`);
  const [x, y] = at;
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons: button === 'left' ? 1 : 2, clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0, clickCount: 1 });
  await delay(60);
}
async function waitFor(check, what, tries = 100, ms = 50) {
  for (let i = 0; i < tries; i++) {
    const value = await check();
    if (value) return value;
    await delay(ms);
  }
  throw new Error(`timed out waiting for ${what}`);
}
let shotN = 0;
async function shot(page, name) {
  if (!shots) return;
  await mkdir(shots, { recursive: true });
  const s = await page.send('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(shots, `${String(++shotN).padStart(2, '0')}-${name}.png`), Buffer.from(s.data, 'base64'));
}
const setting = (page, k) => page.run(`window.RefBoard.appSettings[${JSON.stringify(k)}]`);
const shown = (page, sel) => page.run(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});return !!el&&el.getClientRects().length>0;})()`);
const visibleRows = (page, scope) => page.run(`[...document.querySelectorAll(${JSON.stringify(scope + ' .s2-row')})].filter(r=>r.getClientRects().length).map(r=>r.querySelector('.s2-label')?.textContent)`);

let step = 'launch';
const report = {};
let page = null;
try {
  page = await connect();
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  await page.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
  await waitFor(() => page.run('!!(window.RefBoard && window.RefBoard.startupComplete)').catch(() => false), 'startup', 300);
  await page.run(`(async()=>{document.querySelectorAll('.modal.show').forEach(el=>el.classList.remove('show'));document.querySelector('#rwNewBoard').click();
    for(let i=0;i<100&&!document.body.classList.contains('board-active');i++)await new Promise(r=>setTimeout(r,50));})()`);
  await waitFor(() => page.run(`getComputedStyle(document.getElementById('openingOverlay')).visibility==='hidden'`), 'the opening overlay to go');

  step = 'open from the board menu';
  await click(page, '#board', 'right');
  await waitFor(() => page.run(`[...document.querySelectorAll('#ctxmenu .mi')].some(e=>e.textContent.trim()==='Settings')`), 'the board menu');
  await page.run(`[...document.querySelectorAll('#ctxmenu .mi')].find(e=>e.textContent.trim()==='Settings').id='smokeSettingsItem'`);
  await click(page, '#smokeSettingsItem');
  await waitFor(() => page.run(`document.getElementById('settingsModal').classList.contains('show')`), 'Settings to open');
  assert.equal(await page.run(`document.getElementById('settingsTitle').textContent`), 'General', 'opens on General');
  await shot(page, 'general');

  step = 'General';
  for (const [id, k] of [['setAutosave', 'autosave'], ['setWarnLarge', 'warnLargeImages'], ['setSnap', 'snapEnabled'], ['setThumbs', 'generateThumbnails']]) {
    const before = await setting(page, k);
    await click(page, `#${id}`);
    assert.equal(await setting(page, k), !before, `#${id} flips ${k}`);
    assert.equal(await page.run(`document.getElementById('${id}').getAttribute('aria-checked')`), String(!before), `#${id} says so`);
    if (id === 'setAutosave') assert.equal(await shown(page, '#setAutosaveEveryRow'), false, 'the interval hides while autosave is off');
    if (id === 'setWarnLarge') assert.equal(await shown(page, '#setLargeMPRow'), false, 'the limit hides while warnings are off');
    await click(page, `#${id}`);
    assert.equal(await setting(page, k), before, `#${id} flips back`);
  }
  await click(page, '#setAutosaveEvery button[data-min="20"]');
  assert.equal(await setting(page, 'autosaveIntervalMin'), 20, 'an interval button sets the interval');
  assert.match(await page.run(`document.getElementById('setAutosaveSub').textContent`), /every 20 minutes/, 'and the description follows');
  await click(page, '#setLargeMPRow .ui-num-up');
  assert.equal(await setting(page, 'largeImageMP'), 45, '+ raises the limit by 5');
  await click(page, '#setLargeMPRow .ui-num-down');
  assert.equal(await setting(page, 'largeImageMP'), 40, '− lowers it');
  await shot(page, 'general-after');

  step = 'Appearance';
  await click(page, '.s2-tab[data-pane="appearance"]');
  assert.equal(await page.run(`document.getElementById('settingsTitle').textContent`), 'Appearance');
  await click(page, '.theme-swatch[data-theme="pine"]');
  assert.equal(await page.run(`document.documentElement.getAttribute('data-theme')`), 'pine', 'a theme applies');
  assert.deepEqual(await page.run(`[...document.querySelectorAll('.theme-swatch.active')].map(b=>b.dataset.theme)`), ['pine']);
  await shot(page, 'appearance-forest');
  const pick = async (id, value) => {
    await click(page, `#${id} + .ui-select-button`);
    await waitFor(() => shown(page, `#uiSelectMenu-${id}.show`), `the ${id} menu`);
    await click(page, `#uiSelectMenu-${id} [data-value="${value}"]`);
  };
  await pick('setGridStyle', 'none');
  assert.equal(await page.run('window.RefBoard.state.gridAppearance'), 'none', 'Grid style changes the board grid');
  await pick('setGridStyle', 'dots');
  await pick('setLandingLayout', 'focus');
  assert.equal(await setting(page, 'landingLayout'), 'focus', 'Home layout');
  await pick('setLandingLayout', 'classic');
  await pick('setToolbarMode', 'pinned');
  assert.equal(await setting(page, 'toolbarMode'), 'pinned', 'Left toolbar');
  assert.equal(await page.run(`document.body.classList.contains('toolbar-pinned')`), true, 'the toolbar is pinned');
  await pick('setToolbarMode', 'floating');
  await click(page, '#setGridStyle + .ui-select-button');
  const menuShadow = await page.run(`getComputedStyle(document.getElementById('uiSelectMenu-setGridStyle')).boxShadow`);
  report.menuShadow = menuShadow;
  await shot(page, 'select-menu-open');
  await key(page, 'Escape');
  assert.equal(await shown(page, '#uiSelectMenu-setGridStyle.show'), false, 'Esc closes the open menu');
  assert.equal(await page.run(`document.getElementById('settingsModal').classList.contains('show')`), true, 'and only the menu');
  await click(page, '.theme-swatch[data-theme="midnight"]');

  step = 'Performance';
  await click(page, '.s2-tab[data-pane="performance"]');
  for (const [id, k] of [['setPauseHidden', 'pauseWhenHidden'], ['setHideGridNav', 'hideGridWhileNavigating'], ['setLightDrag', 'lightDragPreview']]) {
    const before = await setting(page, k);
    await click(page, `#${id}`);
    assert.equal(await setting(page, k), !before, `#${id} flips ${k}`);
    await click(page, `#${id}`);
  }
  await pick('setRenderQuality', 'fast');
  assert.equal(await setting(page, 'renderQuality'), 'fast', 'Image render quality');
  await pick('setRenderQuality', 'high');
  await pick('setImageMemory', '1024');
  assert.equal(await setting(page, 'imageMemoryMB'), 1024, 'Decoded image memory');
  await pick('setImageMemory', 'auto');
  await click(page, '.s2-pane[data-pane="performance"] .ui-num-up');
  assert.equal(await setting(page, 'undoLimit'), 210, 'Undo history +10');
  await click(page, '.s2-pane[data-pane="performance"] .ui-num-down');
  assert.equal(await setting(page, 'undoLimit'), 200);
  await shot(page, 'performance');

  step = 'About';
  await click(page, '.s2-tab[data-pane="system"]');
  assert.equal(await page.run(`document.getElementById('settingsTitle').textContent`), 'About');
  assert.match(await page.run(`document.getElementById('setVersionText').textContent`), /^RefBoard \d+\.\d+\.\d+/, 'the version shows');
  assert.deepEqual(await page.run(`(()=>{const a=document.getElementById('setAboutIcon'),h=document.getElementById('landingBrandIcon');return [a.src===h.src,a.complete&&a.naturalWidth>0];})()`), [true, true], 'About shows the official icon, loaded');
  assert.equal(await page.run(`document.getElementById('setCheckUpdates').disabled`), true, 'no update check in a development build');
  const startup = await setting(page, 'checkUpdatesOnStartup');
  await click(page, '#setCheckOnStartup');
  assert.equal(await setting(page, 'checkUpdatesOnStartup'), !startup, 'Check on startup');
  await click(page, '#setCheckOnStartup');
  await shot(page, 'about');

  step = 'search';
  await click(page, '#settingsSearch');
  await type(page, 'theme');
  await waitFor(() => page.run(`document.getElementById('settingsModal').classList.contains('s2-searching')`), 'search mode');
  assert.equal(await page.run(`document.getElementById('settingsTitle').textContent`), 'Search');
  assert.equal(await shown(page, '.s2-themes'), true, 'a search from About finds the theme picker in Appearance');
  assert.equal(await page.run(`document.querySelector('.s2-tab[data-pane="appearance"] .s2-count').textContent`), '1', 'the nav counts it');
  await shot(page, 'search-theme');
  await page.run(`(()=>{const s=document.getElementById('settingsSearch');s.value='ctrl g';s.dispatchEvent(new Event('input'));})()`);
  assert.deepEqual(await visibleRows(page, '.s2-pane[data-pane="shortcuts"]'), ['Group', 'Ungroup'], '"ctrl g" finds Ctrl+G and Ctrl+Shift+G only');
  assert.deepEqual(await visibleRows(page, '.s2-pane:not([data-pane="shortcuts"])'), [], 'and no setting');
  await shot(page, 'search-ctrl-g');
  await page.run(`(()=>{const s=document.getElementById('settingsSearch');s.value='zebra';s.dispatchEvent(new Event('input'));})()`);
  assert.equal(await shown(page, '#settingsEmpty'), true, 'no match says so');
  await shot(page, 'search-empty');
  await key(page, 'Escape');
  assert.equal(await page.run(`document.getElementById('settingsSearch').value`), '', 'Esc in the search clears it');
  assert.equal(await page.run(`document.getElementById('settingsModal').classList.contains('show')`), true, 'and leaves Settings open');
  assert.equal(await page.run(`document.getElementById('settingsTitle').textContent`), 'About', 'back on the pane it was on');

  step = 'Shortcuts and Look up a key';
  await click(page, '.s2-tab[data-pane="shortcuts"]');
  const listed = await page.run(`document.querySelectorAll('.s2-pane[data-pane="shortcuts"] .s2-sc').length`);
  report.shortcutRows = listed;
  assert.ok(listed >= 60, `${listed} shortcuts listed`);
  assert.equal(await page.run(`document.getElementById('s2SnipBlock')===document.querySelector('.s2-pane[data-pane="shortcuts"]').firstElementChild`), true, 'Snip to board comes first');
  await shot(page, 'shortcuts');
  await click(page, '#settingsLookup');
  await waitFor(() => shown(page, '.s2-lookup-rec'), 'the lookup to listen');
  await key(page, 'KeyG', ['shift'], 'G');
  await waitFor(() => page.run(`!document.querySelector('.s2-lookup-rec')`), 'the lookup to finish');
  assert.deepEqual(await visibleRows(page, '.s2-pane[data-pane="shortcuts"]'), ['Grayscale the whole board'], 'Shift+G is board grayscale');
  assert.equal(await page.run('document.documentElement.classList.contains("gray")||window.RefBoard.state.boardGray||false'), false, 'and looking it up did not turn it on');
  await shot(page, 'lookup-shift-g');
  await click(page, '#s2LookupClear');
  await click(page, '#settingsLookup');
  await waitFor(() => shown(page, '.s2-lookup-rec'), 'the lookup to listen again');
  await key(page, 'KeyT', ['ctrl'], 't');
  await waitFor(() => page.run(`!document.querySelector('.s2-lookup-rec')`), 'the lookup to finish');
  assert.deepEqual(await visibleRows(page, '.s2-pane[data-pane="shortcuts"]'), ['Always on top'], 'Ctrl+T is Always on top');
  const pin = await page.run('window.RefBoardAPI.pinGetState()');
  assert.equal(pin?.mode || 'off', 'off', 'and looking it up did not pin the window');
  await click(page, '#s2LookupClear');
  await click(page, '#settingsLookup');
  await waitFor(() => shown(page, '.s2-lookup-rec'), 'the lookup to listen a third time');
  await key(page, 'KeyB', ['ctrl', 'alt'], 'b');
  await waitFor(() => shown(page, '#s2LookupNone'), 'the free combination');
  await shot(page, 'lookup-free');
  // A backdrop click closes Settings and ends a lookup still listening.
  await click(page, '#s2LookupClear');
  await click(page, '#settingsLookup');
  await page.run(`document.getElementById('settingsModal').dispatchEvent(new MouseEvent('click',{bubbles:true}))`);
  assert.equal(await page.run(`document.getElementById('settingsModal').classList.contains('show')`), false, 'the backdrop closes Settings');
  await key(page, 'KeyM');
  assert.equal(await page.run('window.RefBoard.appSettings.minimap'), true, 'keys reach the board again (M toggled the minimap)');
  await key(page, 'KeyM');

  step = 'the ? panel';
  await key(page, 'Slash', ['shift'], '?');
  await waitFor(() => page.run(`document.getElementById('helpModal').classList.contains('show')`), 'the ? panel');
  report.helpRows = await page.run(`document.querySelectorAll('#helpShortcuts .ks').length`);
  assert.equal(report.helpRows, listed + 1, 'the ? panel lists the same shortcuts, plus Snip');
  await shot(page, 'help-panel');
  await key(page, 'Escape');

  step = 'Restore defaults asks first';
  await click(page, '#board', 'right');
  await waitFor(() => page.run(`[...document.querySelectorAll('#ctxmenu .mi')].some(e=>e.textContent.trim()==='Settings')`), 'the board menu');
  await page.run(`[...document.querySelectorAll('#ctxmenu .mi')].find(e=>e.textContent.trim()==='Settings').id='smokeSettingsItem'`);
  await click(page, '#smokeSettingsItem');
  await waitFor(() => page.run(`document.getElementById('settingsModal').classList.contains('show')`), 'Settings to open again');
  await click(page, '.s2-tab[data-pane="general"]');
  await click(page, '#setThumbs');
  assert.equal(await setting(page, 'generateThumbnails'), false);
  await click(page, '#settingsRestore');
  await waitFor(() => page.run(`document.getElementById('confirmModal').classList.contains('show')`), 'the confirm');
  assert.equal(await page.run(`document.getElementById('confirmTitle').textContent`), 'Restore default settings?');
  await shot(page, 'restore-confirm');
  await click(page, '#confirmCancel');
  assert.equal(await setting(page, 'generateThumbnails'), false, 'Cancel keeps the settings');
  await click(page, '#settingsRestore');
  await waitFor(() => page.run(`document.getElementById('confirmModal').classList.contains('show')`), 'the confirm again');
  await click(page, '#confirmOk');
  await waitFor(async () => (await setting(page, 'generateThumbnails')) === true, 'defaults to come back');
  assert.equal(await page.run(`document.getElementById('setThumbs').classList.contains('on')`), true, 'the page shows them');
  assert.equal(await page.run(`document.getElementById('settingsModal').classList.contains('show')`), true, 'Settings stays open');

  console.log('settings smoke ok', JSON.stringify(report));
} catch (error) {
  console.error(`settings smoke failed at: ${step}`);
  if (page) await shot(page, 'failure').catch(() => {});
  throw error;
} finally {
  page?.close();
  if (child.exitCode === null) child.kill();
  await Promise.race([once(child, 'exit'), delay(4000)]).catch(() => {});
  await removeProfileDir(profile).catch(() => rm(profile, { recursive: true, force: true }).catch(() => {}));
}
