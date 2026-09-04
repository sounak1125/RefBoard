/**
 * The sidecar save path, pinned by shape. See scripts/board-sidecar.js for the
 * format; this guards the wiring around it.
 *
 * A save appends to the store only the images it lacks and rewrites the small
 * index; a legacy embedded board still opens through the byte scanner and is
 * converted to a sidecar pair by its next save; renaming a board moves both
 * files; the Explorer thumbnail readers still find the preview in the index.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const main = await readFile(new URL('../main.js', import.meta.url), 'utf8');
const preload = await readFile(new URL('../preload.js', import.meta.url), 'utf8');
const rename = await readFile(new URL('./board-rename.js', import.meta.url), 'utf8');
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

const handler = (src, channel) => {
  const start = src.indexOf(`ipcMain.handle('${channel}'`);
  assert.ok(start >= 0, `main.js must handle '${channel}'`);
  const next = src.indexOf('ipcMain.handle(', start + 1);
  return src.slice(start, next < 0 ? undefined : next);
};
const fn = name => {
  const m = html.match(new RegExp(`(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
  assert.ok(m, `${name} should be findable`);
  return m[0];
};

/* --- main: the store is the save target --- */
assert.match(main, /require\('\.\/scripts\/board-sidecar'\)/, 'main.js uses the sidecar module');
assert.ok(packageJson.build.files.includes('scripts/board-sidecar.js'), 'the module ships in the package');

const begin = handler(main, 'begin-board-save');
assert.match(begin, /readSidecarIndex\(target\)/, 'a save over a sidecar board reads its index');
assert.match(begin, /openSidecarStore\(session\.storePath, \{ create: true, truncate: !index \}\)/, 'a non-sidecar target starts a fresh store; a sidecar target keeps its own');
assert.match(begin, /session\.existing\.set\(image\.id, image\)/, 'records the index still points at are reused');
assert.match(begin, /if \(image\.offset \+ image\.length <= session\.store\.size\)/, 'a record beyond the store is not reused');
assert.match(begin, /stored: \[\.\.\.session\.existing\.keys\(\)\]/, 'the renderer is told what the store already holds');
assert.match(begin, /if \(boardSaveSessionForTarget\(target\)\) throw new Error\('Board save in progress'\)/, 'two saves cannot append to one store at once');

const append = main.match(/async function appendBoardSaveImageParts\(session, image, data\) \{[\s\S]*?\n {2}\}/)?.[0];
assert.ok(append, 'appendBoardSaveImageParts should be findable');
assert.match(append, /appendSidecarImage\(session\.store, image, data\)/, 'appends go to the store as raw bytes');
assert.doesNotMatch(append, /boardImageParts|base64/, 'no base64 on the save path');

const finish = handler(main, 'finish-board-save');
assert.match(finish, /session\.appended\.get\(id\) \|\| session\.existing\.get\(id\)/, 'the index points at appended or reused records');
assert.match(finish, /throw new Error\(`Missing image data: \$\{id\}`\)/, 'an image in neither is a failed save, not a silent hole');
assert.match(finish, /shouldCompactSidecar\(storeSize, garbage/, 'compaction is considered on every save');
assert.match(finish, /await compactSidecarStore\(session\.storePath, images\)/, 'compaction rewrites the store before the index');
assert.match(finish, /await writeSidecarIndex\(session\.target, session\.core, session\.preview, images\)/, 'the index is written last, atomically');
assert.ok(finish.indexOf('compactSidecarStore') < finish.indexOf('writeSidecarIndex'), 'the new store lands before the index that points into it');

const discard = main.match(/async function discardBoardSaveSession\(session\) \{[\s\S]*?\n {2}\}/)?.[0];
assert.match(discard, /truncate\(session\.startSize\)/, 'an abandoned save gives its appended bytes back');

/* --- main: open handles both formats --- */
const open = handler(main, 'begin-board-open');
assert.match(open, /const index = await readSidecarIndex\(resolved\);\s*if \(index\) \{/, 'a sidecar index is detected before the legacy scanner runs');
assert.match(open, /must sit beside the \.refboard file/, 'a missing store is explained, not a generic failure');
assert.match(open, /scanBoardHandle\(handle, stat\.size\)/, 'a legacy embedded board still opens through the byte scanner');
assert.match(main, /if \(session\.sidecar\) return readSidecarImage\(session\.handle, image, session\.storeSize\);/, 'sidecar reads are raw byte ranges');
assert.match(main, /function armBoardOpenTimer\(session\)/, 'the open session timer is re-armed by reads');
const preview = handler(main, 'write-board-preview');
assert.match(preview, /writeSidecarIndex\(target, core, preview, images\)/, 'a preview write on a sidecar board rewrites only the index');
assert.match(preview, /rewriteBoardFilePreview\(target, preview\)/, 'a legacy board still gets the header splice');

/* --- rename moves the pair --- */
assert.match(rename, /if \(hasStore\) await fs\.rename\(fromStore, toStore\);/, 'the store is renamed with the index');
assert.match(rename, /if \(hasStore\) await fs\.rename\(toStore, fromStore\)\.catch/, 'a failed index rename puts the store back');

/* --- bridge --- */
assert.match(preload, /beginBoardSave: \(defaultName, filePath, core, preview, forceDialog = false, imageRefs = \[\]\)/, 'the bridge carries the image references');

/* --- renderer: send only what the store lacks --- */
assert.match(html, /function markImagePixelsChanged\(im\)/, 'pixel changes are counted per record');
assert.equal((html.match(/markImagePixelsChanged\(im\);/g) || []).length, 2, 'both byte-replacing paths (paint commit, history restore) mark the record');
const needs = fn('imageNeedsStoreAppend');
assert.match(needs, /if \(!im\?\.id \|\| !storedIds\.has\(im\.id\)\) return true;/, 'an image the store lacks is sent');
assert.match(needs, /known \? im\.storedAs\.gen !== gen : gen > 0/, 'an image whose pixels changed since it was stored is resent');
const save = html.match(/async function performBoardSave\(opts = \{\}\) \{[\s\S]*?\nasync function saveBoardFile/)?.[0];
assert.match(save, /snapshot\.core, preview, saveAs, snapshot\.imageRefs,/, 'the save hands the store the image references');
assert.match(save, /if \(!imageNeedsStoreAppend\(im, savePath, storedIds\)\) continue;/, 'reused images are skipped before their bytes are even read');
assert.match(save, /im\.storedAs = \{ path: result\.filePath, gen: im\.pixelGen \|\| 0 \};/, 'a finished save records where each image now lives');
assert.match(html, /pixelGen: im\.pixelGen \|\| 0,\s*storedPath: im\.storedAs\?\.path \|\| null/, 'the bookkeeping persists with the session');
assert.match(html, /storedAs: j\.version === 4 && meta\.path \? \{ path: meta\.path, gen: 0 \} : null,/, 'opening a sidecar board marks every image as stored; a legacy board does not');

console.log('sidecar save contract passed');
