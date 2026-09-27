import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import vm from 'node:vm';

const [mainSource, uiSource] = await Promise.all([
  readFile(new URL('../bootstrapper/main.js', import.meta.url), 'utf8'),
  readFile(new URL('../build/installer-ui/app.js', import.meta.url), 'utf8'),
]);

// Execute the production IPC handler without launching an actual installer.
const handlers = new Map();
const children = [];
let setupExists = true;
let spawnError = null;
const quitTimers = [];
let quitCount = 0;
const electron = {
  app: { whenReady: () => ({ then() {} }), on() {}, quit: () => quitCount++ },
  ipcMain: { handle: (name, handler) => handlers.set(name, handler), on() {} },
};
vm.runInNewContext(mainSource, {
  __dirname: path.resolve('bootstrapper'),
  process: { resourcesPath: path.resolve('bootstrapper/payload'), env: {} },
  setTimeout: callback => quitTimers.push(callback),
  require(name) {
    if (name === 'electron') return electron;
    if (name === 'path') return path;
    if (name === 'fs') return { existsSync: () => setupExists };
    if (name === 'child_process') return { spawn() {
      if (spawnError) throw spawnError;
      const child = new EventEmitter();
      child.unrefCount = 0;
      child.unref = () => child.unrefCount++;
      children.push(child);
      return child;
    } };
    throw new Error(`Unexpected require: ${name}`);
  },
});
const start = handlers.get('installer:start');
const launch = handlers.get('installer:launch');

// The renderer runs with minimal DOM controls and instant animation frames.
function element() {
  const classes = new Set();
  const descendants = new Map();
  return {
    style: {}, disabled: false, textContent: '',
    classList: {
      add: value => classes.add(value), remove: value => classes.delete(value),
      contains: value => classes.has(value),
      toggle(value, force) { if (force) classes.add(value); else classes.delete(value); },
    },
    append() {}, setAttribute() {}, addEventListener() {},
    querySelector(selector) {
      if (!descendants.has(selector)) descendants.set(selector, element());
      return descendants.get(selector);
    },
  };
}
const root = element();
const body = element();
let frameTime = 0;
let launched = 0;
const bridge = { start, launch: () => { launched++; return { launched: true }; } };
const ui = vm.createContext({
  document: {
    body, querySelector: selector => root.querySelector(selector),
    createElement: element, querySelectorAll: () => [], addEventListener() {},
  },
  window: { RefBoardInstaller: bridge },
  performance: { now: () => frameTime },
  requestAnimationFrame: callback => queueMicrotask(() => callback(frameTime += 10000)),
  setTimeout: () => 1, clearTimeout() {},
});
vm.runInContext(uiSource, ui);
const install = () => vm.runInContext('simulateInstall()', ui);
const button = root.querySelector('#installButton');
const label = () => button.querySelector('.button-label').textContent;
const settle = () => new Promise(resolve => setImmediate(resolve));

const first = install();
await settle();
assert.equal(children.length, 1);
await install();
assert.equal((await start()).alreadyRunning, true, 'concurrent IPC calls must not spawn another installer');
assert.equal(children.length, 1, 'concurrent UI and IPC starts share the active attempt');
children[0].emit('exit', 1);
await first;
assert.equal(label(), 'Retry install');
assert.equal(button.disabled, false);
assert.equal(body.classList.contains('is-complete'), false);

const retry = install();
await settle();
assert.equal(children.length, 2, 'retry must spawn a fresh installer');
assert.equal(button.disabled, true, 'retry must wait for its own process to finish');
assert.equal(root.querySelector('#installState').textContent, 'Finishing setup\u2026');
children[1].emit('exit', 0);
await retry;
assert.equal(label(), 'Launch RefBoard');
assert.equal(button.disabled, false);
assert.equal(body.classList.contains('is-complete'), true);
await install();
assert.equal(launched, 1);
assert.equal(children.length, 2, 'launch must not reinstall');

// Early failures must release the main-process lock too.
setupExists = false;
assert.equal((await start()).reason, 'setup-not-found');
setupExists = true;
spawnError = new Error('spawn failed');
assert.equal((await start()).reason, 'spawn-failed');
spawnError = null;
const processFailure = start();
children.at(-1).emit('error', new Error('process failed'));
assert.equal((await processFailure).reason, 'process-error');
const recovered = start();
children.at(-1).emit('exit', 0);
assert.equal((await recovered).ok, true);

// A rejected IPC promise must also offer retry instead of leaving the UI busy.
vm.runInContext('installComplete = false; launching = false', ui);
bridge.start = () => Promise.reject(new Error('IPC disconnected'));
await install();
assert.equal(label(), 'Retry install');
assert.equal(button.disabled, false);
bridge.start = () => Promise.resolve({ ok: true });
await install();
assert.equal(label(), 'Launch RefBoard');

// Launch failures stay in the completed installer and retry launching only.
bridge.launch = () => Promise.reject(new Error('IPC disconnected'));
await install();
assert.equal(label(), 'Retry launch');
assert.equal(button.disabled, false);
assert.equal(body.classList.contains('is-complete'), true);
bridge.launch = () => ({ launched: false, reason: 'app-not-found' });
await install();
assert.equal(label(), 'Retry launch');
assert.match(root.querySelector('#installMeta').textContent, /could not be found/);
assert.equal(button.disabled, false);

// Exercise production launch IPC, including asynchronous errors from spawn.
setupExists = false;
assert.equal((await launch()).reason, 'app-not-found');
setupExists = true;
spawnError = new Error('spawn EPERM');
assert.equal((await launch()).reason, 'spawn-failed');
spawnError = null;
const failedLaunch = launch();
const failedChild = children.at(-1);
assert.doesNotThrow(() => failedChild.emit('error', new Error('spawn EACCES')));
assert.equal((await failedLaunch).reason, 'process-error');
assert.equal(failedChild.unrefCount, 0);
assert.equal(quitTimers.length, 0, 'failed launches must keep the installer open');

bridge.launch = launch;
const launchRetry = install();
const launchedChild = children.at(-1);
const childrenBeforeDuplicate = children.length;
await install();
const duplicateLaunch = launch();
assert.equal(children.length, childrenBeforeDuplicate, 'repeated launch requests must share one process');
assert.equal(button.disabled, true);
assert.equal(label(), 'Launching\u2026');
assert.equal(quitTimers.length, 0, 'wait for the spawn event before quitting');
launchedChild.emit('spawn');
await launchRetry;
assert.equal((await duplicateLaunch).launched, true);
assert.equal(launchedChild.unrefCount, 1);
assert.equal(quitTimers.length, 1, 'one successful launch schedules one quit');
assert.equal((await launch()).launched, true);
assert.equal(children.length, childrenBeforeDuplicate, 'a completed launch must not spawn twice before quit');
quitTimers[0]();
assert.equal(quitCount, 1);

console.log('installer install and launch retry tests passed');
