/**
 * Navigating must not rewrite the board.
 *
 * zoomAt, panView, the minimap, fit and the view tween all called
 * scheduleSave(false). The `false` only skipped the dirty flag: 400 ms after
 * every wheel or drag pause the renderer still shallow-copied every item and
 * every image record into the IndexedDB session store, and rewrote the
 * recent-works file through IPC. On a 500-image board that is a full
 * serialisation per scroll pause. The camera now has its own record.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');

const fn = name => {
  const m = html.match(new RegExp(`(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
  assert.ok(m, `${name} should be findable`);
  return m[0];
};

/* --- the view path exists and writes only the camera --- */
assert.match(html, /const SESSION_VIEW_KEY = `\$\{SESSION_META_KEY\}:view`;/, 'the view record is keyed beside the board record, per window');
assert.match(fn('persistViewNow'), /dbPutChecked\('meta', SESSION_VIEW_KEY, \{ view: \{ \.\.\.state\.view \}, savedAt: Date\.now\(\) \}\)/,
  'the view record carries the camera and a timestamp, nothing else');
const schedule = fn('scheduleViewSave');
assert.match(schedule, /clearTimeout\(viewSaveTimer\)/, 'view saves are debounced');
assert.match(schedule, /VIEW_SAVE_DEBOUNCE_MS/, 'the view debounce is named, not a literal');
assert.doesNotMatch(schedule, /markBoardDirty|touchRecentWorkEdited|persistBoardNow/, 'a view save must not dirty the board, touch recents, or persist items');

/* --- every navigation entry point uses it --- */
for (const name of ['zoomAt', 'panView', 'minimapPanTo', 'fitTo', 'animateViewTo']) {
  const body = fn(name);
  assert.match(body, /scheduleViewSave\(\);/, `${name} must persist only the view`);
  assert.doesNotMatch(body, /scheduleSave\(/, `${name} must not persist the board`);
}
// Anchored on the right-drag bookkeeping so this is the pointerup branch, not pointermove's.
const panEnd = html.match(/if \(mode\.type === 'pan'\) \{\s*if \(mode\.right\) lastRightDrag = mode\.dist;[\s\S]*?\n {2}\} else if/);
assert.ok(panEnd, 'the pointerup pan branch should be findable');
assert.match(panEnd[0], /scheduleViewSave\(\);/, 'the end of a drag-pan persists only the view');
assert.doesNotMatch(panEnd[0], /scheduleSave\(/, 'the end of a drag-pan must not persist the board');

/* --- board-state callers keep the board path --- */
assert.match(fn('commitDrawSessionAndSave'), /scheduleSave\(false\);/, 'a bitmap bake still persists the board without re-dirtying it');

/* --- restore picks the newer of the two records --- */
const newest = fn('newestSessionView');
assert.match(newest, /dbGet\('meta', SESSION_VIEW_KEY\)\.catch\(\(\) => null\)/, 'a missing or unreadable view record falls back to the board record');
assert.match(newest, /viewAt > boardAt/, 'the view record wins only when it is newer');
assert.match(html, /normalizeSessionView\(await newestSessionView\(meta\)\)/, 'session restore consults the view record');
assert.match(fn('persistBoardNow'), /savedAt: Date\.now\(\)/, 'the board record keeps its timestamp so the comparison is meaningful');

console.log('view persist contract passed');
