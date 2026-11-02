/**
 * "New" badges in the real app, driven with real clicks.
 *
 * Launch 1 starts from a store that last saw What's New for 2.1.6 and checks
 * that the first launch of this version writes the badges the rules in
 * new-badges.js pick from the real changelog, and leaves What's New alone.
 *
 * Launch 2 starts from 2.2.0's three badges, so the walk does not shift when a
 * later release adds its own, and checks each place a badge shows:
 *   (a) one image selected: Remove object is marked, its callout sits under it
 *       with the note's line, and Labels has a dot for what waits in its panel;
 *       the right-click menu marks Remove object too. Got it retires it in both;
 *   (b) two selected: the Line up rows buttons are marked and the callout moves
 *       to them; Arrange in the menu has a dot, and using Line up rows: left
 *       from its submenu retires the badge;
 *   (c) the Labels panel: Display has a dot, and opening it shows the chip and
 *       the callout inside the Label alignment row;
 *   (d) Settings, with that badge put on the Home layout row (no released note
 *       points at a Settings row yet): the menu's Settings item and the
 *       Appearance tab have dots, the row has the chip and callout, and Got it
 *       there clears every mark in the app and empties the store.
 *
 * Set REFBOARD_SMOKE_SHOT_DIR to save crops of the selection bar, the menu, the
 * Labels panel and Settings with their badges.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeProfileDir } from './smoke-profile-cleanup.mjs';
import newBadgeRules from './new-badges.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = process.env.REFBOARD_SMOKE_EXECUTABLE || path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const shotDir = process.env.REFBOARD_SMOKE_SHOT_DIR || '';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
const changelog = JSON.parse(await readFile(path.join(root, 'changelog.json'), 'utf8'));
const badgesOf220 = newBadgeRules.badgesBetween(changelog, '2.1.6', '2.2.0');
const badge = id => badgesOf220.find(b => b.id === id);
assert.deepEqual(badgesOf220.map(b => b.id), ['remove-object', 'line-up-rows', 'label-align'], '2.2.0 points three notes at controls');

async function launch(name, store) {
  const profile = await mkdtemp(path.join(os.tmpdir(), `refboard-new-badges-${name}-`));
  await writeFile(path.join(profile, 'whats-new.json'), JSON.stringify(store));
  const child = spawn(electron, [...(process.env.REFBOARD_SMOKE_EXECUTABLE ? [] : ['.']), '--remote-debugging-port=0', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-features=CalculateNativeWinOcclusion', `--user-data-dir=${profile}`], {
    cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  const app = { profile, child, stderr: () => stderr };
  app.store = async () => JSON.parse(await readFile(path.join(profile, 'whats-new.json'), 'utf8'));
  app.close = async () => {
    app.cdp?.close();
    if (child.exitCode === null) child.kill();
    await Promise.race([once(child, 'exit'), delay(3000)]).catch(() => {});
    await removeProfileDir(profile);
  };
  try {
    let port = null;
    for (let attempt = 0; attempt < 100 && !port; attempt++) {
      if (child.exitCode !== null) throw new Error(`Electron exited before smoke setup (${child.exitCode})\n${stderr}`);
      try {
        const [line] = (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/);
        if (/^\d+$/.test(line)) port = Number(line);
      } catch { /* wait for Chromium */ }
      if (!port) await delay(100);
    }
    if (!port) throw new Error(`Electron debugging port did not become ready\n${stderr}`);
    app.cdp = await attach(port);
    await app.cdp.send('Page.enable');
    await app.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    await app.cdp.run(`(async()=>{const wait=ms=>new Promise(r=>setTimeout(r,ms));
      for(let i=0;i<300&&!(window.RefBoard&&window.RefBoard.startupComplete);i++)await wait(50);
      if(!window.RefBoard?.startupComplete)throw new Error('startup did not complete');
      window.__nbErrors=[];window.addEventListener('error',e=>window.__nbErrors.push(e.message));
      return true;})()`);
  } catch (err) {
    await app.close();
    throw err;
  }
  return app;
}

async function attach(port) {
  let target = null;
  for (let attempt = 0; attempt < 100 && !target; attempt++) {
    try {
      const list = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json());
      target = list.find(t => t.type === 'page' && /index\.html/i.test(t.url || '') && !/pane=secondary/i.test(t.url || ''));
    } catch { /* retry */ }
    if (!target) await delay(100);
  }
  if (!target) throw new Error('no RefBoard page target');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let nextId = 0;
  const pending = new Map();
  socket.onmessage = event => {
    const msg = JSON.parse(event.data);
    if (!msg.id || !pending.has(msg.id)) return;
    const h = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) h.reject(new Error(msg.error.message)); else h.resolve(msg.result);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const run = async expression => {
    const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
    return res.result.value;
  };
  return { send, run, close: () => socket.close() };
}

async function waitFor(check, what, tries = 60) {
  for (let i = 0; i < tries; i++) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/* Launch 1: the first launch of this version settles the badges. */
const fromOld = { lastSeenVersion: '2.1.6' };
const first = await launch('first', fromOld);
try {
  const expected = newBadgeRules.storeAfterLaunch(fromOld, changelog, version);
  await waitFor(async () => (await first.store()).lastRunVersion === version, 'the launch to record its version');
  const store = await first.store();
  assert.deepEqual(store, expected, 'the first launch writes the badges the rules pick from the real changelog');
  for (const id of ['remove-object', 'line-up-rows', 'label-align']) {
    assert(store.badges.some(b => b.id === id), `coming from 2.1.6 brings the ${id} badge`);
  }
  assert.equal(store.lastSeenVersion, '2.1.6', 'badges leave What\'s New\'s own record alone');
  assert.deepEqual(await first.cdp.run('window.RefBoardAPI.getNewBadges()'), store.badges, 'the app is handed what the store holds');
} catch (err) {
  if (first.stderr().trim()) console.error(`--- electron stderr ---\n${first.stderr().trim()}`);
  throw err;
} finally {
  await first.close();
}

/* Launch 2: a walk through every place a badge shows. */
const seeded = { lastSeenVersion: version, lastRunVersion: version, badges: badgesOf220 };
const app = await launch('walk', seeded);
const cdp = app.cdp;
const mouse = (type, x, y) => cdp.send('Input.dispatchMouseEvent', {
  type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1,
});
// A real click at the centre of what the expression returns.
async function clickOn(expression, what) {
  const at = await cdp.run(`(()=>{const el=(${expression});
    if(!el||!el.checkVisibility())return null;
    el.scrollIntoView({block:'nearest'});
    const r=el.getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2];})()`);
  assert(at, `${what} should be on screen to click`);
  await mouse('mouseMoved', at[0], at[1]);
  await mouse('mousePressed', at[0], at[1]);
  await mouse('mouseReleased', at[0], at[1]);
  await delay(250);
}
const select = ids => cdp.run(`(()=>{const RB=window.RefBoard;RB.state.sel=new Set(${JSON.stringify(ids)});RB.updateSelBarForTest();RB.invalidate();return true;})()`);
// Right-click on empty board: with a selection, the menu shows its entries.
const openMenu = () => cdp.run(`(async()=>{
  document.getElementById('board').dispatchEvent(new MouseEvent('contextmenu',{clientX:innerWidth-160,clientY:innerHeight-140,bubbles:true,cancelable:true}));
  await new Promise(r=>setTimeout(r,200));
  return document.querySelector('#ctxmenu').classList.contains('show');})()`);
const menuItem = label => `[...document.querySelectorAll('#ctxmenu .mi, #ctxSub .mi')].find(el=>el.firstElementChild?.textContent===${JSON.stringify(label)})`;
const menuMark = label => cdp.run(`(()=>{const el=${menuItem(label)};if(!el)return null;
  return {isNew:el.classList.contains('nb-new'),trail:el.classList.contains('nb-trail'),
    after:getComputedStyle(el.firstElementChild,'::after').content};})()`);
const marks = () => cdp.run(`(()=>{const has=(s,c)=>!!document.querySelector(s)?.classList.contains(c);
  const dot=s=>!!document.querySelector(s+' > .nb-dot');
  return {
    fill:has('#sFill','nb-new'), fillDot:dot('#sFill'),
    lineUp:['#sAlignLeft','#sAlignCenter','#sAlignRight'].map(s=>has(s,'nb-new')),
    sTags:has('#sTags','nb-trail')&&dot('#sTags'), btnTags:has('#btnTags','nb-trail')&&dot('#btnTags'),
    display:has('#tagDisplay > summary','nb-trail')&&dot('#tagDisplay > summary'),
    labelRow:has('[data-badge="label-align"].tag-panel-labels','nb-new'),
    callouts:[...document.querySelectorAll('.nb-callout')].filter(c=>c.checkVisibility()).map(c=>({id:c.dataset.badgeId,host:c.parentElement.id||c.parentElement.className,
      shown:true,title:c.querySelector('b')?.textContent,text:c.querySelector('p')?.textContent||''})),
  };})()`);
// Whether an element sits wholly inside a scrolling panel's visible box.
const inView = (scroller, selector) => cdp.run(`(()=>{const s=document.querySelector(${JSON.stringify(scroller)}).getBoundingClientRect();
  const r=document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect();
  return !!r&&r.top>=s.top&&r.bottom<=s.bottom;})()`);
const storedIds = async () => (await app.store()).badges.map(b => b.id);
async function shoot(name, selectors) {
  if (!shotDir) return;
  await delay(350); // past the callout's fade-in
  const box = await cdp.run(`(()=>{const rs=${JSON.stringify(selectors)}.map(s=>document.querySelector(s))
    .filter(el=>el&&el.checkVisibility()).map(el=>el.getBoundingClientRect());
    const x=Math.max(0,Math.min(...rs.map(r=>r.left))-16),y=Math.max(0,Math.min(...rs.map(r=>r.top))-16);
    return {x,y,width:Math.max(...rs.map(r=>r.right))+16-x,height:Math.max(...rs.map(r=>r.bottom))+16-y};})()`);
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { ...box, scale: 2 } });
  await writeFile(path.join(shotDir, name), Buffer.from(shot.data, 'base64'));
}

try {
  assert.deepEqual(await cdp.run('window.RefBoardAPI.getNewBadges()'), badgesOf220, 'a second launch of the same version keeps the waiting badges');

  const ids = await cdp.run(`(async()=>{
    const wait=ms=>new Promise(r=>setTimeout(r,ms));
    document.querySelectorAll('.modal.show').forEach(el=>el.classList.remove('show'));
    document.querySelector('#rwNewBoard').click();
    for(let i=0;i<100&&!document.body.classList.contains('board-active');i++)await wait(50);
    if(!document.body.classList.contains('board-active'))throw new Error('New board did not open');
    await wait(300);
    const RB=window.RefBoard;
    const files=await Promise.all([['#c8543c',0],['#3c7ac8',1]].map(async([color,i])=>{
      const c=document.createElement('canvas');c.width=200;c.height=150;
      const g=c.getContext('2d');g.fillStyle=color;g.fillRect(0,0,200,150);
      return new File([await new Promise(r=>c.toBlob(r,'image/png'))],'img'+i+'.png',{type:'image/png'});
    }));
    const added=await RB.addImages(files);
    await wait(400);
    added.forEach((it,i)=>{ it.x=i*260; it.y=0; it.w=200; it.h=150; it.rot=0; });
    RB.state.view.s=0.6; RB.state.view.tx=120; RB.state.view.ty=220;
    RB.invalidateLayout(); RB.invalidate();
    await wait(200);
    return added.map(it=>it.id);
  })()`);
  assert.equal(ids.length, 2, 'two images to select');

  /* (a) One image: Remove object. */
  await select([ids[0]]);
  await waitFor(async () => (await marks()).fill, 'Remove object to be marked');
  let m = await marks();
  assert.equal(m.fillDot, true, 'the new button has a dot');
  assert.deepEqual(m.callouts, [{ id: 'remove-object', host: 'selbar', shown: true, title: 'Remove object', text: badge('remove-object').description }],
    'one callout, under the bar, with the note\'s line');
  assert.equal(m.sTags, true, 'Labels in the bar has a dot for the badge waiting in its panel');
  assert.equal(m.btnTags, true, 'so does Labels in the toolbar');
  const aim = await cdp.run(`(()=>{const c=document.querySelector('#selbar > .nb-callout'),b=document.querySelector('#sFill');
    const cr=c.getBoundingClientRect(),br=b.getBoundingClientRect(),ar=c.querySelector('.nb-callout-arrow').getBoundingClientRect();
    const bar=document.querySelector('#selbar'),bb=bar.getBoundingClientRect();
    return {arrow:ar.left+ar.width/2,button:br.left+br.width/2,below:cr.top>=br.bottom,inside:cr.left>=0&&cr.right<=innerWidth,
      debug:{barLeft:bb.left,clientLeft:bar.clientLeft,calloutLeft:cr.left,styleLeft:c.style.left,arrowX:c.style.getPropertyValue('--nb-arrow-x'),
        arrowRect:[ar.left,ar.width],btn:[br.left,br.width],cs:getComputedStyle(c.querySelector('.nb-callout-arrow')).left,border:getComputedStyle(c).borderLeftWidth}};})()`);
  assert(Math.abs(aim.arrow - aim.button) <= 1, `the arrow points at Remove object (${aim.arrow} vs ${aim.button}) ${JSON.stringify(aim.debug)}`);
  assert(aim.below && aim.inside, 'the callout hangs under the bar, on screen');
  await shoot('badge-selbar.png', ['#selbar', '#selbar > .nb-callout']);

  assert.equal(await openMenu(), true, 'the right-click menu opens');
  assert.deepEqual(await menuMark('Remove object…'), { isNew: true, trail: false, after: '"New"' }, 'the menu marks Remove object as new');
  assert.deepEqual(await menuMark('Settings'), { isNew: false, trail: false, after: 'none' }, 'Settings has nothing new');
  await shoot('badge-menu.png', ['#ctxmenu']);
  await clickOn(`document.querySelector('#selcount')`, 'the bar\'s count');

  await clickOn(`document.querySelector('#selbar .nb-got-it')`, 'Got it');
  m = await marks();
  assert.equal(m.fill || m.fillDot, false, 'Got it clears the button');
  assert.deepEqual(m.callouts, [], 'and its callout');
  await waitFor(async () => !(await storedIds()).includes('remove-object'), 'Got it to reach the store');
  assert.deepEqual(await storedIds(), ['line-up-rows', 'label-align'], 'only that badge is retired');
  assert.equal(await openMenu(), true);
  assert.deepEqual(await menuMark('Remove object…'), { isNew: false, trail: false, after: 'none' }, 'the menu no longer marks it');
  await clickOn(`document.querySelector('#selcount')`, 'the bar\'s count');

  /* (b) Two images: Line up rows. */
  await select(ids);
  await waitFor(async () => (await marks()).lineUp.every(Boolean), 'the Line up rows buttons to be marked');
  m = await marks();
  assert.deepEqual(m.callouts.map(c => [c.id, c.host, c.shown, c.title]), [['line-up-rows', 'selbar', true, badge('line-up-rows').title]],
    'the callout moves to the first Line up rows button');
  assert.equal(await cdp.run(`document.querySelector('#sAlignLeft').classList.contains('nb-anchor')`), true);
  await shoot('badge-selbar-lineup.png', ['#selbar', '#selbar > .nb-callout']);
  assert.equal(await openMenu(), true);
  assert.deepEqual(await menuMark('Arrange'), { isNew: false, trail: true, after: '""' }, 'Arrange has a dot for what is inside it');
  await clickOn(menuItem('Arrange'), 'Arrange');
  assert.deepEqual(await menuMark('Line up rows: left'), { isNew: true, trail: false, after: '"New"' }, 'the submenu marks Line up rows');
  await shoot('badge-submenu.png', ['#ctxmenu', '#ctxSub']);
  await clickOn(menuItem('Line up rows: left'), 'Line up rows: left');
  await waitFor(async () => !(await storedIds()).includes('line-up-rows'), 'using Line up rows to retire its badge');
  m = await marks();
  assert.deepEqual(m.lineUp, [false, false, false], 'using it from the menu clears the bar\'s buttons too');
  assert.deepEqual(m.callouts, [], 'and the callout');

  /* (c) The Labels panel. */
  await clickOn(`document.querySelector('#sTags')`, 'Labels in the bar');
  assert.equal(await cdp.run(`document.querySelector('#tagPanel').classList.contains('open')`), true, 'the Labels panel opens');
  m = await marks();
  assert.equal(m.display, true, 'Display has a dot while it is closed');
  if (!await cdp.run(`document.querySelector('#tagDisplay').open`)) await clickOn(`document.querySelector('#tagDisplay > summary')`, 'Display');
  m = await marks();
  assert.equal(m.labelRow, true, 'the Label alignment row is marked');
  assert.equal(await cdp.run(`getComputedStyle(document.querySelector('[data-badge="label-align"] > span'),'::after').content`), '"New"');
  assert.deepEqual(m.callouts.map(c => [c.id, c.shown, c.title, c.text]), [['label-align', true, 'Label alignment', badge('label-align').description]],
    'its callout opens inside the row');
  assert.equal(await inView('#tagPanel', '#tagPanel .nb-got-it'), true, 'the panel scrolls so the callout\'s Got it is in view');
  await shoot('badge-labels.png', ['#tagPanel']);
  await clickOn(`document.querySelector('#sTags')`, 'Labels in the bar');

  /* (d) Settings. */
  await cdp.run(`(()=>{document.querySelector('#setLandingLayout').closest('.s2-row').dataset.badge='label-align';
    window.RefBoard.applyNewBadgesForTest();return true;})()`);
  assert.equal(await openMenu(), true);
  assert.deepEqual(await menuMark('Settings'), { isNew: false, trail: true, after: '""' }, 'Settings in the menu has a dot');
  await clickOn(menuItem('Settings'), 'Settings');
  assert.equal(await cdp.run(`document.querySelector('#settingsModal').classList.contains('show')`), true, 'Settings opens');
  assert.deepEqual(await cdp.run(`[...document.querySelectorAll('.s2-tab')].filter(t=>t.querySelector(':scope > .nb-dot')).map(t=>t.dataset.pane)`),
    ['appearance'], 'only the Appearance tab has a dot');
  await clickOn(`document.querySelector('.s2-tab[data-pane="appearance"]')`, 'Appearance');
  assert.equal(await inView('.settings2-content', '.s2-pane[data-pane="appearance"] .nb-got-it'), true,
    'the pane scrolls so the callout under its last row is in view');
  const row = await cdp.run(`(()=>{const r=document.querySelector('#setLandingLayout').closest('.s2-row');const c=r.querySelector('.nb-callout');
    return {isNew:r.classList.contains('nb-new'),label:r.querySelector('.s2-label').textContent,
      after:getComputedStyle(r.querySelector('.s2-label'),'::after').content,callout:!!c&&c.checkVisibility(),
      under:!!c&&c.getBoundingClientRect().top>=r.querySelector('.s2-label').getBoundingClientRect().bottom};})()`);
  assert.deepEqual(row, { isNew: true, label: 'Home layout', after: '"New"', callout: true, under: true },
    'the row gets the chip and its callout below it, and search still reads only the label');
  await shoot('badge-settings.png', ['.settings2-content']);
  await clickOn(`document.querySelector('#setLandingLayout').closest('.s2-row').querySelector('.nb-got-it')`, 'Got it in Settings');
  await waitFor(async () => (await storedIds()).length === 0, 'the last badge to be retired');
  m = await marks();
  assert.deepEqual(await cdp.run(`document.querySelectorAll('.nb-new, .nb-trail, .nb-dot, .nb-callout').length`), 0,
    'Got it in Settings clears that badge everywhere: the row, the tab, the Labels panel and both Labels buttons');
  const final = await app.store();
  assert.equal(final.lastRunVersion, version, 'the version on record does not move');
  assert.equal(final.lastSeenVersion, version, 'nor does What\'s New\'s');
  assert.deepEqual(await cdp.run('window.__nbErrors'), [], 'no page errors');

  console.log(`new badges Electron smoke passed - first launch picked ${firstLaunchBadges().length} badges from 2.1.6 to ${version}; `
    + 'Remove object (bar, menu, Got it), Line up rows (bar, Arrange submenu, used), Label alignment (Labels panel, Settings row, Got it) all cleared');
} catch (err) {
  if (app.stderr().trim()) console.error(`--- electron stderr ---\n${app.stderr().trim()}`);
  throw err;
} finally {
  await app.close();
}

function firstLaunchBadges() {
  return newBadgeRules.storeAfterLaunch(fromOld, changelog, version).badges;
}
