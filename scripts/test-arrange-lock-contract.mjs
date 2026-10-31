/**
 * Align in a row and Align in a column refuse a locked group.
 *
 * Both laid out every selected item with no lock check, so a locked group
 * moved whenever a loose image anchored the row or column, and a child
 * selected alongside its group was moved once with the group and again on its
 * own. Align left/center/right and dragging already refused and filtered.
 * smoke-arrange-lock.mjs drives the buttons; this pins the shape.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');

const body = name => {
  const m = html.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
  assert.ok(m, `${name} should be findable`);
  return m[0];
};

for (const name of ['alignSelectionHorizontal', 'alignSelectionVertical']) {
  const fn = body(name);
  assert.match(fn, /const items = picked\.filter\(it => !\(it\.groupId && pickedIds\.has\(it\.groupId\)\)\);/,
    `${name} leaves a child whose group is selected too to the group`);
  assert.match(fn, /if \(idsIncludeLockedGroupItems\(expandMoveIds\(new Set\(items\.map\(it => it\.id\)\)\)\)\) \{\s*toast\('Group is locked'\);\s*return;\s*\}\s*pushUndo\(\);/,
    `${name} refuses a locked group, children included, before it takes an undo step`);
  assert.match(fn, /let anchor = items\.find\(it => it\.id === state\.anchorId\)/,
    `${name} only anchors on an item it lays out`);
}

console.log('arrange lock contract passed');
