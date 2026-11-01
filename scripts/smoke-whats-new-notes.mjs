/**
 * What's New shows where to find a change and its caveat, driven through the
 * real UI on a fresh profile that last saw 2.1.6: Home offers the notes, the
 * notice opens them, and each 2.2.0 change shows its title, its one-line
 * description, and its where and note lines exactly when changelog.json has
 * them. An item's details never shows in the app; it is for the GitHub release.
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
const profile = await mkdtemp(path.join(os.tmpdir(), 'refboard-whats-new-smoke-'));
const shots = process.env.REFBOARD_SMOKE_SHOTS || '';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Seen through 2.1.6, so 2.2.0's notes are new to this profile whichever
// version is running.
await writeFile(path.join(profile, 'whats-new.json'), JSON.stringify({ lastSeenVersion: '2.1.6' }));
const changelog = JSON.parse(await readFile(path.join(root, 'changelog.json'), 'utf8'));
const expected = ['new', 'improved', 'fixed'].flatMap(section => changelog['2.2.0'].sections[section].map(item => ({ section, ...item })));

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

// A real pointer click, refused when something else sits on top of the target.
async function click(page, selector) {
  const at = await page.run(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)return null;const r=el.getBoundingClientRect();if(!r.width||!r.height)return null;const x=r.x+r.width/2,y=r.y+r.height/2;return el.contains(document.elementFromPoint(x,y))?[x,y]:null;})()`);
  assert.ok(at, `${selector} is on screen and nothing covers it`);
  const [x, y] = at;
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
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

let step = 'launch';
const report = {};
let page = null;
try {
  page = await connect();
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  await page.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
  await waitFor(() => page.run('!!(window.RefBoard && window.RefBoard.startupComplete)').catch(() => false), 'startup', 300);

  step = 'the notice on Home';
  await waitFor(() => page.run(`(()=>{const n=document.getElementById('whatsNewNotice');return !!n&&!n.classList.contains('hide')&&n.getClientRects().length>0;})()`), "the What's New notice on Home");
  await shot(page, 'home-notice');

  step = 'open the notes';
  await click(page, '#whatsNewOpen');
  await waitFor(() => page.run(`document.getElementById('whatsNewModal').classList.contains('show')`), "What's New to open");
  await delay(900); // let the cards' entrance animation settle before reading positions
  await shot(page, 'whats-new');

  step = 'each 2.2.0 change';
  const cards = await page.run(`[...document.querySelectorAll('#whatsNewSections .wn-section')].flatMap(section=>[...section.querySelectorAll('.wn-item')].map(card=>{
    const text=sel=>card.querySelector(sel)?.textContent??null;
    const shown=sel=>{const el=card.querySelector(sel);if(!el)return false;const r=el.getBoundingClientRect(),c=card.getBoundingClientRect();return r.width>0&&r.height>0&&r.left>=c.left-0.5&&r.right<=c.right+0.5&&r.bottom<=c.bottom+0.5&&getComputedStyle(el).visibility!=='hidden';};
    return {section:section.dataset.section,title:text('.wn-item-title'),version:text('.wn-item-version'),description:text('.wn-item-description'),where:text('.wn-item-where'),note:text('.wn-item-note'),whereShown:shown('.wn-item-where'),noteShown:shown('.wn-item-note'),text:card.textContent};
  }))`);
  report.cards = cards.length;
  let withWhere = 0;
  let withNote = 0;
  for (const item of expected) {
    const card = cards.find(c => c.section === item.section && c.title === item.title && (c.version === null || c.version === 'v2.2.0'));
    assert.ok(card, `"${item.title}" is listed under ${item.section}`);
    assert.equal(card.description, item.description, `"${item.title}" shows its one-line description`);
    assert.equal(card.where, item.where ?? null, `"${item.title}" shows where to find it exactly when the notes say`);
    assert.equal(card.note, item.note ?? null, `"${item.title}" shows its caveat exactly when the notes have one`);
    if (item.where) { assert.equal(card.whereShown, true, `"${item.title}": the where line is drawn inside its card`); withWhere++; }
    if (item.note) { assert.equal(card.noteShown, true, `"${item.title}": the note line is drawn inside its card`); withNote++; }
    if (item.details) assert.ok(!card.text.includes(item.details), `"${item.title}": details stays out of the app`);
  }
  // Without these the loop above would pass while checking no where or note line.
  assert.ok(withWhere > 0 && withNote > 0, '2.2.0 has at least one where and one note to check');
  Object.assign(report, { withWhere, withNote });

  console.log('whats new smoke ok', JSON.stringify(report));
} catch (error) {
  console.error(`whats new smoke failed at: ${step}`);
  if (page) await shot(page, 'failure').catch(() => {});
  throw error;
} finally {
  page?.close();
  if (child.exitCode === null) child.kill();
  await Promise.race([once(child, 'exit'), delay(4000)]).catch(() => {});
  await removeProfileDir(profile).catch(() => rm(profile, { recursive: true, force: true }).catch(() => {}));
}
