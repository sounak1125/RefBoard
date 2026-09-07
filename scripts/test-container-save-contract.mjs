/**
 * The single-file board wiring, pinned by shape. See scripts/board-container.js.
 *
 * A save over a container appends what the file lacks and a fresh index; a
 * save over anything else (a new path, a legacy embedded board, a 2.1.0
 * sidecar pair) builds a fresh container beside it and swaps it in, copying a
 * pair's images from its store so the renderer resends nothing. Open reads a
 * container's tail index; previews come from the head stub. Sidecar pairs and
 * legacy boards still open.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const main = await readFile(new URL('../main.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

const handler = (channel) => {
  const start = main.indexOf(`ipcMain.handle('${channel}'`);
  assert.ok(start >= 0, `main.js must handle '${channel}'`);
  const next = main.indexOf('ipcMain.handle(', start + 1);
  return main.slice(start, next < 0 ? undefined : next);
};
const fn = name => {
  const m = main.match(new RegExp(`(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\r?\\n {2}\\}`));
  assert.ok(m, `${name} should be findable`);
  return m[0];
};

assert.match(main, /require\('\.\/scripts\/board-container'\)/, 'main.js uses the container module');
assert.ok(packageJson.build.files.includes('scripts/board-container.js'), 'the module ships in the package');
assert.ok(packageJson.build.files.includes('scripts/board-sidecar.js'), 'the sidecar module still ships, to read 2.1.0 pairs');

const kind = fn('boardFileKind');
assert.match(kind, /isContainerHead\(head\)\) return 'container'/, 'a container is recognised by its first bytes');
assert.match(kind, /readSidecarIndex\(target\)\.catch\(\(\) => null\)\) \? 'sidecar' : 'legacy'/, 'a JSON board is a sidecar index or a legacy embedded board');

const begin = handler('begin-board-save');
assert.match(begin, /const kind = await boardFileKind\(target\);/, 'the save decides by what is at the path');
assert.match(begin, /session\.mode = 'append';\s*session\.container = await openContainer\(target\);/, 'a container is saved in place');
assert.match(begin, /session\.tempPath = `\$\{target\}\.saving-\$\{process\.pid\}-\$\{token\}`;\s*session\.container = await openContainer\(session\.tempPath, \{ create: true, truncate: true \}\);/, 'anything else gets a fresh container beside it');
assert.match(begin, /const bytes = await readSidecarImage\(store\.handle, image, store\.size\);\s*const entry = await appendContainerImage\(session\.container, image, bytes\);/, 'a pair\'s images are copied from its store into the new file');
assert.match(begin, /stored: \[\.\.\.session\.existing\.keys\(\)\]/, 'the renderer is told what the file already holds');

const append = fn('appendBoardSaveImageParts');
assert.match(append, /appendContainerImage\(session\.container, image, data\)/, 'appends go into the container');

const finish = handler('finish-board-save');
assert.match(finish, /const written = await writeContainerIndex\(box, session\.core, session\.preview, images\);/, 'the index is written at the tail, then the head stub');
assert.match(finish, /if \(session\.mode === 'append'\) \{[\s\S]*?shouldCompactContainer\(written\.size, garbage/, 'an in-place save considers compaction');
assert.match(finish, /rebuildContainer\(session\.target, \{\s*sourcePath: session\.target/, 'compaction copies the live records into a fresh file');
assert.match(finish, /await replaceBoardFile\(session\.target, tempPath\);/, 'a conversion or a new file swaps the temp container in, keeping the previous file as .bak');
assert.match(finish, /if \(session\.mode === 'convert-sidecar' && session\.sourceStorePath\) \{\s*await fs\.unlink\(session\.sourceStorePath\)/, 'a converted pair\'s store is removed once its images are in the board');

const discard = fn('discardBoardSaveSession');
assert.match(discard, /if \(session\.mode === 'append'\) \{[\s\S]*?truncate\(session\.startSize\)/, 'an abandoned in-place save gives its bytes back');
assert.match(discard, /if \(session\.tempPath\) await fs\.unlink\(session\.tempPath\)/, 'an abandoned conversion removes its temp file');

const open = handler('begin-board-open');
assert.match(open, /if \(\(await boardFileKind\(resolved\)\) === 'container'\) \{\s*const box = await openContainer\(resolved, \{ write: false \}\);/, 'a container opens from its tail index');
assert.match(open, /const index = await readSidecarIndex\(resolved\);\s*if \(index\) \{/, 'a 2.1.0 pair still opens');
assert.match(open, /scanBoardHandle\(handle, stat\.size\)/, 'a legacy embedded board still opens');
assert.match(main, /if \(session\.container\) return readContainerImage\(session\.handle, image, session\.storeSize\);/, 'container reads are raw byte ranges');

const preview = handler('get-board-preview');
assert.match(preview, /=== 'container'\) return await readContainerPreview\(target\);/, 'previews come from the head stub');
const writePreview = handler('write-board-preview');
assert.match(writePreview, /await writeContainerIndex\(box, core, preview, images\);/, 'a preview write on a container appends an index and refreshes the stub');

assert.match(html, /storedAs: j\.version >= 4 && meta\.path \? \{ path: meta\.path, gen: 0 \} : null,/, 'opening any indexed board marks its images as stored');

console.log('container save contract passed');
