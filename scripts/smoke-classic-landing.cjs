'use strict';

/** Classic landing: responsive library, stable surfaces and real layout-switch input. */
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const root = path.resolve(__dirname, '..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'refboard-classic-'));
const output = path.join(root, 'stress-out-smoke', 'classic-landing');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', profile);
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.on('window-all-closed', () => {});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const longTitle = 'Architecture references — materials, spatial studies and all the details for the autumn collection';
const preview = fs.readFileSync(path.join(root, 'build', 'icon.png')).toString('base64');
let win;
let step = 'startup';
const errors = [];
const results = { layouts: [], states: [], idleFramesIdentical: false };

async function run(expression) {
  let timer;
  try {
    return await Promise.race([
      win.webContents.executeJavaScript(expression),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Renderer timed out: ' + expression.slice(0, 100))), 10000); }),
    ]);
  } finally { clearTimeout(timer); }
}
async function waitFor(expression, label) {
  for (let i = 0; i < 200; i++) {
    if (await run(`Boolean(${expression})`).catch(() => false)) return;
    await delay(30);
  }
  throw new Error('Timed out: ' + label);
}
async function capture(name) {
  await delay(220);
  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(output, name + '.png'), image.toPNG());
  return image.toPNG();
}
async function click(selector) {
  const point = await run(`(() => {
    const el=document.querySelector(${JSON.stringify(selector)}); const r=el.getBoundingClientRect();
    return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};
  })()`);
  assert.ok(await run(`document.elementFromPoint(${point.x},${point.y})?.closest(${JSON.stringify(selector)}) !== null`), 'click target must be reachable: ' + selector);
  win.webContents.sendInputEvent({ type: 'mouseMove', ...point });
  win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
  win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
  await delay(70);
}
async function seed(count) {
  await run(`(async () => {
    localStorage.setItem('refboard.recentWorks',JSON.stringify(Array.from({length:${count}},(_,i)=>({
      path:'C:/ClassicSmoke/board-'+i+'.refboard',title:i===0?${JSON.stringify(longTitle)}:'Study '+i,
      itemCount:24-i,thumbnailData:${JSON.stringify(preview)},thumbnail:'preview.png',
      lastEdited:Date.UTC(2026,8,5,10)-i*86400000
    }))));
    window.RefBoardAPI={revealBoardFile:async()=>({ok:true}),setRecentWorkPinned:async()=>[]};
    await window.RefBoard.renderRecentWorksForTest();
    document.querySelector('#recentWorks').scrollTop=0;
  })()`);
  await waitFor(`document.querySelectorAll('#recentGrid .rw-card').length===${count}`, 'fixture cards');
  if (count) await waitFor(`[...document.querySelectorAll('#recentGrid .rw-thumb img')].length===${count} && [...document.querySelectorAll('#recentGrid .rw-thumb img')].every(i=>i.complete&&i.naturalWidth>0)`, 'decoded previews');
}
async function search(text) {
  await run(`document.querySelector('#rwSearchInput').value=${JSON.stringify(text)};
    document.querySelector('#rwSearchInput').dispatchEvent(new Event('input',{bubbles:true}));`);
  await delay(120);
}

const geometry = `(() => {
  const rect=el=>el.getBoundingClientRect();
  const intersects=(a,b)=>Math.min(a.right,b.right)-Math.max(a.left,b.left)>.5 && Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>.5;
  const contains=(outer,inner)=>inner.left>=outer.left-1&&inner.right<=outer.right+1&&inner.top>=outer.top-1&&inner.bottom<=outer.bottom+1;
  const page=document.querySelector('#recentWorks'), header=document.querySelector('.rw-header'), hr=rect(header);
  const cards=[...document.querySelectorAll('#recentGrid .rw-card')];
  const cardRects=cards.map(rect), grid=document.querySelector('#recentGrid');
  // The clear button intentionally sits inside the search input. Check its
  // own containment instead of treating that composition as overlapping peers.
  const controls=[...header.querySelectorAll('button:not(.rw-search-clear),input')].filter(el=>{const r=rect(el);return r.width>0&&r.height>0;});
  const cr=controls.map(rect);
  const searchClear=document.querySelector('#rwSearchClear'), searchClearRect=rect(searchClear);
  const pseudo=['::before','::after'].map(p=>{const s=getComputedStyle(page,p);return {content:s.content,image:s.backgroundImage,size:s.backgroundSize,blend:s.mixBlendMode};});
  const titles=cards.map(card=>{const el=card.querySelector('.rw-title'),s=getComputedStyle(el);return {
    fits:contains(rect(card),rect(el)),ellipsis:s.textOverflow==='ellipsis',overflow:el.scrollWidth>el.clientWidth,
    label:el.textContent,animation:getComputedStyle(card).animationName
  };});
  const actions=cards.map(card=>{
    const buttons=[...card.querySelectorAll('button')].filter(el=>{const r=rect(el);return r.width>0&&r.height>0;});
    return {count:buttons.length,fit:buttons.every(b=>contains(rect(card),rect(b))),
      separate:buttons.every((a,i)=>buttons.every((b,j)=>i===j||!intersects(rect(a),rect(b))))};
  });
  const visiblePanels=['#recentEmpty','#recentNoResults','#rwRestore'].map(s=>document.querySelector(s)).filter(el=>{const r=rect(el);return r.width>0&&r.height>0;});
  return {width:innerWidth,height:innerHeight,theme:document.documentElement.dataset.theme||'default',
    overflow:page.scrollWidth-page.clientWidth,columns:getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length,
    cardCount:cards.length,cardWidth:cardRects[0]?.width,
    cardsSeparate:cardRects.every((a,i)=>cardRects.every((b,j)=>i===j||!intersects(a,b))),
    cardsClearHeader:cardRects.every(r=>r.top>=hr.bottom-1),
    headerFits:hr.left>=0&&hr.right<=innerWidth+1,
    controlsFit:cr.every(r=>contains(hr,r)),controlsSeparate:cr.every((a,i)=>cr.every((b,j)=>i===j||!intersects(a,b))),
    searchClearFits:searchClearRect.width===0||searchClearRect.height===0||contains(rect(document.querySelector('#rwSearch')),searchClearRect),
    imagesContain:cards.every(c=>getComputedStyle(c.querySelector('.rw-thumb img')).objectFit==='contain'),
    pseudo,titles,actions,
    headerAnimations:[...header.querySelectorAll('*')].map(el=>getComputedStyle(el).animationName).filter(n=>n!=='none'),
    panelsFit:visiblePanels.every(p=>{const r=rect(p);return r.left>=0&&r.right<=innerWidth+1&&r.top>=hr.bottom-1;}),
    restoreClear:document.querySelector('#rwRestore').hidden||cardRects.every(r=>r.top>=rect(document.querySelector('#rwRestore')).bottom-1)
  };
})()`;

function checkGeometry(g, expectCards = true) {
  const detail = JSON.stringify(g);
  assert.ok(g.overflow <= 1 && g.headerFits && g.controlsFit && g.controlsSeparate && g.searchClearFits, 'header and controls must fit: ' + detail);
  assert.ok(g.panelsFit && g.restoreClear, 'status panels must fit: ' + detail);
  assert.deepEqual(g.headerAnimations, [], 'header must have no entrance animation');
  assert.ok(g.pseudo.every(p=>p.content==='none'||p.content==='normal'||(!/url\(|repeating-|linear-gradient/i.test(p.image)&&p.blend!=='overlay')), 'grid and grain must be absent: '+detail);
  if (!expectCards) return;
  assert.ok(g.columns>=2 && g.cardsSeparate && g.cardsClearHeader && g.imagesContain, 'library geometry must fit: '+detail);
  assert.ok(g.titles.every(t=>t.fits&&t.ellipsis&&t.animation==='none'), 'titles must stay within stable cards: '+detail);
  assert.ok(g.actions.every(a=>a.count===4&&a.fit&&a.separate), 'four card actions must fit: '+detail);
}

async function main() {
  try {
    await app.whenReady();
    win = new BrowserWindow({ show:false, width:1440, height:900, frame:false,
      webPreferences:{contextIsolation:true,nodeIntegration:false,backgroundThrottling:false,offscreen:true} });
    win.webContents.on('console-message', details => {
      if (/Uncaught|SyntaxError|ReferenceError|TypeError/.test(details.message||'')) errors.push(details.message);
    });
    await win.loadFile(path.join(root,'index.html'));
    await waitFor('window.RefBoard?.startupComplete','startup');
    await run(`localStorage.setItem('refboard.settings',JSON.stringify({landingLayout:'classic'}));`);
    win.webContents.reloadIgnoringCache();
    await waitFor('window.RefBoard?.startupComplete','Classic startup');
    await seed(12);

    step='unchanged refresh';
    const refresh=await run(`(async () => {
      const card=document.querySelector('#recentGrid .rw-card'),img=card.querySelector('.rw-thumb img');
      card.focus();
      await window.RefBoard.renderRecentWorksForTest();
      return {sameCard:card===document.querySelector('#recentGrid .rw-card'),
        sameImage:img===document.querySelector('#recentGrid .rw-card .rw-thumb img'),
        decoded:img.complete&&img.naturalWidth>0,focused:document.activeElement===card};
    })()`);
    assert.deepEqual(refresh,{sameCard:true,sameImage:true,decoded:true,focused:true},'unchanged refresh must retain decoded preview nodes and keyboard focus');
    results.refresh=refresh;
    await run('document.activeElement.blur()');

    step='responsive themes';
    for (const theme of ['default','black']) {
      await run(theme==='black'?`document.documentElement.dataset.theme='black'`:`delete document.documentElement.dataset.theme`);
      for (const [width,height] of [[1440,900],[1024,768],[720,480]]) {
        win.setContentSize(width,height);
        await delay(220);
        const g=await run(geometry); results.layouts.push(g); checkGeometry(g);
        assert.ok(g.titles[0].overflow,'long fixture title should truncate');
        await capture(theme+'-'+width+'x'+height);
      }
    }
    await run(`delete document.documentElement.dataset.theme`);
    win.setContentSize(1440,900);
    await delay(220);

    step='hover and keyboard actions';
    const before=await run(`document.querySelector('#recentGrid .rw-card').getBoundingClientRect().toJSON()`);
    const point={x:Math.round(before.left+before.width/2),y:Math.round(before.top+before.height/2)};
    win.webContents.sendInputEvent({type:'mouseMove',...point});
    await delay(280);
    const hover=await run(`(() => {
      const card=document.querySelector('#recentGrid .rw-card');return {rect:card.getBoundingClientRect().toJSON(),
        target:document.elementFromPoint(${point.x},${point.y})?.closest('.rw-card')===card,
        visible:[...card.querySelectorAll('button')].every(b=>Number(getComputedStyle(b).opacity)===1)};
    })()`);
    for(const key of ['left','top','width','height']) assert.ok(Math.abs(hover.rect[key]-before[key])<=1,'hover must retain stable card bounds: '+JSON.stringify(hover));
    assert.ok(hover.target&&hover.visible,'hover must expose reachable card actions');
    win.webContents.sendInputEvent({type:'mouseMove',x:5,y:10});
    await run(`document.querySelector('#recentGrid .rw-card').focus()`);
    await delay(220);
    assert.ok(await run(`[...document.querySelector('#recentGrid .rw-card').querySelectorAll('button')].every(b=>Number(getComputedStyle(b).opacity)===1)`),'keyboard focus must expose card actions');
    await run(`document.activeElement.blur()`);
    await delay(350);
    const idleA=await capture('idle');
    await delay(400);
    const idleB=(await win.webContents.capturePage()).toPNG();
    assert.ok(idleA.equals(idleB),'idle landing screenshots must be pixel-identical');
    results.idleFramesIdentical=true;

    step='layout switch and search persistence';
    await search('Architecture');
    await waitFor(`document.querySelectorAll('#recentGrid .rw-card').length===1`,'Classic search');
    await click('#rwLayoutFlow');
    await waitFor(`document.querySelector('#recentWorks').classList.contains('layout-focus')&&document.querySelectorAll('.ff-card').length===1`,'Flow switch');
    assert.deepEqual(await run(`({query:document.querySelector('#rwSearchInput').value,
      stored:JSON.parse(localStorage.getItem('refboard.settings')).landingLayout,
      setting:document.querySelector('#setLandingLayout').value,
      flow:document.querySelector('#rwLayoutFlow').getAttribute('aria-pressed'),grid:document.querySelector('#rwLayoutGrid').getAttribute('aria-pressed')})`),
      {query:'Architecture',stored:'focus',setting:'focus',flow:'true',grid:'false'});
    await click('#rwLayoutGrid');
    await waitFor(`!document.querySelector('#recentWorks').classList.contains('layout-focus')&&document.querySelectorAll('#recentGrid .rw-card').length===1`,'Classic switch');
    assert.deepEqual(await run(`({query:document.querySelector('#rwSearchInput').value,
      stored:JSON.parse(localStorage.getItem('refboard.settings')).landingLayout,
      setting:document.querySelector('#setLandingLayout').value,
      grid:document.querySelector('#rwLayoutGrid').getAttribute('aria-pressed'),flow:document.querySelector('#rwLayoutFlow').getAttribute('aria-pressed')})`),
      {query:'Architecture',stored:'classic',setting:'classic',grid:'true',flow:'false'});
    await search('');

    step='few, many and empty states';
    win.setContentSize(720,480);
    for(const count of [1,3,12]) {
      await seed(count); await delay(160);
      const g=await run(geometry); checkGeometry(g); results.states.push({state:'boards-'+count,...g});
      await capture('boards-'+count);
    }
    await search('No matching references');
    await waitFor(`!document.querySelector('#recentNoResults').classList.contains('hide')`,'no results');
    const noResults=await run(geometry);checkGeometry(noResults,false);results.states.push({state:'no-results',...noResults});
    await capture('no-results');
    await click('#rwNoResultsClear');
    await waitFor(`document.querySelectorAll('#recentGrid .rw-card').length===12`,'clear no results');

    step='restore prompt';
    await run(`document.querySelector('#rwRestore').hidden=false`);
    const restore=await run(geometry);checkGeometry(restore);results.states.push({state:'restore',...restore});
    await capture('restore');
    await run(`document.querySelector('#rwRestore').hidden=true`);
    await seed(0);
    await waitFor(`!document.querySelector('#recentEmpty').classList.contains('hide')`,'empty library');
    const empty=await run(geometry);checkGeometry(empty,false);results.states.push({state:'empty',...empty});
    await capture('empty');
    assert.deepEqual(errors,[],'renderer errors');
    fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(results,null,2));
    console.log('Classic landing Electron smoke passed: six size/theme combinations, card actions, keyboard focus, stable hover and idle frames, layout/search/settings persistence, single/few/many boards, empty/search/restore states.');
  } catch(error) {
    console.error('Classic landing smoke failed at '+step,error);
    if(win&&!win.isDestroyed()) await capture('failure').catch(()=>{});
    process.exitCode=1;
  } finally {
    if(win&&!win.isDestroyed()) win.destroy();
    const {removeProfileDir}=await import('./smoke-profile-cleanup.mjs');
    await removeProfileDir(profile);
    app.exit(process.exitCode||0);
  }
}
void main();
