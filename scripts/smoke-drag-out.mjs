/**
 * Drag out: the staging half, driven for real inside Electron.
 *
 * A native OS drag cannot be automated — webContents.startDrag hands control to
 * the shell and blocks until a drop happens. So this smoke covers everything up
 * to that call: the grip only appears when the selection holds images, staging
 * writes real files into the main process's temp directory, an untouched image
 * hands over its own bytes, and two images sharing a filename become two files.
 * The drop itself stays a manual check.
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
const profile = await mkdtemp(path.join(os.tmpdir(), 'refboard-dragout-'));
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
  for(let attempt=0;attempt<200&&!window.RefBoard;attempt++)await wait(50);
  if(!window.RefBoard)throw new Error('RefBoard API unavailable');
  for(let attempt=0;attempt<300&&!window.RefBoard.startupComplete;attempt++)await wait(50);
  if(!window.RefBoard.startupComplete)throw new Error('RefBoard startup did not complete');
  document.querySelectorAll('.modal.show').forEach(el=>el.classList.remove('show'));
  document.querySelector('#rwNewBoard')?.click();
  for(let attempt=0;attempt<100&&!document.body.classList.contains('board-active');attempt++)await wait(50);
  if(!document.body.classList.contains('board-active'))throw new Error('New board did not open');
  await wait(250);
  document.querySelectorAll('.modal.show').forEach(el=>el.classList.remove('show'));

  const RB=window.RefBoard;

  // Two visibly different images that deliberately share one filename.
  const makePng=async(fill)=>{
    const c=document.createElement('canvas');c.width=64;c.height=48;
    const g=c.getContext('2d');g.fillStyle=fill;g.fillRect(0,0,64,48);
    return await new Promise(r=>c.toBlob(r,'image/png'));
  };
  const blobA=await makePng('#c81e28');
  const blobB=await makePng('#1eb45a');
  const bytesOf=async b=>[...new Uint8Array(await b.arrayBuffer())];

  const added=await RB.addImages([
    new File([blobA],'ref.png',{type:'image/png'}),
    new File([blobB],'ref.png',{type:'image/png'}),
  ]);
  await wait(500);
  if(added.length!==2)throw new Error('expected two images on the board');

  // A note must not offer a drag: there is no file to hand over.
  const note=RB.state.items.find(it=>it.kind==='note');

  const grip=document.querySelector('#sDragOut');
  const gripPresent=!!grip;
  const gripHidden=grip?grip.hidden:null;

  const select=ids=>{
    RB.state.sel=new Set(ids);
    RB.updateSelBarForTest();
  };

  select([]);
  const barWithNothing=document.querySelector('#selbar').classList.contains('has-images');

  select(added.map(it=>it.id));
  const barWithImages=document.querySelector('#selbar').classList.contains('has-images');
  const gripVisible=grip?getComputedStyle(grip).display!=='none':null;
  const resolved=RB.dragOutItemsForTest().length;

  const staged=await RB.stageDragOutForTest(RB.dragOutItemsForTest());

  // Only a note selected: nothing resolves, so nothing can be dragged.
  let barWithNoteOnly=null;
  if(note){ select([note.id]); barWithNoteOnly=document.querySelector('#selbar').classList.contains('has-images'); }

  return {
    gripPresent, gripHidden, gripVisible,
    barWithNothing, barWithImages, barWithNoteOnly,
    resolved,
    paths: staged?staged.paths:[],
    hasIcon: !!(staged&&staged.icon&&staged.icon.startsWith('data:image/')),
    sourceBytes: [await bytesOf(blobA), await bytesOf(blobB)],
  };
})()`;

try {
  const r = await evaluate(await debuggerPort(), smokeExpression);

  assert.equal(r.gripPresent, true, 'the selection bar must carry a drag grip');
  assert.equal(r.gripHidden, false, 'the grip must not hide itself in the desktop app');

  // Offering a drag with nothing draggable behind it is a dead control.
  assert.equal(r.barWithNothing, false, 'an empty selection must not advertise a drag');
  assert.equal(r.barWithImages, true, 'an image selection must advertise a drag');
  assert.equal(r.gripVisible, true, 'the grip must be visible once images are selected');
  if (r.barWithNoteOnly !== null) {
    assert.equal(r.barWithNoteOnly, false, 'a note-only selection has no file to hand over');
  }

  assert.equal(r.resolved, 2, `both images should resolve for the drag (got ${r.resolved})`);
  assert.equal(r.paths.length, 2, `both images should be staged (got ${r.paths.length})`);
  assert.equal(r.hasIcon, true, 'a drag icon should be rendered from the first image');

  // Two images called "ref.png" must not become one file.
  const names = r.paths.map(p => path.basename(p));
  assert.equal(new Set(names.map(n => n.toLowerCase())).size, 2, `staged names collided: ${names.join(', ')}`);
  assert.deepEqual(names, ['ref.png', 'ref_2.png'], `unexpected staged names: ${names.join(', ')}`);

  // Staged files are real files on disk, holding the original bytes — an
  // untouched image must not be re-encoded on its way out.
  for (const [i, filePath] of r.paths.entries()) {
    const onDisk = await readFile(filePath);
    assert.ok(onDisk.length > 0, `${names[i]} was staged empty`);
    assert.deepEqual(
      [...onDisk], r.sourceBytes[i],
      `${names[i]} does not hold the original bytes — it was re-encoded`,
    );
  }

  // Staging belongs to the app's own temp area, not next to the user's files.
  for (const filePath of r.paths) {
    assert.ok(
      filePath.split(path.sep).includes('RefBoard-DragOut'),
      `staged outside the drag-out directory: ${filePath}`,
    );
  }

  console.log(`drag out Electron smoke passed — ${r.paths.length} files staged as ${names.join(', ')}`);
} finally {
  if (child.exitCode === null) child.kill();
  await Promise.race([once(child, 'exit'), delay(3000)]).catch(() => {});
  await removeProfileDir(profile);
}
