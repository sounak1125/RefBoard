/**
 * Four small correctness holes, each pinned by shape.
 *
 * 1. The item-kind predicates dereferenced `it.kind` unguarded, and Enter with
 *    zero or several items selected handed them null: an uncaught TypeError on
 *    a plain keypress. Any stale id in the selection crashed the selection bar
 *    the same way through singleSelectedGroup.
 * 2. Undo and redo ran during a live pointer gesture. restoreSnap replaces
 *    every item object, but the gesture keeps references to the old ones, so a
 *    mid-drag Ctrl+Z made the snap solver measure orphans while the move wrote
 *    to the new objects, and an in-flight resize or crop wrote to a detached
 *    object and vanished.
 * 3. deleteItemsByIds removed an emptied group from the board but not from the
 *    selection, leaving a stale id for updateSelBar to trip over.
 * 4. recent-works.json and whats-new.json were written with a truncating
 *    writeFile; a crash mid-write emptied the recents list and every pin.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const main = await readFile(new URL('../main.js', import.meta.url), 'utf8');

const fn = name => {
  const m = html.match(new RegExp(`(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
  assert.ok(m, `${name} should be findable`);
  return m[0];
};

/* --- 1. predicates tolerate null --- */
assert.match(html, /const isImageItem = it => !!it && \(it\.kind \|\| 'image'\) === 'image';/, 'isImageItem guards null');
for (const [name, kind] of [['isNoteItem', 'note'], ['isArrowItem', 'arrow'], ['isGroupItem', 'group']]) {
  assert.match(html, new RegExp(`const ${name} = it => it\\?\\.kind === '${kind}';`), `${name} guards null`);
}
assert.match(html, /if \(k === 'enter'\) \{\s*const it = state\.sel\.size === 1 \? byId\(\[\.\.\.state\.sel\]\[0\]\) : null;\s*if \(it && isNoteItem\(it\)\)/,
  'Enter checks for an item before asking what kind it is');

/* --- 2. history refuses a live gesture --- */
for (const name of ['undo', 'redo']) {
  const body = fn(name);
  assert.match(body, /^function \w+\(\) \{\s*if \(mode\) return Promise\.resolve\(\);/, `${name} refuses while a gesture is live, before queueing`);
  assert.match(body, /await settleDrawCommitForHistory\(\);\s*if \(mode\) return;/, `${name} re-checks after waiting its turn, in case a gesture began meanwhile`);
}

/* --- 3. an emptied group leaves the selection too --- */
const del = fn('deleteItemsByIds');
assert.match(del, /const removedGroups = new Set\(\);/, 'emptied groups are collected');
assert.match(del, /removedGroups\.add\(gid\);/, 'each emptied group is recorded');
assert.match(del, /for \(const id of removedGroups\) state\.sel\.delete\(id\);/, 'emptied groups are dropped from the selection');
assert.match(del, /if \(state\.anchorId && \(toDelete\.has\(state\.anchorId\) \|\| removedGroups\.has\(state\.anchorId\)\)\) state\.anchorId = null;/,
  'an emptied group cannot remain the selection anchor');

/* --- 4. the two JSON stores are written atomically --- */
assert.match(main, /const \{ writeJsonAtomic \} = require\('\.\/scripts\/atomic-json'\);/, 'main.js uses the atomic writer');
assert.match(main, /async function saveRecentWorks\(list\) \{\s*await writeJsonAtomic\(recentWorksPath\(\), list\);\s*\}/, 'recent works are written atomically');
assert.match(main, /async function saveWhatsNewStore\(data\) \{\s*await writeJsonAtomic\(whatsNewStorePath\(\), data\);\s*\}/, 'the what\'s-new store is written atomically');
assert.doesNotMatch(main, /fs\.writeFile\((?:recentWorksPath|whatsNewStorePath)\(\)/, 'neither store uses a truncating write');

console.log('small correctness contract passed');
