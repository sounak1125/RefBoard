import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { boardHeaderPrefix, boardImageParts } = require('./board-save-format.js');
const {
  readBoardPreview,
  readBoardImageBytes,
  rewriteBoardFilePreview,
  scanBoardFile,
} = require('./board-open-stream.js');

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const main = await readFile(new URL('../main.js', import.meta.url), 'utf8');
const preload = await readFile(new URL('../preload.js', import.meta.url), 'utf8');

assert.match(
  html,
  /beginBoardSave\([\s\S]*?snapshot\.core, null, saveAs/,
  'streamed saves must still pass null preview up front (non-blocking)',
);
assert.match(
  html,
  /scheduleBoardPreviewBackfill\(result\.filePath\)/,
  'after a streamed save the renderer must schedule an async preview backfill',
);
assert.match(
  html,
  /captureBoardFilePreviewBase64\(720\)/,
  'backfill must capture the 720px board-file preview',
);
assert.match(
  html,
  /writeBoardPreview\(pathToFill, preview\)/,
  'backfill must call the writeBoardPreview bridge',
);
assert.match(
  html,
  /if \(meta\.path && !cachedCurrentBoardThumb\)[\s\S]*?scheduleBoardPreviewBackfill\(meta\.path\)/,
  'opening a board without an embedded preview should self-heal once via backfill',
);
assert.match(
  preload,
  /writeBoardPreview: \(filePath, preview\) => ipcRenderer\.invoke\('write-board-preview', \{ filePath, preview \}\)/,
  'preload must expose writeBoardPreview',
);
assert.match(
  main,
  /ipcMain\.handle\('write-board-preview'/,
  'main must register write-board-preview',
);
assert.match(
  main,
  /ipcMain\.handle\('write-board-preview'[\s\S]*?rewriteBoardFilePreview\(target, preview\);[\s\S]*?refreshShellIcons\(target\)/,
  'write-board-preview must splice the preview then refresh shell icons',
);

const tempDir = await mkdtemp(path.join(os.tmpdir(), 'refboard-preview-backfill-'));
try {
  const filePath = path.join(tempDir, 'no-preview.refboard');
  const core = {
    app: 'refboard',
    version: 3,
    items: [{ id: 'item-1', kind: 'image', imgId: 'image-1', name: 'shot.png' }],
  };
  const bytes = Buffer.from([1, 2, 3, 4, 5, 250, 251]);
  const parts = boardImageParts(
    { id: 'image-1', type: 'image/png', name: 'shot.png', w: 8, h: 8 },
    bytes,
  );
  // Streamed save path: null preview omits the key entirely.
  const initial = boardHeaderPrefix(core, null) + parts.prefix + parts.base64 + parts.suffix + ']}';
  await writeFile(filePath, initial);

  assert.equal(await readBoardPreview(filePath), null, 'file saved without preview should read as null');

  const preview = Buffer.from('embedded-preview-bytes-for-explorer').toString('base64');
  const result = await rewriteBoardFilePreview(filePath, preview);
  assert.equal(result.written, true);
  assert.equal(await readBoardPreview(filePath), preview, 'backfill must embed a readable preview in the header');

  const scanned = await scanBoardFile(filePath);
  assert.equal(scanned.core.app, 'refboard');
  assert.equal(scanned.core.preview, preview);
  assert.equal(scanned.images.length, 1);
  assert.ok(
    (await readBoardImageBytes(filePath, scanned.images[0])).equals(bytes),
    'image payload must survive the header rewrite',
  );

  // Second backfill should replace the preview without corrupting images.
  const preview2 = Buffer.from('second-preview').toString('base64');
  await rewriteBoardFilePreview(filePath, preview2);
  assert.equal(await readBoardPreview(filePath), preview2);
  assert.ok(
    (await readBoardImageBytes(filePath, (await scanBoardFile(filePath)).images[0])).equals(bytes),
    'replacing an existing preview must keep image bytes intact',
  );
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

console.log('board preview backfill tests passed');
