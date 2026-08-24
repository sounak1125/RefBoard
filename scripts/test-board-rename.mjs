/**
 * Renaming a board from Home moves the real .refboard file, so the failure
 * modes are file-system ones: a name Windows will not accept, a collision with
 * a board already in that folder, an orphaned .bak, a stale recents entry.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  boardNameFromPath,
  boardRenameFailureText,
  boardRenameTargetPath,
  normalizeBoardName,
  renameBoardFile,
  validateBoardName,
} = require('./board-rename.js');

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const main = await readFile(new URL('../main.js', import.meta.url), 'utf8');
const preload = await readFile(new URL('../preload.js', import.meta.url), 'utf8');

/* ---------- name validation ---------- */

assert.equal(validateBoardName('Trip moodboard').ok, true);
assert.equal(validateBoardName('Client work - v2 (final)').ok, true, 'spaces, dashes and brackets are legal file names');
assert.equal(validateBoardName('  spaced  ').name, 'spaced', 'surrounding whitespace is trimmed, not rejected');
assert.equal(normalizeBoardName('Board.refboard'), 'Board', 'a typed-back extension must not double up');
assert.equal(normalizeBoardName('Board.RefBoard'), 'Board', 'the extension check is case-insensitive');
assert.equal(boardNameFromPath('C:/boards/Trip.refboard'), 'Trip');

assert.equal(validateBoardName('').reason, 'empty');
assert.equal(validateBoardName('   ').reason, 'empty');
assert.equal(validateBoardName('.refboard').reason, 'empty', 'an extension with no stem is not a name');
for (const bad of ['a/b', 'a\\b', 'a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b']) {
  assert.equal(validateBoardName(bad).reason, 'invalid-chars', `${bad} must be rejected`);
}
assert.equal(validateBoardName('bad\u0007name').reason, 'invalid-chars', 'control characters must be rejected');
assert.equal(validateBoardName('trailing.').reason, 'trailing-dot-or-space');
assert.equal(validateBoardName('CON').reason, 'reserved');
assert.equal(validateBoardName('lpt9').reason, 'reserved', 'reserved device names are case-insensitive');
assert.equal(validateBoardName('CONTACT').ok, true, 'a name that merely starts with a device name is fine');
assert.equal(validateBoardName('x'.repeat(121)).reason, 'too-long');
assert.equal(validateBoardName('x'.repeat(120)).ok, true);

for (const reason of ['empty', 'invalid-chars', 'exists', 'reserved', 'missing', 'busy']) {
  assert.ok(boardRenameFailureText(reason).length > 4, `${reason} needs user-facing text`);
}
assert.equal(boardRenameFailureText('nonsense'), 'Could not rename that board', 'unknown reasons still get a message');

assert.equal(
  path.basename(boardRenameTargetPath('C:/boards/old.refboard', 'New')),
  'New.refboard',
  'the target keeps the board extension',
);
assert.equal(
  path.dirname(boardRenameTargetPath(path.join('C:', 'boards', 'old.refboard'), 'New')),
  path.join('C:', 'boards'),
  'a rename never moves the board to another folder',
);

/* ---------- the file-system rename ---------- */

const tempDir = await mkdtemp(path.join(os.tmpdir(), 'refboard-rename-'));
try {
  const from = path.join(tempDir, 'Old board.refboard');
  await writeFile(from, 'board-bytes');
  await writeFile(`${from}.bak`, 'previous-generation');

  const renamed = await renameBoardFile(from, 'New board');
  assert.equal(renamed.ok, true);
  assert.equal(renamed.name, 'New board');
  assert.equal(renamed.to, path.join(tempDir, 'New board.refboard'));
  assert.equal(await readFile(renamed.to, 'utf8'), 'board-bytes');
  assert.equal(existsSync(from), false, 'the old file must not linger');
  assert.equal(
    await readFile(`${renamed.to}.bak`, 'utf8'),
    'previous-generation',
    'the recovery copy must follow the board instead of being orphaned',
  );
  assert.equal(existsSync(`${from}.bak`), false);

  const noop = await renameBoardFile(renamed.to, 'New board');
  assert.equal(noop.ok, true);
  assert.equal(noop.unchanged, true, 'renaming to the same name is a no-op, not an EEXIST failure');

  const withExtension = await renameBoardFile(renamed.to, 'New board.refboard');
  assert.equal(withExtension.unchanged, true, 'typing the extension back in is still the same name');

  const other = path.join(tempDir, 'Taken.refboard');
  await writeFile(other, 'other-board');
  const collision = await renameBoardFile(renamed.to, 'Taken');
  assert.equal(collision.ok, false);
  assert.equal(collision.reason, 'exists');
  assert.equal(await readFile(other, 'utf8'), 'other-board', 'a collision must never overwrite the other board');
  assert.equal(existsSync(renamed.to), true, 'a rejected rename leaves the source untouched');

  const cased = await renameBoardFile(renamed.to, 'NEW BOARD');
  assert.equal(cased.ok, true, 'a case-only rename must not be read as a collision with itself');
  assert.equal(cased.unchanged, false);
  assert.equal(path.basename(cased.to), 'NEW BOARD.refboard');

  const gone = await renameBoardFile(path.join(tempDir, 'ghost.refboard'), 'Anything');
  assert.equal(gone.reason, 'missing');

  const notABoard = await renameBoardFile(path.join(tempDir, 'notes.txt'), 'Anything');
  assert.equal(notABoard.reason, 'invalid-path');
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

/* ---------- wiring ---------- */

assert.match(preload, /renameRecentWork: \(filePath, name\) => ipcRenderer\.invoke\('rename-recent-work'/, 'preload must expose the rename bridge');
assert.match(main, /ipcMain\.handle\('rename-recent-work'/, 'main must handle the rename');
assert.match(
  main,
  /ipcMain\.handle\('rename-recent-work'[\s\S]*?boardSaveSessions\.values\(\)[\s\S]*?reason: 'busy'/,
  'a rename must be refused while that board is mid-save',
);
assert.match(
  main,
  /ipcMain\.handle\('rename-recent-work'[\s\S]*?boardOpenSessions\.values\(\)[\s\S]*?reason: 'busy'/,
  'a rename must be refused while that board is mid-open',
);
assert.match(
  main,
  /ipcMain\.handle\('rename-recent-work'[\s\S]*?const newId = recentIdForPath\(result\.to\)[\s\S]*?fs\.rename\(path\.join\(thumbnailsDir\(\), thumbnail\), path\.join\(thumbnailsDir\(\), next\)\)/,
  'the cached thumbnail is keyed by path, so it has to move with the rename',
);
assert.match(
  main,
  /ipcMain\.handle\('rename-recent-work'[\s\S]*?\.filter\(w => w\.id !== newId && path\.resolve\(w\.path\) !== result\.to\)/,
  'a stale entry at the new path must not leave the same board listed twice',
);
assert.match(
  main,
  /ipcMain\.handle\('rename-recent-work'[\s\S]*?refreshShellIcons\(result\.from\)[\s\S]*?refreshShellIcons\(result\.to\)/,
  'Explorer must be told about both the old and the new path',
);

assert.match(html, /btn\.className = 'rw-card-rename';/, 'Home cards need a rename control');
assert.match(html, /\.rw-card-rename\{/, 'the rename control needs its own styling');
assert.match(html, /btn\.title = 'Rename board \(F2\)'/, 'the rename control must advertise its shortcut');
assert.match(
  html,
  /async function renameRecentWork\(filePath, name\)[\s\S]*?window\.RefBoardAPI\.renameRecentWork\(filePath, wanted\)/,
  'Home rename must go through the main process, not just relabel the card',
);
assert.match(
  html,
  /if \(sameFilePath\(currentBoardPath, result\.from\)\) \{[\s\S]*?currentBoardPath = result\.path;[\s\S]*?currentBoardTitle = result\.title;/,
  'renaming the board that is still loaded must repoint this window at the new file',
);
assert.match(
  html,
  /function clickClosedARename\(\)[\s\S]*?renameClosedAt < 250/,
  'the click that dismisses a rename must not also open the board',
);
assert.match(
  html,
  /e\.target\.closest\('[^']*\.rw-card-rename[^']*\.rw-rename-input[^']*'\)/,
  'the Focus Flow drag gesture must ignore the rename controls',
);
assert.match(html, /else if \(e\.key === 'F2'\) \{ e\.preventDefault\(\); renameFocusedLandingCard\(\); \}/, 'F2 must start a rename on Home');

console.log('board rename contract ok');
