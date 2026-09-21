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
const electron = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const profile = await mkdtemp(path.join(os.tmpdir(), 'refboard-split-'));
const child = spawn(electron, ['.', '--remote-debugging-port=0', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-features=CalculateNativeWinOcclusion', `--user-data-dir=${profile}`], {
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
  const toggle=document.querySelector('#splitToggle');
  const minimap=document.querySelector('#minimapToggle');
  if(!toggle)throw new Error('split toggle missing');
  if(!minimap)throw new Error('minimap toggle missing');
  const shown=getComputedStyle(toggle).display!=='none';
  if(!shown)throw new Error('split toggle must be visible on the primary pane');
  if(typeof window.RefBoardAPI?.splitEnter!=='function')throw new Error('splitEnter bridge missing');
  const opened=await window.RefBoardAPI.splitEnter(0.5);
  if(!opened?.opened)throw new Error('split-enter failed: '+JSON.stringify(opened));
  return {
    pane: window.RefBoard.boardPane,
    toggleVisible: shown,
    ratio: opened.ratio,
  };
})()`;

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
    const r=await window.RefBoardAPI.splitExit();
    const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
    for(let attempt=0;attempt<80;attempt++){
      if(document.querySelector('#splitToggle')?.getAttribute('aria-pressed')==='false')break;
      await wait(50);
    }
    return {
      pending: !!(r?.pending || r?.closed),
      reason: r?.reason || null,
      pressed: document.querySelector('#splitToggle')?.getAttribute('aria-pressed'),
    };
  })()`, { urlPattern: /index\.html\?(?!.*pane=secondary)/i });
  assert.ok(afterExit.pending, 'split-exit should close or wait for the right pane handshake');
} catch (err) {
  failed = true;
  console.error(err);
} finally {
  if (!child.killed) child.kill();
  await Promise.race([once(child, 'exit'), delay(3000)]).catch(() => {});
  await removeProfileDir(profile);
}
if (failed) process.exit(1);
console.log('split-view smoke ok');
