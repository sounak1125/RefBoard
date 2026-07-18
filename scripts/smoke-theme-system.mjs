import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const profile = await mkdtemp(path.join(os.tmpdir(), 'refboard-theme-smoke-'));
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
    if (child.exitCode !== null) throw new Error(`Electron exited before theme smoke setup (${child.exitCode})\n${stderr}`);
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
  const target = targets.find(entry => entry.type === 'page' && /RefBoard|index\.html/i.test(`${entry.title} ${entry.url}`)) || targets.find(entry => entry.type === 'page');
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
  const response = await send('Runtime.evaluate', { expression, awaitPromise:true, returnByValue:true });
  socket.close();
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  return response.result.value;
}

const smokeExpression = String.raw`(async()=>{
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  for(let attempt=0;attempt<100&&!window.RefBoard;attempt++)await wait(50);
  if(!window.RefBoard)throw new Error('RefBoard API unavailable');
  const normalize=color=>{const probe=document.createElement('i');probe.style.color=color;document.body.append(probe);const value=getComputedStyle(probe).color;probe.remove();return value;};
  const ids=['midnight','slate','graphite','pine','plum','dim'];
  const results=[];
  for(const id of ids){
    const button=document.querySelector('.theme-swatch[data-theme="'+id+'"]');
    button.click();await wait(25);
    const root=getComputedStyle(document.documentElement);
    window.RefBoard.animatics.open();await wait(25);
    const workspace=document.querySelector('#animaticsWorkspace'),workspaceStyle=getComputedStyle(workspace),topStyle=getComputedStyle(document.querySelector('.an-top'));
    const timelineResizer=document.querySelector('.an-timeline-resizer'),sideResizer=document.querySelector('.an-side-resizer');
    results.push({
      id,
      stored:localStorage.getItem('refboard.theme'),
      rootTheme:document.documentElement.getAttribute('data-theme')||'midnight',
      active:[...document.querySelectorAll('.theme-swatch.active')].map(item=>item.dataset.theme),
      pressed:[...document.querySelectorAll('.theme-swatch[aria-pressed="true"]')].map(item=>item.dataset.theme),
      rootBg:normalize(root.getPropertyValue('--bg')),
      rootAccent:normalize(root.getPropertyValue('--acc')),
      animaticsBg:workspaceStyle.backgroundColor,
      animaticsAccent:normalize(workspaceStyle.getPropertyValue('--an-accent')),
      topSurface:topStyle.backgroundColor,
      rootSurface:normalize(root.getPropertyValue('--surface-1')),
      stageBackground:getComputedStyle(document.querySelector('.an-stage-row')).backgroundColor,
      timelineHitArea:getComputedStyle(timelineResizer).backgroundColor,
      timelineGripWidth:getComputedStyle(timelineResizer,'::after').width,
      timelineGripColor:getComputedStyle(timelineResizer,'::after').backgroundColor,
      sideGripWidth:getComputedStyle(sideResizer,'::after').width,
      playBackground:getComputedStyle(document.querySelector('.an-play')).backgroundColor,
      snapBackground:getComputedStyle(document.querySelector('.an-snap-btn')).backgroundColor,
      passiveIconBackground:getComputedStyle(document.querySelector('#anAddImages')).backgroundColor,
    });
    window.RefBoard.animatics.close();
  }
  document.querySelector('.theme-swatch[data-theme="midnight"]').click();
  return results;
})()`;

try {
  const results = await evaluate(await debuggerPort(), smokeExpression);
  assert.equal(results.length, 6, 'all six themes should be exercised');
  assert.equal(new Set(results.map(result => result.rootBg)).size, 6, 'each theme should render a unique background');
  assert.equal(new Set(results.map(result => result.rootAccent)).size, 6, 'each theme should render a unique accent');
  for (const result of results) {
    assert.equal(result.stored, result.id, `${result.id} should persist`);
    assert.equal(result.rootTheme, result.id, `${result.id} should apply on the root`);
    assert.deepEqual(result.active, [result.id], `${result.id} should be the only active theme card`);
    assert.deepEqual(result.pressed, [result.id], `${result.id} should expose the correct accessible state`);
    assert.equal(result.animaticsBg, result.rootBg, `${result.id} should reach the Animatics workspace`);
    assert.equal(result.animaticsAccent, result.rootAccent, `${result.id} accent should reach Animatics controls`);
    assert.equal(result.topSurface, result.rootSurface, `${result.id} surface should reach the Animatics toolbar`);
    assert.equal(result.stageBackground, 'rgb(13, 15, 19)', `${result.id} should keep the viewer workspace neutral`);
    assert.equal(result.timelineHitArea, 'rgba(0, 0, 0, 0)', `${result.id} should not paint the timeline resize hit area`);
    assert.equal(result.timelineGripWidth, '52px', `${result.id} should retain the compact timeline grip`);
    assert.equal(result.timelineGripColor, 'rgb(64, 70, 83)', `${result.id} should retain the neutral timeline grip color`);
    assert.equal(result.sideGripWidth, '2px', `${result.id} should retain the thin inspector grip`);
    assert.equal(result.playBackground, 'rgb(240, 242, 247)', `${result.id} should retain the neutral playback control`);
    assert.notEqual(result.snapBackground, result.passiveIconBackground, `${result.id} should keep Snap visually distinct from passive tools`);
  }
  console.log('theme Electron persistence and cross-workspace smoke passed');
} finally {
  if (child.exitCode === null) child.kill();
  await Promise.race([once(child, 'exit'), delay(3000)]).catch(() => {});
  await rm(profile, { recursive:true, force:true });
}
