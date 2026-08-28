/**
 * Tags, driven through the real UI.
 *
 * The unit tests in test-tags.mjs cover the values and the filter rules; this
 * covers the parts only a running board can answer: that the popover writes
 * tags onto the selected items, that the filter actually isolates rather than
 * merely dimming, that Ctrl+F finds an image by tag, and — the one that would
 * quietly ruin the feature — that tags survive a save and reopen.
 *
 * Notes are rebuilt field by field in normalizeItem while images are spread, so
 * the round trip is checked on both kinds.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeProfileDir } from './smoke-profile-cleanup.mjs';
import { evaluate } from './smoke-cdp.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const profile = await mkdtemp(path.join(os.tmpdir(), 'refboard-tags-'));
const workDir = await mkdtemp(path.join(os.tmpdir(), 'refboard-tags-board-'));
const boardPath = path.join(workDir, 'tagged.refboard');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const child = spawn(electron, ['.', '--remote-debugging-port=0', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-features=CalculateNativeWinOcclusion', `--user-data-dir=${profile}`], {
  cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
});
let stderr = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', chunk => { stderr += chunk; });

async function debuggerPort() {
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`Electron exited before smoke setup (${child.exitCode})\n${stderr}`);
    try {
      const [port] = (await readFile(portFile, 'utf8')).trim().split(/\r?\n/);
      if (/^\d+$/.test(port)) return Number(port);
    } catch { /* wait for Chromium */ }
    await delay(100);
  }
  throw new Error(`Electron debugging port did not become ready\n${stderr}`);
}

const smokeExpression = `(async()=>{
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  for(let i=0;i<200&&!window.RefBoard;i++)await wait(50);
  if(!window.RefBoard)throw new Error('RefBoard API unavailable');
  for(let i=0;i<300&&!window.RefBoard.startupComplete;i++)await wait(50);
  if(!window.RefBoard.startupComplete)throw new Error('RefBoard startup did not complete');
  document.querySelectorAll('.modal.show').forEach(el=>el.classList.remove('show'));
  document.querySelector('#rwNewBoard').click();
  for(let i=0;i<100&&!document.body.classList.contains('board-active');i++)await wait(50);
  if(!document.body.classList.contains('board-active'))throw new Error('New board did not open');
  await wait(300);
  document.querySelectorAll('.modal.show').forEach(el=>el.classList.remove('show'));

  const RB=window.RefBoard;
  const filePath=${JSON.stringify(boardPath)};
  const png=async(fill)=>{
    const c=document.createElement('canvas');c.width=200;c.height=150;
    const g=c.getContext('2d');g.fillStyle=fill;g.fillRect(0,0,200,150);
    return await new Promise(r=>c.toBlob(r,'image/png'));
  };

  const added=await RB.addImages([
    new File([await png('#c8543c')],'warm.png',{type:'image/png'}),
    new File([await png('#3c7ac8')],'cool.png',{type:'image/png'}),
    new File([await png('#4cc86a')],'green.png',{type:'image/png'}),
  ]);
  await wait(500);
  if(added.length!==3)throw new Error('expected three images');

  // A note as well: notes are rebuilt field by field on load, images are not.
  const note=RB.state.items.find(it=>it.kind==='note');

  const select=ids=>{ RB.state.sel=new Set(ids); RB.updateSelBarForTest(); };
  /* What a mouse actually sends. A bare .click() skips pointerdown, which is
     where every dismissal in this app runs, so it cannot catch a control that
     closes the surface it lives on. */
  const press=el=>{
    if(!el)throw new Error('press() got nothing to press');
    el.dispatchEvent(new PointerEvent('pointerdown',{button:0,bubbles:true}));
    el.dispatchEvent(new MouseEvent('click',{button:0,bubbles:true}));
  };
  const pressTagButton=async()=>{
    document.querySelector('#sTags').dispatchEvent(new PointerEvent('pointerdown',{button:0,bubbles:true}));
    await wait(140);
    return document.querySelector('#tagPop').classList.contains('open');
  };
  // The button toggles, so a second tagging pass has to reopen rather than
  // press again blindly — pressing again is what closes it.
  const ensureTagPopOpen=async()=>{
    const pop=document.querySelector('#tagPop');
    if(!pop.classList.contains('open'))await pressTagButton();
    if(!pop.classList.contains('open')){
      throw new Error('tag popover did not open — selbar="'+document.querySelector('#selbar').className
        +'" sel='+RB.state.sel.size+' toast="'+document.querySelector('#toast').textContent+'"');
    }
  };
  const typeTags=async(text)=>{
    await ensureTagPopOpen();
    const input=document.querySelector('#tagPopInput');
    input.value=text;
    input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
    await wait(160);
  };

  // Tag two images at once, then one on its own.
  select([added[0].id,added[1].id]);
  await typeTags('Mood, lighting');
  select([added[2].id]);
  await typeTags('mood');

  const tagsOf=id=>{ const it=RB.state.items.find(x=>x.id===id); return it?[...(it.tags||[])]:null; };
  const afterTagging={
    first:tagsOf(added[0].id), second:tagsOf(added[1].id), third:tagsOf(added[2].id),
  };

  // A case variant must not become a second tag.
  select([added[2].id]);
  await typeTags('MOOD');
  const afterDuplicate=tagsOf(added[2].id);

  const selbarOffersTags=document.querySelector('#selbar').classList.contains('has-taggable');

  // Pressing the button again closes it, so it cannot be left covering the board.
  const stillOpenBeforeToggle=document.querySelector('#tagPop').classList.contains('open');
  const openAfterSecondPress=await pressTagButton();

  // Filter to 'lighting': two images carry it, one does not.
  press(document.querySelector('#btnTags'));
  await wait(150);
  const panelOpen=document.querySelector('#tagPanel').classList.contains('open');
  const chips=[...document.querySelectorAll('#tagPanelList .tag-chip')];
  const chipLabels=chips.map(c=>c.dataset.tag);
  const lightingChip=chips.find(c=>c.dataset.tag.toLowerCase()==='lighting');
  if(!lightingChip)throw new Error('lighting chip missing from the panel');
  press(lightingChip);
  await wait(150);

  const filtered=RB.tagStateForTest();
  const countText=document.querySelector('#tagPanelCount').textContent;

  // 'all' must narrow where 'any' widened.
  const moodChip=[...document.querySelectorAll('#tagPanelList .tag-chip')].find(c=>c.dataset.tag.toLowerCase()==='mood');
  press(moodChip);
  await wait(120);
  const anyMode=RB.tagStateForTest();
  press(document.querySelector('#tagModeAll'));
  await wait(120);
  const allMode=RB.tagStateForTest();

  press(document.querySelector('#tagClear'));
  await wait(120);
  const cleared=RB.tagStateForTest();

  // Give 'mood' a colour through the well on its panel row.
  const moodDot=[...document.querySelectorAll('#tagPanelList .tag-row')]
    .find(row=>row.querySelector('.tag-chip').dataset.tag.toLowerCase()==='mood')
    .querySelector('.tag-dot');
  press(moodDot);
  await wait(200);
  const colorPopOpen=document.querySelector('#tagColorPop').classList.contains('open');
  const swatches=[...document.querySelectorAll('#tagColorGrid .tag-color-sw')];
  const chosen=swatches[2].style.background;
  press(swatches[2]);
  await wait(200);
  const colorsAfterPick={...RB.state.tagColors};
  // The swatch lives in a popover rendered outside #tagPanel; if the panel
  // treats pressing it as an outside click it closes, and a real mouse then
  // never delivers the click at all.
  const panelSurvivedColorPick=document.querySelector('#tagPanel').classList.contains('open');

  // Undo must take a colour with it: it is board data, not a preference.
  RB.undoForTest();
  await wait(200);
  const colorsAfterUndo={...RB.state.tagColors};
  RB.redoForTest&&RB.redoForTest();
  await wait(200);
  const colorsAfterRedo={...RB.state.tagColors};
  if(!Object.keys(colorsAfterRedo).length){
    // No redo hook: put the colour back so the round trip below has something.
    const dot=[...document.querySelectorAll('#tagPanelList .tag-row')]
      .find(row=>row.querySelector('.tag-chip').dataset.tag.toLowerCase()==='mood')
      .querySelector('.tag-dot');
    press(dot); await wait(180);
    press(document.querySelectorAll('#tagColorGrid .tag-color-sw')[2]);
    await wait(200);
  }
  const colorsBeforeSave={...RB.state.tagColors};

  /* The glow must be the same size on screen however far the board is zoomed
     out. shadowBlur is not scaled by the canvas transform, so dividing it by
     the view scale made it grow as you zoomed out — 17px of reach at 100% and
     over 400px at 25%. Measured by differencing a frame that has tag colours
     against the same frame without them: whatever changed is the glow. */
  const glowReach=async zoom=>{
    const board=document.getElementById('board');
    const bctx=board.getContext('2d');
    const dpr=devicePixelRatio||1;
    const it=added[0];
    const strip=async withGlow=>{
      RB.state.tagColors = withGlow ? {mood:'#5aa2ff'} : {};
      RB.state.view.s=zoom;
      const cx=it.x+it.w/2, cy=it.y+it.h/2;
      RB.state.view.tx=board.clientWidth/2 - cx*zoom;
      RB.state.view.ty=board.clientHeight/2 - cy*zoom;
      RB.invalidate();
      await wait(350);
      const x0=Math.max(0, Math.round(((it.x+it.w)*zoom+RB.state.view.tx)*dpr));
      const y0=Math.max(0, Math.round((cy*zoom+RB.state.view.ty)*dpr));
      const w=Math.max(1, Math.min(600, board.width-x0));
      return {data:bctx.getImageData(x0,y0,w,1).data, w};
    };
    const on=await strip(true), off=await strip(false);
    let reach=0;
    for(let d=0;d<on.w;d++){
      const i=d*4;
      const diff=Math.abs(on.data[i]-off.data[i])+Math.abs(on.data[i+1]-off.data[i+1])+Math.abs(on.data[i+2]-off.data[i+2]);
      if(diff>8) reach=d;
    }
    return Math.round(reach/dpr);
  };
  /* Measured on a board of one. The strip runs to the right of the item, and
     with neighbours present it crossed their glows too, which made the reading
     the size of the board rather than of one halo. */
  const allItems=RB.state.items.slice();
  const savedSel=new Set(RB.state.sel);
  RB.state.items=[added[0]];
  RB.state.sel=new Set();
  const glowNear=await glowReach(1);
  const glowMid=await glowReach(0.25);
  const glowFar=await glowReach(0.05);
  RB.state.items=allItems;
  RB.state.sel=savedSel;
  RB.state.tagColors={...colorsBeforeSave};
  RB.state.view.s=1;
  RB.updateSelBarForTest();
  RB.invalidate();
  await wait(250);

  // The three label modes, through the panel's own buttons.
  const labelModes=[];
  for(const id of ['#tagLabelsNever','#tagLabelsSelected','#tagLabelsAlways']){
    press(document.querySelector(id));
    await wait(100);
    labelModes.push(RB.appSettings.tagLabels);
  }

  // Ctrl+F must find an image by a tag its filename does not contain.
  const searchHits=RB.searchHitsForTest('lighting');

  // The round trip that would quietly ruin the feature.
  if(note){ select([note.id]); await typeTags('caption'); }
  const noteTagsBefore=note?tagsOf(note.id):null;
  const saved=await RB.saveBoardFile({silent:true,filePath});
  if(!saved)throw new Error('board save failed');
  await wait(400);
  await RB.openBoardFromPath(filePath);
  for(let i=0;i<200&&RB.state.items.length<3;i++)await wait(25);
  await wait(600);

  const reloaded=RB.state.items.filter(it=>it.kind!=='group'&&it.kind!=='arrow')
    .map(it=>({kind:it.kind,name:it.name||'',tags:[...(it.tags||[])]}))
    .sort((a,b)=>a.name.localeCompare(b.name));
  const reloadedBoardTags=RB.tagStateForTest().boardTags;
  const reloadedColors={...RB.state.tagColors};

  return {
    afterTagging, afterDuplicate, selbarOffersTags, panelOpen, chipLabels,
    stillOpenBeforeToggle, openAfterSecondPress,
    colorPopOpen, chosen, colorsAfterPick, colorsAfterUndo, colorsBeforeSave, labelModes,
    panelSurvivedColorPick, glowNear, glowMid, glowFar,
    filtered, countText, anyMode, allMode, cleared,
    searchHits, noteTagsBefore, reloaded, reloadedBoardTags, reloadedColors,
    ids:{first:added[0].id,second:added[1].id,third:added[2].id},
  };
})()`;

try {
  const r = await evaluate(await debuggerPort(), smokeExpression);

  /* ---- writing tags ---- */
  assert.deepEqual(r.afterTagging.first, ['Mood', 'lighting'], 'both tags land on the first selected image');
  assert.deepEqual(r.afterTagging.second, ['Mood', 'lighting'], 'a multi-selection is tagged as one');
  assert.deepEqual(r.afterTagging.third, ['mood'], 'the third image keeps only its own tag');
  assert.deepEqual(r.afterDuplicate, ['mood'], 'adding a case variant must not create a second tag');
  assert.equal(r.selbarOffersTags, true, 'the selection bar offers tagging when something taggable is selected');
  assert.equal(r.stillOpenBeforeToggle, true, 'the popover stays open while tags are being added');
  assert.equal(r.openAfterSecondPress, false, 'pressing the tag button again closes the popover');

  /* ---- the filter ---- */
  assert.equal(r.panelOpen, true, 'the tag button opens the filter panel');
  assert.ok(r.chipLabels.includes('lighting'), `panel is missing tags: ${r.chipLabels.join(', ')}`);

  assert.deepEqual(r.filtered.filter, ['lighting'], 'clicking a chip filters by that tag');
  assert.equal(r.filtered.passIds.length, 2, `expected two images to survive "lighting", got ${r.filtered.passIds.length}`);
  assert.ok(r.filtered.passIds.includes(r.ids.first) && r.filtered.passIds.includes(r.ids.second));
  assert.ok(!r.filtered.passIds.includes(r.ids.third), 'an image without the tag must not pass the filter');
  assert.match(r.countText, /Showing 2 of/, `the panel must say what it is hiding, got "${r.countText}"`);

  // Dimmed rather than hidden: the layout is part of a moodboard's meaning.
  assert.ok(r.filtered.dimAlpha > 0 && r.filtered.dimAlpha < 0.5,
    `excluded items should be dimmed, not erased (alpha ${r.filtered.dimAlpha})`);

  assert.equal(r.anyMode.passIds.length, 3, "'any' must widen as tags are added");
  assert.equal(r.allMode.passIds.length, 2, "'all' must narrow to items carrying every selected tag");
  assert.deepEqual(r.cleared.filter, [], 'Clear must retire the filter');
  assert.equal(r.cleared.passIds.length, 0, 'a cleared filter must pass nothing through the dim path');

  /* ---- colours ---- */
  assert.equal(r.colorPopOpen, true, 'the colour well opens a palette');
  assert.equal(Object.keys(r.colorsAfterPick).length, 1, 'picking a swatch assigns a colour');
  assert.match(Object.values(r.colorsAfterPick)[0], /^#[0-9a-f]{6}$/, 'the colour is stored as hex');
  assert.equal(r.panelSurvivedColorPick, true,
    'choosing a colour must not close the tag panel — with a real mouse that also loses the click');
  assert.deepEqual(r.colorsAfterUndo, {},
    'a tag colour is board data, so undo must take it back');

  /* ---- the glow keeps its size on screen ---- */
  assert.ok(r.glowNear > 2, `no glow measured at 100% zoom (reach ${r.glowNear}px)`);

  /* Dividing shadowBlur by the view scale goes wrong in two directions as the
     board zooms out, and the crossover between them sits near 15% — which is
     why both ends are sampled and 15% is not. Measured against the bug: 54px
     of reach at 25% where a correct build gives 21px, then 1px at 5% where a
     correct build still gives 15px, because a blur that wide smears the colour
     below visibility entirely. The thresholds sit between the two measured
     ratios rather than near either: correct is about 0.9 and 0.27, the bug is
     about 1.8 and 0.06. */
  assert.ok(
    r.glowMid <= r.glowNear * 1.35,
    `the glow grows as the board is zoomed out: ${r.glowNear}px of reach at 100% `
    + `but ${r.glowMid}px at 25% — shadowBlur is being scaled by the view again`,
  );
  assert.ok(
    r.glowFar >= r.glowNear * 0.15,
    `the glow washes out when zoomed far out: ${r.glowNear}px of reach at 100% `
    + `but only ${r.glowFar}px at 5% — the blur is being widened by the view scale`,
  );

  /* ---- label modes ---- */
  assert.deepEqual(r.labelModes, ['never', 'selected', 'always'],
    'all three label modes must be reachable from the panel');

  /* ---- search ---- */
  assert.ok(
    r.searchHits.some(hit => hit.kind === 'image'),
    `Ctrl+F should find an image by tag, got ${JSON.stringify(r.searchHits)}`,
  );

  /* ---- the round trip ---- */
  if (r.noteTagsBefore) assert.deepEqual(r.noteTagsBefore, ['caption'], 'a note can be tagged');

  const byName = Object.fromEntries(r.reloaded.map(it => [it.name, it.tags]));
  assert.deepEqual(byName['warm.png'], ['Mood', 'lighting'], 'image tags must survive save and reopen');
  assert.deepEqual(byName['cool.png'], ['Mood', 'lighting']);
  assert.deepEqual(byName['green.png'], ['mood']);
  const reloadedNote = r.reloaded.find(it => it.kind === 'note');
  if (reloadedNote) {
    assert.deepEqual(reloadedNote.tags, ['caption'],
      'note tags must survive too — notes are rebuilt field by field on load');
  }
  assert.ok(
    r.reloadedBoardTags.some(entry => entry.tag.toLowerCase() === 'lighting'),
    'the reopened board must know its own tags',
  );
  assert.deepEqual(r.reloadedColors, r.colorsBeforeSave,
    'tag colours travel with the board, so they must survive save and reopen');

  console.log(
    `tags Electron smoke passed — tagged through the popover, filtered to `
    + `${r.filtered.passIds.length} of ${r.reloaded.length}, `
    + `glow reach ${r.glowNear}/${r.glowMid}/${r.glowFar}px at 100/25/5% zoom, `
    + `and survived a save and reopen`,
  );
} catch (err) {
  // Electron's own output is the only thing that explains a renderer that
  // never appeared, and it is otherwise swallowed.
  if (stderr.trim()) console.error(`--- electron stderr ---\n${stderr.trim()}`);
  console.error('child exitCode=' + child.exitCode);
  throw err;
} finally {
  if (child.exitCode === null) child.kill();
  await Promise.race([once(child, 'exit'), delay(3000)]).catch(() => {});
  await removeProfileDir(profile);
  await rm(workDir, { recursive: true, force: true }).catch(() => {});
}
