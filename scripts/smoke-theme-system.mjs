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
const profile = await mkdtemp(path.join(os.tmpdir(), 'refboard-theme-smoke-'));
const child = spawn(electron, ['.', '--remote-debugging-port=0', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-features=CalculateNativeWinOcclusion', `--user-data-dir=${profile}`], {
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

const smokeExpression = String.raw`(async()=>{
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  for(let attempt=0;attempt<100&&!window.RefBoard;attempt++)await wait(50);
  if(!window.RefBoard)throw new Error('RefBoard API unavailable');
  // init() ends by navigating to the landing view; anything done before
  // that point gets torn down again. Wait for startup to finish.
  for(let attempt=0;attempt<300&&!window.RefBoard.startupComplete;attempt++)await wait(50);
  if(!window.RefBoard.startupComplete)throw new Error('RefBoard startup did not complete');
  const normalize=color=>{const probe=document.createElement('i');probe.style.color=color;document.body.append(probe);const value=getComputedStyle(probe).color;probe.remove();return value;};
  const ids=['midnight','slate','black','pine','ocean','dim'];
  const results=[];
  for(const id of ids){
    const button=document.querySelector('.theme-swatch[data-theme="'+id+'"]');
    button.click();await wait(25);
    const root=getComputedStyle(document.documentElement);
    results.push({
      id,
      stored:localStorage.getItem('refboard.theme'),
      rootTheme:document.documentElement.getAttribute('data-theme')||'midnight',
      active:[...document.querySelectorAll('.theme-swatch.active')].map(item=>item.dataset.theme),
      pressed:[...document.querySelectorAll('.theme-swatch[aria-pressed="true"]')].map(item=>item.dataset.theme),
      rootBg:normalize(root.getPropertyValue('--bg')),
      rootAccent:normalize(root.getPropertyValue('--acc')),
    });
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
  }
  console.log('theme Electron persistence and cross-workspace smoke passed');
} finally {
  if (child.exitCode === null) child.kill();
  await Promise.race([once(child, 'exit'), delay(3000)]).catch(() => {});
  await removeProfileDir(profile);
}
