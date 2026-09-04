import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rename, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  boardBakPath,
  replaceBoardFile,
  recoverBoardFileIfMissing,
} = require('./board-file-replace.js');

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const main = await readFile(new URL('../main.js', import.meta.url), 'utf8');
const preload = await readFile(new URL('../preload.js', import.meta.url), 'utf8');

// The index is written through the sidecar module, which swaps it in with the
// same stable-.bak helper the whole-file save used.
const sidecar = await readFile(new URL('./board-sidecar.js', import.meta.url), 'utf8');
assert.match(main, /writeSidecarIndex\(session\.target, session\.core, session\.preview, images\)/, 'streamed saves must write the index through the sidecar module');
assert.match(sidecar, /await replaceBoardFile\(target, tempPath\);/, 'the sidecar index swap must keep a stable .bak instead of deleting a UUID backup');
assert.doesNotMatch(main, /unlink\(backupPath\)/, 'finish-board-save must not delete the previous board copy');
assert.match(main, /recoverBoardFileIfMissing\(work\.path\)/, 'recent works must recover a missing board from .bak before listing it');
assert.match(main, /ipcMain\.handle\('read-board-file'[\s\S]*?recoverBoardFileIfMissing\(resolved\)/, 'opening a board file must recover .bak first');
assert.match(main, /ipcMain\.handle\('begin-board-open'[\s\S]*?recoverBoardFileIfMissing\(resolved\)/, 'streamed open must recover .bak first');
assert.match(preload, /recoverBoardFile: \(filePath\) => ipcRenderer\.invoke\('recover-board-file', filePath\)/, 'preload must expose recoverBoardFile');
assert.match(
  html,
  /const missingFile = !!\(meta\.path && !exists\);\s*return \{ offer: !!meta\.dirty \|\| missingFile, missingFile \}/,
  'Restore must be offered when the board path is still missing after recover, even if dirty is false',
);
assert.match(html, /pendingSessionRestoreMissingFile \? 'Board file missing' : 'Unsaved session found'/, 'a missing board file must use distinct restore copy');

const tempDir = await mkdtemp(path.join(os.tmpdir(), 'refboard-file-replace-'));
try {
  const target = path.join(tempDir, 'board.refboard');
  const bak = boardBakPath(target);
  const temp = path.join(tempDir, 'board.refboard.saving-1');

  await writeFile(target, 'original');
  await writeFile(temp, 'updated');
  const replaced = await replaceBoardFile(target, temp);
  assert.equal(replaced.replaced, true);
  assert.equal(await readFile(target, 'utf8'), 'updated');
  assert.equal(await readFile(bak, 'utf8'), 'original', 'successful replace must leave the previous board as .bak');
  assert.equal(existsSync(temp), false);

  const temp2 = path.join(tempDir, 'board.refboard.saving-2');
  await writeFile(temp2, 'newest');
  await replaceBoardFile(target, temp2);
  assert.equal(await readFile(target, 'utf8'), 'newest');
  assert.equal(await readFile(bak, 'utf8'), 'updated', 'the next save must rotate .bak to the previous generation');

  await rm(target, { force: true });
  await writeFile(bak, 'from-bak');
  const recoveredBak = await recoverBoardFileIfMissing(target);
  assert.deepEqual(recoveredBak, { exists: true, recovered: true });
  assert.equal(await readFile(target, 'utf8'), 'from-bak');
  assert.equal(existsSync(bak), false);

  await rm(target, { force: true });
  const crashTarget = path.join(tempDir, 'crash.refboard');
  const crashTemp = `${crashTarget}.saving-pid-token`;
  const crashBak = boardBakPath(crashTarget);
  await writeFile(crashTarget, 'pre-crash');
  await writeFile(crashTemp, 'unfinished');
  await rename(crashTarget, crashBak);
  const recoveredCrash = await recoverBoardFileIfMissing(crashTarget);
  assert.deepEqual(recoveredCrash, { exists: true, recovered: true });
  assert.equal(await readFile(crashTarget, 'utf8'), 'pre-crash', 'a crash after rename-to-bak must restore the original name');
  assert.equal(existsSync(crashTemp), true, 'incomplete .saving temps must not be promoted');

  const legacyTarget = path.join(tempDir, 'legacy.refboard');
  const olderBackup = `${legacyTarget}.backup-1-old`;
  const newerBackup = `${legacyTarget}.backup-2-new`;
  await writeFile(olderBackup, 'older-uuid');
  await utimes(olderBackup, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  await writeFile(newerBackup, 'newer-uuid');
  const recoveredLegacy = await recoverBoardFileIfMissing(legacyTarget);
  assert.deepEqual(recoveredLegacy, { exists: true, recovered: true });
  assert.equal(await readFile(legacyTarget, 'utf8'), 'newer-uuid', 'the newest leftover .backup-* must be promoted when .bak is absent');

  const savingTarget = path.join(tempDir, 'partial.refboard');
  await writeFile(`${savingTarget}.saving-9-abc`, 'partial-bytes');
  await writeFile(`${savingTarget}.preview-9-abc`, 'preview-bytes');
  const skippedTemps = await recoverBoardFileIfMissing(savingTarget);
  assert.deepEqual(skippedTemps, { exists: false, recovered: false });
  assert.equal(existsSync(savingTarget), false, '.saving-* and .preview-* must not become the live board');

  const present = await recoverBoardFileIfMissing(crashTarget);
  assert.deepEqual(present, { exists: true, recovered: false });
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

console.log('board file replace tests passed');
