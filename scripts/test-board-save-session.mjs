/**
 * A streamed board save that fails or is abandoned must clean up after itself.
 *
 * `begin-board-save` opens `<board>.refboard.saving-<pid>-<token>` and holds the
 * handle until `finish-board-save` renames it over the board. The helper that
 * closes the handle and unlinks the temp file on the failure branches was
 * deleted by mistake in ff90c34 while its three call sites stayed. From 2.0.6
 * to 2.0.12 every failed or aborted save therefore threw
 * `ReferenceError: discardBoardSaveSession is not defined` — which masked the
 * real error (disk full, EPERM, antivirus lock), leaked the file handle (the
 * board stays locked on Windows), and left a board-sized temp file next to the
 * user's board forever. Nothing exercised the abort path, so nothing noticed.
 *
 * Two layers here. The specific one pins the helper and its call sites. The
 * general one catches the *class* of bug: an awaited bare call in main.js whose
 * name is defined nowhere in the file. `node --check` does not catch that; only
 * running the branch does, and failure branches rarely run in tests.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const main = await readFile(new URL('../main.js', import.meta.url), 'utf8');

/* --- the helper exists and does both halves of the cleanup --- */
const helperStart = main.search(/async function discardBoardSaveSession\(session\) \{/);
assert.ok(helperStart >= 0, 'main.js must define discardBoardSaveSession(session)');
const helperEnd = main.indexOf('\n  }', helperStart);
const helper = main.slice(helperStart, helperEnd);
assert.match(helper, /session\.handle\?\.close\(\)/, 'the helper must close the open temp-file handle');
assert.match(helper, /fs\.unlink\(session\.tempPath\)/, 'the helper must unlink the temp file');
assert.match(helper, /\.catch\(\(\) => \{\}\)/, 'a missing temp file is not an error during cleanup');

/* --- every save-session failure branch discards the session --- */
const handlerSource = channel => {
  const start = main.indexOf(`ipcMain.handle('${channel}'`);
  assert.ok(start >= 0, `main.js must handle '${channel}'`);
  const next = main.indexOf('ipcMain.handle(', start + 1);
  return main.slice(start, next < 0 ? undefined : next);
};
for (const channel of ['begin-board-save', 'finish-board-save', 'abort-board-save']) {
  assert.match(
    handlerSource(channel),
    /await discardBoardSaveSession\(session\)/,
    `'${channel}' must discard the session on its failure/abort branch`,
  );
}
// finish must drop the session from the map *before* trying to complete it, so a
// failed finish cannot leave a half-written session that later reports "busy".
const finish = handlerSource('finish-board-save');
assert.ok(
  finish.indexOf('boardSaveSessions.delete(token)') < finish.indexOf('session.store.handle.sync()'),
  'finish-board-save must remove the session before flushing the store',
);

/* --- general guard: awaited bare calls resolve to something defined --- */
const defined = new Set();
for (const m of main.matchAll(/(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g)) defined.add(m[1]);
for (const m of main.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)) defined.add(m[1]);
for (const m of main.matchAll(/(?:const|let|var)\s+\{([^}]+)\}\s*=/g)) {
  for (const part of m[1].split(',')) {
    const name = part.split(':').pop().split('=')[0].trim();
    if (name) defined.add(name);
  }
}
for (const m of main.matchAll(/(?:const|let|var)\s+\[([^\]]+)\]\s*=/g)) {
  for (const part of m[1].split(',')) {
    const name = part.split('=')[0].trim();
    if (name) defined.add(name);
  }
}
// Awaited callbacks handed in as parameters, plus platform globals.
const allowed = new Set(['fetch', 'import', 'Promise']);
const undefinedCalls = new Set();
for (const m of main.matchAll(/(?<![.\w$])await\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
  const name = m[1];
  if (defined.has(name) || allowed.has(name)) continue;
  undefinedCalls.add(name);
}
assert.deepEqual(
  [...undefinedCalls].sort(),
  [],
  `main.js awaits helpers it never defines: ${[...undefinedCalls].join(', ')}`,
);

console.log('board save session contract passed');
