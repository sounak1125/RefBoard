import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const profile = await mkdtemp(path.join(os.tmpdir(), 'refboard-pin-smoke-'));
const child = spawn(electron, ['.', '--remote-debugging-port=0', `--user-data-dir=${profile}`], {
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
    if (child.exitCode !== null) throw new Error(`Electron exited before pin smoke setup (${child.exitCode})\n${stderr}`);
    try {
      const [port] = (await readFile(portFile, 'utf8')).trim().split(/\r?\n/);
      if (/^\d+$/.test(port)) return Number(port);
    } catch { /* Chromium is still starting. */ }
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
    const handlers = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) handlers.reject(new Error(message.error.message));
    else handlers.resolve(message.result);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  await send('Runtime.enable');
  const response = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  socket.close();
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  return response.result.value;
}

const smokeExpression = String.raw`(async()=>{
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  for(let attempt=0;attempt<200&&!(window.closePinMenus&&document.querySelector('#titlebarPin'));attempt++)await wait(50);
  if(!window.closePinMenus)throw new Error('pin titlebar did not initialize');
  if(!window.RefBoardAPI?.pinGetState)throw new Error('RefBoard pin API unavailable');
  const pin=document.querySelector('#titlebarPin');
  const min=document.querySelector('#titlebarMin');
  const menu=document.querySelector('#titlebarPinMenu');
  const always=document.querySelector('#titlebarPinAlways');
  const above=document.querySelector('#titlebarPinAbove');
  const windows=document.querySelector('#titlebarPinWindows');
  if(!pin||!min||!menu||!always||!above||!windows)throw new Error('pin chrome missing');
  const pinColor=getComputedStyle(pin).color,minColor=getComputedStyle(min).color;
  const pinWidth=getComputedStyle(pin).width,minWidth=getComputedStyle(min).width;
  pin.click();await wait(40);
  const menuOpen=menu.classList.contains('show');
  const labels=[...menu.querySelectorAll('.mi')].map(item=>item.textContent.replace(/\s+/g,' ').trim());
  always.click();await wait(80);
  const pinned=await window.RefBoardAPI.pinGetState();
  const pinnedClass=pin.classList.contains('pinned');
  const pressed=pin.getAttribute('aria-pressed');
  pin.click();await wait(40);
  above.click();await wait(120);
  const listOpen=windows.classList.contains('show');
  const listItems=[...windows.querySelectorAll('.mi')].map(item=>item.textContent.trim());
  always.click();await wait(80);
  const unpinned=await window.RefBoardAPI.pinGetState();
  return {
    besideMin:pin.nextElementSibling===min,
    width:pinWidth,
    minWidth,
    color:pinColor,
    minColor,
    menuOpen,
    labels,
    pinnedMode:pinned.mode,
    pinnedAlways:!!pinned.alwaysOnTop,
    pinnedClass,
    pressed,
    listOpen,
    listCount:listItems.length,
    listHasPlaceholder:listItems.some(text=>/no other windows found/i.test(text)),
    unpinnedMode:unpinned.mode,
    unpinnedAlways:!!unpinned.alwaysOnTop,
    unpinnedClass:pin.classList.contains('pinned'),
  };
})()`;

try {
  const result = await evaluate(await debuggerPort(), smokeExpression);
  assert.equal(result.besideMin, true, 'the pin button must sit immediately beside minimize');
  assert.equal(result.width, result.minWidth, 'the pin button must match the minimize control width');
  assert.equal(result.color, result.minColor, 'the idle pin button must match the other window controls');
  assert.equal(result.menuOpen, true, 'clicking the pin must open the pin menu');
  assert.ok(result.labels.some(label => /Always on top$/.test(label) || label.includes('Always on top')), 'the menu must include Always on top');
  assert.ok(result.labels.some(label => /Always on top of/.test(label)), 'the menu must include Always on top of…');
  assert.equal(result.pinnedMode, 'always', 'choosing Always on top must pin globally');
  assert.equal(result.pinnedAlways, true, 'global pin must set Electron always-on-top');
  assert.equal(result.pinnedClass, true, 'the pin button must show the pinned state');
  assert.equal(result.pressed, 'true', 'the pin button must expose pressed=true while pinned');
  assert.equal(result.listOpen, true, 'Always on top of… must open the window list');
  assert.ok(result.listCount >= 1, 'the window list must render at least one row');
  assert.equal(result.unpinnedMode, 'off', 'choosing Always on top again must unpin');
  assert.equal(result.unpinnedAlways, false, 'unpin must clear Electron always-on-top');
  assert.equal(result.unpinnedClass, false, 'the pin button must clear its pinned state');
  console.log('pin window Electron smoke passed');
} finally {
  if (child.exitCode === null) child.kill();
  await Promise.race([once(child, 'exit'), delay(3000)]).catch(() => {});
  await rm(profile, { recursive: true, force: true });
}
