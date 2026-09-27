import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import { mkdtemp, readFile, rename, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const {
  boardBakPath,
  cleanupBoardBackup,
  replaceBoardFile,
  recoverBoardFileIfMissing,
} = require('./board-file-replace.js');

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const main = await readFile(new URL('../main.js', import.meta.url), 'utf8');
const preload = await readFile(new URL('../preload.js', import.meta.url), 'utf8');
const replacementSource = await readFile(new URL('./board-file-replace.js', import.meta.url), 'utf8');

function withFilesystemFaults(faults) {
  const module = { exports: {} };
  vm.runInNewContext(replacementSource, {
    module,
    require: id => id === 'fs/promises' ? { ...fs, ...faults } : require(id),
    console: { warn() {} },
  });
  return module.exports;
}

// New and converted boards share the replacement and interrupted-save recovery path.
assert.match(main, /await replaceBoardFile\(session\.target, tempPath\);/, 'new and converted boards must use the recoverable replacement helper');
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
  assert.equal(replaced.bakPath, null);
  assert.equal(existsSync(bak), false, 'successful replacement must remove the temporary .bak');
  assert.equal(existsSync(temp), false);

  const temp2 = path.join(tempDir, 'board.refboard.saving-2');
  await writeFile(bak, 'backup-left-by-an-older-release');
  await writeFile(temp2, 'newest');
  await replaceBoardFile(target, temp2);
  assert.equal(await readFile(target, 'utf8'), 'newest');
  assert.equal(existsSync(bak), false, 'repeated successful saves must not leave .bak');

  // A failed swap restores the old board and does not report success.
  await assert.rejects(replaceBoardFile(target, `${target}.missing-temp`), { code: 'ENOENT' });
  assert.equal(await readFile(target, 'utf8'), 'newest');
  assert.equal(existsSync(bak), false, 'successful rollback restores the normal filename');

  // If both installation and rollback fail, the only good copy stays recoverable.
  await writeFile(temp, 'cannot-install');
  const blockedSwap = withFilesystemFaults({
    async rename(from, to) {
      if (from === temp || from === bak) throw Object.assign(new Error('Locked file'), { code: 'EPERM' });
      return fs.rename(from, to);
    },
  });
  await assert.rejects(blockedSwap.replaceBoardFile(target, temp), { code: 'EPERM' });
  assert.equal(existsSync(target), false);
  assert.equal(await readFile(bak, 'utf8'), 'newest');
  assert.equal(await cleanupBoardBackup(target), false, 'never clean up the only surviving board');
  assert.equal((await recoverBoardFileIfMissing(target)).recovered, true);

  // A locked backup after a committed save is a cleanup issue, not a failed save.
  await writeFile(temp, 'committed-despite-cleanup-failure');
  const blockedCleanup = withFilesystemFaults({
    async unlink(filePath) {
      if (filePath === bak) throw Object.assign(new Error('Backup locked'), { code: 'EACCES' });
      return fs.unlink(filePath);
    },
  });
  const committed = await blockedCleanup.replaceBoardFile(target, temp);
  assert.equal(committed.replaced, true);
  assert.equal(committed.bakPath, bak);
  assert.equal(await readFile(target, 'utf8'), 'committed-despite-cleanup-failure');
  assert.equal(await readFile(bak, 'utf8'), 'newest');
  assert.equal(await cleanupBoardBackup(target), true, 'a later successful save can retry cleanup');

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

  // Exit the real replacement process between its renames, with no catch/finally.
  // This covers actual interruption both before and after installing the new file.
  for (const stage of ['backup', 'installed']) {
    const stoppedTarget = path.join(tempDir, `stopped-${stage}.refboard`);
    const stoppedTemp = `${stoppedTarget}.saving-test`;
    await writeFile(stoppedTarget, 'before-crash');
    await writeFile(stoppedTemp, 'after-crash');
    const child = spawnSync(process.execPath, ['-e', `
      const fs = require('fs/promises');
      const [helper, target, temp, stage] = process.argv.slice(1);
      const rename = fs.rename;
      fs.rename = async (from, to) => {
        await rename(from, to);
        if (to === (stage === 'backup' ? target + '.bak' : target)) process.exit(77);
      };
      require(helper).replaceBoardFile(target, temp).catch(() => process.exit(1));
    `, require.resolve('./board-file-replace.js'), stoppedTarget, stoppedTemp, stage], { windowsHide: true });
    assert.equal(child.status, 77, child.stderr?.toString());
    assert.equal(await readFile(`${stoppedTarget}.bak`, 'utf8'), 'before-crash');
    const recovered = await recoverBoardFileIfMissing(stoppedTarget);
    assert.equal(recovered.recovered, stage === 'backup');
    assert.equal(await readFile(stoppedTarget, 'utf8'), stage === 'backup' ? 'before-crash' : 'after-crash');
    if (stage === 'installed') {
      assert.equal(existsSync(`${stoppedTarget}.bak`), true, 'opening alone preserves the interrupted-save backup');
      await cleanupBoardBackup(stoppedTarget);
      assert.equal(existsSync(`${stoppedTarget}.bak`), false);
    }
  }
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

console.log('board file replace tests passed');
