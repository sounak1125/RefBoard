/**
 * What's New, driven through the real UI on a fresh profile that last saw
 * 2.1.6:
 * - Home's card names the update's headline and its first changes, and counts
 *   the rest.
 * - The window leads with the first new feature, gives the next few tiles and
 *   folds everything else into one row that opens in place. Every change in
 *   the update is in the window exactly once with its one-line description,
 *   and with its where and note lines exactly when the notes have them. An
 *   item's details never shows: it is for the GitHub release.
 * - With the rest folded, the window fits without scrolling.
 * - Got it closes the window and records the version as seen.
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
const KEYS = ['new', 'improved', 'fixed'];

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

// Every change the window shows, read back from the page: its title (without
// any version tag), description, where and note lines, and where it sits.
const READ_WINDOW = `[...document.querySelectorAll('#whatsNewSections .wn-lead, #whatsNewSections .wn-tile, #whatsNewSections .wn-row')].map(el=>{
  const kind=el.classList.contains('wn-lead')?'lead':el.classList.contains('wn-tile')?'tile':'row';
  const titleEl=el.querySelector('.wn-lead-title, .wn-tile-title, .wn-row-title');
  const title=titleEl?.firstChild?.textContent??null;
  let description=el.querySelector('.wn-lead-text, .wn-tile-text')?.textContent??null;
  if(kind==='row'){const text=el.querySelector('.wn-row-text').textContent;const at=text.indexOf(' — ');description=at===-1?null:text.slice(at+3);}
  const line=sel=>el.querySelector(sel)?.textContent??null;
  const shown=sel=>{const n=el.querySelector(sel);return !!n&&n.getClientRects().length>0;};
  return {kind,title,description,where:line('.wn-item-where'),note:line('.wn-item-note'),whereShown:shown('.wn-item-where'),noteShown:shown('.wn-item-note'),text:el.textContent};
})`;

let step = 'launch';
const report = {};
let page = null;
try {
  page = await connect();
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  await page.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
  await waitFor(() => page.run('!!(window.RefBoard && window.RefBoard.startupComplete)').catch(() => false), 'startup', 300);
  const payload = await page.run('window.RefBoardAPI.checkWhatsNew()');
  assert.equal(payload?.show, true, 'this profile has an update to show');
  const items = KEYS.flatMap(key => payload.sections[key].map(item => ({ key, ...item })));
  const named = [...payload.sections.new, ...payload.sections.improved];

  step = 'the card on Home';
  await waitFor(() => page.run(`(()=>{const n=document.getElementById('whatsNewNotice');return !!n&&!n.classList.contains('hide')&&n.getClientRects().length>0;})()`), "the What's New card on Home");
  const card = await page.run(`(()=>{const q=s=>document.querySelector(s);return {kicker:q('#whatsNewNoticeKicker').textContent,title:q('#whatsNewNoticeTitle').textContent,lines:[...document.querySelectorAll('#whatsNewNoticeList .wn-notice-line')].map(l=>l.lastChild.textContent),more:q('#whatsNewNoticeMore').textContent,cta:q('#whatsNewNoticeCta').getClientRects().length>0,fixes:q('#whatsNewNotice').classList.contains('wn-notice-fixes')};})()`);
  assert.equal(card.kicker, `What's new · ${payload.version}`);
  assert.equal(card.title, payload.headline, 'the card leads with the headline');
  assert.deepEqual(card.lines, named.slice(0, 3).map(item => item.title), 'and names the first changes');
  assert.equal(card.lines.length + Number(/\+ (\d+)/.exec(card.more)?.[1] || 0), items.length, 'and counts the rest');
  assert.equal(card.cta, true, 'with a way in');
  assert.equal(card.fixes, false, 'a feature release is not shown as fixes');
  report.card = card;
  await shot(page, 'home-card');

  step = 'open the window';
  await click(page, '#whatsNewOpen');
  await waitFor(() => page.run(`document.getElementById('whatsNewModal').classList.contains('show')`), "What's New to open");
  await delay(900); // let the entrance animation settle before reading positions
  assert.equal(await page.run(`document.getElementById('whatsNewKicker').textContent`), `What's new in ${payload.version}`);
  assert.equal(await page.run(`document.getElementById('whatsNewHeadline').textContent`), payload.headline);
  await shot(page, 'window');

  step = 'every change, once';
  const shown = await page.run(READ_WINDOW);
  assert.deepEqual(shown.map(entry => entry.title).sort(), items.map(item => item.title).sort(), 'every change is in the window exactly once');
  assert.equal(shown.find(entry => entry.kind === 'lead')?.title, (payload.sections.new[0] || payload.sections.improved[0]).title, 'the first new feature leads');
  let withWhere = 0;
  let withNote = 0;
  for (const item of items) {
    const entry = shown.find(e => e.title === item.title);
    assert.equal(entry.description, item.description, `"${item.title}" shows its one-line description`);
    assert.equal(entry.where, item.where ?? null, `"${item.title}" shows where to find it exactly when the notes say`);
    assert.equal(entry.note, item.note ?? null, `"${item.title}" shows its caveat exactly when the notes have one`);
    const details = changelog[item.version]?.sections[item.key].find(source => source.title === item.title)?.details;
    if (details) assert.ok(!entry.text.includes(details), `"${item.title}": details stays out of the app`);
    if (entry.kind !== 'row') {
      if (item.where) { assert.equal(entry.whereShown, true, `"${item.title}": the where line is drawn`); withWhere++; }
      if (item.note) { assert.equal(entry.noteShown, true, `"${item.title}": the note line is drawn`); withNote++; }
    }
  }
  // Without these the loop would pass while checking no where or note line.
  assert.ok(withWhere > 0 && withNote > 0, '2.2.0 has at least one where and one note on show');
  Object.assign(report, { lead: 1, tiles: shown.filter(e => e.kind === 'tile').length, folded: shown.filter(e => e.kind === 'row').length, withWhere, withNote });

  step = 'the rest is folded';
  const folded = await page.run(`(()=>{const t=document.querySelector('.wn-more-toggle');const l=document.getElementById('whatsNewMoreList');return {expanded:t?.getAttribute('aria-expanded'),count:t?.querySelector('.wn-more-count')?.textContent,label:t?.querySelector('.wn-more-label')?.textContent,hidden:!!l&&l.hidden&&l.getClientRects().length===0,rows:l?.children.length};})()`);
  assert.equal(folded.expanded, 'false');
  assert.equal(folded.hidden, true, 'the folded changes start hidden');
  assert.equal(Number(folded.count), folded.rows, 'the row counts what it holds');
  report.folded = folded;

  step = 'fits without scrolling';
  const fit = await page.run(`(()=>{const s=document.getElementById('whatsNewScroll');return {scroll:s.scrollHeight,box:s.clientHeight,inner:innerHeight};})()`);
  report.fit = fit;
  // Smaller screens get less room; the window may scroll there and that is fine.
  if (fit.inner >= 760) assert.ok(fit.scroll <= fit.box + 1, `with the rest folded the window fits (${fit.scroll} content in ${fit.box})`);

  step = 'open the folded row';
  // On a short screen the row sits below the fold; scroll to it as a person would.
  await page.run(`(()=>{const s=document.getElementById('whatsNewScroll'),t=document.querySelector('.wn-more-toggle');
    const sr=s.getBoundingClientRect(),tr=t.getBoundingClientRect();if(tr.bottom>sr.bottom)s.scrollTop+=tr.bottom-sr.bottom+8;return true;})()`);
  await click(page, '.wn-more-toggle');
  assert.equal(await page.run(`document.querySelector('.wn-more-toggle').getAttribute('aria-expanded')`), 'true');
  assert.equal(await page.run(`[...document.querySelectorAll('#whatsNewMoreList .wn-row')].every(r=>r.getClientRects().length>0)`), true, 'its changes show in place');
  await shot(page, 'window-open');

  step = 'Got it';
  await click(page, '#whatsNewGotIt');
  await waitFor(() => page.run(`!document.getElementById('whatsNewModal').classList.contains('show')`), 'the window to close');
  await waitFor(async () => JSON.parse(await readFile(path.join(profile, 'whats-new.json'), 'utf8')).lastSeenVersion === payload.version, 'the version to be recorded as seen');
  assert.equal(await page.run(`document.getElementById('whatsNewNotice').classList.contains('hide')`), true, 'and the card goes away');

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
