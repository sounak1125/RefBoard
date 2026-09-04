/**
 * The delta history wiring, pinned by shape. See scripts/board-history.mjs.
 *
 * pushUndo no longer serialises the board; it opens a baseline the module
 * diffs later. Undo and redo apply one side of an entry to the live items in
 * place. A pixel edit's bitmaps ride on the entry in both directions.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

const fn = name => {
  const m = html.match(new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\) \\{[\\s\\S]*?\\r?\\n\\}`));
  assert.ok(m, `${name} should be findable`);
  return m[0];
};

/* --- construction --- */
assert.match(html, /import \{ createBoardHistory, snapshotBoard, applyDelta \} from '\.\/scripts\/board-history\.mjs';/, 'the module is imported');
assert.ok(packageJson.build.files.includes('scripts/board-history.mjs'), 'the module ships in the package');
assert.match(html, /const boardHistory = createBoardHistory\(\{\s*snapshot: \(\) => snapshotBoard\(state\.items, \{/, 'the history snapshots state.items and the board props');
assert.match(html, /limit: \(\) => undoLimit,\s*byteBudget: \(\) => undoByteBudget,/, 'the count limit and byte budget are read live from the settings');
assert.match(html, /const \{ undoStack, redoStack \} = boardHistory;/, 'the stacks are the module\'s');

/* --- the whole-board snapshot is gone --- */
assert.doesNotMatch(html, /const snap = \(\) => JSON\.stringify\(/, 'no whole-board JSON snapshot');
assert.doesNotMatch(html, /function restoreSnap\(/, 'no whole-board restore');
assert.doesNotMatch(html, /function pushUndoSnapshot\(/, 'no snapshot push');
assert.doesNotMatch(html, /function captureUndoState\(/, 'no re-snapshot on undo');
const push = fn('pushUndo');
assert.match(push, /boardHistory\.begin\(extra\);/, 'pushUndo opens a baseline');
assert.doesNotMatch(push, /JSON\.stringify/, 'pushUndo serialises nothing');
assert.match(push, /before: createBitmapHistoryRef\(opts\.imgId, opts\.blob\), after: null/, 'a pixel edit attaches its pre-edit bytes');

/* --- applying an entry --- */
const apply = fn('applyBoardDelta');
assert.match(apply, /applyDelta\(\{\s*items: state\.items,/, 'entries apply to the live items');
assert.match(apply, /if \(result\.items\) state\.items = result\.items;/, 'the array is replaced only when membership or order changed');
assert.match(apply, /for \(const g of groupItems\(\)\) syncGroupFrame\(g\);/, 'group frames follow their children');
assert.match(apply, /if \(result\.items\) reconcileGroupOrder\(\);/, 'group order is reconciled only when the array changed');
assert.match(apply, /invalidateWorkspaceBBox\(\);/, 'the indexes are told');
const applyEntry = fn('applyUndoEntry');
assert.match(applyEntry, /applyBoardDelta\(entry, direction\);/, 'the item delta is applied in the requested direction');
assert.match(applyEntry, /const ref = entry\.bitmap \? entry\.bitmap\[direction\] : null;/, 'the bitmap for that direction is restored');

/* --- undo and redo --- */
const undo = fn('undo');
assert.match(undo, /if \(mode\) return Promise\.resolve\(\);/, 'undo still refuses during a gesture');
assert.match(undo, /await settleDrawCommitForHistory\(\);[\s\S]*?const entry = boardHistory\.undo\(\);[\s\S]*?await captureBitmapAfterState\(entry\);[\s\S]*?await applyUndoEntry\(entry, 'before'\);/,
  'undo settles drawing, pops the entry, captures the post-edit bitmap for redo, then applies before');
assert.match(undo, /if \(!undoStack\.length && !boardHistory\.hasPending\(\)\)/, 'an open operation counts as history');
const redo = fn('redo');
assert.match(redo, /if \(mode\) return Promise\.resolve\(\);/, 'redo still refuses during a gesture');
assert.match(redo, /const entry = boardHistory\.redo\(\);[\s\S]*?await applyUndoEntry\(entry, 'after'\);/, 'redo pops the entry and applies after');
assert.doesNotMatch(undo + redo, /releaseUndoEntry\(entry\)/, 'entries move between stacks intact; only trim and clear release them');
const release = fn('releaseUndoEntry');
assert.match(release, /releaseBitmapRef\(bitmap\.before\);\s*releaseBitmapRef\(bitmap\.after\);/, 'both bitmaps of an entry are released with it');

/* --- note editing is one entry --- */
assert.match(html, /if \(!continuingSameNote \|\| !noteEditStartBoardSnapshot\) \{ pushUndo\(\); noteEditStartBoardSnapshot = true; \}/, 'a note edit opens a baseline when it starts');
assert.match(html, /if \(editStartBoardSnapshot\) boardHistory\.finalize\(\);/, 'and finalises it when it ends, recording only what changed');

/* --- hooks --- */
assert.match(html, /historyBeginForTest\(times = 20\)/, 'the per-gesture cost is measurable');
assert.match(html, /historyStats: \(\) => boardHistory\.stats\(\),/, 'history stats are reachable');

console.log('board history contract passed');
